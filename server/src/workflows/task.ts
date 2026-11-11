/**
 * 工作流运行 = 一个 durable task（`datawhisper.workflow_run`），每个节点 = 它拥有的子任务
 * （`datawhisper.workflow_node`，由 `jobs/work-task.ts` 提供执行、进度、取消与重跑语义）。
 *
 * 与旧 `agent/workflows/scheduler.py` 的对应关系：
 *
 * - `advance()` 的每次 tick ↔ 本 phase 的一次调用。phase 每次都从任务记录与运行索引重新推导，
 *   所以崩溃后 `harness.resume()` 会接着调度，不需要额外的恢复逻辑。
 * - 节点失败：`attempt < max_attempts` 时创建下一次 attempt（旧 `create_retry_attempt`）；
 *   用尽后节点保持 failed，下游按旧规则跳过，运行最终 failed（重试/跳过/终止）。
 * - 并发：`limits.max_concurrent_node_runs` 限制本 run 同时在跑的节点；全局/工作区/run/profile
 *   配额从「活的节点任务记录」计数（旧 `WorkflowConcurrencyLimiter` 是进程内集合，重启即失效）。
 * - 运行记录：运行 task 的 input 是图的不可变快照；节点尝试的索引写在 session 文档里，
 *   因为终态 task 不保留 checkpoint，历史查询不能只靠运行 task。
 *
 * 本 phase 只提交一次：读（索引、节点任务、全库活任务）→ 创建重试/派发 → 写索引 →
 * 返回 waiting（等一个活节点）或 terminal。等待一个而不是全部活节点，是因为 pi-durable 的
 * `waiting` 只能等「一组任务全部终态」；等最老的那个可以在每次节点结束时重新调度，
 * 与旧实现「每个 job 结束都 advance 一次」的行为最接近。
 */

import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineDocFamily,
  defineTask,
  type Harness,
  type NextTaskState,
  type Task,
  type TaskId,
  type TaskRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import type { WorkCheckpoint, WorkInput, WorkResult } from "../jobs/work-task.ts";
import {
  collectOutputs,
  hasApprovalEdge,
  isTerminalNodeStatus,
  nodeMaxAttempts,
  planReadiness,
  predecessors,
  reworkLimit,
  reworkNodes,
  reworkTargets,
  runMode,
} from "./graph.ts";
import {
  WORKFLOW_NODE_TASK_KIND,
  type ApprovalKind,
  type WorkflowApproval,
  type WorkflowFailure,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeRef,
  type WorkflowNodeStatus,
  type WorkflowNodeView,
  type WorkflowQuotas,
  type WorkflowRunCheckpoint,
  type WorkflowRunIndex,
  type WorkflowRunInput,
  type WorkflowRunResult,
  type WorkflowUsage,
} from "./types.ts";

/** 运行索引：每个 run 一份（session 文档族），记录节点任务 id 与跳过集合。 */
export const WORKFLOW_RUN_INDEX = defineDocFamily<WorkflowRunIndex, null>({
  kind: "datawhisper.workflow-run-index",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ nodes: [], skipped: [], iterations: {}, revisions: {}, approvals: [], decisions: 0 }),
  checkpointWhen: () => true,
});

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
type NodeRecord = { ref: WorkflowNodeRef; record: AnyTaskRecord };

