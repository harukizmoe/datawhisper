/**
 * Hook data model and context expansion (port of `agent/hooks/models.py`).
 *
 * `HookContext.expand` is the only templating language hooks have: `$NAME` (no braces — `${NAME}` stays literal),
 * letters/digits/underscore for the head and dotted segments for nested tool args / extra values. A dict or list value
 * is inserted as `json.dumps(..., ensure_ascii=False)`, `None` as an empty string, everything else through `str()`.
 * Environment variables are *not* consulted.
 */
import { isMapping, pyStrip, pyStr } from "../py-compat.ts";
import { evaluateCondition } from "./conditions.ts";

export interface ActionInit {
  command?: string;
  message?: string;
  url?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
}

/** `Action` dataclass. */
export class Action {
  readonly type: string;
  command: string;
  message: string;
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  timeout: number;

  constructor(type: string, init: ActionInit = {}) {
    this.type = type;
    this.command = init.command ?? "";
    this.message = init.message ?? "";
    this.url = init.url ?? "";
    this.method = init.method ?? "POST";
    this.body = init.body ?? null;
    this.headers = init.headers ?? {};
    this.timeout = init.timeout ?? 10;
  }
}

export interface ActionResult {
  output: string;
  success: boolean;
}

/** Dataclass field names (as the Python condition language spells them) to this class's properties. */
const FIELD_BY_PYTHON_NAME: Readonly<Record<string, ContextField>> = {
  event_name: "eventName",
  session_id: "sessionId",
  turn_id: "turnId",
  workspace_id: "workspaceId",
  workspace_name: "workspaceName",
  workspace_path: "workspacePath",
  tool_name: "toolName",
  tool_args: "toolArgs",
  tool_ok: "toolOk",
  tool_error: "toolError",
  message: "message",
  final_answer: "finalAnswer",
  error: "error",
  model_provider: "modelProvider",
  model: "model",
  elapsed_seconds: "elapsedSeconds",
  extra: "extra",
};

type ContextField =
  | "eventName"
  | "sessionId"
  | "turnId"
  | "workspaceId"
  | "workspaceName"
  | "workspacePath"
  | "toolName"
  | "toolArgs"
  | "toolOk"
  | "toolError"
  | "message"
  | "finalAnswer"
  | "error"
  | "modelProvider"
  | "model"
  | "elapsedSeconds"
  | "extra";

export interface HookContextInit {
  eventName?: string;
  sessionId?: string;
  turnId?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOk?: boolean | null;
  toolError?: string;
  message?: string;
  finalAnswer?: string;
  error?: string;
  modelProvider?: string;
  model?: string;
  elapsedSeconds?: number | null;
  extra?: Record<string, unknown>;
}

/** `HookContext` dataclass. */
export class HookContext {
  eventName: string;
  sessionId: string;
  turnId: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolOk: boolean | null;
  toolError: string;
  message: string;
  finalAnswer: string;
  error: string;
  modelProvider: string;
  model: string;
  elapsedSeconds: number | null;
  extra: Record<string, unknown>;

  constructor(init: HookContextInit = {}) {
    this.eventName = init.eventName ?? "";
    this.sessionId = init.sessionId ?? "";
    this.turnId = init.turnId ?? "";
    this.workspaceId = init.workspaceId ?? "";
    this.workspaceName = init.workspaceName ?? "";
    this.workspacePath = init.workspacePath ?? "";
    this.toolName = init.toolName ?? "";
    this.toolArgs = init.toolArgs ?? {};
    this.toolOk = init.toolOk ?? null;
    this.toolError = init.toolError ?? "";
    this.message = init.message ?? "";
    this.finalAnswer = init.finalAnswer ?? "";
    this.error = init.error ?? "";
    this.modelProvider = init.modelProvider ?? "";
    this.model = init.model ?? "";
    this.elapsedSeconds = init.elapsedSeconds ?? null;
    this.extra = init.extra ?? {};
  }

  /** A copy with `tool_args` / `extra` copied one level deep, then the given overrides. */
  child(updates: HookContextInit = {}): HookContext {
    return new HookContext({
      eventName: this.eventName,
      sessionId: this.sessionId,
      turnId: this.turnId,
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      workspacePath: this.workspacePath,
      toolName: this.toolName,
      toolArgs: { ...this.toolArgs },
      toolOk: this.toolOk,
      toolError: this.toolError,
      message: this.message,
      finalAnswer: this.finalAnswer,
      error: this.error,
      modelProvider: this.modelProvider,
      model: this.model,
      elapsedSeconds: this.elapsedSeconds,
      extra: { ...this.extra },
      ...updates,
    });
  }

  /** `get_field`: aliases, `args.` / `extra.` nesting, then the dataclass attribute (missing → ""). */
  getField(name: unknown): unknown {
    let key = pyStrip(name === null || name === undefined ? "" : String(name));
    if (key === "") return "";
    key = FIELD_ALIASES[key] ?? key;
    if (key.startsWith("args.")) return nestedGet(this.toolArgs, key.slice(5));
    if (key.startsWith("extra.")) return nestedGet(this.extra, key.slice(6));
    const field = FIELD_BY_PYTHON_NAME[key];
    return field === undefined ? "" : this[field];
  }

