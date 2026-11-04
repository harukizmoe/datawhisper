/**
 * Output-tool guard (port of `_OUTPUT_TOOL_GUARDS` in agent/agent.py).
 *
 * Report/PPT/Excel/dashboard tools exist in pairs: a `propose_*` outline the model offers, and the `generate_*` /
 * `export_*` tool the system runs after the user confirms. Both are reachable only inside their slash command (or a
 * builtin skill that acts as that command): the model must never call them from ordinary chat, or it would produce a
 * deck from a half-understood request with no confirmation. A blocked batch is answered with a tool result telling the
 * model to reply in plain text instead.
 */

/** Tool name -> the command (or builtin skill name) that may call it. */
export const OUTPUT_TOOL_GUARDS: Readonly<Record<string, ReadonlySet<string>>> = {
  propose_ppt_outline: new Set(["ppt", "ppt_revise"]),
  generate_ppt: new Set(["ppt_confirm"]),
  propose_report_outline: new Set(["report", "report_revise"]),
  export_report: new Set(["report_confirm"]),
  propose_excel_export: new Set(["export", "excel_revise"]),
  export_excel: new Set(["excel_confirm"]),
  propose_dashboard_outline: new Set(["dashboard", "dashboard_revise"]),
  generate_dashboard: new Set(["dashboard_confirm"]),
};

/**
 * The token that unlocks guarded tools this turn: the slash command, or the builtin skill's name when the turn was
 * started by a skill (`agent.activation.kind === "skill"`). Empty when neither applies.
 */
export function guardToken(command: string | undefined, activation: { kind: string; name: string }): string {
  if (command !== undefined && command !== "") return command;
  return activation.kind === "skill" ? activation.name : "";
}

export type OutputToolBlock = { name: string; reason: string };

/**
 * The guarded calls of a batch that the token may not unlock. Python blocks the whole batch when this is non-empty and
 * gives every guarded call a `[SYSTEM BLOCK]` result while other calls get `ok` (they are cancelled, not executed).
 */
export function blockedOutputTools(toolNames: readonly string[], token: string): OutputToolBlock[] {
  return toolNames
    .filter((name) => {
      const allowed = OUTPUT_TOOL_GUARDS[name];
      return allowed !== undefined && !allowed.has(token);
    })
    .map((name) => ({ name, reason: blockMessage(name) }));
}

export function blockMessage(name: string): string {
  return (
    `[SYSTEM BLOCK] '${name}' requires a slash command. ` +
    "Do NOT call output tools in regular chat. " +
    "Reply to the user in plain text, and suggest the relevant slash command if appropriate."
  );
}
