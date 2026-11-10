/**
 * 工作流节点的 agent 执行器。
 *
 * 旧实现里节点由 `agent/workflows/executor.py` 驱动：给节点拼一段提示，跑一轮 agent，取最终答复。
 * 新实现把它落成「一次独立会话的一轮提交」：节点运行不污染用户正在聊的会话，可被取消、可重放，
 * 用量直接取本轮 `usage` 汇总，供运行级 token 预算使用。
 */

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Conversations } from "../conversations/service.ts";
import type { SourceDocStore } from "../ipc/source-store.ts";
import { WorkflowError, type WorkflowNode, type WorkflowNodeExecute, type WorkflowNodeResult, type WorkflowUsage } from "./types.ts";

/** 执行器需要的宿主能力：建会话、复制数据源、提交一轮、读最终答复。 */
export type AgentNodeDeps = {
  readonly harness: Harness;
  readonly context: Context;
  readonly conversations: Pick<Conversations, "create" | "submitTurn" | "abort">;
  /** 会话级来源文档；省略时节点不带数据源。 */
  readonly sources?: SourceDocStore;
};

/**
 * 节点没写 `allowed_tools` 时的默认工具：只读的数据查询。无人值守的节点不该默认拿到写文件、导出、
 * 发消息之类的工具，需要的节点必须在图里显式列出。
 */
export const DEFAULT_NODE_TOOLS: readonly string[] = ["get_schema", "get_table_detail", "query_data", "query_knowledge", "profile_data"];

/** 节点本轮可见的工具：图里的 `allowed_tools`（可以是空表，表示纯文字节点），缺省为只读默认集。 */
export function nodeAllowedTools(node: WorkflowNode): string[] {
  const declared = node.allowed_tools;
  if (!Array.isArray(declared)) return [...DEFAULT_NODE_TOOLS];
  return declared.filter((name): name is string => typeof name === "string");
}

/** 由 agent 会话执行的节点类型：verifier 是带固定输出（decision/issues/evidence）的 agent 节点。 */
const AGENT_NODE_TYPES = new Set(["agent", "verifier", undefined]);

/** verifier 的 decision 取值：pass 放行，rework 沿 retry_loop 打回，escalate 交给人。 */
export const VERIFIER_DECISIONS = ["pass", "rework", "escalate"] as const;

/** 规范化 verifier 的 decision（忽略大小写与空白）；不在取值内就让节点失败，而不是当成通过。 */
export function verifierDecision(node: WorkflowNode, value: JsonValue | undefined): string {
  const decision = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(VERIFIER_DECISIONS as readonly string[]).includes(decision)) {
    throw new WorkflowError(
      "workflow_output_contract_violation",
      `verifier ${node.node_id} returned decision ${JSON.stringify(value ?? null)}; expected one of ${VERIFIER_DECISIONS.join(", ")}`,
    );
  }
  return decision;
}

