/**
 * Synchronous hook engine (port of `agent/hooks/engine.py`).
 *
 * Python runs hooks on the caller's thread and only side effects (`async`, or fire-and-forget HTTP/command) go to a
 * 8-worker pool; a process-wide semaphore caps 32 background slots. The TS port keeps that shape: `runHooks` /
 * `runPreToolHooks` await each synchronous hook so the caller's ordering and results are identical, while background
 * work is handed to an injected {@link HookScheduler} (a microtask by default, a manual queue in tests) and a
 * {@link BackgroundQueue} that rejects beyond capacity with the same notification Python emits.
 *
 * Once semantics live in a process-local {@link OnceRegistry}: a reservation covers running *and* completed runs, so a
 * slow background hook cannot be scheduled twice, and completed keys are capped at 10 000 (FIFO eviction).
 */
import { pyHead, pyStrip, pyTruthy } from "../py-compat.ts";
import type { ActionResult, Hook, HookContext } from "./models.ts";
import { ToolRejectedError } from "./models.ts";
import { executeAction, type ExecutorDeps } from "./executors.ts";

export type OnceKey = [hookId: string, scopeKey: string];

/** Process-local, engine-independent reservation for `once` hooks. */
export class OnceRegistry {
  private readonly running = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly completedOrder: string[] = [];
  private readonly maxCompleted: number;

  constructor(maxCompleted = 10_000) {
    this.maxCompleted = Math.max(1, Math.trunc(maxCompleted));
  }

  reserve(hook: Hook, ctx: HookContext): OnceKey | null {
    if (!hook.once) return ["", ""];
    let scopeId: string;
    if (hook.onceScope === "turn") scopeId = ctx.turnId || ctx.sessionId || "anonymous";
    else if (hook.onceScope === "session") scopeId = ctx.sessionId || "anonymous";
    else scopeId = "global";
    const key = `${hook.id}\u0000${hook.onceScope}:${scopeId}`;
    if (this.running.has(key) || this.completed.has(key)) return null;
    this.running.add(key);
    return [hook.id, `${hook.onceScope}:${scopeId}`];
  }

  complete(key: OnceKey): void {
    if (key[0] === "") return;
    const id = `${key[0]}\u0000${key[1]}`;
    this.running.delete(id);
    this.completed.add(id);
    this.completedOrder.push(id);
    while (this.completedOrder.length > this.maxCompleted) {
      this.completed.delete(this.completedOrder.shift()!);
    }
  }

  release(key: OnceKey): void {
    if (key[0] !== "") this.running.delete(`${key[0]}\u0000${key[1]}`);
  }
}

/** Process-wide default, matching Python's module-level `_ONCE_REGISTRY` (engines are recreated per turn). */
export const defaultOnceRegistry = new OnceRegistry();

/** Counting semaphore for background hook slots (Python: `BoundedSemaphore(32)`). */
export class BackgroundQueue {
  private inFlight = 0;

  constructor(readonly capacity = 32) {}

  acquire(): boolean {
    if (this.inFlight >= this.capacity) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }

  get active(): number {
    return this.inFlight;
  }
}

/** Process-wide default, shared like Python's module-level `_BACKGROUND_SLOTS`. */
export const defaultBackgroundQueue = new BackgroundQueue();

export type HookScheduler = {
  submit(task: () => void | Promise<void>): void;
};

/** Runs background hooks after the current turn, as the thread pool would. */
export const microtaskScheduler: HookScheduler = {
  submit(task) {
    queueMicrotask(() => {
      void task();
    });
  },
};

export class HookNotification {
  readonly hookId: string;
  readonly event: string;
  readonly output: string;
  readonly success: boolean;

  constructor(hookId: string, event: string, output = "", success = true) {
    this.hookId = hookId;
    this.event = event;
    this.output = output;
    this.success = success;
  }

  /** SSE/event payload: output truncated to 500 code points. */
  toEvent(): Record<string, unknown> {
    return {
      type: "hook_event",
      hook_id: this.hookId,
      event: this.event,
      ok: this.success,
      output: pyHead(this.output, 500),
    };
  }
}