/** 节点任务状态 → 旧 `NodeRunStatus`。 */
export function workflowNodeStatus(record: AnyTaskRecord): WorkflowNodeStatus {
  switch (record.state.status) {
    case "pending":
      return "queued";
    case "running":
    case "waiting":
    case "sleeping":
      return "running";
    case "completing":
      return "output_ready";
    case "terminal":
      switch (record.state.outcome.status) {
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
}

function isLive(record: AnyTaskRecord): boolean {
  return record.state.status !== "terminal";
}

/** 节点执行器的返回值存在 work task 的 `result.value` 里（`{ output, usage? }`）。 */
function nodePayload(record: AnyTaskRecord): { output: JsonValue; usage: WorkflowUsage | null } | undefined {
  if (record.state.status !== "terminal" || record.state.outcome.status !== "completed") return undefined;
  const result = record.state.outcome.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return { output: result ?? null, usage: null };
  const value = "value" in result ? result.value : null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { output: value ?? null, usage: null };
  const output = "output" in value ? value.output : null;
  const rawUsage = "usage" in value ? value.usage : undefined;
  const usage =
    typeof rawUsage === "object" && rawUsage !== null && !Array.isArray(rawUsage)
      ? (rawUsage as WorkflowUsage)
      : null;
  return { output: output ?? null, usage };
}

function nodeError(record: AnyTaskRecord): string {
  if (record.state.status !== "terminal") return "";
  const outcome = record.state.outcome;
  if (outcome.status === "failed" || outcome.status === "faulted") return outcome.error.message;
  if (outcome.status === "orphaned") return outcome.reason;
  return "";
}

function usageTokens(usage: WorkflowUsage | null): number {
  return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
}

/** 旧 `_concurrency_key`：有 profile 用 profile，否则用节点 id。 */
function profileKey(node: WorkflowNode): string {
  return node.agent_profile_id || node.node_id;
}

function quotaKey(workspaceId: string, runId: number, profileId: string): string {
  return `${workspaceId}\u0000${runId}\u0000${profileId}`;
}

/** 全库活的节点任务：配额只看活任务，数量很小，按状态分别扫描避免翻历史。 */
async function scanLiveNodeKeys(tx: Tx): Promise<string[]> {
  const keys: string[] = [];
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
    let cursor;
    do {
      const page = await tx.scanTasks({ kind: WORKFLOW_NODE_TASK_KIND, status }, 256, cursor);
      for (const record of page.items) {
        const input = record.input as unknown as { runId?: number; workspaceId?: string; profileId?: string };
        if (typeof input.runId !== "number") continue;
        keys.push(quotaKey(input.workspaceId ?? "", input.runId, input.profileId ?? ""));
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  return keys;
}

function quotaAllows(liveKeys: readonly string[], candidate: string, quotas: WorkflowQuotas): boolean {
  const parts = candidate.split("\u0000");
  const workspace = parts[0] ?? "";
  const run = parts[1] ?? "";
  const profile = parts[2] ?? "";
  if (liveKeys.length >= quotas.global) return false;
  if (liveKeys.includes(candidate)) return false;
  const keys = liveKeys.map((key) => {
    const item = key.split("\u0000");
    return { workspace: item[0] ?? "", run: item[1] ?? "", profile: item[2] ?? "" };
  });
  if (keys.filter((key) => key.workspace === workspace).length >= quotas.workspace) return false;
  if (new Set(keys.filter((key) => key.run === run).map((key) => key.profile)).size >= quotas.run) return false;
  if (keys.filter((key) => key.profile === profile).length >= quotas.profile) return false;
  return true;
}

function runFailure(input: WorkflowRunInput, startedAt: number | undefined, now: number, records: readonly NodeRecord[]): WorkflowFailure | null {
  const limits = input.graph.limits ?? {};
  if (limits.max_run_minutes !== undefined) {
    const deadline = (startedAt ?? input.createdAt) + limits.max_run_minutes * 60_000;
    if (now > deadline) {
      return { code: "workflow_run_timeout", message: "workflow run exceeded max_run_minutes" };
    }
  }
  if (limits.max_total_tokens !== undefined) {
    const used = records.reduce((sum, { record }) => sum + usageTokens(nodePayload(record)?.usage ?? null), 0);
    if (used > limits.max_total_tokens) {
      return {
        code: "workflow_token_budget_exceeded",
        message: `workflow consumed ${used} tokens, above max_total_tokens=${limits.max_total_tokens}`,
      };
    }
  }
  return null;
}

function terminalFailure(code: string, message: string): NextTaskState<WorkflowRunCheckpoint, WorkflowRunResult> {
  const failure = { code, message };
  return {
    status: "terminal",
    outcome: { status: "failed", error: { message, detail: { code } }, result: { outputs: {}, failure } },
  };
}

/** 组装节点输入：入口节点额外接受 `business_context`；其余按 `input_contract` 从前驱输出取。 */
function nodeInputs(
  node: WorkflowNode,
  runInputs: Record<string, JsonValue>,
  predecessorOutputs: ReadonlyMap<string, JsonValue>,
  entry: boolean,
): Record<string, JsonValue> {
  const contract = new Set(node.input_contract ?? []);
  const values: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(runInputs)) {
    if (contract.has(name) || (entry && name === "business_context")) values[name] = value;
  }
  for (const output of predecessorOutputs.values()) {
    if (typeof output !== "object" || output === null || Array.isArray(output)) continue;
    for (const name of contract) {
      const value = output[name];
      if (value !== undefined) values[name] = value;
    }
  }
  return values;
}

/** 节点任务的 WorkInput：`args` 里带节点定义与组装好的输入，执行器只依赖它。 */
function nodeWorkInput(options: {
  runId: number;
  workspaceId: string;
  profileId: string;
  node: WorkflowNode;
  inputs: Record<string, JsonValue>;
  iteration: number;
  attempt: number;
  /** 发起运行的会话（运行任务所属的会话）。 */
  conversationId: number;
  now: number;
}): WorkInput {
  // 节点定义来自持久化的工作流版本，输入是纯 JSON；pi-durable 只负责序列化。
  const args = {
    runId: options.runId,
    workspaceId: options.workspaceId,
    profileId: options.profileId,
    node: options.node,
    inputs: options.inputs,
    iteration: options.iteration,
    attempt: options.attempt,
    conversationId: options.conversationId,
  } as unknown as JsonValue;
  return {
    kind: options.node.node_id,
    label: options.node.node_id,
    createdAt: options.now,
    replay: options.node.replay ?? "safe",
    idempotencyKey: `workflow:${options.runId}:${options.node.node_id}:${options.iteration}:${options.attempt}`,
    args,
  };
}

export type WorkflowRunTaskOptions = {
  quotas: WorkflowQuotas;
  /** 节点任务定义；run task 用它创建子任务，并按它的名字读记录。 */
  nodeTask: Task<WorkInput, WorkCheckpoint, WorkResult, object>;
  /** 门任务定义：运行只有待批审批时等它，人做出决定后它落定、唤醒运行。 */
  gateTask: Task<WorkInput, WorkCheckpoint, WorkResult, object>;
};

export function createWorkflowRunTask(options: WorkflowRunTaskOptions): Task<WorkflowRunInput, WorkflowRunCheckpoint, WorkflowRunResult, object> {
  const nodeKind = options.nodeTask.definition.name;

  return defineTask<WorkflowRunInput, WorkflowRunCheckpoint, WorkflowRunResult>({
    name: "datawhisper.workflow_run",
    version: 1,
    initial: () => ({ phase: "schedule" }),
    phases: {
      schedule: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const input = task.input;
          const graph = input.graph;
          const index = await tx.doc(WORKFLOW_RUN_INDEX, String(task.id), null);
          const skipped = new Set(index.skipped);

          // ── 读：本 run 的节点记录（索引是唯一来源，避免全库扫描历史） ─────────────────────
          const records: NodeRecord[] = [];
          const missingRefs: number[] = [];
          for (const ref of index.nodes) {
            const record = await tx.task(ref.taskId as TaskId);
            if (record === undefined || record.kind !== nodeKind || record.owner !== task.id) {
              missingRefs.push(ref.taskId);
              continue;
            }
            records.push({ ref, record });
          }
          // 旧实现把「绑定 Job 丢失」判为节点失败；这里没有可写回的节点记录，直接让运行失败。
          if (missingRefs.length > 0) {
            return terminalFailure(
              "workflow_node_record_missing",
              `workflow node task missing: ${missingRefs.join(", ")}`,
            );
          }
          const latest = new Map<string, NodeRecord>();
          for (const item of records) {
            const currentLatest = latest.get(item.ref.nodeId);
            if (
              currentLatest === undefined ||
              item.ref.iteration > currentLatest.ref.iteration ||
              (item.ref.iteration === currentLatest.ref.iteration &&
                (item.ref.attempt > currentLatest.ref.attempt ||
                  (item.ref.attempt === currentLatest.ref.attempt && item.ref.taskId > currentLatest.ref.taskId)))
            ) {
              latest.set(item.ref.nodeId, item);
            }
          }
          const statuses = new Map<string, WorkflowNodeStatus>();
          const outputs = new Map<string, JsonValue>();
          const iterations = new Map(Object.entries(index.iterations ?? {}));
          const revisions = new Map(Object.entries(index.revisions ?? {}));
          const requiredIteration = (nodeId: string): number => iterations.get(nodeId) ?? 1;
          for (const [nodeId, item] of latest) {
            // 已经被打回、进入下一轮的节点：上一轮的状态与输出不再算数。
            if (item.ref.iteration < requiredIteration(nodeId)) continue;
            statuses.set(nodeId, workflowNodeStatus(item.record));
            const payload = nodePayload(item.record);
            if (payload !== undefined) outputs.set(nodeId, payload.output);
          }
          // 手动重试沿用的输出：这个节点没有自己的记录、也没有被打回重开，就当作已经成功。
          for (const [nodeId, output] of Object.entries(input.seed ?? {})) {
            if (latest.has(nodeId) || requiredIteration(nodeId) > 1) continue;
            statuses.set(nodeId, "succeeded");
            outputs.set(nodeId, output);
          }

          // ── verifier 打回：decision=rework 时重开「打回目标 → verifier」这一段，修改意见交给目标节点 ──
          // 没有 retry_loop 出边的 verifier 只是把 decision 交给下游（比如条件边），不会触发重做。
          for (const node of graph.nodes) {
            if (node.type !== "verifier" || statuses.get(node.node_id) !== "succeeded") continue;
            const output = outputs.get(node.node_id);
            if (typeof output !== "object" || output === null || Array.isArray(output) || output.decision !== "rework") continue;
            const targets = reworkTargets(graph, node.node_id);
            if (targets.length === 0) continue;
            const current = requiredIteration(node.node_id);
            const limit = reworkLimit(graph, node.node_id);
            if (current >= limit) {
              return terminalFailure(
                "workflow_iteration_limit_reached",
                `verifier ${node.node_id} still asked for rework after ${current} iteration(s); the limit is ${limit}`,
              );
            }
            for (const id of reworkNodes(graph, node.node_id)) {
              iterations.set(id, current + 1);
              statuses.delete(id);
              outputs.delete(id);
              skipped.delete(id);
            }
            const feedback = reworkFeedback(output);
            for (const target of targets) revisions.set(target, feedback);
          }

          // ── 审批：待批的节点对下游表现为 waiting_approval；已有决定的按决定落地 ─────────────────
          const mode = runMode(graph);
          const approvals: WorkflowApproval[] = (index.approvals ?? []).map((item) => ({ ...item }));
          let pendingApprovals = 0;
          for (const node of graph.nodes) {
            const item = latest.get(node.node_id);
            if (item === undefined || item.ref.iteration < requiredIteration(node.node_id)) continue;
            const output = outputs.get(node.node_id);
            const kind = approvalKind(graph, node, mode, statuses.get(node.node_id), item, output);
            if (kind === undefined) continue;
            if (kind === "stop") {
              return terminalFailure(
                "workflow_escalation_required",
                `verifier ${node.node_id} escalated, and a full_auto run has nobody to escalate to`,
              );
            }
            let approval = approvals.find((existing) => existing.nodeRunId === item.ref.taskId);
            if (approval === undefined) {
              approval = {
                id: `ap_${approvals.length + 1}`,
                nodeId: node.node_id,
                nodeRunId: item.ref.taskId,
                iteration: item.ref.iteration,
                kind,
                reason: approvalReason(kind, node.node_id),
                output: kind === "exception_review" ? nodeError(item.record) : (output ?? null),
                comment: "",
              };
              approvals.push(approval);
            }
            if (approval.decision === undefined) {
              statuses.set(node.node_id, "waiting_approval");
              pendingApprovals += 1;
              continue;
            }
            if (approval.decision === "reject_and_stop") {
              const why = approval.comment === "" ? "" : `: ${approval.comment}`;
              return terminalFailure("workflow_approval_rejected", `approval for node ${node.node_id} was rejected${why}`);
            }
            if (approval.decision === "approve_with_changes" && typeof output === "object" && output !== null && !Array.isArray(output)) {
              outputs.set(node.node_id, { ...output, ...approval.changes });
            }
            if (approval.decision === "reject_and_retry") {
              // 人要求重做：和 verifier 打回同一套机制。escalation 重开整段环，其余只重做这个节点。
              const current = requiredIteration(node.node_id);
              const restart = approval.kind === "escalation" ? reworkNodes(graph, node.node_id) : [node.node_id];
              for (const id of restart) {
                iterations.set(id, current + 1);
                statuses.delete(id);
                outputs.delete(id);
                skipped.delete(id);
              }
              const targets = approval.kind === "escalation" ? reworkTargets(graph, node.node_id) : [];
              const feedback = approval.comment === "" ? "A reviewer asked for a redo without further comments." : approval.comment;
              for (const target of targets.length > 0 ? targets : [node.node_id]) revisions.set(target, feedback);
            }
          }

          // 配额要看到所有 run 的活节点，必须在任何写之前读完。
          const liveKeys = await scanLiveNodeKeys(tx);
          // 门任务记录同样要在任何写之前读。
          const gateRecord = index.gate === undefined ? undefined : await tx.task(index.gate as TaskId);

          // ── 运行级限制：超时、token 预算（旧 `_expire_timed_out_run` / `_expire_token_budget`） ──
          const failure = runFailure(input, task.startedAt, runtime.now(), records);
          if (failure !== null) return terminalFailure(failure.code, failure.message);

          const nodesById = new Map(graph.nodes.map((node) => [node.node_id, node]));
          const nextNodes: WorkflowNodeRef[] = [...index.nodes];
          let active = records.filter(({ record }) => isLive(record)).length;
          const liveIds: number[] = records.filter(({ record }) => isLive(record)).map(({ ref }) => ref.taskId);

          // ── 重试：失败的节点在 max_attempts 内再开一次 attempt ─────────────────────────
          for (const [nodeId, item] of latest) {
            const node = nodesById.get(nodeId);
            if (node === undefined) continue;
            // 已经被打回的节点：这是上一轮的记录，失败了也不再重试它。
            if (item.ref.iteration < requiredIteration(nodeId)) continue;
            if (workflowNodeStatus(item.record) !== "failed") continue;
            if (item.ref.attempt >= nodeMaxAttempts(node)) continue;
            const ref = { nodeId, iteration: item.ref.iteration, attempt: item.ref.attempt + 1, taskId: 0 };
            const previous = (item.record.input as unknown as { args?: { inputs?: Record<string, JsonValue> } }).args ?? {};
            const taskId = await tx.createTask(
              options.nodeTask,
              nodeWorkInput({
                runId: task.id,
                workspaceId: input.workspaceId,
                profileId: profileKey(node),
                node,
                inputs: previous.inputs ?? {},
                iteration: ref.iteration,
                attempt: ref.attempt,
                conversationId: task.conversationId as unknown as number,
                now: runtime.now(),
              }),
              { ownership: { kind: "task", taskId: task.id } },
            );
            const created = { ...ref, taskId };
            nextNodes.push(created);
            liveIds.push(taskId);
            // 新 attempt 在跑：下游看到的是「未终态」，不会被立刻跳过；本轮也不再派发它。
            statuses.set(nodeId, "queued");
            liveKeys.push(quotaKey(input.workspaceId, task.id, profileKey(node)));
            active += 1;
          }

          // ── 就绪/跳过 ───────────────────────────────────────────────────────────────
          const plan = planReadiness({ graph, statuses, outputs, skipped });
          for (const nodeId of plan.skipped) skipped.add(nodeId);

          // ── 派发：并发上限 + 四类配额 ────────────────────────────────────────────────
          const maxConcurrent = graph.limits?.max_concurrent_node_runs;
          for (const nodeId of plan.ready) {
            if (maxConcurrent !== undefined && active >= maxConcurrent) break;
            const node = nodesById.get(nodeId);
            if (node === undefined) continue;
            const profileId = profileKey(node);
            const candidate = quotaKey(input.workspaceId, task.id, profileId);
            if (!quotaAllows(liveKeys, candidate, options.quotas)) continue;

            const predecessorOutputs = new Map<string, JsonValue>();
            for (const source of predecessors(graph).get(nodeId) ?? []) {
              const output = outputs.get(source);
              if (output !== undefined) predecessorOutputs.set(source, output);
            }
            const inputs = nodeInputs(
              node,
              input.inputs,
              predecessorOutputs,
              (predecessors(graph).get(nodeId) ?? []).length === 0,
            );
            // 打回后的目标节点拿到修改意见（图里要在 input_contract 里声明 revision_request）。
            const revision = revisions.get(nodeId);
            if (revision !== undefined && (node.input_contract ?? []).includes("revision_request")) {
              inputs.revision_request = revision;
            }
            const iteration = requiredIteration(nodeId);
            const ref = { nodeId, iteration, attempt: 1, taskId: 0 };
            const taskId = await tx.createTask(
              options.nodeTask,
              nodeWorkInput({
                runId: task.id,
                workspaceId: input.workspaceId,
                profileId,
                node,
                inputs,
                iteration,
                attempt: 1,
                conversationId: task.conversationId as unknown as number,
                now: runtime.now(),
              }),
              { ownership: { kind: "task", taskId: task.id } },
            );
            const created = { ...ref, taskId };
            nextNodes.push(created);
            liveIds.push(taskId);
            liveKeys.push(candidate);
            active += 1;
          }

          index.nodes = nextNodes;
          index.skipped = [...skipped];
          index.iterations = Object.fromEntries(iterations);
          index.revisions = Object.fromEntries(revisions);
          index.approvals = approvals;
          const checkpoint: WorkflowRunCheckpoint = { phase: "schedule", pendingApprovals };

          // ── 还有活节点：等最老的一个结束，再重新调度 ─────────────────────────────────
          if (liveIds.length > 0) {
            liveIds.sort((a, b) => a - b);
            return {
              status: "waiting",
              checkpoint,
              on: [liveIds[0] as TaskId],
              policy: "allSettled",
            };
          }

          // ── 只剩待批审批：等门任务；人做出决定后它落定，运行重新调度 ─────────────────────
          // `waiting` 只能等任务，所以人的决定要有一个任务来承载。门任务活着就复用，否则按当前的决定数新建。
          if (pendingApprovals > 0) {
            const reusable =
              gateRecord !== undefined &&
              gateRecord.kind === options.gateTask.definition.name &&
              gateRecord.owner === task.id &&
              isLive(gateRecord);
            const gateId =
              reusable && index.gate !== undefined
                ? index.gate
                : await tx.createTask(options.gateTask, gateWorkInput(task.id, index.decisions ?? 0, runtime.now()), {
                    ownership: { kind: "task", taskId: task.id },
                  });
            index.gate = gateId;
            return { status: "waiting", checkpoint, on: [gateId as TaskId], policy: "allSettled" };
          }

          // ── 结算（旧 `_settle_run`） ─────────────────────────────────────────────────
          const allStatuses = graph.nodes.map(
            (node) => statuses.get(node.node_id) ?? (skipped.has(node.node_id) ? "skipped" : "pending"),
          );
          if (allStatuses.some((status) => status === "failed" || status === "rejected")) {
            return terminalFailure("workflow_node_failed", "one or more workflow nodes failed");
          }
          if (allStatuses.some((status) => status === "canceled")) {
            return { status: "terminal", outcome: { status: "aborted", reason: "canceled" } };
          }
          if (!allStatuses.every((status) => isTerminalNodeStatus(status))) {
            return terminalFailure("workflow_scheduler_stalled", "workflow scheduler made no progress");
          }
          const finalOutputs = collectOutputs(graph, outputs);
          const required = graph.output_schema?.required ?? [];
          const missing = required.filter((name) => !(name in finalOutputs)).sort();
          if (missing.length > 0) {
            return terminalFailure(
              "workflow_final_output_missing",
              `workflow final outputs missing: ${missing.join(", ")}`,
            );
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: { outputs: finalOutputs, failure: null } },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", reason: "canceled" } }),
        context,
      );
    },
  });
}

/** 运行详情的节点视图：每个图节点取最新尝试；没派发过的显示 pending/skipped。 */
export function nodeViews(
  graph: WorkflowRunInput["graph"],
  refs: readonly WorkflowNodeRef[],
  records: ReadonlyMap<number, AnyTaskRecord>,
  skipped: ReadonlySet<string>,
  approvals: readonly WorkflowApproval[],
  seed: Readonly<Record<string, JsonValue>>,
): WorkflowNodeView[] {
  const byNode = new Map<string, WorkflowNodeRef[]>();
  for (const ref of refs) {
    const list = byNode.get(ref.nodeId) ?? [];
    list.push(ref);
    byNode.set(ref.nodeId, list);
  }
  const views: WorkflowNodeView[] = [];
  for (const node of graph.nodes) {
    const attempts = (byNode.get(node.node_id) ?? []).sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt || a.taskId - b.taskId);
    if (attempts.length === 0) {
      const seeded = seed[node.node_id];
      views.push({
        nodeId: node.node_id,
        nodeRunId: null,
        status: seeded !== undefined ? "succeeded" : skipped.has(node.node_id) ? "skipped" : "pending",
        iteration: 1,
        attempt: 1,
        agentProfileId: profileKey(node),
        input: {},
        output: seeded ?? null,
        error: "",
        usage: null,
        startedAt: null,
        endedAt: null,
        reused: seeded !== undefined,
      });
      continue;
    }
    for (const ref of attempts) {
      const record = records.get(ref.taskId);
      if (record === undefined) continue;
      const payload = nodePayload(record);
      const input = (record.input as unknown as { args?: { inputs?: Record<string, JsonValue> } }).args ?? {};
      const approval = approvals.find((item) => item.nodeRunId === ref.taskId);
      // 人改过的键盖在原输出上；待批的节点对外显示 waiting_approval。
      const original = payload?.output ?? null;
      const output =
        approval?.decision === "approve_with_changes" && typeof original === "object" && original !== null && !Array.isArray(original)
          ? { ...original, ...approval.changes }
          : original;
      views.push({
        nodeId: ref.nodeId,
        nodeRunId: ref.taskId,
        status: approval !== undefined && approval.decision === undefined ? "waiting_approval" : workflowNodeStatus(record),
        iteration: ref.iteration,
        attempt: ref.attempt,
        agentProfileId: profileKey(node),
        input: input.inputs ?? {},
        output,
        error: nodeError(record),
        usage: payload?.usage ?? null,
        startedAt: record.startedAt === undefined ? null : new Date(record.startedAt).toISOString(),
        endedAt: record.endedAt === undefined ? null : new Date(record.endedAt).toISOString(),
        reused: false,
      });
    }
  }
  return views;
}

/** 供 service 读取运行索引。 */
export async function readRunIndex(harness: Harness, id: number, context: Context): Promise<WorkflowRunIndex> {
  const value = await harness.snapshot(WORKFLOW_RUN_INDEX, String(id), context);
  if (value === undefined) return { nodes: [], skipped: [], approvals: [], decisions: 0 };
  return {
    nodes: [...value.nodes],
    skipped: [...value.skipped],
    iterations: { ...value.iterations },
    revisions: { ...value.revisions },
    approvals: (value.approvals ?? []).map((approval) => ({ ...approval })),
    decisions: value.decisions ?? 0,
    ...(value.gate === undefined ? {} : { gate: value.gate }),
  };
}

/** 打回时交给目标节点的修改意见：reviewer 的 issues 与 evidence 原文，让它知道要改什么。 */
function reworkFeedback(output: Record<string, JsonValue>): string {
  const text = (value: JsonValue | undefined): string => (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value));
  const lines = ["The independent reviewer asked for rework. Address these issues:", text(output.issues)];
  const evidence = text(output.evidence);
  if (evidence !== "") lines.push("Evidence:", evidence);
  return lines.join("\n");
}


