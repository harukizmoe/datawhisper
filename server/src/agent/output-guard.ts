/**
 * 输出工具守卫（移植自 agent/agent.py 的 `_OUTPUT_TOOL_GUARDS`）。
 *
 * 报告/PPT/Excel/看板类工具成对存在：模型给出的 `propose_*` 大纲，以及用户确认后由系统执行的
 * `generate_*` / `export_*` 工具。两者都只能在其斜杠命令（或充当该命令的内置 skill）内被调用：
 * 模型绝不能在日常聊天中调用它们，否则会在没有确认的情况下、仅凭一知半解的请求生成文档。
 * 被拦截的批次会以工具结果作答，要求模型改用纯文本回复。
 */

/** 工具名 -> 可以调用它的命令（或内置 skill 名）。 */
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
 * 本轮解锁受守卫工具的 token：斜杠命令，或本轮由 skill 启动时的内置 skill 名
 * （`agent.activation.kind === "skill"`）。两者都不适用时为空串。
 */
export function guardToken(command: string | undefined, activation: { kind: string; name: string }): string {
  if (command !== undefined && command !== "") return command;
  return activation.kind === "skill" ? activation.name : "";
}

export type OutputToolBlock = { name: string; reason: string };

/**
 * 批次中 token 无权解锁的受守卫调用。该结果非空时，Python 会拦截整个批次：每个受守卫调用都得到
 * `[SYSTEM BLOCK]` 结果，其他调用得到 `ok`（它们被取消，并未执行）。
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
