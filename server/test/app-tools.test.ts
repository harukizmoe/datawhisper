/**
 * A 类工具（纯 TS）的行为测试。
 *
 * 用真实临时目录做工作区，用内存 pi-durable 文档宿主做任务/团队存储，
 * 不启动 Python、不访问网络（`browse_webpage` 注入 fetch）。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  APP_TOOL_NAMES,
  createAppTools,
  createMemoryDocHost,
  initialPlanStore,
  initialTaskBoard,
  initialTeamStore,
  NodeWorkspaceFs,
  tokenizeCommand,
  type AppTool,
  type AppToolDeps,
  type AppToolDetails,
  type CanvasProject,
  type CanvasStore,
  type ToolResultArtifactRef,
} from "../src/tools/app/index.ts";
import { readZipEntry, listZipEntries } from "../src/tools/app/workspace/zip.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "app-tools-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
  const first = result.output?.[0];
  return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
}

const API = {} as unknown as ToolExecutionApi<AppToolDetails>;

function run(tool: AppTool, args: object = {}) {
  return tool.execute(args, API, BACKGROUND_CONTEXT);
}

function byName(tools: readonly AppTool[], name: string): AppTool {
  const tool = tools.find((item) => item.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

/** 构造一个最小 ZIP（stored）用于 DOCX/XLSX 测试。 */
function zip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    crcTable[index] = value >>> 0;
  }
  const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

function makeXlsx(): Buffer {
  return zip([
    {
      name: "xl/workbook.xml",
      data:
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: "xl/sharedStrings.xml",
      data: '<sst><si><t>Name</t></si><si><t>Value</t></si></sst>',
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data:
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>hello</t></is></c></row>' +
        "</sheetData></worksheet>",
    },
  ]);
}

function makeDocx(): Buffer {
  return zip([
    {
      name: "word/document.xml",
      data:
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>World</w:t></w:r></w:p>" +
        "</w:body></w:document>",
    },
  ]);
}

type FakeCanvas = CanvasStore & { projects: Map<string, CanvasProject> };

function fakeCanvas(): FakeCanvas {
  const projects = new Map<string, CanvasProject>();
  let sequence = 0;
  return {
    projects,
    async getProject(projectId) {
      return projects.get(projectId);
    },
    async createProject(options) {
      sequence += 1;
      const project: CanvasProject = {
        id: `p${sequence}`,
        template_id: options.templateId,
        title: options.title,
        diagram_xml: "",
        rendering_mode: "chart",
      };
      projects.set(project.id, project);
      return project;
    },
    async updateProjectDiagramXml(options) {
      const project = projects.get(options.projectId);
      if (project === undefined) throw new Error("missing project");
      const updated = { ...project, diagram_xml: options.diagramXml };
      projects.set(options.projectId, updated);
      return updated;
    },
    async updateProjectRenderingMode(options) {
      const project = projects.get(options.projectId);
      if (project === undefined) throw new Error("missing project");
      const updated = { ...project, rendering_mode: options.renderingMode };
      projects.set(options.projectId, updated);
      return updated;
    },
    async getProjectDiagramXml(projectId) {
      return projects.get(projectId)?.diagram_xml as string | undefined;
    },
  };
}

type Harness = {
  root: string;
  deps: AppToolDeps;
  tools: AppTool[];
  canvas: FakeCanvas;
};

function makeHarness(overrides: Partial<AppToolDeps> = {}): Harness {
  const root = tempDir();
  const workspace = join(root, "ws");
  const dataRoot = join(root, "data");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(dataRoot, "uploads"), { recursive: true });
  mkdirSync(join(dataRoot, "outputs"), { recursive: true });
  const canvas = fakeCanvas();
  const deps: AppToolDeps = {
    workspace: new NodeWorkspaceFs({
      userRoot: workspace,
      userPermission: "read_write",
      dataRoot,
      resourceRoot: join(root, "resources"),
      metaDir: join(workspace, ".meta"),
      cacheDir: join(workspace, ".cache"),
    }),
    docs: {
      tasks: createMemoryDocHost(initialTaskBoard()),
      teams: createMemoryDocHost(initialTeamStore()),
      plans: createMemoryDocHost(initialPlanStore()),
    },
    sessionId: "s1",
    workspaceId: "w1",
    now: () => new Date("2026-01-02T03:04:05"),
    canvas,
    ...overrides,
  };
  return { root, deps, tools: createAppTools(deps), canvas };
}

