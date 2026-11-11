import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness as HarnessClass, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { migrateOldData, sessionEntries } from "../scripts/migrate-old-data.ts";

/**
 * 迁移脚本的验收：用一份「旧版本会写出什么」的合成数据跑一遍，再读新存储确认内容对得上。
 *
 * 旧格式按 `api/saved_sessions.py::save_session` 与 `data/jobs_store.py`、
 * `data/workflow_run_store.py` 的字段写；不依赖用户真的在本机跑过旧版。
 */
const roots: string[] = [];

function makeOldRoot(): { old: string; next: string } {
  const base = mkdtempSync(join(tmpdir(), "dw-migrate-"));
  roots.push(base);
  const old = join(base, "old");
  const next = join(base, "new");
  mkdirSync(join(old, "outputs", "Session"), { recursive: true });
  mkdirSync(join(old, "outputs", "jobs"), { recursive: true });
  mkdirSync(join(old, "outputs", "workflows", "ws-1"), { recursive: true });

  writeFileSync(
    join(old, "outputs", "Session", "月度复盘_20260101_090000.json"),
    JSON.stringify({
      name: "月度复盘",
      saved_at: "2026-01-01T09:00:00",
      session_id: "abc",
      model_provider: "deepseek",
      total_input_tokens: 120,
      total_output_tokens: 40,
      history: [
        { role: "system", content: "ignored" },
        { role: "user", content: "看一下订单表" },
        {
          role: "assistant",
          content: "",
          reasoning: "先看结构",
          tool_calls: [{ id: "call-1", function: { name: "get_schema", arguments: "{\"table\":\"orders\"}" } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "columns: id, amount", chart_ids: ["c1"] },
        { role: "assistant", content: [{ type: "text", text: "订单表有 id 与 amount 两列。" }] },
      ],
    }),
    "utf8",
  );
  // 空的旧会话文件：跳过并记录原因，不能让整次迁移失败。
  writeFileSync(join(old, "outputs", "Session", "empty.json"), JSON.stringify({ name: "空", history: [] }), "utf8");
  writeFileSync(join(old, "outputs", "Session", "broken.json"), "{not json", "utf8");

  const jobs = new Database(join(old, "outputs", "jobs", "jobs.db"));
  jobs.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, label TEXT, parent_id TEXT,
    status TEXT, progress REAL, message TEXT, result TEXT, error TEXT,
    created_at TEXT, started_at TEXT, finished_at TEXT)`);
  jobs
    .query("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("job-1", "abc", "analysis", "跑一次回归", "", "done", 100, "完成", JSON.stringify({ rows: 3 }), null, "2026-01-01T09:00:00", "2026-01-01T09:00:01", "2026-01-01T09:00:02");
  jobs.close();

  const runs = new Database(join(old, "outputs", "workflows", "ws-1", "runs.db"));
  runs.exec(`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_version_id TEXT, workspace_id TEXT, session_id TEXT,
    status TEXT, input_json TEXT, started_by TEXT, started_at TEXT, updated_at TEXT, finished_at TEXT,
    cancel_requested_at TEXT, failure_code TEXT, failure_message TEXT, input_manifest_id TEXT)`);
  runs.exec(`CREATE TABLE workflow_node_runs (id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, iteration INTEGER, attempt INTEGER,
    status TEXT, agent_profile_id TEXT, job_id TEXT, input_json TEXT, output_json TEXT, input_manifest_id TEXT,
    output_manifest_id TEXT, operation_key TEXT)`);
  runs
    .query("INSERT INTO workflow_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("run-1", "wf@1", "ws-1", "abc", "succeeded", "{}", "u1", "2026-01-01T09:00:00", "2026-01-01T09:05:00", "2026-01-01T09:05:00", null, "", "", "");
  runs
    .query("INSERT INTO workflow_node_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("node-1", "run-1", "collect", 1, 1, "succeeded", "p1", "job-1", "{}", JSON.stringify({ output: "ok" }), "", "", "op-1");
  runs.close();

  return { old, next };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("旧数据迁移", () => {
  test("旧历史映射成 entry 草稿：跳过 system、保留工具调用与结果", () => {
    const entries = sessionEntries({
      history: [
        { role: "system", content: "x" },
        { role: "user", content: "问题" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "get_schema", arguments: "{}" } }] },
        { role: "assistant", content: "回答" },
      ],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.assistant"]);
    const call = entries[1]!.model![0] as { content: { type: string; name?: string }[] };
    expect(call.content[0]).toMatchObject({ type: "tool-call", name: "get_schema" });
  });

  test("dry-run 不写入任何东西", async () => {
    const { old, next } = makeOldRoot();
    const report = await migrateOldData({ from: old, to: next, dryRun: true });
    expect(report.sessions.filter((item) => item.skipped === undefined)).toHaveLength(1);
    expect(report.jobs.imported).toBe(1);
    expect(report.runs.imported).toBe(1);
    expect(() => readFileSync(join(next, "datawhisper.sqlite"))).toThrow();
  });

  test("导入会话、job 与运行记录，重复执行不产生重复项", async () => {
    const { old, next } = makeOldRoot();
    const report = await migrateOldData({ from: old, to: next });
    const imported = report.sessions.find((item) => item.skipped === undefined)!;
    expect(imported.messages).toBe(4);
    const skipped = report.sessions.filter((item) => item.skipped !== undefined).map((item) => `${item.file}:${item.skipped}`);
    expect(skipped).toContain("empty.json:no messages");
    expect(skipped.some((line) => line.startsWith("broken.json:unreadable"))).toBe(true);

    // 会话内容进 pi-durable：读回条目确认顺序与正文。
    const harness = await HarnessClass.open(await openNodeSqliteStorage(join(next, "datawhisper.sqlite")), {
      models: createModels(),
      registry: createRegistry(),
      identity: { attribution: null },
    } as never, ctx);
    try {
      const conversation = (await harness.conversation(imported.conversationId as never, ctx))!;
      const page = await conversation.entries({ order: "ascending" }, 100, undefined, ctx);
      expect(page.items.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant"]);
      const first = page.items[0]!.model?.[0];
      expect(first !== undefined && "content" in first ? first.content : undefined).toBe("看一下订单表");
      const toolResult = page.items[2]!;
      expect(toolResult.data).toEqual({ chart_ids: ["c1"] });
    } finally {
      await harness.close(ctx);
    }

    const library = new Database(join(next, "library.sqlite"), { readonly: true });
    try {
      const meta = library.query("SELECT title, created_at FROM session_meta WHERE conversation_id = ?").get(String(imported.conversationId)) as
        | { title: string; created_at: string }
        | null;
      expect(meta?.title).toBe("月度复盘");
      expect(meta?.created_at.length).toBeGreaterThan(0);
      expect((library.query("SELECT COUNT(*) AS n FROM archive_jobs").get() as { n: number }).n).toBe(1);
      expect((library.query("SELECT COUNT(*) AS n FROM archive_runs").get() as { n: number }).n).toBe(1);
      expect((library.query("SELECT COUNT(*) AS n FROM archive_node_runs").get() as { n: number }).n).toBe(1);
      const job = library.query("SELECT label, status, result FROM archive_jobs").get() as { label: string; status: string; result: string };
      expect(job.label).toBe("跑一次回归");
      expect(JSON.parse(job.result)).toEqual({ rows: 3 });
    } finally {
      library.close();
    }

    // 再跑一次：会话会多出一个（脚本按文件导入，不认重），job/运行记录靠 source 主键去重。
    const again = await migrateOldData({ from: old, to: next });
    expect(again.jobs.imported).toBe(0);
    expect(again.jobs.skipped).toBe(1);
    expect(again.runs.imported).toBe(1);
    const library2 = new Database(join(next, "library.sqlite"), { readonly: true });
    try {
      expect((library2.query("SELECT COUNT(*) AS n FROM archive_jobs").get() as { n: number }).n).toBe(1);
      expect((library2.query("SELECT COUNT(*) AS n FROM archive_runs").get() as { n: number }).n).toBe(1);
    } finally {
      library2.close();
    }
  });
});
