/**
 * jobs 查询面（P5.1）：一次长任务就是一个 `datawhisper.job` durable task。
 *
 * 旧实现的 `JobsStore` 把状态、进度、事件写在 `outputs/jobs/jobs.db`，线程池里的工作线程
 * 消失后只能标 failed。这里不再有第二份状态：任务记录本身就是 job 记录，
 * `list`/`get` 从 pi-durable 存储里读，崩溃后由 `harness.resume()` 接着跑。
 *
 * 记录字段对照旧 `data/jobs_store.py`：
 *
 *   id            → TaskId（数字；旧的是 12 位十六进制串）
 *   session_id    → conversationId
 *   type/label    → input.kind / input.label
 *   parent_id     → owner（父 task；由工具/工作流节点创建时存在）
 *   status        → 由 task 状态 + outcome 映射（见 `jobStatus`）
 *   progress/message → checkpoint（运行中）或 outcome（终态）
 *   result/error  → outcome.result.value / outcome.error.message
 *   created_at    → input.createdAt
 *   started_at/finished_at → task.startedAt / task.endedAt
 *   updated_at    → 最后一条进度提交时间
 *
 * 旧的事件流（job_created/progress/done/...，供 SSE 重放）不在这里重建：新协议里界面订阅
 * 会话视图，job 的进度就是任务记录；需要历史事件时由 P6 的 API 层另做投影。
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
import { appError, invalidParams } from "../ipc/errors.ts";
import {
  createWorkTask,
  DEFAULT_PROGRESS_INTERVAL_MS,
  type WorkCheckpoint,
  type WorkExecutorRegistry,
  type WorkInput,
  type WorkResult,
  type WorkReplay,
} from "./work-task.ts";

/** 任务名；查询面按它过滤，不要改成会与其它 task 冲突的名字。 */
export const JOB_TASK_KIND = "datawhisper.job";

/** 与旧 `data/jobs_store.py` 的状态集合一致（`created` 没有单独一步，创建即排队）。 */
export type JobStatus = "queued" | "running" | "canceling" | "succeeded" | "failed" | "canceled";

export type JobView = {
  /** durable task id。 */
  id: number;
  /** 旧 `job_type`。 */
  type: string;
  label: string;
  status: JobStatus;
  /** 0-100。 */
  progress: number;
  message: string;
  result: JsonValue | null;
  error: string | null;
  conversationId: number;
  /** 创建它的 task（工具调用或工作流节点）；没有时为 null。 */
  parentId: number | null;
  /** ISO 8601（UTC）。 */
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  /** 崩溃后被重跑的次数。 */
  restarts: number;
};

export type JobStartRequest = {
  conversationId: number;
  kind: string;
  label?: string;
  args: JsonValue;
  replay?: WorkReplay;
  idempotencyKey?: string;
};

export type JobListQuery = {
  conversationId?: number;
  type?: string;
  status?: JobStatus;
  /** 只列未结束的任务（旧 `active_only`）。 */
  activeOnly?: boolean;
  limit?: number;
};

export type JobsOptions = {
  harness: Harness;
  context: Context;
  executors: WorkExecutorRegistry;
  /** 进度提交间隔（毫秒）；测试传 0 配合注入的时钟。 */
  progressIntervalMs?: number;
  /** 创建时间用的时钟；默认 `Date.now`。 */
  now?: () => number;
};

export type Jobs = {
  /** 供工具/工作流用 `api.createTask(jobs.task, …)` 创建子任务。 */
  readonly task: Task<WorkInput, WorkCheckpoint, WorkResult, object>;
  start(request: JobStartRequest): Promise<{ id: number }>;
  /** 显式取消：提交 abort 标记并等 abort 处理器落定。 */
  cancel(id: number): Promise<JobView>;
  list(query?: JobListQuery): Promise<{ jobs: JobView[] }>;
  get(id: number): Promise<JobView>;
  /** 等终态并返回记录（测试与工具调用用）。 */
  wait(id: number): Promise<JobView>;
};

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

