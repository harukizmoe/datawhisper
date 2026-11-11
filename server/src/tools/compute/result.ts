/**
 * compute 工具结果的整形：把 `tool.<name>` 的 RPC 返回答成 pi-durable 的三条通道
 * （`output` 给模型、`details` 给 UI、语言外的错误保持失败），并且把 worker 的
 * 错误原文、取消语义分开处理。
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  ComputeCancelled,
  ComputeCrashed,
  ComputeError,
  ComputeUnavailable,
} from "../../compute/client.ts";
import { toolExecutionErrorText } from "../guard/result-policy.ts";
import type {
  ComputeToolContext,
  ComputeToolDetails,
  ComputeToolErrorData,
  ComputeToolErrorInfo,
  ComputeToolName,
  ComputeToolProgress,
  ComputeToolRpcResult,
} from "./types.ts";

/** `ComputeToolContext` → worker 的 `context` 参数（snake_case，与 `compute/host.py` 一致）。 */
export function toRpcContext(context: ComputeToolContext): Record<string, unknown> {
  const rpc: Record<string, unknown> = { sources: [...context.sources] };
  if (context.primary !== undefined) rpc.primary = context.primary;
  if (context.tables !== undefined) {
    rpc.tables = Object.fromEntries(
      Object.entries(context.tables).map(([sourceId, tables]) => [sourceId, [...tables]]),
    );
  }
  if (context.userId !== undefined) rpc.user_id = context.userId;
  if (context.workspaceId !== undefined) rpc.workspace_id = context.workspaceId;
  if (context.sessionId !== undefined) rpc.session_id = context.sessionId;
  if (context.lang !== undefined) rpc.lang = context.lang;
  if (context.colorScheme !== undefined) rpc.color_scheme = context.colorScheme;
  if (context.chartIds !== undefined) rpc.chart_ids = [...context.chartIds];
  if (context.chartDir !== undefined) rpc.chart_dir = context.chartDir;
  if (context.workspaceRoot !== undefined) rpc.workspace_root = context.workspaceRoot;
  return rpc;
}

/** 一次调用的 details 底稿：运行期间与最终结果都从这里派生。 */
export function emptyDetails(tool: ComputeToolName): ComputeToolDetails {
  return {
    tool,
    refs: [],
    artifacts: [],
    charts: [],
    events: [],
    tables_changed: false,
    files: [],
  };
}

/** 运行期间提交的 details：已收到的 UI 事件 + 当前进度（事件触发时没有进度）。 */
export function runningDetails(
  tool: ComputeToolName,
  events: readonly JsonValue[],
  progress?: ComputeToolProgress,
): ComputeToolDetails {
  const details: ComputeToolDetails = { ...emptyDetails(tool), events: [...events] };
  if (progress !== undefined) details.progress = progress;
  return details;
}

/** 成功结果的 details：以 worker 的最终返回为准，事件补上本次调用扇出的 refs。 */
export function successDetails(
  tool: ComputeToolName,
  result: ComputeToolRpcResult,
  liveEvents: readonly JsonValue[],
): ComputeToolDetails {
  const details: ComputeToolDetails = {
    tool,
    refs: Array.isArray(result.refs) ? [...result.refs] : [],
    artifacts: Array.isArray(result.artifacts) ? [...result.artifacts] : [],
    charts: Array.isArray(result.charts) ? [...result.charts] : [],
    events: Array.isArray(result.events) ? [...result.events] : [...liveEvents],
    tables_changed: result.tables_changed === true,
    files: Array.isArray(result.files)
      ? result.files.filter((item): item is string => typeof item === "string")
      : [],
  };
  if (typeof result.dashboard_id === "string" && result.dashboard_id !== "") {
    details.dashboard_id = result.dashboard_id;
  }
  return details;
}

function errorData(value: JsonValue | undefined): ComputeToolErrorData | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = value as Record<string, JsonValue>;
  const shaped: ComputeToolErrorData = {};
  if (typeof data.kind === "string") shaped.kind = data.kind;
  if (typeof data.text === "string") shaped.text = data.text;
  if (typeof data.error === "string" && data.error !== "") shaped.error = data.error;
  if (Array.isArray(data.sources)) shaped.sources = [...data.sources];
  return shaped;
}

/**
 * 取消不是工具失败：pi-durable 的 `ToolTask` 在自己的 signal 中止后接收
 * `execute()` 抛出的错误，并把这次调用记为 `aborted`（不是 `tool_error`）。
 * 因此调用方一旦中止，这里必须把错误抛回去，而不能 `return {isError: true}`。
 */
export function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof ComputeCancelled) return true;
  return error instanceof Error && error.name === "AbortError";
}

export type ShapedToolError = {
  readonly text: string;
  readonly details: ComputeToolDetails;
};

/**
 * 把 worker 的失败换成模型文案与 UI details。
 *
 * 文本优先用 worker 给的 `data.text`（旧 agent 的原话），没有时用 JSON-RPC 的
 * message；两者都没有才退回 JS 错误的 message。
 */
export function shapeToolError(tool: ComputeToolName, error: unknown): ShapedToolError {
  if (error instanceof ComputeError) {
    const data = errorData(error.data);
    const info: ComputeToolErrorInfo = {
      kind: data?.kind ?? "compute_error",
      message: error.message,
      sources: data?.sources ?? [],
    };
    if (data?.text !== undefined) info.text = data.text;
    const text = data?.text !== undefined && data.text !== "" ? data.text : error.message;
    return { text, details: { ...emptyDetails(tool), error: info } };
  }
  const message = error instanceof Error ? error.message : String(error);
  const kind = error instanceof ComputeCrashed
    ? "compute_crashed"
    : error instanceof ComputeUnavailable
      ? "compute_unavailable"
      : "tool_error";
  return {
    text: toolExecutionErrorText(tool, message),
    details: { ...emptyDetails(tool), error: { kind, message, sources: [] } },
  };
}