async function statusRoot(tools: readonly AppTool[]): Promise<string> {
  const status = JSON.parse(textOf(await run(byName(tools, "workspace_status"))));
  return status.user_workspace.workdir as string;
}

describe("app tool registry", () => {
  test("exposes the 36 typed tools in stable order", () => {
    const { tools } = makeHarness();
    expect(tools.map((tool) => tool.name)).toEqual([...APP_TOOL_NAMES]);
    expect(tools).toHaveLength(36);
  });

  test("replay policy: reads safe, mutations unsafe", () => {
    const { tools } = makeHarness();
    const safe = new Set([
      "workspace_status", "workspace_glob", "workspace_grep", "workspace_read_file",
      "structured_output", "task_get", "task_list", "team_list", "team_status",
      "select_chart", "propose_excel_export", "propose_report_outline",
      "propose_ppt_outline", "propose_dashboard_outline",
      "ask_user", "browse_webpage", "read_tool_result", "search_mcp_tools",
      "plan_complete", "get_diagram", "memory_read", "load_analysis_skill",
    ]);
    for (const tool of tools) {
      expect({ name: tool.name, replay: tool.replay }).toEqual({
        name: tool.name,
        replay: safe.has(tool.name) ? "safe" : "unsafe",
      });
    }
  });
});

