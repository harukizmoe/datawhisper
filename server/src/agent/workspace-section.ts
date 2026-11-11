/**
 * 属于某个工作区的对话，每一轮系统提示末尾附带的工作区块。
 *
 * 内容：工作区名称与目录、权限、用户在应用里写的说明，以及目录里已有的分层指令文件
 * （`agent/instructions.ts`：`<数据目录>/ZHIXI.md`、`<目录>/ZHIXI.md`、`<目录>/ZHIXI.local.md`）。
 * 普通聊天没有这个块。
 */

import { say } from "../i18n.ts";
import type { WorkspaceRecord } from "../ipc/workspace-store.ts";
import { renderInstructionSection } from "./instructions.ts";
import type { PermissionMode } from "./permission-mode.ts";

/** 告诉模型当前权限模式的含义，让它按模式调整做法（真正的拦截在 `beforeTool` 里）。 */
function modeLine(mode: PermissionMode): string {
  switch (mode) {
    case "manual":
      return say(
        "Permission mode: manual. Every change (writing, editing, deleting, moving, shell commands, exports) asks the user first, so make focused changes and say what each one is for.",
        "权限模式：手动。每次改动（写入、编辑、删除、移动、命令、导出）都会先询问用户，所以改动要有针对性，并说明目的。",
      );
    case "accept_edits":
      return say(
        "Permission mode: accept edits. Writing, editing and exporting files go through automatically; deleting, moving and shell commands still ask the user.",
        "权限模式：自动接受编辑。写入、编辑和导出文件自动通过；删除、移动和命令仍会询问用户。",
      );
    case "plan":
      return say(
        "Permission mode: plan. Changes are not allowed yet: read and analyse, then present your plan as text. The user switches the mode when they want it carried out.",
        "权限模式：计划。暂不允许任何改动：先读取和分析，再把计划写成文字。用户想执行时会切换模式。",
      );
    case "auto":
      return say(
        "Permission mode: auto. Edits, exports and read-only shell commands go through; deleting, moving and other shell commands still ask the user.",
        "权限模式：自动。编辑、导出和只读命令自动通过；删除、移动和其他命令仍会询问用户。",
      );
    case "bypass":
      return say(
        "Permission mode: bypass. Every change is allowed without asking, so double-check destructive actions yourself.",
        "权限模式：跳过确认。所有改动都不再询问，破坏性操作请自己再三确认。",
      );
  }
}

export function renderWorkspaceSection(
  record: Pick<WorkspaceRecord, "name" | "workdir" | "instructions">,
  dataDir: string,
  mode: PermissionMode,
): string {
  const lines = [
    "",
    "",
    "[WORKSPACE]",
    say(
      `This conversation belongs to the workspace "${record.name}". Its folder is mounted as workspace://user (${record.workdir}). Exports are written to its artifacts/ folder.`,
      `本对话属于工作区「${record.name}」，它的文件夹挂载为 workspace://user（${record.workdir}）。导出文件会写到它的 artifacts/ 目录。`,
    ),
    modeLine(mode),
  ];
  if (record.instructions !== "") {
    lines.push("", say("Instructions from the user for this workspace:", "用户为这个工作区写的说明："), record.instructions);
  }
  lines.push("[END WORKSPACE]");
  return lines.join("\n") + renderInstructionSection({ userRoot: dataDir, workspaceRoot: record.workdir });
}
