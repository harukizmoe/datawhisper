/**
 * B 类工具的 pi-durable 外壳：校验与执行都在 Python worker 里，这里只负责
 * 转交参数、转发进度/事件、把结果分到模型通道（`output`）与 UI 通道（`details`）。
 */

import type { JsonValue } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { isCancellation, runningDetails, shapeToolError, successDetails, toRpcContext } from "./result.ts";
import { TOOL_SCHEMAS } from "./schemas.ts";
import {
  computeToolContextKey,
  type ComputeCaller,
  type ComputeToolContext,
  type ComputeToolDetails,
  type ComputeToolName,
  type ComputeToolRpcResult,
} from "./types.ts";

/**
 * `replay` 是“崩溃/重启后这次调用能否重跑”的静态策略，而参数在运行时才知道，
 * 因此这里按工具最坏情况取：
 *
 * - `safe`：只读且幂等。重跑只是再算一遍，不会多出表、文件或重复写入。
 * - `unsafe`：会在 worker 会话里建表/删表/写文件，或一次调用内可能执行写 SQL；
 *   重跑会产生重复副作用。
 */
export const COMPUTE_TOOL_REPLAY: Record<ComputeToolName, "safe" | "unsafe"> = {
  // 只查知识库，读取路径无写入。
  query_knowledge: "safe",
  // 只读 source 的 schema。
  get_schema: "safe",
  get_table_detail: "safe",
  // 只读分析：不改数据，不上传文件；图表 HTML 只在本次调用内捕获。
  profile_data: "safe",
  // 会新建派生表；重跑会再建一次（CREATE 失败或留下第二份结果）。
  create_analysis_table: "unsafe",
  // 删除表，重跑可能在第二次时删掉别的东西或直接失败。
  delete_analysis_tables: "unsafe",
  // 参数允许 CREATE/INSERT/UPDATE/DELETE 的内存写 SQL，重跑会重复写入。
  query_data: "unsafe",
  // 分析结果会落成新的可查询表。
  run_analysis: "unsafe",
  // 图表 HTML 交给调用方持久化，重跑会产生第二份图表。
  generate_chart: "unsafe",
  // 生成 cleaned_data 表。
  clean_data: "unsafe",
  // 以下四个都写文件到 outputs/。
  export_excel: "unsafe",
  export_report: "unsafe",
  generate_ppt: "unsafe",
  generate_dashboard: "unsafe",
};

export type ComputeContextSource =
  | ComputeToolContext
  | ((context: Context) => ComputeToolContext | undefined);

export type ComputeToolsOptions = {
  readonly compute: ComputeCaller;
  /**
   * 会话数据上下文。函数形式按调用解析；省略时读取工具 `Context` 里的
   * `computeToolContextKey`（宿主在派发工具调用时注入）。
   */
  readonly context?: ComputeContextSource;
};

/** 一次 `createComputeTools` 的注册表项：details 比 `ToolRegistration` 的默认值更具体。 */
export type ComputeTool = ToolRegistration<object, ComputeToolDetails>;

/**
 * 由 `api.details()` 提交的“运行中”值会替换整份 details，所以每次提交都带完整
 * 底稿；提交失败（调用已结束、被取消）不影响最终结果，后者另带一份完整 details。
 */
export function makeComputeTool(name: ComputeToolName, options: ComputeToolsOptions): ComputeTool {
  const schema = TOOL_SCHEMAS[name];
  return defineTool<object, ComputeToolDetails>({
    name,
    description: schema.description,
    parameters: schema.parameters,
    replay: COMPUTE_TOOL_REPLAY[name],
    async execute(args, api, context) {
      const supplied = typeof options.context === "function" ? options.context(context) : options.context;
      const toolContext = supplied ?? context.value(computeToolContextKey) ?? { sources: [] };
      const liveEvents: JsonValue[] = [];
      let commits: Promise<void> = Promise.resolve();
      const publish = (details: ComputeToolDetails) => {
        commits = commits.then(() => api.details(details, context)).catch(() => undefined);
      };
      try {
        const result = await options.compute.call<ComputeToolRpcResult>(
          `tool.${name}`,
          { context: toRpcContext(toolContext), args: args as Record<string, unknown> },
          {
            signal: context.abortSignal,
            onProgress(percent, message) {
              publish(runningDetails(name, liveEvents, { percent, message }));
            },
            onEvent(event) {
              liveEvents.push(event);
              publish(runningDetails(name, liveEvents));
            },
          },
        );
        await commits;
        return { output: [{ type: "text", text: result.text }], details: successDetails(name, result, liveEvents) };
      } catch (error) {
        // 中止是调用方的意图，不是工具失败；抛回 ToolTask 让它记为 aborted。
        if (isCancellation(error, context.abortSignal)) throw error;
        const shaped = shapeToolError(name, error);
        await commits;
        return { isError: true, output: [{ type: "text", text: shaped.text }], details: shaped.details };
      }
    },
  });
}
