/**
 * 工作流查询面（P5.2）：启动运行、取消、运行列表与详情。
 *
 * 运行记录 = durable task 记录（`datawhisper.workflow_run`），节点记录 = 它的子任务
 * （`datawhisper.workflow_node`）。旧 `workflow_runs` / `workflow_node_runs` 两张表的字段
 * 在这里这样对应：
 *
 *   workflow_runs.id                → run task id（数字）
 *   workflow_version_id             → input.workflowVersionId
 *   workspace_id / session_id       → input.workspaceId / task.conversationId
 *   status                          → task 状态 + outcome（见 `runStatus`）
 *   input_json                      → input.inputs
 *   started_by / started_at         → input.startedBy / task.startedAt
 *   finished_at                     → task.endedAt
 *   failure_code / failure_message  → outcome.error.detail.code / outcome.error.message
 *   outputs                         → outcome.result.outputs（按 output_schema 过滤）
 *
 *   workflow_node_runs.id           → 节点 task id
 *   run_id / node_id                → input.args.runId / input.args.node.node_id
 *   iteration / attempt             → 运行索引里的 ref
 *   status                          → `workflowNodeStatus`
 *   job_id                          → 节点 task id 本身（不再有独立的 job）
 *   input_json / output_json        → input.args.inputs / outcome.result.value.output
 *   error                           → outcome.error.message
 *   created_at / started_at / finished_at → 索引顺序 / task.startedAt / task.endedAt
 *   *_tokens、model_name…           → 节点执行器返回的 usage
 *
 * 审批：运行索引里的 `approvals` 是记录，`decide` 写入人的决定，调度器按决定落地（见 `task.ts`）。
 * 未迁移：artifact manifest/consumption、运行模板、知识候选、checkpoint 分支（`fork_from_checkpoint`）。
 */

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  type Harness,
  type Task,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { appError } from "../ipc/errors.ts";
import {
  createWorkTask,
  DEFAULT_PROGRESS_INTERVAL_MS,
  type WorkCheckpoint,
  type WorkInput,
  type WorkResult,
} from "../jobs/work-task.ts";
import { reworkLimit, validateWorkflowGraph } from "./graph.ts";
import { createWorkflowRunTask, nodeViews, readRunIndex, WORKFLOW_RUN_INDEX } from "./task.ts";
import {
  DEFAULT_WORKFLOW_QUOTAS,
  WORKFLOW_GATE_TASK_KIND,
  WORKFLOW_NODE_TASK_KIND,
  WORKFLOW_RUN_TASK_KIND,
  WorkflowError,
  type WorkflowApproval,
  type WorkflowDecideRequest,
  type WorkflowFailure,
  type WorkflowGraph,
  type WorkflowListQuery,
  type WorkflowNode,
  type WorkflowNodeExecute,
  type WorkflowNodeRef,
  type WorkflowQuotas,
  type WorkflowRunCheckpoint,
  type WorkflowRunDetail,
  type WorkflowRunInput,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowStartRequest,
} from "./types.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

export type WorkflowsOptions = {
  harness: Harness;
  context: Context;
  /** 节点执行器：由 P5.3/P6 提供（agent 调用、确定性节点等）；测试注入桩。 */
  executeNode: WorkflowNodeExecute;
  quotas?: Partial<WorkflowQuotas>;
  progressIntervalMs?: number;
  /** 创建时间用的时钟；默认 `Date.now`。 */
  now?: () => number;
};

export type Workflows = {
  readonly runTask: Task<WorkflowRunInput, WorkflowRunCheckpoint, WorkflowRunResult, object>;
  readonly nodeTask: Task<WorkInput, WorkCheckpoint, WorkResult, object>;
  readonly gateTask: Task<WorkInput, WorkCheckpoint, WorkResult, object>;
  start(request: WorkflowStartRequest): Promise<{ id: number }>;
  cancel(id: number): Promise<WorkflowRunDetail>;
  list(query?: WorkflowListQuery): Promise<{ runs: WorkflowRunSummary[] }>;
  get(id: number): Promise<WorkflowRunDetail>;
  wait(id: number): Promise<WorkflowRunDetail>;
  /** 对待批的审批做决定；运行随后继续（或按决定终止）。 */
  decide(request: WorkflowDecideRequest): Promise<WorkflowRunDetail>;
};

const SCAN_PAGE = 256;
const SCAN_CAP = 4096;
const DEFAULT_LIST_LIMIT = 100;