const SCAN_PAGE = 256;
/** 过滤后仍不足 `limit` 时的扫描上限，避免一次查询扫穿整个历史。 */
const SCAN_CAP = 4096;
const DEFAULT_LIST_LIMIT = 100;

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

/** IPC 传来的 id 已经按正整数校验；TaskId 是数字的 branded 类型，pi-durable 未导出构造器。 */
function taskId(id: number): TaskId<JsonValue> {
  return id as TaskId<JsonValue>;
}

function asWorkInput(record: AnyTaskRecord): WorkInput {
  // 记录由本模块创建；`kind` 已经由调用方校验过，这里只把存储里的 JSON 还原成输入类型。
  return record.input as unknown as WorkInput;
}

function terminalOutcome(record: AnyTaskRecord): Extract<AnyTaskRecord["state"], { status: "terminal" }>["outcome"] | undefined {
  return record.state.status === "terminal" ? record.state.outcome : undefined;
}

/** 终态里存的 `WorkResult` 是 JSON；这里校验形状，避免把损坏的记录当成结果。 */
function asWorkResult(value: JsonValue | undefined): WorkResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("progress" in value) || typeof value.progress !== "number") return undefined;
  const message = "message" in value && typeof value.message === "string" ? value.message : "";
  const payload = "value" in value ? value.value : null;
  return { value: payload ?? null, progress: value.progress, message };
}

function outcomeResult(record: AnyTaskRecord): WorkResult | undefined {
  const outcome = terminalOutcome(record);
  if (outcome === undefined) return undefined;
  if (outcome.status === "completed" || outcome.status === "aborted") return asWorkResult(outcome.result);
  return undefined;
}

function outcomeDetail(record: AnyTaskRecord): { progress?: number; message?: string; code?: string } {
  const outcome = terminalOutcome(record);
  if (outcome?.status !== "failed") return {};
  const detail = outcome.error.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return {};
  const progress = "progress" in detail && typeof detail.progress === "number" ? detail.progress : undefined;
  const message = "message" in detail && typeof detail.message === "string" ? detail.message : undefined;
  const code = "code" in detail && typeof detail.code === "string" ? detail.code : undefined;
  return { progress, message, code };
}

