/**
 * 长任务的 durable 基座：jobs（P5.1）与 workflow 节点（P5.2）共用同一个 task 定义工厂。
 *
 * 旧实现是 `agent/jobs.py` 的线程池 + `data/jobs_store.py` 的 SQLite 表：进程退出后线程消失，
 * 重启时只能把未完成的 job 标成 failed。这里把一次执行建模为 pi-durable 的 task：
 *
 * - 进度写进 checkpoint（节流后提交），崩溃后从最后一次提交的进度继续展示；
 * - 取消走 `abortTask`/会话中止 → `runtime.signal` 传进执行器（compute 的 `$/cancel` 也用它），
 *   abort 处理器负责落定 `aborted`；
 * - 崩溃重跑由 `replay` 决定：`safe` 重跑执行器，`unsafe` 直接落定 failed（`interrupted`），
 *   已经提交的副作用不会被第二次执行；
 * - 幂等键 `idempotencyKey` 交给执行器（例如 compute 的 `taskId`），重跑时由执行器去重。
 *
 * 终态记录（进度、最后一条消息、结果）放在 outcome 里，因为 pi-durable 的终态 task 不保留
 * checkpoint（`TaskRecord` 的 `checkpoint?: never`），否则查询面读不到已结束任务的进度。
 */

import type { JsonValue } from "@earendil-works/chord";
import { defineTask, type Task } from "@earendil-works/pi-durable";

export type WorkReplay = "safe" | "unsafe";

/** task 输入：全部是 JSON，崩溃后重新构造执行器时只依赖它。 */
export type WorkInput = {
  /** 执行器类型；job 用旧的 `job_type` 语义，工作流节点固定为 `workflow_node`。 */
  kind: string;
  /** 展示用标签（旧 job 的 `label`）。 */
  label: string;
  /** 创建时刻（毫秒，来自 Harness 时钟）。 */
  createdAt: number;
  /** 崩溃后的重跑策略；默认由创建方决定（job 用 safe，节点用 safe，副作用节点可显式 unsafe）。 */
  replay: WorkReplay;
  /** 幂等键：同一个键的重复执行由执行器保证不重复副作用。 */
  idempotencyKey: string;
  /** 执行参数。 */
  args: JsonValue;
};

export type WorkCheckpoint = {
  phase: "run";
  /** 执行器已经启动过几次（崩溃后的重跑也计入）。 */
  starts: number;
  /** 是否已经启动过；`replay: "unsafe"` 用它判断「可能已有副作用」。 */
  started: boolean;
  /** 最近一次已提交的进度（0-100）。 */
  progress: number;
  /** 最近一次已提交的进度消息。 */
  message: string;
  /** 最近一次进度提交的 Harness 时钟（毫秒），用于节流。 */
  updatedAt: number;
};

/** 终态也要保留的字段：终态 task 没有 checkpoint，进度与消息只能放进 outcome。 */
export type WorkResult = {
  value: JsonValue;
  progress: number;
  message: string;
};

export type WorkProgress = (percent: number, message?: string) => void;

/** 执行器拿到的上下文；`signal` 是任务的中止信号（取消、会话中止、Harness 关闭都会触发）。 */
export type WorkContext = {
  readonly taskId: number;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly now: () => number;
  progress: WorkProgress;
  /** 等已排队的进度提交落地；取消或结束前调用，避免吞掉最后一次进度。 */
  flush(): Promise<void>;
};

export type WorkExecute = (input: WorkInput, context: WorkContext) => Promise<JsonValue>;

export type WorkExecutors = Map<string, WorkExecute>;

export type WorkTaskOptions = {
  /** 注册表里的 task 名（持久化在 `TaskRecord.kind`）。 */
  name: string;
  version?: number;
  execute: WorkExecute;
  /** 进度提交的最小间隔（毫秒）；0 表示每次变化都提交（测试用注入的时钟）。 */
  progressIntervalMs?: number;
};

/** `replay: "unsafe"` 的任务被重启打断后的固定错误文案（测试与 UI 都按它判断）。 */
export const INTERRUPTED_UNSAFE =
  "interrupted: the task was cut off before completion and replay=unsafe forbids rerunning it";

export const DEFAULT_PROGRESS_INTERVAL_MS = 100;

/** 旧 `agent/jobs.py` 的失败文案格式：`f"{type(exc).__name__}: {exc}"`。 */
export function formatWorkError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * 创建一个可持久化的执行任务。定义里不捕获 Harness，只捕获执行器：
 * 重启后由宿主用同一份定义重新打开 Harness，phase 从 checkpoint 重跑。
 */
