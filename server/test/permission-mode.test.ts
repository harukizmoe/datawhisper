import { describe, expect, test } from "bun:test";
import { changeClassOf, decidePermission, isReadOnlyBash, PERMISSION_MODES, type PermissionMode } from "../src/agent/permission-mode.ts";

const kind = (mode: PermissionMode, tool: string, args: Record<string, unknown> = {}, allowed: string[] = []) =>
  decidePermission({ mode, tool, args, allowed }).kind;

describe("工具分类", () => {
  test("文件改动、导出算 edit；删除、移动、命令算 destructive；其余不受管", () => {
    expect(changeClassOf("workspace_write_file")).toBe("edit");
    expect(changeClassOf("workspace_edit_file")).toBe("edit");
    expect(changeClassOf("export_excel")).toBe("edit");
    expect(changeClassOf("workspace_delete_file")).toBe("destructive");
    expect(changeClassOf("workspace_move_file")).toBe("destructive");
    expect(changeClassOf("workspace_bash")).toBe("destructive");
    for (const tool of ["workspace_read_file", "workspace_grep", "query_data", "task_create", "generate_chart"]) {
      expect(changeClassOf(tool)).toBeUndefined();
    }
  });
});

describe("模式矩阵", () => {
  const rows: [PermissionMode, string, string][] = [
    ["manual", "workspace_write_file", "ask"],
    ["manual", "workspace_delete_file", "ask"],
    ["accept_edits", "workspace_edit_file", "allow"],
    ["accept_edits", "export_report", "allow"],
    ["accept_edits", "workspace_bash", "ask"],
    ["accept_edits", "workspace_move_file", "ask"],
    ["plan", "workspace_write_file", "block"],
    ["plan", "workspace_bash", "block"],
    ["auto", "workspace_write_file", "allow"],
    ["auto", "workspace_delete_file", "ask"],
    ["auto", "workspace_move_file", "ask"],
    ["bypass", "workspace_delete_file", "allow"],
    ["bypass", "workspace_bash", "allow"],
  ];
  for (const [mode, tool, expected] of rows) {
    test(`${mode} · ${tool} → ${expected}`, () => {
      expect(kind(mode, tool, { command: "rm -rf data" })).toBe(expected as never);
    });
  }

  test("任何模式下读类工具都放行，包括计划模式", () => {
    for (const mode of PERMISSION_MODES) expect(kind(mode, "workspace_read_file")).toBe("allow");
  });

  test("「本对话都允许」只对 edit 类、且只在 manual 下免问；destructive 永远要问", () => {
    expect(kind("manual", "workspace_write_file", {}, ["workspace_write_file"])).toBe("allow");
    expect(kind("manual", "workspace_edit_file", {}, ["workspace_write_file"])).toBe("ask");
    expect(kind("manual", "workspace_bash", { command: "ls" }, ["workspace_bash"])).toBe("ask");
  });

  test("计划模式的拒绝理由告诉模型不要重试、改写成计划", () => {
    const decision = decidePermission({ mode: "plan", tool: "workspace_write_file", args: {}, allowed: [] });
    expect(decision.kind === "block" && decision.reason).toContain("Plan mode");
  });
});

describe("auto 档的只读 bash", () => {
  test("白名单命令与它们之间的管道放行", () => {
    for (const command of ["ls -la", "cat data.csv | head -n 5", "git status", "git log --oneline", "find . -name '*.csv'", "grep -rn foo ."]) {
      expect(isReadOnlyBash(command)).toBe(true);
      expect(kind("auto", "workspace_bash", { command })).toBe("allow");
    }
  });

  test("重定向、串联、命令替换、写文件的参数、非白名单命令都要问", () => {
    for (const command of [
      "",
      "cat a > b",
      "ls; rm a",
      "ls && rm a",
      "ls || rm a",
      "echo $(rm a)",
      "echo `rm a`",
      "find . -delete",
      "find . -exec rm {} +",
      "git commit -m x",
      "git -C . push",
      "rg --pre ./evil foo",
      "rm a",
      "sort -o a b",
      "ls\nrm a",
    ]) {
      expect(isReadOnlyBash(command)).toBe(false);
    }
    expect(kind("auto", "workspace_bash", { command: "rm a" })).toBe("ask");
  });
});