describe("workspace tools", () => {
  test("status/glob/grep/read round-trip", async () => {
    const { tools } = makeHarness();
    writeFileSync(join((await statusRoot(tools)), "notes.md"), "alpha\nbeta\n", "utf8");
    const status = JSON.parse(textOf(await run(byName(tools, "workspace_status"))));
    expect(status.user_workspace.mounted).toBe(true);
    expect(status.system_workspace.roots.map((root: { name: string }) => root.name)).toEqual(["uploads", "outputs", "mcp"]);

    const glob = JSON.parse(textOf(await run(byName(tools, "workspace_glob"), { pattern: "**/*.md" })));
    expect(glob.matches).toEqual([expect.objectContaining({ path: "user/notes.md" })]);
    expect(glob.total).toBe(1);

    const grep = JSON.parse(textOf(await run(byName(tools, "workspace_grep"), { pattern: "bet" })));
    expect(grep.matches).toEqual([{ path: "user/notes.md", line: 2, text: "beta" }]);

    const read = JSON.parse(textOf(await run(byName(tools, "workspace_read_file"), { file_path: "user/notes.md" })));
    expect(read.content).toBe("1: alpha\n2: beta");
    expect(read.total_lines).toBe(2);
    expect(read.next_offset).toBeNull();
  });

  test("read before write, exact edit, mtime guard", async () => {
    const { tools } = makeHarness();
    const root = await statusRoot(tools);
    writeFileSync(join(root, "a.txt"), "one two\n", "utf8");
    const writeAgain = await run(byName(tools, "workspace_write_file"), { file_path: "a.txt", content: "x" });
    expect(writeAgain.isError).toBe(true);
    expect(textOf(writeAgain)).toBe("existing file must be read before it can be changed");

    await run(byName(tools, "workspace_read_file"), { file_path: "a.txt" });
    const edited = JSON.parse(textOf(await run(byName(tools, "workspace_edit_file"), {
      file_path: "a.txt",
      old_string: "two",
      new_string: "three",
    })));
    expect(edited).toEqual({ path: "user/a.txt", replacements: 1 });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one three\n");

    const duplicate = await run(byName(tools, "workspace_edit_file"), {
      file_path: "a.txt",
      old_string: "e",
      new_string: "E",
    });
    expect(textOf(duplicate)).toBe("old_string must occur exactly once; found 3");

    await run(byName(tools, "workspace_read_file"), { file_path: "a.txt" });
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, "a.txt"), future, future);
    const stale = await run(byName(tools, "workspace_edit_file"), {
      file_path: "a.txt",
      old_string: "three",
      new_string: "4",
    });
    expect(textOf(stale)).toBe("file changed after it was read; read it again before editing");
  });

  test("delete/move confirmations and directory guards", async () => {
    const { tools } = makeHarness();
    const root = (await statusRoot(tools));
    writeFileSync(join(root, "del.txt"), "x", "utf8");
    writeFileSync(join(root, "move.txt"), "y", "utf8");
    mkdirSync(join(root, "dir"));
    const denied = await run(byName(tools, "workspace_delete_file"), { file_path: "del.txt", confirm: false });
    expect(textOf(denied)).toBe("file deletion requires confirm=true");
    const directory = await run(byName(tools, "workspace_delete_file"), { file_path: "dir", confirm: true });
    expect(textOf(directory)).toBe("only files can be deleted; directory deletion is not supported");
    const deleted = JSON.parse(textOf(await run(byName(tools, "workspace_delete_file"), {
      file_path: "del.txt",
      confirm: true,
    })));
    expect(deleted.deleted).toBe(true);

    const moved = JSON.parse(textOf(await run(byName(tools, "workspace_move_file"), {
      source_path: "move.txt",
      destination_path: "moved.txt",
    })));
    expect(moved).toEqual({ source_path: "user/move.txt", path: "user/moved.txt", moved: true, overwritten: false });

    writeFileSync(join(root, "a.txt"), "a", "utf8");
    writeFileSync(join(root, "b.txt"), "b", "utf8");
    const overwrite = await run(byName(tools, "workspace_move_file"), {
      source_path: "a.txt",
      destination_path: "b.txt",
    });
    expect(textOf(overwrite)).toBe("destination exists; overwrite requires confirm_overwrite=true");
  });

  test("path policy rejects escapes, read-only roots, blocked and internal paths", async () => {
    const { tools } = makeHarness();
    const escape = await run(byName(tools, "workspace_read_file"), { file_path: "../outside.txt" });
    expect(textOf(escape)).toBe("path must stay inside the mounted workspace");
    const readonly = await run(byName(tools, "workspace_write_file"), {
      file_path: "workspace://uploads/x.txt",
      content: "x",
    });
    expect(textOf(readonly)).toBe("system workspace root 'uploads' is read-only");
    mkdirSync(join((await statusRoot(tools)), ".ssh"), { recursive: true });
    writeFileSync(join((await statusRoot(tools)), ".ssh", "config"), "x", "utf8");
    const blocked = await run(byName(tools, "workspace_read_file"), { file_path: ".ssh/config" });
    expect(textOf(blocked)).toBe("path is blocked by workspace security policy");
    mkdirSync(join((await statusRoot(tools)), ".meta"), { recursive: true });
    writeFileSync(join((await statusRoot(tools)), ".meta", "x"), "x", "utf8");
    const internal = await run(byName(tools, "workspace_read_file"), { file_path: ".meta/x" });
    expect(textOf(internal)).toBe("internal workspace metadata cannot be accessed");
    const outside = tempDir("app-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(outside, join(await statusRoot(tools), "link"));
    const symlinkEscape = await run(byName(tools, "workspace_read_file"), { file_path: "link/secret.txt" });
    expect(textOf(symlinkEscape)).toBe("path must stay inside the mounted workspace");
    const globEscape = await run(byName(tools, "workspace_glob"), { pattern: "**/*", path: "../" });
    expect(textOf(globEscape)).toBe("path must stay inside the mounted workspace");
  });

  test("missing file error carries document candidates", async () => {
    const { tools } = makeHarness();
    writeFileSync(join(await statusRoot(tools), "说明文档.md"), "doc", "utf8");
    const result = await run(byName(tools, "workspace_read_file"), { file_path: "readme.txt" });
    expect(textOf(result)).toContain("file not found: readme.txt");
    expect(textOf(result)).toContain("Document candidates include: user/说明文档.md");
  });

  test("docx and xlsx previews", async () => {
    const { tools } = makeHarness();
    const root = await statusRoot(tools);
    writeFileSync(join(root, "a.docx"), makeDocx());
    writeFileSync(join(root, "a.xlsx"), makeXlsx());
    const docx = JSON.parse(textOf(await run(byName(tools, "workspace_read_file"), { file_path: "a.docx" })));
    expect(docx.content).toBe("1: Hello\n2: World");
    const xlsx = JSON.parse(textOf(await run(byName(tools, "workspace_read_file"), { file_path: "a.xlsx" })));
    expect(xlsx.sheet_name).toBe("Sheet1");
    expect(xlsx.sheets).toEqual(["Sheet1"]);
    expect(xlsx.content).toBe("1: Name\tValue\n2: 42\thello");
    const sheetMissing = await run(byName(tools, "workspace_read_file"), { file_path: "a.xlsx", sheet_name: "Nope" });
    expect(textOf(sheetMissing)).toContain("worksheet not found: Nope");
  });

  test("restricted bash whitelist and confirmations", async () => {
    const { tools } = makeHarness();
    const root = await statusRoot(tools);
    writeFileSync(join(root, "hello.txt"), "hello\n", "utf8");
    writeFileSync(join(root, "a b.txt"), "spaced\n", "utf8");
    writeFileSync(join(root, "ok.json"), '{"a":1}', "utf8");
    const pwd = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), { command: "pwd" })));
    expect(pwd.output).toEqual({ path: "workspace://user", name: "ws" });
    const cat = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), { command: 'cat "a b.txt"' })));
    expect(cat.output.content).toBe("1: spaced");
    const checksum = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), { command: "sha256sum hello.txt" })));
    expect(checksum.output.sha256).toBe(createHash("sha256").update("hello\n").digest("hex"));
    const validated = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), { command: "json validate ok.json" })));
    expect(validated.output.valid).toBe(true);
    const pipe = await run(byName(tools, "workspace_bash"), { command: "cat hello.txt | wc" });
    expect(textOf(pipe)).toContain("shell operators, pipes, redirection");
    const unknown = await run(byName(tools, "workspace_bash"), { command: "curl http://x" });
    expect(textOf(unknown)).toContain("unsupported command; allowed:");
    const rmDenied = await run(byName(tools, "workspace_bash"), { command: "rm hello.txt" });
    expect(textOf(rmDenied)).toBe("file deletion requires confirm=true");
    const rm = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), {
      command: "rm hello.txt",
      confirm: true,
    })));
    expect(rm.output.deleted).toBe(true);
    expect(() => tokenizeCommand("cat 'unterminated")).toThrow("No closing quotation");
  });

  test("bash default path falls back to uploads without a mounted workspace", async () => {
    const root = tempDir();
    const dataRoot = join(root, "data");
    mkdirSync(join(dataRoot, "uploads"), { recursive: true });
    writeFileSync(join(dataRoot, "uploads", "up.txt"), "u", "utf8");
    const tools = createAppTools({
      workspace: new NodeWorkspaceFs({ dataRoot, userPermission: "read_only" }),
      sessionId: "s1",
    });
    const ls = JSON.parse(textOf(await run(byName(tools, "workspace_bash"), { command: "ls" })));
    expect(ls.output.matches).toEqual([expect.objectContaining({ path: "uploads/up.txt" })]);
    const cat = await run(byName(tools, "workspace_read_file"), { file_path: "up.txt" });
    expect(textOf(cat)).toBe("no workspace is mounted for this session");
  });
});