/** 任务状态 → 旧 job 状态。 */
export function jobStatus(record: AnyTaskRecord): JobStatus {
  if (record.abortRequested && record.state.status !== "terminal") return "canceling";
  switch (record.state.status) {
    case "pending":
      return "queued";
    case "running":
    case "waiting":
    case "sleeping":
    case "completing":
      return "running";
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

function liveCheckpoint(record: AnyTaskRecord): WorkCheckpoint | undefined {
  if (record.state.status === "terminal" || record.state.status === "completing") return undefined;
  const value = record.state.checkpoint;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("progress" in value) || typeof value.progress !== "number") return undefined;
  if (!("starts" in value) || typeof value.starts !== "number") return undefined;
  return {
    phase: "run",
    starts: value.starts,
    started: "started" in value && value.started === true,
    progress: value.progress,
    message: "message" in value && typeof value.message === "string" ? value.message : "",
    updatedAt: "updatedAt" in value && typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

/** 把任务记录投影成查询面的一条 job。 */
export function jobView(record: AnyTaskRecord): JobView {
  const input = asWorkInput(record);
  const status = jobStatus(record);
  const checkpoint = liveCheckpoint(record);
  const result = outcomeResult(record);
  const detail = outcomeDetail(record);
  const outcome = terminalOutcome(record);

  const progress =
    status === "succeeded"
      ? 100
      : checkpoint?.progress ?? result?.progress ?? detail.progress ?? 0;
  const message = checkpoint?.message ?? result?.message ?? detail.message ?? "";
  const error =
    outcome === undefined
      ? null
      : outcome.status === "failed"
        ? outcome.error.message
        : outcome.status === "faulted" || outcome.status === "orphaned"
          ? outcome.status === "orphaned"
            ? outcome.reason
            : outcome.error.message
          : null;

  // 终态用结束时间；运行中用最后一次进度提交；排队中退回创建时间。
  const updated =
    checkpoint !== undefined && checkpoint.updatedAt > 0
      ? checkpoint.updatedAt
      : record.endedAt ?? record.startedAt ?? input.createdAt;
  return {
    id: record.id,
    type: input.kind,
    label: input.label,
    status,
    progress,
    message,
    result: result?.value ?? null,
    error,
    conversationId: record.conversationId,
    parentId: record.owner ?? null,
    createdAt: iso(input.createdAt) ?? new Date(0).toISOString(),
    startedAt: iso(record.startedAt),
    updatedAt: iso(updated) ?? new Date(0).toISOString(),
    finishedAt: iso(record.endedAt),
    restarts: record.restarts ?? 0,
  };
}

function matchesQuery(record: AnyTaskRecord, query: JobListQuery): boolean {
  const input = asWorkInput(record);
  if (query.conversationId !== undefined && record.conversationId !== query.conversationId) return false;
  if (query.type !== undefined && input.kind !== query.type) return false;
  const status = jobStatus(record);
  if (query.status !== undefined && status !== query.status) return false;
  if (query.activeOnly === true && status !== "queued" && status !== "running" && status !== "canceling") return false;
  return true;
}

/** 安装到注册表的扩展：task 必须按名字可见，重启后 Harness 才能恢复它。 */
export function jobsExtension(jobs: Jobs): Extension {
  return defineExtension({ name: "datawhisper-jobs", tasks: [jobs.task] });
}

export function createJobs(options: JobsOptions): Jobs {
  const { harness, context, executors } = options;
  const now = options.now ?? (() => Date.now());
  const task = createWorkTask({
    name: JOB_TASK_KIND,
    execute: executors.dispatch(),
    progressIntervalMs: options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
  });

  async function read(id: number): Promise<AnyTaskRecord> {
    const record = await harness.getTask(taskId(id), context);
    if (record === undefined || record.kind !== JOB_TASK_KIND) {
      throw appError("not_found", `job not found: ${id}`);
    }
    return record;
  }

  return {
    task,

    async start(request) {
      if (typeof request.kind !== "string" || request.kind === "") throw invalidParams("job kind is required");
      if (!Number.isInteger(request.conversationId) || request.conversationId <= 0) {
        throw invalidParams("job conversationId must be a positive integer");
      }
      const input: WorkInput = {
        kind: request.kind,
        label: request.label ?? "",
        createdAt: now(),
        replay: request.replay ?? "safe",
        idempotencyKey: request.idempotencyKey ?? `job:${crypto.randomUUID()}`,
        args: request.args,
      };
      const id = await harness.commit(
        (tx) =>
          tx.createTask(task, input, {
            ownership: { kind: "conversation" },
            // IPC 的会话 id 是正整数；ConversationId 是数字的 branded 类型（同上）。
            conversationId: request.conversationId as ConversationId,
          }),
        context,
      );
      return { id };
    },

    async cancel(id) {
      await read(id);
      const result = await harness.abortTask(taskId(id), context);
      if (result === "terminal") return jobView(await read(id));
      return jobView(await harness.waitForTask(taskId(id), context));
    },

    async list(query = {}) {
      const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIST_LIMIT, 500));
      const records = await harness.commit(async (tx) => {
        const found: AnyTaskRecord[] = [];
        let cursor;
        let scanned = 0;
        do {
          const page = await tx.scanTasks({ kind: JOB_TASK_KIND, order: "descending" }, SCAN_PAGE, cursor);
          for (const record of page.items) {
            scanned += 1;
            if (matchesQuery(record, query)) found.push(record);
            if (found.length >= limit) return found;
          }
          cursor = page.next;
        } while (cursor !== undefined && scanned < SCAN_CAP);
        return found;
      }, context);
      return { jobs: records.map(jobView) };
    },

    async get(id) {
      return jobView(await read(id));
    },

    async wait(id) {
      await read(id);
      return jobView(await harness.waitForTask(taskId(id), context));
    },
  };
}