/** IPC 的 id 已经按正整数校验；TaskId 是数字的 branded 类型，pi-durable 未导出构造器。 */
function taskId(id: number): TaskId<JsonValue> {
  return id as TaskId<JsonValue>;
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

function asRunInput(record: AnyTaskRecord): WorkflowRunInput {
  // 记录由本模块创建；图与输入都是 JSON，存储层原样返回。
  return record.input as unknown as WorkflowRunInput;
}

const ALL_DECISIONS: readonly string[] = ["approve", "approve_with_changes", "reject_and_retry", "reject_and_stop"];

/**
 * 决定在提交前必须站得住：不认识的决定、对失败节点说「通过」、重做超过轮数、改了合同之外的键，
 * 都在这里拒绝，而不是写进去再让调度器卡住。返回要落地的改动（只有 `approve_with_changes` 有）。
 */
function validateDecision(
  graph: WorkflowGraph,
  approval: WorkflowApproval,
  request: WorkflowDecideRequest,
): Record<string, JsonValue> | undefined {
  const invalid = (message: string) => new WorkflowError("workflow_approval_invalid", message);
  if (!ALL_DECISIONS.includes(request.decision)) {
    throw invalid("decision must be approve, approve_with_changes, reject_and_retry, or reject_and_stop");
  }
  const approving = request.decision === "approve" || request.decision === "approve_with_changes";
  if (approving && approval.kind !== "key_approval") {
    throw invalid(`approval ${approval.id} (${approval.kind}) cannot be approved; choose reject_and_retry or reject_and_stop`);
  }
  if (request.decision === "reject_and_retry") {
    const limit = reworkLimit(graph, approval.nodeId);
    if (approval.iteration >= limit) {
      throw new WorkflowError(
        "workflow_iteration_limit_reached",
        `node ${approval.nodeId} reached max_iterations=${limit}; choose reject_and_stop`,
      );
    }
  }
  if (request.decision !== "approve_with_changes") return undefined;
  const changes = request.changes;
  if (typeof changes !== "object" || changes === null || Array.isArray(changes) || Object.keys(changes).length === 0) {
    throw invalid("approve_with_changes requires a non-empty changes object");
  }
  const contract = graph.nodes.find((node) => node.node_id === approval.nodeId)?.output_contract ?? [];
  const outside = Object.keys(changes).filter((key) => !contract.includes(key));
  if (outside.length > 0) {
    throw invalid(`changes may only set keys from the node's output_contract (${contract.join(", ") || "none declared"}); not allowed: ${outside.join(", ")}`);
  }
  return changes;
}

/** 运行状态：`completing` 已经有 outcome，但子任务还没排空，按 outcome 展示。 */
export function runStatus(record: AnyTaskRecord): WorkflowRunStatus {
  if (record.state.status !== "terminal" && record.abortRequested) return "canceling";
  const outcome = record.state.status === "terminal" || record.state.status === "completing" ? record.state.outcome : undefined;
  if (outcome !== undefined) {
    switch (outcome.status) {
      case "completed":
        return "succeeded";
      case "aborted":
        return "canceled";
      case "failed":
      case "faulted":
      case "orphaned":
        return "failed";
    }
  }
  // 调度器每次落定检查点时记下待批审批数；列表不必逐个读索引就能显示 waiting_approval。
  const checkpoint = record.state.status === "terminal" || record.state.status === "completing" ? undefined : record.state.checkpoint;
  if (checkpoint !== undefined && (checkpoint as unknown as WorkflowRunCheckpoint).pendingApprovals) return "waiting_approval";
  return "running";
}

function runFailureOf(record: AnyTaskRecord): WorkflowFailure | null {
  if (record.state.status !== "terminal" && record.state.status !== "completing") return null;
  const outcome = record.state.outcome;
  if (outcome.status === "failed") {
    const detail = outcome.error.detail;
    const code =
      typeof detail === "object" && detail !== null && !Array.isArray(detail) && "code" in detail && typeof detail.code === "string"
        ? detail.code
        : "workflow_run_failed";
    return { code, message: outcome.error.message };
  }
  if (outcome.status === "faulted") return { code: "workflow_task_faulted", message: outcome.error.message };
  if (outcome.status === "orphaned") return { code: "workflow_task_orphaned", message: outcome.reason };
  return null;
}

/** 终态里存的 `WorkflowRunResult` 是 JSON；校验形状后再取 outputs。 */
function asRunResult(value: JsonValue | undefined): WorkflowRunResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("outputs" in value) || typeof value.outputs !== "object" || value.outputs === null || Array.isArray(value.outputs)) {
    return undefined;
  }
  const failure =
    "failure" in value && typeof value.failure === "object" && value.failure !== null && !Array.isArray(value.failure) && "code" in value.failure && typeof value.failure.code === "string" && "message" in value.failure && typeof value.failure.message === "string"
      ? { code: value.failure.code, message: value.failure.message }
      : null;
  return { outputs: value.outputs as Record<string, JsonValue>, failure };
}