describe("task and team stores", () => {
  test("task lifecycle and validation", async () => {
    const { tools } = makeHarness();
    const created = JSON.parse(textOf(await run(byName(tools, "task_create"), {
      title: "Write spec",
      description: "draft",
      blocks: ["b", "b"],
    })));
    expect(created.id).toHaveLength(10);
    expect(created.blocks).toEqual(["b"]);
    expect(created.created_at).toBe("2026-01-02T03:04:05");
    const listed = JSON.parse(textOf(await run(byName(tools, "task_list"), { status: "pending" })));
    expect(listed).toHaveLength(1);
    const updated = JSON.parse(textOf(await run(byName(tools, "task_update"), {
      task_id: created.id,
      status: "completed",
      add_blocked_by: ["x"],
    })));
    expect(updated.status).toBe("completed");
    expect(updated.blocked_by).toEqual(["x"]);
    const got = JSON.parse(textOf(await run(byName(tools, "task_get"), { task_id: created.id })));
    expect(got.title).toBe("Write spec");
    const badStatus = await run(byName(tools, "task_list"), { status: "done" });
    expect(textOf(badStatus)).toBe("invalid task status");
    const missing = await run(byName(tools, "task_get"), { task_id: "nope" });
    expect(textOf(missing)).toBe("task not found: nope");
    const noTitle = await run(byName(tools, "task_create"), { title: "  " });
    expect(textOf(noTitle)).toBe("task title is required");
  });

  test("teams: quality reviewer, mailbox protection, delegation plans", async () => {
    const { tools } = makeHarness();
    const created = JSON.parse(textOf(await run(byName(tools, "team_create"), {
      name: "研究组",
      description: "team",
      members: [{ name: "analyst", role: "analyst", instructions: "be careful" }],
    })));
    expect(created.members.map((member: { name: string }) => member.name)).toEqual(["analyst", "质量复核员"]);
    expect(created.quality_reviewer).toEqual({ name: "质量复核员", auto_added: true });

    const duplicate = await run(byName(tools, "team_create"), {
      name: "dup",
      members: [{ name: "a" }, { name: "a" }],
    });
    expect(textOf(duplicate)).toBe("duplicate member: a");

    const sent = JSON.parse(textOf(await run(byName(tools, "send_message"), {
      team_name: "研究组",
      recipient: "leader",
      message: "hello",
    })));
    expect(sent.sent).toBe(1);
    const status = JSON.parse(textOf(await run(byName(tools, "team_status"), { name: "研究组" })));
    expect(status.lead_unread_messages).toBe(1);
    const protectedDelete = await run(byName(tools, "team_delete"), { name: "研究组" });
    expect(textOf(protectedDelete)).toContain("默认保留以便复盘");
    const forced = JSON.parse(textOf(await run(byName(tools, "team_delete"), { name: "研究组", force: true })));
    expect(forced).toEqual({ deleted: "研究组", force: true });

    await run(byName(tools, "team_create"), { name: "另一个组", members: [{ name: "b" }] });
    const broadcast = JSON.parse(textOf(await run(byName(tools, "send_message"), {
      team_name: "另一个组",
      recipient: "*",
      message: "all",
    })));
    expect(broadcast.sent).toBe(2);
    const unknown = await run(byName(tools, "send_message"), {
      team_name: "另一个组",
      recipient: "nobody",
      message: "x",
    });
    expect(textOf(unknown)).toBe("member not found: nobody");
    const teams = JSON.parse(textOf(await run(byName(tools, "team_list"))));
    expect(teams.map((team: { name: string }) => team.name)).toEqual(["另一个组"]);

    const plan = JSON.parse(textOf(await run(byName(tools, "team_plan_create"), {
      team_name: "另一个组",
      goal: "g",
      assignments: [
        { task_id: "a", member_name: "b", prompt: "p1" },
        { task_id: "b", member_name: "b", prompt: "p2", depends_on: ["a"] },
      ],
    })));
    expect(plan.plan.id.startsWith("tp_")).toBe(true);
    expect(plan.plan.status).toBe("planned");
    expect(plan.plan.budget.task_count).toBe(2);

    const cycle = await run(byName(tools, "team_plan_create"), {
      team_name: "另一个组",
      goal: "g",
      assignments: [
        { task_id: "a", member_name: "b", prompt: "p", depends_on: ["b"] },
        { task_id: "b", member_name: "b", prompt: "p", depends_on: ["a"] },
      ],
    });
    expect(textOf(cycle)).toBe("dynamic task dependencies contain a cycle");
    const duplicated = await run(byName(tools, "team_plan_create"), {
      team_name: "另一个组",
      goal: "g",
      assignments: [
        { task_id: "a", member_name: "b", prompt: "p" },
        { task_id: "a", member_name: "b", prompt: "p" },
      ],
    });
    expect(textOf(duplicated)).toBe("duplicate dynamic task id");
  });
});

