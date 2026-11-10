/**
 * 工作流（P5.2）的图、运行记录与状态类型。
 *
 * 图结构沿用旧 `agent/workflows/models.py` 的字段名（`node_id`、`entry_node_ids`、
 * `input_contract`、`join_policy`、`max_attempts` 等），这样已发布的工作流版本可以原样导入；
 * 审批（`approval` 边、`run_policy.mode` 非 full_auto）本轮不实现，启动时明确拒绝而不是静默改变语义。
 */

import type { JsonValue } from "@earendil-works/chord";

export type WorkflowErrorCode =
  | "workflow_graph_invalid"
  | "workflow_resource_not_found"
  | "workflow_run_not_recoverable"
  | "workflow_approval_not_supported"
  // 节点执行器：越界类型、缺提示、取消、空输出、会话丢失。旧实现抛普通异常后由调度器记节点失败，
  // 这里给稳定错误码，运行记录里能直接看出是节点的哪一种失败。
  | "workflow_node_type_unsupported"
  | "workflow_node_prompt_missing"
  | "workflow_node_canceled"
  | "workflow_node_empty_output"
  | "workflow_node_conversation_missing"
  | "workflow_output_contract_violation"
  | "workflow_validation_failed"
  | "workflow_iteration_limit_reached";

/** 与旧 `WorkflowContractError` 对齐：`code` 是机器可读的稳定错误码。 */
export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export type EdgeType = "auto" | "conditional" | "approval" | "retry_loop";

export type EdgeCondition = { field: string; equals: JsonValue };

export type WorkflowEdge = {
  edge_id: string;
  from_node: string;
  to_node: string;
  type?: EdgeType;
  condition?: EdgeCondition;
  max_iterations?: number;
};

export type JoinPolicy = "all_success" | "all_terminal";

export type WorkflowNode = {
  node_id: string;
  /** 旧节点类型：agent / validation / router / sql / export / verifier；执行器自己解释。 */
  type?: string;
  agent_profile_id?: string;
  max_attempts?: number;
  max_iterations?: number;
  join_policy?: JoinPolicy;
  input_contract?: string[];
  output_contract?: string[];
  output_artifacts?: Record<string, string>;
  side_effects?: string[];
  /** 崩溃后是否重跑该节点的执行器；默认 safe（agent 调用可重放），副作用节点应显式 unsafe。 */
  replay?: "safe" | "unsafe";
  /** 其余节点参数（prompt、sql、export 等）原样交给执行器。 */
  [key: string]: JsonValue | undefined;
};

export type WorkflowLimits = {
  max_concurrent_node_runs?: number;
  max_total_tokens?: number;
  max_run_minutes?: number;
};

export type WorkflowRunPolicy = { mode?: "full_auto" | "key_approval" | "exception_review" };

export type WorkflowOutputSchema = {
  properties?: Record<string, JsonValue>;
  required?: string[];
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  entry_node_ids: string[];
  limits?: WorkflowLimits;
  run_policy?: WorkflowRunPolicy;
  output_schema?: WorkflowOutputSchema;
  input_schema?: JsonValue;
};

/** 旧 `RunStatus`；`waiting_approval`/`paused` 目前不会出现（审批未实现），保留取值以便 UI 类型稳定。 */
export type WorkflowRunStatus =
  | "running"
  | "waiting_approval"
  | "paused"
  | "canceling"
  | "canceled"
  | "succeeded"
  | "failed";

/** 旧 `NodeRunStatus`。 */
export type WorkflowNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "output_ready"
  | "succeeded"
  | "rejected"
  | "skipped"
  | "failed"
  | "canceled";

export type WorkflowFailure = {
  code: string;
  message: string;
};

export type WorkflowUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  tool_calls?: number;
  model_name?: string;
  provider_name?: string;
};

/** 节点执行器的返回值。`usage` 用于运行级 token 预算。 */
export type WorkflowNodeResult = {
  output: JsonValue;
  usage?: WorkflowUsage;
};

export type WorkflowNodeExecute = (
  node: WorkflowNode,
  inputs: Record<string, JsonValue>,
  context: {
    readonly signal: AbortSignal;
    readonly nodeId: string;
    readonly iteration: number;
    /** 发起运行的会话：节点复用它已打开的数据源、继承它的模型。 */
    readonly conversationId: number;
    /** 节点自己的任务 id：节点会话归它所有（不出现在会话列表里，取消时一并停下）。 */
    readonly taskId: number;
    readonly attempt: number;
    readonly idempotencyKey: string;
    readonly now: () => number;
    progress(percent: number, message?: string): void;
  },
) => Promise<WorkflowNodeResult>;

/** 运行输入（旧 `workflow_runs.input_json` + `session_id`/`workspace_id`/`started_by`）。 */
export type WorkflowRunInput = {
  workflowVersionId: string;
  graph: WorkflowGraph;
  inputs: Record<string, JsonValue>;
  startedBy: string;
  createdAt: number;
  workspaceId: string;
};

export type WorkflowRunCheckpoint = { phase: "schedule" };

export type WorkflowRunResult = {
  outputs: Record<string, JsonValue>;
  failure: WorkflowFailure | null;
};

/** 节点任务索引：终态 task 不保留 checkpoint，索引存在 session 文档里，`runs.get` 才能查历史。 */
export type WorkflowNodeRef = {
  nodeId: string;
  iteration: number;
  attempt: number;
  taskId: number;
};

export type WorkflowRunIndex = {
  nodes: WorkflowNodeRef[];
  /** 被跳过的节点（条件边未选中，或前驱未全部成功）。 */
  skipped: string[];
  /** 节点当前所在的轮次（verifier 打回会让一批节点进入下一轮）；没有记录的节点是第 1 轮。 */
  iterations?: Record<string, number>;
  /** 打回时交给目标节点的修改意见（`revision_request` 输入），按节点 id。 */
  revisions?: Record<string, string>;
};

export type WorkflowRunSummary = {
  id: number;
  workflowVersionId: string;
  conversationId: number;
  workspaceId: string;
  status: WorkflowRunStatus;
  startedBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  failure: WorkflowFailure | null;
};

export type WorkflowNodeView = {
  nodeId: string;
  /** 没有派发过的节点为 null。 */
  nodeRunId: number | null;
  status: WorkflowNodeStatus;
  iteration: number;
  attempt: number;
  agentProfileId: string;
  input: Record<string, JsonValue>;
  output: JsonValue | null;
  error: string;
  usage: WorkflowUsage | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type WorkflowRunDetail = WorkflowRunSummary & {
  graph: WorkflowGraph;
  inputs: Record<string, JsonValue>;
  outputs: Record<string, JsonValue>;
  nodes: WorkflowNodeView[];
};

/** 旧 `WorkflowConcurrencyLimiter` 的四个配额；计数从活的节点任务记录推导，进程重启后依然有效。 */
export type WorkflowQuotas = {
  global: number;
  workspace: number;
  run: number;
  profile: number;
};

export const DEFAULT_WORKFLOW_QUOTAS: WorkflowQuotas = {
  global: 6,
  workspace: 3,
  run: 2,
  profile: 1,
};

export const WORKFLOW_RUN_TASK_KIND = "datawhisper.workflow_run";
export const WORKFLOW_NODE_TASK_KIND = "datawhisper.workflow_node";

export type WorkflowStartRequest = {
  conversationId: number;
  workflowVersionId: string;
  graph: WorkflowGraph;
  inputs?: Record<string, JsonValue>;
  workspaceId?: string;
  startedBy?: string;
};

export type WorkflowListQuery = {
  conversationId?: number;
  status?: WorkflowRunStatus;
  limit?: number;
};