function isBlank(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * `validation` 节点：只检查上游交来的输入。`validation.required` 里的名字必须存在，`validation.non_empty` 里的
 * 还不能是空；全部通过后把一句说明写进每个输出字段，下游据此知道输入已验过。
 */
export function validateInputs(node: WorkflowNode, inputs: Record<string, JsonValue>): Record<string, JsonValue> {
  const spec = node.validation;
  const rules = typeof spec === "object" && spec !== null && !Array.isArray(spec) ? spec : {};
  const names = (key: string): string[] => {
    const value = rules[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  const required = names("required");
  const nonEmpty = names("non_empty");
  for (const name of required) {
    if (!(name in inputs)) throw new WorkflowError("workflow_validation_failed", `node ${node.node_id}: required input is missing: ${name}`);
  }
  for (const name of nonEmpty) {
    if (isBlank(inputs[name])) throw new WorkflowError("workflow_validation_failed", `node ${node.node_id}: input must not be empty: ${name}`);
  }
  const checked = [...new Set([...required, ...nonEmpty])];
  const summary = `Validated inputs: ${checked.length === 0 ? "(no rules)" : checked.join(", ")}`;
  const fields = contractFields(node);
  return Object.fromEntries((fields.length === 0 ? ["result"] : fields).map((name) => [name, summary]));
}

/**
 * 拼节点提示。字段名沿用旧图定义：`prompt`/`goal` 二选一，`inputs` 由上游节点输出填充。
 * 上游 value 一律按 JSON 渲染，避免模型看到 `[object Object]`。
 */
export function buildNodePrompt(node: WorkflowNode, inputs: Record<string, JsonValue>): string {
  const template = typeof node.prompt === "string" ? node.prompt : typeof node.goal === "string" ? node.goal : "";
  const lines: string[] = [];
  if (template.trim() === "") {
    throw new WorkflowError("workflow_node_prompt_missing", `node ${node.node_id} has no prompt`);
  }
  lines.push(template.trim());
  if (Object.keys(inputs).length > 0) {
    lines.push("", "[INPUTS]", JSON.stringify(inputs, null, 2));
  }
  const contract = Array.isArray(node.output_contract) ? node.output_contract.filter((field) => typeof field === "string") : [];
  if (contract.length > 0) {
    // 旧实现在提示末尾列出必需字段；缺字段时运行结算会判 `workflow_final_output_missing`。
    lines.push("", `[OUTPUT CONTRACT] ${contract.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * 从一轮的可见条目里取最后一条助手消息的纯文本，并汇总用量。
 *
 * 条目形状来自 `ConversationView.entries`：每条 `EntryRecord` 的 `model` 是消息数组，
 * 助手的正文在 `model[0].content` 的 `text` 块里，用量在 `model[0].usage`（`input`/`output`/`cacheRead`）。
 * 多轮工具往返会产生多条助手条目，所以文本取最后一条、用量逐条累加。
 */
export function readTurnResult(entries: readonly { kind: string; model?: unknown }[]): {
  text: string;
  usage: WorkflowUsage;
} {
  let text = "";
  let input = 0;
  let output = 0;
  let cached = 0;
  let toolCalls = 0;
  let sawUsage = false;
  for (const entry of entries) {
    if (entry.kind === "pi.tool-call") toolCalls += 1;
    if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) continue;
    for (const message of entry.model) {
      const record = message as { content?: unknown; usage?: Record<string, unknown> };
      if (Array.isArray(record.content)) {
        const pieces: string[] = [];
        for (const block of record.content) {
          const value = block as { type?: string; text?: string };
          if (value.type === "text" && typeof value.text === "string") pieces.push(value.text);
        }
        if (pieces.length > 0) text = pieces.join("");
      }
      const counted = record.usage;
      if (counted === undefined) continue;
      sawUsage = true;
      input += typeof counted.input === "number" ? counted.input : 0;
      output += typeof counted.output === "number" ? counted.output : 0;
      cached += typeof counted.cacheRead === "number" ? counted.cacheRead : 0;
    }
  }
  const usage: WorkflowUsage = { tool_calls: toolCalls };
  if (sawUsage) {
    usage.input_tokens = input;
    usage.output_tokens = output;
    usage.cached_input_tokens = cached;
  }
  return { text, usage };
}


/** 节点声明的输出字段（`output_contract`）；旧图里可能缺省。 */
export function contractFields(node: WorkflowNode): string[] {
  return Array.isArray(node.output_contract) ? node.output_contract.filter((field) => typeof field === "string" && field !== "") : [];
}

/** 去掉整段包裹的 ```json 围栏；旧实现在解析多输出节点时先剥这一层。 */
function stripFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return match === null ? text.trim() : match[1]!.trim();
}

/**
 * 把节点答复映射成「按输出契约命名的值」。
 *
 * 规则与旧 `runtime.py::_parse_agent_outputs` 一致：没有契约时只有 `result`；一个字段时整段文本归它；
 * 多个字段必须是 key 与契约完全一致的 JSON 对象——旧注释写得很清楚，多输出节点是制品接口，
 * 不能退化成「把同一段长文抄给每个名字」。
 */
export function parseAgentOutputs(content: string, outputNames: readonly string[]): Record<string, JsonValue> {
  if (outputNames.length === 0) return { result: content };
  if (outputNames.length === 1) return { [outputNames[0]!]: content };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch {
    throw new WorkflowError(
      "workflow_output_contract_violation",
      "multi-output agent node must return a JSON object keyed by its output contract",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WorkflowError("workflow_output_contract_violation", "multi-output agent node must return a JSON object");
  }
  const expected = new Set(outputNames);
  const actual = new Set(Object.keys(parsed));
  const missing = outputNames.filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) details.push(`missing ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`undeclared ${extra.join(", ")}`);
    throw new WorkflowError(
      "workflow_output_contract_violation",
      `multi-output agent result keys do not match output contract: ${details.join("; ")}`,
    );
  }
  const record = parsed as Record<string, JsonValue>;
  return Object.fromEntries(outputNames.map((name) => [name, record[name]!])) as Record<string, JsonValue>;
}

/** 旧实现认定的「占位交付物」标记：出现即判节点失败，不让空话流进最终报告。 */
const BLOCKING_MARKERS = [
  "工具调用已达到上限",
  "未能生成完整最终总结",
  "tool calls have reached the limit",
  "tool call limit reached",
  "failed / empty",
] as const;

/** 契约字段必须非空，且不得含占位标记或图里声明的禁用子串（`output_validation.forbidden_substrings`）。 */
export function validateNodeOutputs(node: WorkflowNode, outputs: Record<string, JsonValue>): void {
  const validation = node.output_validation;
  const forbidden =
    typeof validation === "object" && validation !== null && !Array.isArray(validation)
      ? ((validation as { forbidden_substrings?: unknown }).forbidden_substrings as unknown[] | undefined) ?? []
      : [];
  const forbiddenText = forbidden.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
  for (const name of contractFields(node)) {
    const value = outputs[name];
    const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    if (text.trim() === "") {
      throw new WorkflowError("workflow_output_contract_violation", `workflow node ${node.node_id} produced an empty required output: ${name}`);
    }
    const lower = text.toLowerCase();
    const match = [...BLOCKING_MARKERS, ...forbiddenText].find((item) => lower.includes(item));
    if (match !== undefined) {
      throw new WorkflowError(
        "workflow_output_contract_violation",
        `workflow node ${node.node_id} produced a placeholder output containing: ${match}`,
      );
    }
  }
}

/** 建节点执行器。取消走 `signal`：提交前已取消就不建会话；运行中取消则中止该会话的这一轮。
 */
export function createAgentNodeExecutor(deps: AgentNodeDeps): WorkflowNodeExecute {
  return async (node, inputs, context): Promise<WorkflowNodeResult> => {
    const type = node.type;
    // 确定性检查：不调模型，也不建会话。
    if (type === "validation") return { output: validateInputs(node, inputs) };
    if (!AGENT_NODE_TYPES.has(type)) {
      throw new WorkflowError(
        "workflow_node_type_unsupported",
        `node ${node.node_id}: node type '${String(type)}' is not supported by the agent executor`,
      );
    }
    if (context.signal.aborted) throw new WorkflowError("workflow_node_canceled", `node ${node.node_id} was canceled before start`);
    const prompt = buildNodePrompt(node, inputs);
    context.progress(10, "creating node conversation");

    // 模型沿用发起会话的，节点不另选；会话归节点任务所有，所以不出现在会话列表里，节点取消时一并停下。
    const origin = await deps.harness.conversation(context.conversationId as ConversationId, deps.context);
    const originAgent = origin === undefined ? undefined : await origin.agent(deps.context);
    const created = await deps.conversations.create(
      originAgent?.model === undefined ? {} : { model: originAgent.model, thinkingLevel: originAgent.thinkingLevel },
      { ownerTaskId: context.taskId },
    );
    const conversationId = created.id;
    // 数据源：复制发起会话里参与分析的来源（compute 里是同一批已打开的 source，节点只读使用）。
    // 没有来源的会话照常跑：这时模型只剩上游文字可用，由节点提示自己决定怎么处理。
    if (deps.sources !== undefined) {
      const originSources = await deps.sources.read(context.conversationId).catch(() => undefined);
      const active = originSources?.sources.filter((item) => item.active) ?? [];
      if (active.length > 0) {
        await deps.sources.update(conversationId, (draft) => {
          draft.sources = active;
        });
      }
    }
    if (context.signal.aborted) throw new WorkflowError("workflow_node_canceled", `node ${node.node_id} was canceled before submit`);

    context.progress(25, "running");

    const conversation = (await deps.harness.conversation(conversationId as never, deps.context)) as Conversation | undefined;
    if (conversation === undefined) throw new WorkflowError("workflow_node_conversation_missing", `node ${context.nodeId}: conversation vanished`);
    const onAbort = (): void => {
      void deps.conversations.abort(conversationId);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await deps.conversations.submitTurn(conversationId, {
        requestId: context.idempotencyKey,
        text: prompt,
        allowedTools: nodeAllowedTools(node),
      });
      await conversation.waitForIdle(deps.context);
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
    if (context.signal.aborted) throw new WorkflowError("workflow_node_canceled", `node ${node.node_id} was canceled`);

    context.progress(90, "collecting output");
    const view = (await conversation.watch(deps.context)).value;
    const { text, usage } = readTurnResult(view.entries as never);
    if (text.trim() === "") {
      throw new WorkflowError("workflow_node_empty_output", `node ${node.node_id} produced no assistant text`);
    }
    const outputs = parseAgentOutputs(text, contractFields(node));
    validateNodeOutputs(node, outputs);
    if (type === "verifier") outputs.decision = verifierDecision(node, outputs.decision);
    return { output: outputs, usage };
  };
}