describe("charts, proposals, interaction", () => {
  test("select_chart ranks trend charts and returns empty guidance", async () => {
    const { tools } = makeHarness();
    const result = textOf(await run(byName(tools, "select_chart"), { user_intent: "各月销售额趋势" }));
    expect(result).toContain("### 选项 1：折线图");
    expect(result).toContain("`['x', 'y']`");
    expect(result).toContain("**下一步操作**");
    const empty = textOf(await run(byName(tools, "select_chart"), { user_intent: "zzzz" }));
    expect(empty).toBe(
      "No matching charts found in the registry. Use `ask_user` to confirm the visualization goal before selecting a chart.",
    );
  });

  test("proposals never write files and match old markdown", async () => {
    const { tools } = makeHarness();
    const excel = textOf(await run(byName(tools, "propose_excel_export"), {
      tables: ["t1", "t2"],
      filename: "out",
      summary: "s",
    }));
    expect(excel).toBe("导出计划已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。");
    const report = await run(byName(tools, "propose_report_outline"), {
      title: "报告",
      sections: [{ heading: "H", content: "C" }],
    });
    expect(report.details!.markdown).toBe("**报告**（共 1 个章节）\n\n| # | 章节标题 |\n|---|---------|\n| 1 | H |");
    const emptyReport = await run(byName(tools, "propose_report_outline"), { title: " ", sections: [] });
    expect(textOf(emptyReport)).toBe("'propose_report_outline' requires a non-empty 'title'.");
    const ppt = await run(byName(tools, "propose_ppt_outline"), { title: "T", slides: [] });
    expect(textOf(ppt)).toContain("ERROR: slides array is empty.");
    const dash = await run(byName(tools, "propose_dashboard_outline"), { name: "D", widgets: [] });
    expect(textOf(dash)).toContain("ERROR: widgets array is empty.");
  });

  test("pptx color scheme updates session preference", async () => {
    const holder = { value: "mckinsey" };
    const { tools } = makeHarness({ colorScheme: holder });
    const result = await run(byName(tools, "set_ppt_color_scheme"), { scheme: "BCG" });
    expect(textOf(result)).toBe("✅ 配色已切换为「BCG Green」（波士顿咨询绿色配色），后续图表和 PPT 均使用此配色。");
    expect(holder.value).toBe("bcg");
    const unknown = await run(byName(tools, "set_ppt_color_scheme"), { scheme: "zebra" });
    expect(textOf(unknown)).toBe(
      "未知配色方案 'zebra'。可用方案：mckinsey, bcg, bain, ey",
    );
  });

  test("ask_user normalizes options and rejects invalid menus", async () => {
    const { tools } = makeHarness();
    const result = await run(byName(tools, "ask_user"), {
      question: " 方向？ ",
      options: [{ label: "盈利" }, { label: "盈利" }, { text: "结构" }],
      multi_select: true,
    });
    expect(result.details).toEqual({
      tool: "ask_user",
      question: "方向？",
      options: ["盈利", "结构"],
      multi_select: true,
    });
    const empty = await run(byName(tools, "ask_user"), { question: "q", options: [] });
    expect(textOf(empty)).toBe("'ask_user': 'options' cannot be empty; provide 2-6 items (error code: ASKU-001).");
    const single = await run(byName(tools, "ask_user"), { question: "q", options: ["a"] });
    expect(textOf(single)).toBe("'ask_user': 'options' must contain 2-6 items (error code: ASKU-002).");
  });

  test("structured_output and plan_complete", async () => {
    const { tools } = makeHarness();
    const bad = await run(byName(tools, "structured_output"), { output: 1 });
    expect(textOf(bad)).toBe("output must be an object, array, or string");
    const missing = await run(byName(tools, "structured_output"), { output: { a: 1 }, required_fields: ["b"] });
    expect(textOf(missing)).toBe("missing required fields: b");
    const wrongShape = await run(byName(tools, "structured_output"), { output: [], required_fields: ["a"] });
    expect(textOf(wrongShape)).toBe("required_fields can only validate object output");
    const plan = JSON.parse(textOf(await run(byName(tools, "plan_complete"), {
      summary: "done",
      steps: [{ id: 1 }],
    })));
    expect(plan).toEqual({ summary: "done", steps: [{ id: 1 }] });
  });

  test("load_analysis_skill loads SOP text and rejects unknown names", async () => {
    const skillsDir = tempDir();
    writeFileSync(
      join(skillsDir, "trend.md"),
      "---\nname: trend\ndescription: trend analysis\nallowedTools: []\n---\nFollow the trend SOP.\n",
      "utf8",
    );
    const { tools } = makeHarness({ skillDirs: { builtinDir: skillsDir } });
    const loaded = textOf(await run(byName(tools, "load_analysis_skill"), { name: "trend" }));
    expect(loaded).toContain("[SKILL LOADED: trend]");
    expect(loaded).toContain("Follow the trend SOP.");
    const unknown = await run(byName(tools, "load_analysis_skill"), { name: "nope" });
    expect(textOf(unknown)).toBe("ERROR: unknown analysis skill. Check available skills in the system prompt.");
  });

  test("memory_read returns record body or unavailable text", async () => {
    const memoryRoot = tempDir();
    mkdirSync(join(memoryRoot, "memories"), { recursive: true });
    writeFileSync(
      join(memoryRoot, "memories", "pref.md"),
      "---\nname: pref\ntype: user\ntitle: 偏好\ncreated_at: '2026-01-01'\n---\n喜欢简洁回答。\n",
      "utf8",
    );
    const { tools } = makeHarness({ memoryDirs: { userDir: memoryRoot } });
    const found = textOf(await run(byName(tools, "memory_read"), { name: "pref" }));
    expect(found).toBe("[user] 偏好\n喜欢简洁回答。");
    const missing = textOf(await run(byName(tools, "memory_read"), { name: "unknown" }));
    expect(missing).toBe("Memory record is unavailable in the current scope.");
  });
});