/**
 * 节点这一轮结果要不要人来决定。返回 `"stop"` 表示 verifier 要求升级给人，但运行是 full_auto，没有人可升级。
 * - `exception_review` 模式：节点用完重试仍失败；
 * - verifier 判了 `escalate`：交给人；
 * - `key_approval` 模式：带 `approval` 出边的节点成功后放行前要人确认。verifier 没判 pass 时不能放行，也升级给人。
 */
function approvalKind(
  graph: WorkflowGraph,
  node: WorkflowNode,
  mode: "full_auto" | "key_approval" | "exception_review",
  status: WorkflowNodeStatus | undefined,
  item: NodeRecord,
  output: JsonValue | undefined,
): ApprovalKind | "stop" | undefined {
  if (status === "failed") {
    return mode === "exception_review" && item.ref.attempt >= nodeMaxAttempts(node) ? "exception_review" : undefined;
  }
  if (status !== "succeeded") return undefined;
  const decision =
    node.type === "verifier" && typeof output === "object" && output !== null && !Array.isArray(output) ? output.decision : undefined;
  if (decision === "escalate") return mode === "full_auto" ? "stop" : "escalation";
  if (mode !== "key_approval" || !hasApprovalEdge(graph, node.node_id)) return undefined;
  return node.type === "verifier" && decision !== "pass" ? "escalation" : "key_approval";
}

function approvalReason(kind: ApprovalKind, nodeId: string): string {
  switch (kind) {
    case "key_approval":
      return `Node ${nodeId} finished; its output needs approval before downstream nodes run.`;
    case "exception_review":
      return `Node ${nodeId} failed after all attempts; decide whether to redo it or stop the run.`;
    case "escalation":
      return `The reviewer at node ${nodeId} could not clear the output; decide whether to redo it with your comments or stop the run.`;
  }
}

/** 门任务的 WorkInput：只带运行 id 与「在第几个决定之后创建」，等到有更新的决定就落定。 */
function gateWorkInput(runId: number, since: number, now: number): WorkInput {
  return {
    kind: "workflow_gate",
    label: `approval wait for run ${runId}`,
    createdAt: now,
    replay: "safe",
    idempotencyKey: `workflow-gate:${runId}:${since}`,
    args: { runId, since },
  };
}
