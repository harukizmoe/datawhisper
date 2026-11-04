/**
 * 团队成员委托：给一个成员开一条独立子会话，跑一轮受限的 agent，并取回正文与用量。
 *
 * 旧实现（`agent/agent.py::_run_delegated_llm`）在 Leader 进程里用一套手写的工具循环跑成员；
 * 这里换成真正的会话：成员只看到 `allowed_tools`（`configure({ modelTools })`），
 * 取消直接 `Conversations.abort()`，父会话不受影响，子会话也能在团队视图里按 id 回查。
 *
 * 子会话的元数据写进会话级文档 `TEAM_DELEGATE_DOC`（标题、成员、允许工具、用量），
 * 同时由一个 `beforeTool` 守卫读同一份文档做运行时兜底：即使调用方式绕过了工具集收敛，
 * 非允许工具也会被拦下。
 */

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  type Conversation,
  type ConversationId,
  defineDoc,
  defineExtension,
  type Extension,
  type Harness,
  hook,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { PlanUsage, TeamMember } from "../tools/app/docs.ts";
import { isoSeconds } from "../tools/app/tasks.ts";
import type {
  TeamDelegateRequest,
  TeamDelegateResult,
  TeamDelegationPort,
} from "../tools/app/types.ts";
import { readTurnResult } from "../workflows/agent-node.ts";

/** 旧实现 `_delegated_tool_schemas` 的只读默认集；`allowed_tools` 只能在此基础上收窄。 */
export const DEFAULT_DELEGATE_TOOLS: readonly string[] = [
  "workspace_status",
  "workspace_glob",
  "workspace_grep",
  "workspace_read_file",
  "get_schema",
  "get_table_detail",
  "query_data",
  "query_knowledge",
  "memory_read",
  "select_chart",
  "profile_data",
];

export type TeamDelegateDocStatus = "idle" | "running" | "completed" | "failed" | "canceled";

/** 子会话的元数据；团队视图用它说明“这是谁的第几次调用”。 */
export type TeamDelegateDoc = {
  team_name: string;
  member_name: string;
  title: string;
  role: string;
  allowed_tools: string[];
  parent_conversation_id: number | null;
  started_at: string;
  finished_at: string;
  status: TeamDelegateDocStatus;
  usage: PlanUsage;
};

export const TEAM_DELEGATE_DOC = defineDoc<TeamDelegateDoc>({
  kind: "datawhisper.team-delegate",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    team_name: "",
    member_name: "",
    title: "",
    role: "",
    allowed_tools: [],
    parent_conversation_id: null,
    started_at: "",
    finished_at: "",
    status: "idle",
    usage: emptyUsage(),
  }),
  checkpointWhen: () => true,
});

export function emptyUsage(): PlanUsage {
  return {
    model: "",
    provider: "",
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    tool_calls: 0,
  };
}

/** 委托标题：界面按它就能看出团队与成员，不需要再查文档。 */
export function teamDelegateTitle(teamName: string, memberName: string): string {
  return `团队委托：${teamName} / ${memberName}`;
}

/** 允许工具 = 只读默认集 ∩ 调用方声明；声明里写了默认集之外的名字也不会生效。 */
export function allowedDelegateTools(requested: readonly string[] | null | undefined): string[] {
  if (requested === null || requested === undefined) return [...DEFAULT_DELEGATE_TOOLS];
  const selected = new Set(requested.map((name) => String(name)));
  return DEFAULT_DELEGATE_TOOLS.filter((name) => selected.has(name));
}

/** 把成员角色与允许工具写进子会话的 instructions；工具清单同时写进文档供守卫核对。 */
function delegateInstructions(member: TeamMember, allowed: readonly string[]): string {
  return (
    "You are a bounded delegated analyst working as one member of a team. " +
    "You may use only the provided tools to inspect schemas, query data, read relevant workspace files, " +
    "and search business knowledge. When workspace spreadsheets are registered as data-source tables, " +
    "prefer get_schema/query_data for quantitative work; use workspace_read_file for direct sheet inspection. " +
    "Do not modify data. Do not create teams or ask the user questions. " +
    `Allowed tools: ${allowed.length === 0 ? "(none)" : allowed.join(", ")}. ` +
    `Role: ${member.role || "analyst"}. ` +
    `Instructions: ${member.instructions || ""}\n` +
    "Return concise Markdown. Focus on the requested subtask only. " +
    "Do not restate all input data; provide concrete findings, risks, and recommendations that the Leader can synthesize."
  );
}

/** 旧实现会在正文后附一行“工具使用”；保留它便于 Leader 判断成员是否真的查过数据。 */
function withToolFooter(content: string, events: readonly JsonValue[]): string {
  const names = [
    ...new Set(
      events.flatMap((event) => {
        if (event === null || typeof event !== "object" || Array.isArray(event) || !("tool" in event)) return [];
        const name = event.tool;
        return typeof name === "string" && name !== "" ? [name] : [];
      }),
    ),
  ];
  if (names.length === 0) return content;
  return `${content.trimEnd()}\n\n---\n工具使用：${names.join(", ")}`.trimEnd();
}