/** Persists one trigger record; the server wires `data/hooks_store.record_hook_trigger` here. */
export type TriggerRecorder = (
  hook: Hook,
  notification: HookNotification,
  ctx: HookContext,
  actionType: string,
) => void;

export interface HookLogger {
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

const consoleLogger: HookLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

export interface HookEngineOptions extends ExecutorDeps {
  enabled?: boolean;
  allowCommandHooks?: boolean;
  fireAndForgetSideEffects?: boolean;
  onceRegistry?: OnceRegistry;
  backgroundQueue?: BackgroundQueue;
  scheduler?: HookScheduler;
  /** Replaces `executeAction` in tests; production uses the real executors. */
  execute?: (action: Hook["action"], ctx: HookContext, deps: ExecutorDeps) => Promise<ActionResult>;
  recordTrigger?: TriggerRecorder | null;
  logger?: HookLogger;
}

export class HookEngine {
  readonly enabled: boolean;
  readonly allowCommandHooks: boolean;
  readonly fireAndForgetSideEffects: boolean;
  readonly hooks: Hook[];
  private readonly onceRegistry: OnceRegistry;
  private readonly backgroundQueue: BackgroundQueue;
  private readonly scheduler: HookScheduler;
  private readonly execute: (action: Hook["action"], ctx: HookContext, deps: ExecutorDeps) => Promise<ActionResult>;
  private readonly recordTrigger: TriggerRecorder | null;
  private readonly logger: HookLogger;
  private readonly deps: ExecutorDeps;
  private readonly promptMessages: string[] = [];
  private readonly notifications: HookNotification[] = [];

  constructor(hooks: readonly Hook[], options: HookEngineOptions = {}) {
    this.hooks = [...hooks];
    this.enabled = options.enabled ?? true;
    this.allowCommandHooks = options.allowCommandHooks ?? false;
    this.fireAndForgetSideEffects = options.fireAndForgetSideEffects ?? false;
    this.onceRegistry = options.onceRegistry ?? defaultOnceRegistry;
    this.backgroundQueue = options.backgroundQueue ?? defaultBackgroundQueue;
    this.scheduler = options.scheduler ?? microtaskScheduler;
    this.execute = options.execute ?? executeAction;
    this.recordTrigger = options.recordTrigger ?? null;
    this.logger = options.logger ?? consoleLogger;
    this.deps = {
      allowCommand: this.allowCommandHooks,
      fetch: options.fetch,
      spawn: options.spawn,
      timers: options.timers,
    };
  }

  findMatchingHooks(event: string, ctx: HookContext): Hook[] {
    if (!this.enabled) return [];
    return this.hooks.filter((hook) => hook.event === event && hook.shouldRun(ctx));
  }

  /** Runs the hooks for an event; returns every notification accumulated so far (the buffer is drained). */
  async runHooks(event: string, ctx: HookContext): Promise<HookNotification[]> {
    const matched = this.findMatchingHooks(event, ctx.child({ eventName: event }));
    for (const hook of matched) {
      const hookCtx = ctx.child({ eventName: event });
      const reservation = this.onceRegistry.reserve(hook, hookCtx);
      if (reservation === null) continue;
      if (hook.asyncExec || this.shouldFireAndForget(hook)) {
        this.submitBackground(hook, hookCtx, reservation);
      } else {
        await this.runSingleSafely(hook, hookCtx, reservation);
      }
    }
    return this.drainNotifications();
  }

  /**
   * Runs `pre_tool_use` hooks and reports the first rejecting one. Hooks without `reject` still run (and may push
   * prompt messages), and notifications stay buffered for the caller to drain.
   */
  async runPreToolHooks(ctx: HookContext): Promise<ToolRejectedError | null> {
    const eventCtx = ctx.child({ eventName: "pre_tool_use" });
    for (const hook of this.findMatchingHooks("pre_tool_use", eventCtx)) {
      const reservation = this.onceRegistry.reserve(hook, eventCtx);
      if (reservation === null) continue;
      if (this.shouldFireAndForget(hook)) {
        this.submitBackground(hook, eventCtx, reservation);
        continue;
      }
      const notification = await this.runSingleSafely(hook, eventCtx, reservation);
      if (hook.reject) {
        return new ToolRejectedError(eventCtx.toolName, notification.output || "tool call rejected by hook", hook.id);
      }
    }
    return null;
  }

