/**
 * `tools/compute` 的类型契约：工具名、会话数据上下文、compute RPC 的返回与错误形状，
 * 以及工具 `details` 的结构。
 *
 * 世界线：模型参数由 TS 的 JSON Schema 校验一次，然后原样交给 Python worker 的
 * `tool.<name>`；worker 会用旧 agent 的 `validate_tool_args` 再校验一次，并把旧文案
 * 作为错误返回。因此这里的参数类型只用于内部转交，不是第二套校验。
 */

import { createContextKey } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { CallOptions } from "../../compute/client.ts";

/** B 类工具（旧 `agent/tools/schemas.py` 中由 compute worker 执行的那 14 个）。 */
export const COMPUTE_TOOL_NAMES = [
  "query_knowledge",
  "get_schema",
  "get_table_detail",
  "create_analysis_table",
  "delete_analysis_tables",
  "query_data",
  "run_analysis",
  "generate_chart",
  "profile_data",
  "clean_data",
  "export_excel",
  "export_report",
  "generate_ppt",
  "generate_dashboard",
] as const satisfies readonly string[];

export type ComputeToolName = (typeof COMPUTE_TOOL_NAMES)[number];

/**
 * 一次工具调用看到的数据上下文，对应 `compute/host.py` 的 `context`：
 *
 * - `sources`：按界面顺序排列的活动 source id（多 source 时 worker 用 `src1__` 前缀合并）。
 * - `primary`：默认执行工具的主 source，省略时取 `sources[0]`。
 * - `tables`：SQL 数据源的“分析表”选择，缺省要求界面先选表。
 * - `chartIds`/`chartDir`：本会话已有图表的 id 与其 HTML 目录，`export_report` 用它们插图。
 *
 * `sessionId` 只影响导出链接里的 `sid`；`userId` 决定知识库作用域。
 */
export type ComputeToolContext = {
  readonly sources: readonly string[];
  readonly primary?: string;
  readonly tables?: Readonly<Record<string, readonly string[]>>;
  readonly userId?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly lang?: "zh" | "en";
  readonly colorScheme?: string;
  readonly chartIds?: readonly string[];
  readonly chartDir?: string;
  /** 工作区对话所属的目录；compute 据此把导出写进 `<目录>/artifacts/`，并把目录加进 SQL 读文件白名单。 */
  readonly workspaceRoot?: string;
};

/**
 * 宿主放在工具调用 `Context` 里的数据上下文。工具默认从这里读取，因此
 * `createComputeTools({ compute })` 不需要与会话存储耦合。
 */
export const computeToolContextKey = createContextKey<ComputeToolContext>("compute tool context");

/**
 * `ComputeClient` 中工具需要的唯一能力。测试可以注入假实现来固定错误形状，
 * 生产使用真实的 `ComputeClient`。
 */
export type ComputeCaller = {
  call<T = JsonValue>(method: string, params?: Record<string, unknown>, options?: CallOptions): Promise<T>;
};

/** worker 的 JSON-RPC 结果对象（`compute/host.py::run_tool` 的返回）。 */
export type ComputeToolRpcResult = {
  text: string;
  refs?: JsonValue[];
  artifacts?: JsonValue[];
  charts?: JsonValue[];
  events?: JsonValue[];
  tables_changed?: boolean;
  files?: string[];
  dashboard_id?: string;
};

/**
 * worker 失败时 `error.data` 的形状：`kind` 决定 UI 如何展示，`text`（若有）就是
 * 模型看到的原文；没有 `text` 的 kind（`source_not_open`、`sql_table_selection_required`）
 * 使用 JSON-RPC 的 error message。
 */
export type ComputeToolErrorData = {
  kind?: string;
  text?: string;
  error?: string;
  sources?: JsonValue[];
};

/** 一次失败的结构化说明，供 UI 展示；模型只看到 `output` 文本。 */
export type ComputeToolErrorInfo = {
  kind: string;
  message: string;
  text?: string;
  sources: JsonValue[];
};

/** 进度：worker 的 `progress` 通知（百分比 + 阶段文案）。 */
export type ComputeToolProgress = {
  percent?: number;
  message: string;
};

/**
 * 工具的 `details`：UI 读取的结构化结果。字段名与 worker 返回一致，避免在两个
 * 世界线之间继续改名；`output` 才是模型看到的文本。
 */
export type ComputeToolDetails = {
  tool: ComputeToolName;
  refs: JsonValue[];
  artifacts: JsonValue[];
  charts: JsonValue[];
  events: JsonValue[];
  tables_changed: boolean;
  files: string[];
  dashboard_id?: string;
  /** 只在运行期间出现；最终结果的 details 里没有。 */
  progress?: ComputeToolProgress;
  /** 只在 `isError` 结果里出现。 */
  error?: ComputeToolErrorInfo;
};