function runOutputs(record: AnyTaskRecord): Record<string, JsonValue> {
  if (record.state.status !== "terminal" && record.state.status !== "completing") return {};
  return asRunResult(record.state.outcome.result)?.outputs ?? {};
}

function runSummary(record: AnyTaskRecord): WorkflowRunSummary {
  const input = asRunInput(record);
  return {
    id: record.id,
    workflowVersionId: input.workflowVersionId,
    conversationId: record.conversationId,
    workspaceId: input.workspaceId,
    status: runStatus(record),
    startedBy: input.startedBy,
    createdAt: iso(input.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(record.startedAt),
    endedAt: iso(record.endedAt),
    failure: runFailureOf(record),
  };
}

function matchesQuery(record: AnyTaskRecord, query: WorkflowListQuery): boolean {
  if (query.conversationId !== undefined && record.conversationId !== query.conversationId) return false;
  if (query.status !== undefined && runStatus(record) !== query.status) return false;
  return true;
}

/** 安装到注册表的扩展：运行与节点两个 task 定义都按名字可见。 */
export function workflowsExtension(workflows: Workflows): Extension {
  return defineExtension({ name: "datawhisper-workflows", tasks: [workflows.runTask, workflows.nodeTask, workflows.gateTask] });
}

export function createWorkflows(options: WorkflowsOptions): Workflows {
  const { harness, context } = options;
  const now = options.now ?? (() => Date.now());
  const quotas: WorkflowQuotas = { ...DEFAULT_WORKFLOW_QUOTAS, ...options.quotas };

  const nodeTask = createWorkTask({
    name: WORKFLOW_NODE_TASK_KIND,
    execute: async (input, work) => {
      const args = input.args as unknown as {
        runId: number;
        workspaceId: string;
        profileId: string;
        node: WorkflowNode;
        inputs: Record<string, JsonValue>;
        iteration: number;
        attempt: number;
        conversationId: number;
      };
      const result = await options.executeNode(args.node, args.inputs, {
        signal: work.signal,
        nodeId: args.node.node_id,
        iteration: args.iteration,
        conversationId: args.conversationId,
        taskId: work.taskId,
        attempt: args.attempt,
        idempotencyKey: work.idempotencyKey,
        now: work.now,
        progress: work.progress,
      });
      if (typeof result !== "object" || result === null || Array.isArray(result) || !("output" in result)) {
        throw new Error("workflow node executor must return { output, usage? }");
      }
      // 执行器返回值是纯 JSON；WorkflowUsage 的可选字段不能直接赋给 JsonValue。
      const value = { output: result.output ?? null, ...(result.usage === undefined ? {} : { usage: result.usage }) } as unknown as JsonValue;
      return value;
    },
    progressIntervalMs: options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
  });

  // 人的决定要有一个任务来承载：运行只剩待批审批时等这个门任务，决定提交后它落定、唤醒运行。
  // 进程内的等待者只负责「立刻醒」；重启后门任务重跑，先读索引里的决定数，不依赖进程内状态。
  const waiters = new Map<number, Set<() => void>>();
  const gateTask = createWorkTask({
    name: WORKFLOW_GATE_TASK_KIND,
    execute: async (input, work) => {
      const args = input.args as unknown as { runId: number; since: number };
      for (;;) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const set = waiters.get(args.runId) ?? new Set<() => void>();
        set.add(resolve);
        waiters.set(args.runId, set);
        work.signal.addEventListener("abort", () => resolve(), { once: true });
        try {
          // 先登记等待者再读决定数，两者之间提交的决定不会丢。
          const index = await readRunIndex(harness, args.runId, context);
          if ((index.decisions ?? 0) > args.since || work.signal.aborted) return null;
          await promise;
        } finally {
          set.delete(resolve);
          if (set.size === 0) waiters.delete(args.runId);
        }
      }
    },
    progressIntervalMs: options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
  });

  const runTask = createWorkflowRunTask({ quotas, nodeTask, gateTask });

  async function readRun(id: number): Promise<AnyTaskRecord> {
    const record = await harness.getTask(taskId(id), context);
    if (record === undefined || record.kind !== WORKFLOW_RUN_TASK_KIND) {
      throw appError("not_found", `workflow run not found: ${id}`);
    }
    return record;
  }

  async function detail(id: number): Promise<WorkflowRunDetail> {
    const record = await readRun(id);
    const input = asRunInput(record);
    const index = await readRunIndex(harness, id, context);
    const records = new Map<number, AnyTaskRecord>();
    await Promise.all(
      index.nodes.map(async (ref: WorkflowNodeRef) => {
        const node = await harness.getTask(taskId(ref.taskId), context);
        if (node !== undefined && node.kind === WORKFLOW_NODE_TASK_KIND) records.set(ref.taskId, node);
      }),
    );
    return {
      ...runSummary(record),
      graph: input.graph,
      inputs: input.inputs,
      outputs: runOutputs(record),
      nodes: nodeViews(input.graph, index.nodes, records, new Set(index.skipped), index.approvals ?? []),
      approvals: [...(index.approvals ?? [])].sort((a, b) => Number(a.decision !== undefined) - Number(b.decision !== undefined)),
    };
  }

  return {
    runTask,
    nodeTask,
    gateTask,

    async start(request) {
      const graph = validateWorkflowGraph(request.graph);
      const input: WorkflowRunInput = {
        workflowVersionId: request.workflowVersionId,
        graph,
        inputs: request.inputs ?? {},
        startedBy: request.startedBy ?? "",
        createdAt: now(),
        workspaceId: request.workspaceId ?? "",
      };
      const id = await harness.commit(
        (tx) =>
          tx.createTask(runTask, input, {
            ownership: { kind: "conversation" },
            // IPC 的会话 id 是正整数；ConversationId 是数字的 branded 类型（同上）。
            conversationId: request.conversationId as ConversationId,
            // 旧工作流运行独立于聊天回合：中止一轮对话不会停掉它，只有显式 cancel 才停。
            background: true,
          }),
        context,
      );
      return { id };
    },

    async cancel(id) {
      await readRun(id);
      await harness.abortTask(taskId(id), context);
      await harness.waitForTask(taskId(id), context);
      return detail(id);
    },

    async list(query = {}) {
      const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, 500));
      const records = await harness.commit(async (tx) => {
        const found: AnyTaskRecord[] = [];
        let cursor;
        let scanned = 0;
        do {
          const page = await tx.scanTasks({ kind: WORKFLOW_RUN_TASK_KIND, order: "descending" }, SCAN_PAGE, cursor);
          for (const record of page.items) {
            scanned += 1;
            if (matchesQuery(record, query)) found.push(record);
            if (found.length >= limit) return found;
          }
          cursor = page.next;
        } while (cursor !== undefined && scanned < SCAN_CAP);
        return found;
      }, context);
      return { runs: records.map(runSummary) };
    },

    async get(id) {
      return detail(id);
    },

    async wait(id) {
      await readRun(id);
      await harness.waitForTask(taskId(id), context);
      return detail(id);
    },

    async decide(request) {
      const run = await readRun(request.runId);
      if (run.state.status === "terminal" || run.state.status === "completing") {
        throw new WorkflowError("workflow_approval_invalid", `workflow run ${request.runId} has already finished`);
      }
      const graph = asRunInput(run).graph;
      await harness.commit(async (tx) => {
        const index = await tx.doc(WORKFLOW_RUN_INDEX, String(request.runId), null);
        const approvals = index.approvals ?? [];
        const found = approvals.find((item) => item.id === request.approvalId);
        if (found === undefined) {
          throw new WorkflowError("workflow_resource_not_found", `workflow approval not found: ${request.approvalId}`);
        }
        if (found.decision !== undefined) {
          throw new WorkflowError("workflow_approval_already_decided", `approval ${found.id} was already decided: ${found.decision}`);
        }
        const changes = validateDecision(graph, found, request);
        const decided: WorkflowApproval = {
          ...found,
          decision: request.decision,
          comment: request.comment ?? "",
          ...(changes === undefined ? {} : { changes }),
          decidedAt: new Date(now()).toISOString(),
        };
        index.approvals = approvals.map((item) => (item.id === found.id ? decided : item));
        index.decisions = (index.decisions ?? 0) + 1;
      }, context);
      // 决定先提交，再叫醒门任务；中间崩溃时门任务重启后读到决定，同样会落定。
      for (const wake of waiters.get(request.runId) ?? []) wake();
      return detail(request.runId);
    },
  };
}

export { WORKFLOW_RUN_INDEX };
