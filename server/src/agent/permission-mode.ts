/**
 * 工作区对话的权限模式：哪些「会改东西」的工具调用直接放行、需要询问、或直接拒绝。
 *
 * 五档照 Claude Code：
 * - `manual`：每次改动都问；
 * - `accept_edits`：写文件、改文件、导出自动放行，删除/移动/bash 仍问；
 * - `plan`：只读；任何改动都拒绝，让模型先把计划写成文字；
 * - `auto`：规则判断——编辑与导出放行，纯只读的 bash 放行，删除、移动与其余 bash 仍问；
 * - `bypass`：全部放行（目录边界、敏感文件过滤等硬限制仍由工具本身执行）。
 *
 * 这里只有纯函数，不碰状态也不等人：询问由 `permission-gate.ts` 与审批 broker 完成。
 */

import { say } from "../i18n.ts";

export const PERMISSION_MODES = ["manual", "accept_edits", "plan", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** 工作区对话新建时的模式。 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "manual";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** `edit`：写进目录或产出文件；`destructive`：删除、移动、执行命令，难以撤销。 */
export type ChangeClass = "edit" | "destructive";

// 只有真正落到工作区文件上的工具才受模式管：任务板、团队、工作流等应用内状态不算，图表写在数据目录里也不算。
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "workspace_write_file",
  "workspace_edit_file",
  "export_excel",
  "export_report",
  "generate_ppt",
  "generate_dashboard",
]);
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(["workspace_delete_file", "workspace_move_file", "workspace_bash"]);

/** 工具不受权限模式管时返回 undefined（读类工具与应用内状态类工具）。 */
export function changeClassOf(tool: string): ChangeClass | undefined {
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (DESTRUCTIVE_TOOLS.has(tool)) return "destructive";
  return undefined;
}

export type PermissionDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "ask" }
  | { readonly kind: "block"; readonly reason: string };

// 只读命令白名单：只含不会写文件、不会执行别的程序的命令；带参数的危险写法在 `isReadOnlyBash` 里再排除。
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "pwd", "stat", "du", "df", "diff", "jq", "find", "git", "which",
]);
const READ_ONLY_GIT: ReadonlySet<string> = new Set(["status", "log", "diff", "show"]);
const FIND_WRITES = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

/** 命令是否只读：不含重定向、命令替换、`;`/`&&`/`||`，只允许 `|` 串起白名单命令。 */
export function isReadOnlyBash(command: string): boolean {
  if (command.trim() === "" || /[;&<>`$(){}\\\n]/.test(command) || command.includes("||")) return false;
  for (const segment of command.split("|")) {
    const words = segment.trim().split(/\s+/);
    const program = words[0] ?? "";
    if (!READ_ONLY_COMMANDS.has(program)) return false;
    const args = words.slice(1);
    if (program === "git" && !READ_ONLY_GIT.has(args.find((arg) => !arg.startsWith("-")) ?? "")) return false;
    if (program === "find" && args.some((arg) => FIND_WRITES.test(arg))) return false;
    if ((program === "grep" || program === "rg") && args.some((arg) => arg.startsWith("--pre"))) return false;
  }
  return true;
}

export function decidePermission(options: {
  readonly mode: PermissionMode;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** 用户在本对话里选过「本对话都允许」的工具名（只对 `edit` 类生效）。 */
  readonly allowed: readonly string[];
}): PermissionDecision {
  const change = changeClassOf(options.tool);
  if (change === undefined) return { kind: "allow" };
  switch (options.mode) {
    case "bypass":
      return { kind: "allow" };
    case "plan":
      return {
        kind: "block",
        reason: say(
          "[PERMISSION] Plan mode is active, so changes are not allowed yet. Do not retry this call: write your plan as text and let the user switch the mode when they want it carried out.",
          "[PERMISSION] 当前是计划模式，暂不允许任何改动。不要重试这次调用：先把计划写成文字，等用户切换模式后再执行。",
        ),
      };
    case "accept_edits":
      return change === "edit" ? { kind: "allow" } : { kind: "ask" };
    case "auto":
      if (change === "edit") return { kind: "allow" };
      return options.tool === "workspace_bash" && isReadOnlyBash(String(options.args.command ?? "")) ? { kind: "allow" } : { kind: "ask" };
    case "manual":
      return change === "edit" && options.allowed.includes(options.tool) ? { kind: "allow" } : { kind: "ask" };
  }
}
