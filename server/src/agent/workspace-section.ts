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

export function renderWorkspaceSection(
  record: Pick<WorkspaceRecord, "name" | "workdir" | "permission" | "instructions">,
  dataDir: string,
): string {
  const lines = [
    "",
    "",
    "[WORKSPACE]",
    say(
      `This conversation belongs to the workspace "${record.name}". Its folder is mounted as workspace://user (${record.workdir}).`,
      `本对话属于工作区「${record.name}」，它的文件夹挂载为 workspace://user（${record.workdir}）。`,
    ),
    record.permission === "read_write"
      ? say("Permission: read-write. You may change files in the workspace when the user asks.", "权限：可读写。用户要求时可以修改工作区里的文件。")
      : say(
          "Permission: read-only. Never modify files in the workspace; exports are written to its artifacts/ folder.",
          "权限：只读。不要修改工作区里的文件；导出文件会写到它的 artifacts/ 目录。",
        ),
  ];
  if (record.instructions !== "") {
    lines.push("", say("Instructions from the user for this workspace:", "用户为这个工作区写的说明："), record.instructions);
  }
  lines.push("[END WORKSPACE]");
  return lines.join("\n") + renderInstructionSection({ userRoot: dataDir, workspaceRoot: record.workdir });
}