export function createWorkTask(options: WorkTaskOptions): Task<WorkInput, WorkCheckpoint, WorkResult, object> {
  const interval = Math.max(0, options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  const execute = options.execute;

  return defineTask<WorkInput, WorkCheckpoint, WorkResult>({
    name: options.name,
    version: options.version ?? 1,
    initial: () => ({ phase: "run", starts: 0, started: false, progress: 0, message: "", updatedAt: 0 }),
    phases: {
      run: async (task, runtime, context) => {
        const checkpoint = task.state.checkpoint;
        const progressSnapshot = { progress: checkpoint.progress, message: checkpoint.message };

        // 上一次调用已经启动过执行器：unsafe 任务可能已经产生了副作用，不能重跑。
        if (checkpoint.started && task.input.replay === "unsafe") {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: INTERRUPTED_UNSAFE, detail: { code: "interrupted", ...progressSnapshot } },
              },
            }),
            context,
          );
          return;
        }

        const starts = checkpoint.starts + 1;
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              phase: "run",
              starts,
              started: true,
              progress: checkpoint.progress,
              message: checkpoint.message,
              updatedAt: runtime.now(),
            },
          }),
          context,
        );

        let lastProgress = checkpoint.progress;
        let lastMessage = checkpoint.message;
        let lastCommitAt = checkpoint.updatedAt;
        let closed = false;
        let queue: Promise<void> = Promise.resolve();

        const progress: WorkProgress = (percent, message = "") => {
          if (closed) return;
          const pct = clampPercent(percent);
          if (pct === lastProgress && message === lastMessage) return;
          const at = runtime.now();
          // 进度只影响展示：节流掉的变化不值得多一次持久化提交。
          if (interval > 0 && at - lastCommitAt < interval) return;
          lastProgress = pct;
          lastMessage = message;
          lastCommitAt = at;
          queue = queue
            .then(() =>
              runtime.commit(
                () => ({
                  status: "running",
                  checkpoint: {
                    phase: "run",
                    starts,
                    started: true,
                    progress: pct,
                    message,
                    updatedAt: at,
                  },
                }),
                context,
              ),
            )
            .catch(() => undefined);
        };

        const workContext: WorkContext = {
          taskId: task.id,
          idempotencyKey: task.input.idempotencyKey,
          signal: runtime.signal,
          now: () => runtime.now(),
          progress,
          flush: () => queue,
        };

        let value: JsonValue;
        try {
          value = await execute(task.input, workContext);
        } catch (error) {
          await queue;
          closed = true;
          // 中止是调用方的意图，不是任务失败：抛回给 Harness，让 abort 处理器落定 aborted。
          if (runtime.signal.aborted) throw error;
          const message = formatWorkError(error);
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: {
                  message,
                  detail: { code: "error", progress: lastProgress, message: lastMessage },
                },
              },
            }),
            context,
          );
          return;
        }

        await queue;
        closed = true;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { value: value ?? null, progress: lastProgress, message: lastMessage },
            },
          }),
          context,
        );
      },
    },
    abort: async (task, runtime, context) => {
      // 取消也要保留最后一次已提交的进度与消息（旧 store 的 mark_canceled 只改状态）。
      const checkpoint = task.state.checkpoint;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "aborted",
            reason: "canceled",
            result: { value: null, progress: checkpoint.progress, message: checkpoint.message },
          },
        }),
        context,
      );
    },
  });
}

/** 按 `kind` 分发的执行器注册表：job 的 `type` 与工作流节点的执行器都从这里取。 */
export class WorkExecutorRegistry {
  readonly #executors: WorkExecutors = new Map();

  register(kind: string, execute: WorkExecute): this {
    if (kind === "") throw new Error("work executor kind cannot be empty");
    this.#executors.set(kind, execute);
    return this;
  }

  has(kind: string): boolean {
    return this.#executors.has(kind);
  }

  get(kind: string): WorkExecute | undefined {
    return this.#executors.get(kind);
  }

  /** 供 `createWorkTask` 使用：未知类型是确定的失败，而不是崩溃。 */
  dispatch(): WorkExecute {
    return async (input, context) => {
      const execute = this.#executors.get(input.kind);
      if (execute === undefined) throw new Error(`unknown work kind: ${input.kind}`);
      return execute(input, context);
    };
  }
}
