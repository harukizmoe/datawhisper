/**
 * B 类工具的装配点。
 *
 * `createComputeTools({ compute })` 返回 14 个 pi-durable 工具；调用它们只需要一个
 * 能执行 `tool.<name>` 的 `ComputeClient`。会话数据上下文由宿主放在工具调用
 * `Context` 的 `computeToolContextKey` 下，或直接作为 `context` 传入。
 */

import { makeComputeTool, type ComputeTool, type ComputeToolsOptions } from "./tool.ts";
import { COMPUTE_TOOL_NAMES } from "./types.ts";

export { computeToolContextKey, COMPUTE_TOOL_NAMES } from "./types.ts";
export type {
  ComputeCaller,
  ComputeToolContext,
  ComputeToolDetails,
  ComputeToolErrorData,
  ComputeToolErrorInfo,
  ComputeToolName,
  ComputeToolProgress,
  ComputeToolRpcResult,
} from "./types.ts";
export { COMPUTE_TOOL_REPLAY, makeComputeTool } from "./tool.ts";
export type { ComputeContextSource, ComputeToolsOptions } from "./tool.ts";
export type { ComputeTool } from "./tool.ts";
export { TOOL_SCHEMAS, type ComputeToolSchema } from "./schemas.ts";
export {
  emptyDetails,
  isCancellation,
  runningDetails,
  shapeToolError,
  successDetails,
  toRpcContext,
  type ShapedToolError,
} from "./result.ts";

/** 新建 14 个工具壳。每个壳都是无状态的，可以跨会话共用。 */
export function createComputeTools(options: ComputeToolsOptions): ComputeTool[] {
  return COMPUTE_TOOL_NAMES.map((name) => makeComputeTool(name, options));
}
