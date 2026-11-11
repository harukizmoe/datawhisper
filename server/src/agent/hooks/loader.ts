/**
 * Load and validate persisted hook settings (port of `agent/hooks/loader.py`).
 *
 * Error text is part of the settings UI contract, and the order of the checks is the order Python raises in: the hook
 * list first (each hook: id, event, action, name, flags, scope, cross-field rules, `enabled` last), then duplicate ids,
 * then the two top-level booleans. `serializeSettings` writes exactly the keys and key order `hooks.json` stores.
 */
import { isMapping, pyStrip, pyStr, pyTruthy } from "../py-compat.ts";
import { SUPPORTED_EVENTS, normalizeEventName } from "./events.ts";
import { Action, Hook, type HookSettings } from "./models.ts";

const ACTION_TYPES: Readonly<Record<string, true>> = { prompt: true, http: true, command: true };
const ONCE_SCOPES: Readonly<Record<string, true>> = { turn: true, session: true, global: true };

export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConfigError";
  }
}

/** `str(value or "")`: Python `or` truthiness first, then `str()`. */
function text(value: unknown): string {
  return pyStr(pyTruthy(value) ? value : "");
}

/** `raw.get(key, fallback)` — only a missing key falls back. */
function getWithDefault(raw: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : fallback;
}

function requireBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HookConfigError(`${field} must be a boolean`);
  return value;
}

/** `int(value)` for the value types a settings file can contain; null where Python raises. */
function pyInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string") {
    const trimmed = pyStrip(value);
    if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(trimmed)) return null;
    return Number(trimmed.replaceAll("_", ""));
  }
  return null;
}

export function loadSettings(raw: unknown): HookSettings {
  const settings = raw ?? {};
  if (!isMapping(settings)) throw new HookConfigError("hook settings must be an object");
  const hooksRaw = pyTruthy(settings.hooks) ? settings.hooks : [];
  if (!Array.isArray(hooksRaw)) throw new HookConfigError("hooks must be a list");
  const hooks = hooksRaw.map((item, index) => loadHook(item, index));
  const ids = hooks.map((hook) => hook.id);
  if (new Set(ids).size !== ids.length) throw new HookConfigError("hook ids must be unique");
  return {
    enabled: requireBool(getWithDefault(settings, "enabled", true), "enabled"),
    allowCommandHooks: requireBool(getWithDefault(settings, "allow_command_hooks", false), "allow_command_hooks"),
    hooks,
  };
}

export function serializeSettings(settings: HookSettings): Record<string, unknown> {
  return {
    enabled: settings.enabled,
    allow_command_hooks: settings.allowCommandHooks,
    hooks: settings.hooks.map(serializeHook),
  };
}

export function defaultSettings(): Record<string, unknown> {
  return { enabled: true, allow_command_hooks: false, hooks: [] };
}

function loadHook(input: unknown, index: number): Hook {
  if (!isMapping(input)) throw new HookConfigError(`hook[${index}] must be an object`);
  const id = pyStrip(text(input.id));
  if (id === "") throw new HookConfigError(`hook[${index}].id is required`);
  const event = normalizeEventName(pyStrip(text(input.event)));
  if (SUPPORTED_EVENTS[event] !== true) throw new HookConfigError(`hook[${id}].event is unsupported: ${event}`);
  const action = loadAction(input.action, id);
  let name = pyStrip(text(input.name) || text(input.title) || "");
  if (name === "" && id === "promlight-turn-end") name = "PromLight 信号灯";
  const internalEndpoint = requireBool(
    getWithDefault(input, "internal_endpoint", id.startsWith("codex_")),
    `hook[${id}].internal_endpoint`,
  );
  const reject = requireBool(getWithDefault(input, "reject", false), `hook[${id}].reject`);
  const asyncExec = requireBool(
    getWithDefault(input, "async", getWithDefault(input, "async_exec", false)),
    `hook[${id}].async`,
  );
  const once = requireBool(getWithDefault(input, "once", false), `hook[${id}].once`);
  const onceScope = pyStrip(text(getWithDefault(input, "once_scope", "session")) || "session").toLowerCase();
  if (ONCE_SCOPES[onceScope] !== true) {
    throw new HookConfigError(
      `hook[${id}].once_scope must be one of: ${Object.keys(ONCE_SCOPES).sort().join(", ")}`,
    );
  }
  if (reject && event !== "pre_tool_use") {
    throw new HookConfigError(`hook[${id}].reject is only allowed for pre_tool_use`);
  }
  if (reject && action.type !== "prompt") {
    throw new HookConfigError(`hook[${id}].reject hooks must use a prompt action`);
  }
  if (asyncExec && action.type === "prompt") {
    throw new HookConfigError(`hook[${id}].prompt hooks cannot be async`);
  }
  if (event === "pre_tool_use" && asyncExec) {
    throw new HookConfigError(`hook[${id}].pre_tool_use hooks cannot be async`);
  }
  return new Hook({
    id,
    event,
    action,
    name,
    enabled: requireBool(getWithDefault(input, "enabled", true), `hook[${id}].enabled`),
    internalEndpoint,
    condition: pyStrip(text(input.if) || text(input.condition) || ""),
    reject,
    once,
    onceScope,
    asyncExec,
  });
}

function loadAction(input: unknown, hookId: string): Action {
  if (!isMapping(input)) throw new HookConfigError(`hook[${hookId}].action must be an object`);
  const actionType = pyStrip(text(input.type));
  if (ACTION_TYPES[actionType] !== true) {
    throw new HookConfigError(`hook[${hookId}].action.type is unsupported: ${actionType}`);
  }
  const timeout = pyInt(getWithDefault(input, "timeout", 10));
  if (timeout === null) throw new HookConfigError(`hook[${hookId}].action.timeout must be an integer`);
  if (timeout <= 0 || timeout > 120) {
    throw new HookConfigError(`hook[${hookId}].action.timeout must be between 1 and 120`);
  }
  const message = pyStr(text(input.message) || text(input.prompt) || "");
  const rawHeaders = pyTruthy(input.headers) ? input.headers : {};
  if (!isMapping(rawHeaders)) throw new HookConfigError(`hook[${hookId}].action.headers must be an object`);
  const action = new Action(actionType, {
    command: text(input.command),
    message,
    url: text(input.url),
    method: (text(input.method) || "POST").toUpperCase(),
    body: getWithDefault(input, "body", null),
    headers: Object.fromEntries(Object.entries(rawHeaders).map(([key, value]) => [key, pyStr(value)])),
    timeout,
  });
  if (action.type === "prompt" && pyStrip(action.message) === "") {
    throw new HookConfigError(`hook[${hookId}].action.message is required`);
  }
  if (action.type === "http" && pyStrip(action.url) === "") {
    throw new HookConfigError(`hook[${hookId}].action.url is required`);
  }
  if (action.type === "command" && pyStrip(action.command) === "") {
    throw new HookConfigError(`hook[${hookId}].action.command is required`);
  }
  return action;
}

function serializeHook(hook: Hook): Record<string, unknown> {
  return {
    id: hook.id,
    name: hook.name,
    enabled: hook.enabled,
    internal_endpoint: hook.internalEndpoint,
    event: hook.event,
    if: hook.condition,
    reject: hook.reject,
    once: hook.once,
    once_scope: hook.onceScope,
    async: hook.asyncExec,
    action: {
      type: hook.action.type,
      command: hook.action.command,
      message: hook.action.message,
      url: hook.action.url,
      method: hook.action.method,
      body: hook.action.body,
      headers: hook.action.headers,
      timeout: hook.action.timeout,
    },
  };
}
