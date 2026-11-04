/**
 * 工作流节点的 agent 执行器。
 *
 * 旧实现里节点由 `agent/workflows/executor.py` 驱动：给节点拼一段提示，跑一轮 agent，取最终答复。
 * 新实现把它落成「一次独立会话的一轮提交」：节点运行不污染用户正在聊的会话，可被取消、可重放，
 * 用量直接取本轮 `usage` 汇总，供运行级 token 预算使用。
 */

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { Conversations } from "../conversations/service.ts";
import { WorkflowError, type WorkflowNode, type WorkflowNodeExecute, type WorkflowNodeResult, type WorkflowUsage } from "./types.ts";

/** 执行器需要的宿主能力；只用到「建会话 + 提交一轮 + 读最终答复」。 */
export type AgentNodeDeps = {
  readonly harness: Harness;
  readonly context: Context;
  readonly conversations: Pick<Conversations, "create" | "submitTurn" | "abort">;
  /** 节点默认模型；省略时走服务默认模型（与用户手动新建会话一致）。 */
  readonly model?: () => Promise<{ provider: string; modelId: string } | undefined>;
  /** 节点级工具收敛：节点会话不该看用户的全部工具。省略时沿用 `conversations` 的默认收敛。 */
  readonly prepareConversation?: (conversationId: number, node: WorkflowNode) => Promise<void>;
};

/** 支持由本执行器处理的节点类型；其余类型在运行前就明确失败，不静默跳过。 */
const AGENT_NODE_TYPES = new Set(["agent", undefined]);

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
    if (!AGENT_NODE_TYPES.has(type)) {
      throw new WorkflowError(
        "workflow_node_type_unsupported",
        `node ${node.node_id}: node type '${String(type)}' is not supported by the agent executor`,
      );
    }
    if (context.signal.aborted) throw new WorkflowError("workflow_node_canceled", `node ${node.node_id} was canceled before start`);
    const prompt = buildNodePrompt(node, inputs);
    context.progress(10, "creating node conversation");

    const created = await deps.conversations.create({ title: `workflow:${context.nodeId}` });
    const conversationId = created.id;
    const model = await deps.model?.();
    if (model !== undefined) {
      // 只设置默认模型；思考强度沿用会话默认，节点不额外覆盖。
      await deps.harness.conversation(conversationId as never, deps.context).then((conversation) =>
        conversation?.configure({ model }, deps.context),
      );
    }
    await deps.prepareConversation?.(conversationId, node);
    if (context.signal.aborted) throw new WorkflowError("workflow_node_canceled", `node ${node.node_id} was canceled before submit`);

    context.progress(25, "running");

    const conversation = (await deps.harness.conversation(conversationId as never, deps.context)) as Conversation | undefined;
    if (conversation === undefined) throw new WorkflowError("workflow_node_conversation_missing", `node ${context.nodeId}: conversation vanished`);
    const onAbort = (): void => {
      void deps.conversations.abort(conversationId);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await deps.conversations.submitTurn(conversationId, { requestId: context.idempotencyKey, text: prompt });
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
    return { output: outputs, usage };
  };
}