  /** `expand`: recursive over dicts/lists, `$NAME` substitution in strings, other scalars untouched. */
  expand(template: unknown): unknown {
    if (Array.isArray(template)) return template.map((item) => this.expand(item));
    if (isMapping(template)) {
      return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, this.expand(value)]));
    }
    if (typeof template !== "string") return template;
    return template.replace(/\$([A-Z][A-Z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g, (_match, name: string) => {
      const value = this.getField(variableToField(name));
      if (Array.isArray(value) || isMapping(value)) return jsonDumps(value);
      if (value === null || value === undefined) return "";
      return pyStr(value);
    });
  }
}

export interface HookInit {
  id: string;
  event: string;
  action: Action;
  name?: string;
  enabled?: boolean;
  internalEndpoint?: boolean;
  condition?: string;
  reject?: boolean;
  once?: boolean;
  onceScope?: string;
  asyncExec?: boolean;
  executed?: boolean;
}

/** `Hook` dataclass. `executed` is per-instance and only consulted together with `once`. */
export class Hook {
  id: string;
  event: string;
  action: Action;
  name: string;
  enabled: boolean;
  internalEndpoint: boolean;
  condition: string;
  reject: boolean;
  once: boolean;
  onceScope: string;
  asyncExec: boolean;
  executed: boolean;

  constructor(init: HookInit) {
    this.id = init.id;
    this.event = init.event;
    this.action = init.action;
    this.name = init.name ?? "";
    this.enabled = init.enabled ?? true;
    this.internalEndpoint = init.internalEndpoint ?? false;
    this.condition = init.condition ?? "";
    this.reject = init.reject ?? false;
    this.once = init.once ?? false;
    this.onceScope = init.onceScope ?? "session";
    this.asyncExec = init.asyncExec ?? false;
    this.executed = init.executed ?? false;
  }

  shouldRun(ctx: HookContext): boolean {
    if (!this.enabled || (this.once && this.executed)) return false;
    if (this.condition === "") return true;
    return evaluateCondition(this.condition, ctx);
  }

  markExecuted(): void {
    this.executed = true;
  }
}

export interface HookSettings {
  enabled: boolean;
  allowCommandHooks: boolean;
  hooks: Hook[];
}

/** `ToolRejectedError`: `message` is the hook output (or the caller's default). */
export class ToolRejectedError extends Error {
  readonly tool: string;
  readonly reason: string;
  readonly hookId: string;

  constructor(tool: string, reason: string, hookId: string) {
    super(reason);
    this.name = "ToolRejectedError";
    this.tool = tool;
    this.reason = reason;
    this.hookId = hookId;
  }
}

/** Python's `aliases` dict in `get_field` (values are dataclass field names). */
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  event: "event_name",
  tool: "tool_name",
  args: "tool_args",
  ok: "tool_ok",
};

/** `_nested_get`: dotted lookup through dicts only; any other value in the path yields "". */
function nestedGet(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of pyStr(path).split(".")) {
    if (part === "") continue;
    if (!isMapping(current)) return "";
    current = Object.hasOwn(current, part) ? current[part] : "";
  }
  return current;
}

/** `_variable_to_field`. */
function variableToField(name: string): string {
  const base = name.toLowerCase();
  const mapping: Record<string, string> = {
    event: "event_name",
    session_id: "session_id",
    turn_id: "turn_id",
    workspace_id: "workspace_id",
    workspace_name: "workspace_name",
    workspace_path: "workspace_path",
    tool_name: "tool_name",
    tool: "tool_name",
    message: "message",
    final_answer: "final_answer",
    error: "error",
    tool_error: "tool_error",
    model: "model",
    model_provider: "model_provider",
    elapsed_seconds: "elapsed_seconds",
  };
  if (base.startsWith("tool_args.")) return `args.${base.slice("tool_args.".length)}`;
  return mapping[base] ?? base;
}

function jsonString(text: string): string {
  let out = '"';
  for (const char of text) {
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char === "\b") out += "\\b";
    else if (char === "\f") out += "\\f";
    else {
      const code = char.codePointAt(0)!;
      out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
    }
  }
  return `${out}"`;
}

/**
 * `json.dumps(value, ensure_ascii=False)`: Python's default `", "` / `": "` separators and lowercase literals.
 * Integers keep their integer form; a float with no fractional part becomes "2" instead of Python's "2.0" because JS
 * cannot tell the two JSON numbers apart (same convention as `pyStr`).
 */
export function jsonDumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyStr(value);
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) return `[${value.map((item) => jsonDumps(item)).join(", ")}]`;
  if (isMapping(value)) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${jsonString(key)}: ${jsonDumps(item)}`)
      .join(", ")}}`;
  }
  return pyStr(value);
}