  drainPromptMessages(): string[] {
    return this.promptMessages.splice(0, this.promptMessages.length);
  }

  drainNotifications(): HookNotification[] {
    return this.notifications.splice(0, this.notifications.length);
  }

  private shouldFireAndForget(hook: Hook): boolean {
    if (!this.fireAndForgetSideEffects) return false;
    if (hook.reject) return false;
    return hook.action.type === "http" || hook.action.type === "command";
  }

  private submitBackground(hook: Hook, ctx: HookContext, reservation: OnceKey): boolean {
    if (!this.backgroundQueue.acquire()) {
      this.onceRegistry.release(reservation);
      const output = `background hook queue is full (capacity=${this.backgroundQueue.capacity})`;
      this.notifications.push(new HookNotification(hook.id, hook.event, output, false));
      this.logger.warn(`[hooks] ${output} id=${hook.id} event=${hook.event}`);
      return false;
    }
    try {
      this.scheduler.submit(() => this.runSingleBackground(hook, ctx, reservation));
    } catch (error) {
      this.backgroundQueue.release();
      this.onceRegistry.release(reservation);
      this.logger.error(`[hooks] failed to schedule hook id=${hook.id} event=${hook.event}`, error);
      return false;
    }
    return true;
  }

  /** No notification is emitted when the action throws: Python only logs that case. */
  private async runSingleBackground(hook: Hook, ctx: HookContext, reservation: OnceKey): Promise<void> {
    try {
      const result = await this.execute(hook.action, ctx, this.deps);
      const notification = new HookNotification(
        hook.id,
        hook.event,
        result.output ? String(result.output) : "",
        Boolean(result.success),
      );
      this.persistTrigger(hook, notification, ctx);
      if (!result.success) {
        this.logger.warn(
          `[hooks] background hook failed id=${hook.id} event=${hook.event} output=${pyHead(notification.output, 500)}`,
        );
      }
    } catch (error) {
      this.logger.error(`[hooks] background hook failed id=${hook.id} event=${hook.event}`, error);
    } finally {
      hook.markExecuted();
      this.onceRegistry.complete(reservation);
      this.backgroundQueue.release();
    }
  }

  private async runSingleSafely(hook: Hook, ctx: HookContext, reservation: OnceKey): Promise<HookNotification> {
    let output: string;
    let success: boolean;
    try {
      const result = await this.execute(hook.action, ctx, this.deps);
      output = result.output ? String(result.output) : "";
      success = Boolean(result.success);
    } catch (error) {
      this.logger.error(`[hooks] hook failed id=${hook.id} event=${hook.event}`, error);
      output = error instanceof Error ? error.message : String(error);
      success = false;
    }
    hook.markExecuted();
    this.onceRegistry.complete(reservation);
    if (hook.action.type === "prompt" && success && pyStrip(output) !== "") {
      this.promptMessages.push(pyStrip(output));
    }
    const notification = new HookNotification(hook.id, hook.event, output, success);
    this.notifications.push(notification);
    this.persistTrigger(hook, notification, ctx);
    return notification;
  }

  /** `_record_trigger`: internal endpoints and test-mode runs stay out of the history file. */
  private persistTrigger(hook: Hook, notification: HookNotification, ctx: HookContext): void {
    if (hook.internalEndpoint || pyTruthy(ctx.extra.test_mode)) return;
    try {
      this.recordTrigger?.(hook, notification, ctx, hook.action.type);
    } catch (error) {
      this.logger.error(`[hooks] failed to persist trigger record id=${notification.hookId}`, error);
    }
  }
}
