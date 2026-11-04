/**
 * Hook event vocabulary (port of `agent/hooks/events.py`).
 *
 * `SUPPORTED_EVENTS` is what a saved settings file may reference; `DISPATCHED_EVENTS` is the subset the Python
 * application actually raises. Two names are kept for compatibility only:
 *
 * - `session_end` — no dispatch point in `api/` or `agent/`;
 * - `permission_request` — only reachable through the legacy `/api/hooks/test` bridge, never raised by a lifecycle.
 *
 * Callers must not present either as an active lifecycle hook.
 */
import { pyStrip } from "../py-compat.ts";

export const HOOK_EVENTS = {
  startup: "startup",
  sessionStart: "session_start",
  sessionEnd: "session_end",
  userPromptSubmit: "user_prompt_submit",
  turnStart: "turn_start",
  turnEnd: "turn_end",
  toolCall: "tool_call",
  preToolUse: "pre_tool_use",
  postToolUse: "post_tool_use",
  permissionRequest: "permission_request",
  subagentStart: "subagent_start",
  subagentStop: "subagent_stop",
  preCompact: "pre_compact",
  postCompact: "post_compact",
  stop: "stop",
  error: "error",
} as const;

export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];

export const SUPPORTED_EVENTS: Readonly<Record<string, true>> = Object.freeze({
  startup: true,
  session_start: true,
  session_end: true,
  user_prompt_submit: true,
  turn_start: true,
  turn_end: true,
  tool_call: true,
  pre_tool_use: true,
  post_tool_use: true,
  permission_request: true,
  subagent_start: true,
  subagent_stop: true,
  pre_compact: true,
  post_compact: true,
  stop: true,
  error: true,
});

/** Events with an in-process dispatch point (`api/__init__.py`, `api/chat.py`, `api/commands.py`, `agent/agent.py`). */
export const DISPATCHED_EVENTS: Readonly<Record<string, true>> = Object.freeze({
  startup: true,
  session_start: true,
  user_prompt_submit: true,
  turn_start: true,
  turn_end: true,
  tool_call: true,
  pre_tool_use: true,
  post_tool_use: true,
  subagent_start: true,
  subagent_stop: true,
  pre_compact: true,
  post_compact: true,
  stop: true,
  error: true,
});

/** Compacted (`eventname`) and underscore spellings accepted from stored settings and the UI. */
export const EVENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  sessionstart: HOOK_EVENTS.sessionStart,
  session_start: HOOK_EVENTS.sessionStart,
  sessionend: HOOK_EVENTS.sessionEnd,
  session_end: HOOK_EVENTS.sessionEnd,
  userpromptsubmit: HOOK_EVENTS.userPromptSubmit,
  user_prompt_submit: HOOK_EVENTS.userPromptSubmit,
  turnbegin: HOOK_EVENTS.turnStart,
  turn_begin: HOOK_EVENTS.turnStart,
  turnstart: HOOK_EVENTS.turnStart,
  turn_start: HOOK_EVENTS.turnStart,
  turnend: HOOK_EVENTS.turnEnd,
  turn_end: HOOK_EVENTS.turnEnd,
  toolcall: HOOK_EVENTS.toolCall,
  tool_call: HOOK_EVENTS.toolCall,
  pretooluse: HOOK_EVENTS.preToolUse,
  pre_tool_use: HOOK_EVENTS.preToolUse,
  posttooluse: HOOK_EVENTS.postToolUse,
  post_tool_use: HOOK_EVENTS.postToolUse,
  permissionrequest: HOOK_EVENTS.permissionRequest,
  permission_request: HOOK_EVENTS.permissionRequest,
  subagentstart: HOOK_EVENTS.subagentStart,
  subagent_start: HOOK_EVENTS.subagentStart,
  subagentstop: HOOK_EVENTS.subagentStop,
  subagent_stop: HOOK_EVENTS.subagentStop,
  precompact: HOOK_EVENTS.preCompact,
  pre_compact: HOOK_EVENTS.preCompact,
  postcompact: HOOK_EVENTS.postCompact,
  post_compact: HOOK_EVENTS.postCompact,
  stop: HOOK_EVENTS.stop,
  startup: HOOK_EVENTS.startup,
  error: HOOK_EVENTS.error,
});

/** `normalize_event_name`: untouched names survive verbatim (and then fail the supported-event check). */
export function normalizeEventName(value: unknown): string {
  const raw = pyStrip(value === null || value === undefined ? "" : String(value));
  const key = raw.replaceAll("-", "_").replaceAll(" ", "_");
  const compact = key.replaceAll("_", "").toLowerCase();
  return EVENT_ALIASES[compact] ?? EVENT_ALIASES[key.toLowerCase()] ?? raw;
}
