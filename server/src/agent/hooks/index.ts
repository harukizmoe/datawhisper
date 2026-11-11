/** User-configurable hook engine (port of `agent/hooks/__init__.py`). */
export { HookEngine, HookNotification, OnceRegistry, BackgroundQueue, defaultOnceRegistry, defaultBackgroundQueue, microtaskScheduler } from "./engine.ts";
export type { HookEngineOptions, HookScheduler, HookLogger, OnceKey, TriggerRecorder } from "./engine.ts";
export { HookConfigError, loadSettings, serializeSettings, defaultSettings } from "./loader.ts";
export { Action, Hook, HookContext, ToolRejectedError } from "./models.ts";
export type { ActionResult, ActionInit, HookContextInit, HookInit, HookSettings } from "./models.ts";
export { DISPATCHED_EVENTS, EVENT_ALIASES, HOOK_EVENTS, SUPPORTED_EVENTS, normalizeEventName } from "./events.ts";
export type { HookEventName } from "./events.ts";
export { executeAction } from "./executors.ts";
export type { CommandResult, ExecutorDeps, TimerApi } from "./executors.ts";
export { evaluateCondition } from "./conditions.ts";
export { ShlexError, shlexSplit } from "./shlex.ts";