/** 去掉 `withToolFooter` 追回的尾行，再决定结果是否可用。 */
function stripToolFooter(content: string): string {
  const text = content.trim();
  for (const marker of ["\n\n---\n工具使用：", "\n---\n工具使用："]) {
    const index = text.indexOf(marker);
    if (index >= 0) return text.slice(0, index).trim();
  }
  if (text.startsWith("---\n工具使用：") || text.startsWith("工具使用：")) return "";
  return text;
}

/** 旧 `_delegated_result_invalid_reason`：空答复、截断表格、未闭合代码块都不能算成功。 */
export function invalidDelegatedResult(
  content: string,
  toolEvents: readonly JsonValue[],
): { code: string; error: string } | undefined {
  const body = stripToolFooter(content);
  if (body === "") {
    return { code: "team_delegate_empty_output", error: "delegated member produced no final Markdown result" };
  }
  if (body.includes("成员工具调用已达到上限，未能生成完整最终总结")) {
    return {
      code: "team_delegate_tool_call_limit",
      error: "delegated member exhausted tool rounds without a final result",
    };
  }
  if (body.length < 40 && toolEvents.length > 0) {
    return { code: "team_delegate_result_too_short", error: "delegated member final result is too short to verify" };
  }
  if ((body.match(/```/g) ?? []).length % 2 === 1) {
    return { code: "team_delegate_invalid_result", error: "delegated member result has an unclosed code block" };
  }
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1) ?? "";
  if (last.startsWith("|") && last.split("|").length < 3) {
    return {
      code: "team_delegate_invalid_result",
      error: "delegated member result appears truncated inside a Markdown table",
    };
  }
  return undefined;
}

type MessageLike = { content?: unknown; timestamp?: number };

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const value = block as { type?: string; text?: string };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("");
}

type PendingCall = { tool: string; args: JsonValue; created_at: string };

/**
 * 从会话条目还原旧 `tool_events` 的形状：一次调用一条，状态取工具结果的 `isError`。
 * 工具结果条目自带 `durationMs` 与 `toolCallId`，不需要再记时间戳。
 */
export function delegatedToolEvents(entries: readonly { kind: string; model?: unknown }[]): JsonValue[] {
  const calls = new Map<string, PendingCall>();
  const events: JsonValue[] = [];
  for (const entry of entries) {
    if (entry.kind === "pi.assistant" && Array.isArray(entry.model)) {
      for (const message of entry.model as MessageLike[]) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
          const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
          if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
          calls.set(call.id, {
            tool: call.name,
            args: (call.arguments ?? {}) as JsonValue,
            created_at: typeof message.timestamp === "number" ? isoSeconds(new Date(message.timestamp)) : "",
          });
        }
      }
      continue;
    }
    if (entry.kind !== "pi.tool-result" || !Array.isArray(entry.model)) continue;
    for (const message of entry.model as {
      toolCallId?: string;
      toolName?: string;
      content?: unknown;
      isError?: boolean;
      durationMs?: number;
    }[]) {
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      const tool = message.toolName ?? call?.tool ?? "";
      if (tool === "") continue;
      events.push({
        tool,
        args: call?.args ?? {},
        result: textOfContent(message.content).slice(0, 2000),
        status: message.isError === true ? "error" : "ok",
        elapsed_seconds:
          typeof message.durationMs === "number" ? Math.round((message.durationMs / 1000) * 1000) / 1000 : null,
        created_at: call?.created_at ?? "",
      });
    }
  }
  return events.slice(-30);
}

export type TeamDelegateDeps = {
  readonly harness: Harness;
  readonly context: Context;
  readonly conversations: {
    create(body: unknown): Promise<{ id: number }>;
    abort(id: string | number): Promise<{ ok: true }>;
  };
};

type ActiveDelegate = {
  team_name: string;
  member_name: string;
  title: string;
  conversation_id: number;
  canceled: boolean;
  resolve_canceled: (() => void) | undefined;
  readonly canceled_wait: Promise<"canceled">;
};

export type TeamDelegationService = TeamDelegationPort;

/**
 * 建委托执行器。每个成员一轮 = 一条独立会话：
 * `create` → 收敛模型与工具 → 写元数据 → `submit` → `waitForIdle` → 读答复与用量。
 * 取消与超时都会 `abort` 子会话，不会让成员在后台继续烧 token。
 */
export function createTeamDelegateService(deps: TeamDelegateDeps): TeamDelegationService {
  const { harness, context, conversations } = deps;
  const active = new Map<number, ActiveDelegate>();

  function remember(conversationId: number, request: TeamDelegateRequest, title: string): ActiveDelegate {
    const { promise: canceled_wait, resolve: resolve_canceled } = Promise.withResolvers<"canceled">();
    const entry: ActiveDelegate = {
      team_name: request.team_name,
      member_name: request.member.name,
      title,
      conversation_id: conversationId,
      canceled: false,
      resolve_canceled,
      canceled_wait,
    };
    active.set(conversationId, entry);
    return entry;
  }

  async function abort(conversationId: number): Promise<void> {
    try {
      await conversations.abort(conversationId);
    } catch (error) {
      // 会话已经结束时 abort 可能报错；取消仍然要返回给调用方。
      console.error("[teams] 中止委托子会话失败", conversationId, error);
    }
  }

  async function parentAgent(parentConversationId: number | undefined) {
    if (parentConversationId === undefined) return undefined;
    const parent = await harness.conversation(parentConversationId as ConversationId, context);
    return parent === undefined ? undefined : await parent.agent(context);
  }

  async function runOnce(request: TeamDelegateRequest): Promise<TeamDelegateResult> {
    const title = teamDelegateTitle(request.team_name, request.member.name);
    const allowed = allowedDelegateTools(request.allowed_tools);
    const startedAt = isoSeconds(new Date());
    let conversationId = 0;
    let conversation: Conversation | undefined;
    let entry: ActiveDelegate | undefined;
    let usage = emptyUsage();
    let content = "";
    let events: JsonValue[] = [];
    let status: TeamDelegateResult["status"] = "failed";
    let code = "team_delegate_failed";
    let error = "";

    try {
      const parent = await parentAgent(request.parent_conversation_id);
      let created: { id: number };
      try {
        created = await conversations.create(
          parent?.model === undefined ? {} : { model: parent.model, thinkingLevel: parent.thinkingLevel },
        );
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        return {
          status: "failed",
          code: message.includes("no model") ? "team_delegate_no_model" : "team_delegate_conversation_failed",
          error: message,
          content: "",
          conversation_id: 0,
          conversation_title: title,
          usage: emptyUsage(),
          tool_events: [],
        };
      }
      conversationId = created.id;
      entry = remember(conversationId, request, title);
      conversation = await harness.conversation(conversationId as ConversationId, context);
      if (conversation === undefined) {
        return {
          status: "failed",
          code: "team_delegate_conversation_failed",
          error: `conversation vanished: ${conversationId}`,
          content: "",
          conversation_id: conversationId,
          conversation_title: title,
          usage: emptyUsage(),
          tool_events: [],
        };
      }

      const agent = await conversation.agent(context);
      const allowedSet = new Set(allowed);
      const selected: ToolRegistration[] = agent.tools.filter((tool) => allowedSet.has(tool.name));
      const maxTurns =
        typeof request.max_tool_calls === "number" && request.max_tool_calls > 0
          ? Math.min(Math.floor(request.max_tool_calls) + 1, 1000)
          : undefined;
      await conversation.configure(
        {
          modelTools: selected,
          instructions: delegateInstructions(request.member, allowed),
          ...(maxTurns === undefined ? {} : { maxTurns }),
        },
        context,
      );

      // 元数据先落盘：界面在成员运行期间就能看到“哪个团队/成员在跑”，取消也有据可查。
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(TEAM_DELEGATE_DOC, conversationId as ConversationId);
        Object.assign(doc, {
          team_name: request.team_name,
          member_name: request.member.name,
          title,
          role: request.member.role,
          allowed_tools: allowed,
          parent_conversation_id: request.parent_conversation_id ?? null,
          started_at: startedAt,
          finished_at: "",
          status: "running",
          usage: emptyUsage(),
        } satisfies TeamDelegateDoc);
      }, context);
      await request.on_start?.({ conversation_id: conversationId, title });

      if (entry.canceled) {
        status = "canceled";
        code = "team_delegate_canceled";
        error = "团队成员委托已取消。";
        await abort(conversationId);
        return {
          status,
          code,
          error,
          content: "",
          conversation_id: conversationId,
          conversation_title: title,
          usage: emptyUsage(),
          tool_events: [],
        };
      }

      const timeoutSeconds =
        typeof request.timeout_seconds === "number" && request.timeout_seconds > 0 ? request.timeout_seconds : 300;
      const requestId = request.request_id ?? crypto.randomUUID();
      const prompt = (request.description?.trim() ? `任务：${request.description.trim()}\n\n` : "任务：团队并行分析\n\n") +
        request.prompt +
        "\n\n交付必须完整结束；如表格过长，请压缩行数并给出完整结论，不能在表格或句子中截断。" +
        (request.inbox_context ?? "");

      await conversation.submit({ type: "input", content: prompt, requestId, whenBusy: "followUp" }, context);

      const idle = conversation.waitForIdle(context).then(() => "idle" as const);
      const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<"timeout">();
      const timeoutHandle = setTimeout(resolveTimeout, timeoutSeconds * 1000);
      let outcome: "idle" | "timeout" | "canceled";
      try {
        outcome = await Promise.race([idle, timeout, entry.canceled_wait]);
      } finally {
        clearTimeout(timeoutHandle);
      }
      // abort 可能先让 waitForIdle 返回；显式取消必须优先于“正常空闲”。
      if (entry.canceled) outcome = "canceled";

      if (outcome !== "idle") {
        await abort(conversationId);
        // abort 会等普通作用域空闲；再等一次，确保读到的条目已经写完。
        await idle.catch(() => undefined);
      }

      const watch = await conversation.watch(context, { min: 600, max: 600 });
      const view = watch.value;
      await watch.stop();
      events = delegatedToolEvents(view.entries as never);
      const raw = readTurnResult(view.entries as never);
      usage = {
        model: typeof agent.model?.modelId === "string" ? agent.model.modelId : "",
        provider: typeof agent.model?.provider === "string" ? agent.model.provider : "",
        input_tokens: raw.usage.input_tokens ?? 0,
        output_tokens: raw.usage.output_tokens ?? 0,
        cached_input_tokens: raw.usage.cached_input_tokens ?? 0,
        tool_calls: events.length,
      };
      content = withToolFooter(raw.text, events);
      if (raw.text.trim() === "" && events.length > 0) {
        // 与旧实现一致：工具轮用完但没有最终正文时，给 Leader 一段可识别的占位结论。
        content =
          "成员工具调用已达到上限，未能生成完整最终总结。" +
          "请 Leader 根据下方工具调用流程中的结果进行汇总。";
      }

      if (outcome === "canceled") {
        status = "canceled";
        code = "team_delegate_canceled";
        error = "团队成员委托已取消。";
      } else if (outcome === "timeout") {
        status = "failed";
        code = "team_delegate_timeout";
        error = `团队成员执行超过 ${timeoutSeconds} 秒未完成，已停止等待。`;
        content = "";
      } else {
        status = "completed";
        code = "";
        error = "";
      }
    } catch (failure) {
      status = "failed";
      code = "team_delegate_failed";
      error = failure instanceof Error ? failure.message : String(failure);
      content = "";
      if (conversationId !== 0) await abort(conversationId);
    } finally {
      if (conversation !== undefined && conversationId !== 0) {
        try {
          await conversation.commit(async (tx) => {
            const doc = await tx.doc(TEAM_DELEGATE_DOC, conversationId as ConversationId);
            doc.status = status;
            doc.finished_at = isoSeconds(new Date());
            doc.usage = usage;
          }, context);
        } catch (failure) {
          console.error("[teams] 写委托子会话元数据失败", conversationId, failure);
        }
      }
      if (conversationId !== 0) active.delete(conversationId);
    }

    return {
      status,
      code,
      error,
      content,
      conversation_id: conversationId,
      conversation_title: title,
      usage,
      tool_events: events,
    };
  }

  return {
    run: runOnce,
    async cancel(teamName, memberName) {
      let count = 0;
      for (const entry of [...active.values()]) {
        if (entry.canceled) continue;
        if (entry.team_name !== teamName) continue;
        if (memberName !== undefined && entry.member_name !== memberName) continue;
        entry.canceled = true;
        entry.resolve_canceled?.();
        count += 1;
        // 先主动 abort：调用方 await cancel 返回时，子会话这一轮已经停下。
        await abort(entry.conversation_id);
      }
      return count;
    },
    active() {
      return [...active.values()].map((entry) => ({
        conversation_id: entry.conversation_id,
        team_name: entry.team_name,
        member_name: entry.member_name,
        title: entry.title,
      }));
    },
  };
}

/**
 * 运行时兜底：子会话的 `allowed_tools` 写在元数据文档里，`beforeTool` 每次调用都核对一遍。
 * 工具集收敛已经让模型看不到越权工具；这里防的是文本形式调用、嵌套调用等绕路。
 */
export function teamDelegationGuard(): Extension {
  return defineExtension({
    name: "datawhisper-team-delegate-guard",
    hooks: [
      hook(ToolTask, {
        async beforeTool(call, api, context) {
          const doc = await api.snapshot(TEAM_DELEGATE_DOC, api.conversationId, context);
          if (doc === undefined || doc.status !== "running") return undefined;
          if (doc.allowed_tools.includes(call.name)) return undefined;
          return {
            block:
              `delegated member is not allowed to call ${call.name}; ` +
              `allowed tools: ${doc.allowed_tools.length === 0 ? "(none)" : doc.allowed_tools.join(", ")}`,
          };
        },
      }),
    ],
  });
}