describe("artifacts, web and diagrams", () => {
  test("read_tool_result verifies sha and pages", async () => {
    const dir = tempDir();
    const data = "0123456789 needle here";
    const sha = createHash("sha256").update(data, "utf8").digest("hex");
    writeFileSync(
      join(dir, "tr_abc123.json"),
      JSON.stringify({
        version: 1,
        artifact_id: "tr_abc123",
        session_id: "s1",
        workspace_id: "w1",
        tool: "query_data",
        sha256: sha,
        data,
      }),
      "utf8",
    );
    const refs: ToolResultArtifactRef[] = [{
      artifact_id: "tr_abc123",
      session_id: "s1",
      workspace_id: "w1",
      sha256: sha,
    }];
    const { tools } = makeHarness({
      artifacts: {
        allowed: () => refs,
        async load(id) {
          const record = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
          return { ...record };
        },
      },
    });
    const paged = JSON.parse(textOf(await run(byName(tools, "read_tool_result"), {
      artifact_id: "tr_abc123",
      offset: 3,
      limit: 5,
    })));
    expect(paged.content).toBe("34567");
    expect(paged.next_offset).toBe(8);
    const queried = JSON.parse(textOf(await run(byName(tools, "read_tool_result"), {
      artifact_id: "tr_abc123",
      query: "needle",
    })));
    expect(queried.match_count).toBe(1);
    expect(queried.content).toContain("needle here");
    const notAllowed = await run(byName(tools, "read_tool_result"), { artifact_id: "tr_zzz" });
    expect(textOf(notAllowed)).toBe("artifact is not available in this session");
    const noSession = makeHarness({ sessionId: "", artifacts: { allowed: () => [], load: async () => undefined } });
    const required = await run(byName(noSession.tools, "read_tool_result"), { artifact_id: "tr_abc123" });
    expect(textOf(required)).toBe("active session is required");
    const wrongWorkspace = makeHarness({ workspaceId: "w2", artifacts: { allowed: () => refs, load: async () => undefined } });
    const mismatch = await run(byName(wrongWorkspace.tools, "read_tool_result"), { artifact_id: "tr_abc123" });
    expect(textOf(mismatch)).toBe("artifact belongs to a different workspace");
  });

  test("search_mcp_tools filters by server and returns compact matches", async () => {
    const recorded: string[][] = [];
    const { tools } = makeHarness({
      mcpCatalog: {
        read: () => ({
          version: "v1",
          catalog: [
            {
              name: "mcp__github__create_issue",
              server: "github",
              summary: "Create an issue in a repository",
              keywords: ["github", "issue", "create", "repository"],
              schema_hash: "h1",
            },
            {
              name: "mcp__slack__post_message",
              server: "slack",
              summary: "Post a message to a channel",
              keywords: ["slack", "post", "message", "channel"],
              schema_hash: "h2",
            },
          ],
        }),
        record: (names) => recorded.push([...names]),
      },
    });
    const result = JSON.parse(textOf(await run(byName(tools, "search_mcp_tools"), { query: "github issue" })));
    expect(result.matches).toEqual([
      { name: "mcp__github__create_issue", server: "github", summary: "Create an issue in a repository", schema_hash: "h1" },
    ]);
    expect(result.hint).toBe("Matched tools will be available on the next model step.");
    expect(recorded).toEqual([["mcp__github__create_issue"]]);
    const filtered = await run(byName(tools, "search_mcp_tools"), { query: "message", server: "github" });
    expect(JSON.parse(textOf(filtered)).matches).toEqual([]);
    const absent = makeHarness();
    const empty = JSON.parse(textOf(await run(byName(absent.tools, "search_mcp_tools"), { query: "x" })));
    expect(empty.matches).toEqual([]);
    expect(empty.hint).toBe("No connected MCP tool matched this query.");
  });

  test("browse_webpage blocks private hosts and formats html", async () => {
    const html =
      "<html><head><title>Docs</title><script>x</script></head>" +
      "<body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>";
    const requested: string[] = [];
    const { tools } = makeHarness({
      fetch: (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }) as typeof fetch,
    });
    const result = textOf(await run(byName(tools, "browse_webpage"), { url: "http://93.184.216.34/docs" }));
    expect(result).toContain("Title: Docs");
    expect(result).toContain("Title\nHello & welcome");
    expect(result.endsWith("Hello & welcome")).toBe(true);
    const privateUrl = await run(byName(tools, "browse_webpage"), { url: "http://127.0.0.1/x" });
    expect(textOf(privateUrl)).toBe("local/private network URLs are not allowed");
    const localhost = await run(byName(tools, "browse_webpage"), { url: "http://localhost/x" });
    expect(textOf(localhost)).toBe("local/private network URLs are not allowed");
    const missing = await run(byName(tools, "browse_webpage"), { url: "" });
    expect(textOf(missing)).toBe("url is required");
    expect(requested).toHaveLength(1);
  });

  test("display/edit/get diagram with content fill and cell operations", async () => {
    const { tools, canvas } = makeHarness();
    const display = await run(byName(tools, "display_diagram"), {
      template_id: "bcg_matrix",
      content: { stars: "Star product" },
      title: "BCG",
    });
    expect(display.details!.ok).toBe(true);
    expect(textOf(display)).toContain("Star product");
    const projectId = (display.details!.project as { id: string }).id;
    expect(canvas.projects.get(projectId)?.rendering_mode).toBe("diagram");

    const current = await run(byName(tools, "get_diagram"), { project_id: projectId });
    expect(current.details!.ok).toBe(true);
    expect(typeof current.details!.xml).toBe("string");

    const edited = await run(byName(tools, "edit_diagram"), {
      project_id: projectId,
      operations: [{
        operation: "update",
        cell_id: "5",
        new_xml: '<mxCell id="5" value="New question" vertex="1" parent="1"><mxGeometry/></mxCell>',
      }],
    });
    expect(edited.details!.ok).toBe(true);
    expect(textOf(edited)).toContain("New question");

    const deleted = await run(byName(tools, "edit_diagram"), {
      project_id: projectId,
      operations: [{ operation: "delete", cell_id: "5" }],
    });
    expect(deleted.details!.ok).toBe(true);
    expect(textOf(deleted)).not.toContain('id="5"');

    const missing = await run(byName(tools, "display_diagram"), { xml: '<mxCell id="2" ' });
    expect(missing.isError).toBe(true);
    const noContent = await run(byName(tools, "display_diagram"), { content: { stars: "x" } });
    expect(textOf(noContent)).toBe('{"ok":false,"error":"template_id is required when using content mode"}');
    const unknownProject = await run(byName(tools, "get_diagram"), { project_id: "none" });
    expect(textOf(unknownProject)).toContain("Canvas project none not found");
  });
});

describe("zip reader", () => {
  test("reads stored entries", () => {
    const buffer = makeDocx();
    const entry = listZipEntries(buffer).find((item) => item.name === "word/document.xml");
    expect(entry).toBeDefined();
    expect(readZipEntry(buffer, entry!, 1024 * 1024).toString("utf8")).toContain("<w:t>Hello</w:t>");
    expect(listZipEntries(zip([{ name: "a.txt", data: deflateRawSync(Buffer.from("x")).toString("latin1") }]))).toHaveLength(1);
  });
});
