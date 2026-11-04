import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemoryRecords } from "../src/agent/memory.ts";
import { ComputeError } from "../src/compute/client.ts";
import { loadConfig } from "../src/config.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError } from "../src/ipc/errors.ts";
import { createLibrary, type Library } from "../src/ipc/library.ts";
import type { MethodParams } from "../src/ipc/rpc.ts";
import { type Service, startService } from "../src/service.ts";

type Call = { method: string; params: Record<string, unknown> };
type Responder = (method: string, params: Record<string, unknown>) => unknown;
type FakeCompute = {
  calls: Call[];
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
};

function fakeCompute(responder: Responder): FakeCompute {
  const calls: Call[] = [];
  return {
    calls,
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      return responder(method, params) as T;
    },
  };
}

type Running = { service: Service; library: Library; fake: FakeCompute; dir: string };
const running: Running[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) {
    item.library.close();
    await item.service.stop();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

async function start(responder: Responder = () => ({ ok: true })): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "dw-library-test-"));
  const service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
  const fake = fakeCompute(responder);
  const library = createLibrary({
    harness: service.harness,
    context: service.context,
    conversations: service.conversations,
    compute: fake,
    dataDir: dir,
    dataRoot: dir,
    skillDirs: { builtinDir: join(dir, "skills") },
    commandDirs: { builtinDir: join(dir, "commands") },
    memoryDirs: { userDir: join(dir, "memory") },
  });
  const item = { service, library, fake, dir };
  running.push(item);
  return item;
}

async function rpc<T>(library: Library, method: string, params: MethodParams = {}): Promise<T> {
  const handler = library.methods[method];
  if (handler === undefined) throw new Error(`method not registered: ${method}`);
  // 有些方法（如 dashboard.get、hooks.save 的校验）会同步抛错；async 让它们同样变成 rejected promise，
  // 测试里的 rpcError 才能统一处理。
  return (await handler(params)) as T;
}

async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected an RPC error");
}

function userDraft(text: string) {
  return { kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] as never };
}

function assistantDraft(text: string, call?: { name: string; args: Record<string, unknown> }) {
  const content: unknown[] = [{ type: "text", text }];
  if (call !== undefined) content.push({ type: "toolCall", id: "call-1", name: call.name, arguments: call.args });
  return {
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "stub",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
    ] as never,
  };
}

async function addConversation(service: Service, drafts: unknown[]): Promise<number> {
  const conversation = await service.harness.createConversation({ ownership: { kind: "ownerless" } }, service.context);
  await conversation.commit(async (tx) => {
    for (const draft of drafts) await tx.appendEntry(conversation.id, draft as never);
  }, service.context);
  return conversation.id;
}

describe("session library", () => {
  test("rename, pin, archive, delete and list filtering", async () => {
    const { library, service } = await start();
    const first = await addConversation(service, [
      userDraft("帮我分析季度销售预测"),
      assistantDraft("## 结论\n销售上升", { name: "query_data", args: { sql: "select 1" } }),
    ]);
    const second = await addConversation(service, [userDraft("另一段对话")]);

    await rpc(library, "session.rename", { id: first, title: "季度复盘" });
    const pinned = await rpc<{ id: number; pinned: boolean; archived: boolean }>(library, "session.pin", {
      id: first,
      pinned: true,
    });
    expect(pinned.pinned).toBe(true);

    await rpc(library, "session.archive", { id: second, archived: true });
    const visible = await rpc<{ conversations: { id: number; title: string; pinned: boolean; archived: boolean }[] }>(
      library,
      "session.list",
      { includeModel: false, includeArchived: false },
    );
    const visibleIds = visible.conversations.map((item) => item.id);
    expect(visibleIds).toContain(first);
    expect(visibleIds).not.toContain(second);

    const withArchived = await rpc<{ conversations: { id: number; archived: boolean }[] }>(library, "session.list", {
      includeArchived: true,
      includeModel: false,
    });
    expect(withArchived.conversations.find((item) => item.id === second)?.archived).toBe(true);

    const removed = await rpc<{ deleted: boolean; alreadyDeleted: boolean }>(library, "session.delete", { id: second });
    expect(removed.deleted).toBe(true);
    const repeated = await rpc<{ id: string; title: string; deleted: boolean; alreadyDeleted: boolean }>(
      library,
      "session.delete",
      { id: second },
    );
    expect(repeated).toEqual({ id: String(second), title: "另一段对话", deleted: false, alreadyDeleted: true });

    const afterDelete = await rpc<{ conversations: { id: number }[] }>(library, "session.list", {
      includeArchived: true,
      includeModel: false,
    });
    expect(afterDelete.conversations.map((item) => item.id)).not.toContain(second);
  });

  test("search by body and export markdown with folded tool calls", async () => {
    const { library, service } = await start();
    const id = await addConversation(service, [
      userDraft("帮我分析季度销售预测"),
      assistantDraft("## 结论\n销售上升", { name: "query_data", args: { sql: "select 1" } }),
    ]);
    await rpc(library, "session.rename", { id, title: "季度复盘" });

    const search = await rpc<{ hits: { id: number; matchedIn: string; snippet: string }[] }>(library, "session.search", {
      query: "销售上升",
    });
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]?.id).toBe(id);
    expect(search.hits[0]?.matchedIn).toBe("body");
    expect(search.hits[0]?.snippet).toContain("销售上升");

    const exported = await rpc<{ filename: string; content: string }>(library, "session.export", { id, format: "md" });
    expect(exported.filename).toBe("季度复盘.md");
    expect(exported.content).toContain("# 季度复盘");
    expect(exported.content).toContain("## 用户");
    expect(exported.content).toContain("## 助手");
    expect(exported.content).toContain("- 工具调用: `query_data`");
    expect(exported.content).toContain('"sql":"select 1"');
    expect(exported.content.split("工具调用")).toHaveLength(2);
  });
});

describe("knowledge library", () => {
  test("passes kind/category through and aggregates when kind is omitted", async () => {
    const { library, fake } = await start((method, params) => {
      if (method === "knowledge.list") return { items: [{ kind: params.kind, category_id: params.category_id }] };
      if (method === "knowledge.parse") return { filename: "x.xlsx", format: "xlsx", preview: [], prompts: ["p"] };
      if (method === "knowledge.delete") throw new ComputeError("业务分类不存在", APP_ERROR, { kind: "not_found" });
      return { ok: true };
    });

    const items = await rpc<{ items: { kind: string; category_id: number }[] }>(library, "knowledge.list", {
      kind: "metric",
      categoryId: 2,
    });
    expect(items.items[0]?.kind).toBe("metric");
    expect(fake.calls.at(-1)).toEqual({ method: "knowledge.list", params: { kind: "metric", category_id: 2 } });

    const aggregate = await rpc<{ categories: unknown[]; metrics: unknown[]; rules: unknown[]; notes: unknown[] }>(
      library,
      "knowledge.list",
      {},
    );
    expect(aggregate.categories).toHaveLength(1);
    expect(aggregate.metrics).toHaveLength(1);
    expect(aggregate.rules).toHaveLength(1);
    expect(aggregate.notes).toHaveLength(1);
    expect(fake.calls.filter((call) => call.method === "knowledge.list")).toHaveLength(5);

    const parsed = await rpc<{ filename: string }>(library, "knowledge.parse", { filePath: "/tmp/a.xlsx" });
    expect(parsed.filename).toBe("x.xlsx");
    expect(fake.calls.at(-1)?.params).toEqual({ file_path: "/tmp/a.xlsx" });

    const removed = await rpc<{ deleted: boolean }>(library, "knowledge.remove", { kind: "category", id: 99 });
    expect(removed.deleted).toBe(false);
  });

  test("translates compute errors and makes deletes idempotent", async () => {
    const { library } = await start((method, params) => {
      if (method === "knowledge.parse") {
        throw new ComputeError("不支持的文件格式 .txt，请上传 .xlsx / .xls / .docx", INVALID_PARAMS, {
          kind: "unsupported_format",
        });
      }
      if (method === "knowledge.update") throw new ComputeError("metric 5 not found", APP_ERROR, { kind: "not_found" });
      if (method === "knowledge.deleteFile") throw new ComputeError("File not found: a.xlsx", APP_ERROR, { kind: "file_not_found" });
      return { ok: true, params };
    });

    const invalid = await rpcError(rpc(library, "knowledge.parse", { filePath: "/tmp/a.txt" }));
    expect(invalid.code).toBe(INVALID_PARAMS);
    expect(invalid.data?.kind).toBe("invalid_input");
    expect(invalid.data?.computeKind).toBe("unsupported_format");

    const missing = await rpcError(rpc(library, "knowledge.update", { kind: "metric", id: 5, fields: {} }));
    expect(missing.code).toBe(APP_ERROR);
    expect(missing.data?.kind).toBe("not_found");

    const file = await rpc<{ deleted: boolean; chunks: number }>(library, "knowledge.deleteFile", { filename: "a.xlsx" });
    expect(file).toEqual({ deleted: false, chunks: 0 });
  });
});

describe("memory library", () => {
  test("add/update/remove are visible to listMemoryRecords", async () => {
    const { library, dir } = await start();
    await rpc(library, "memory.add", {
      name: "team-language",
      type: "user",
      title: "回答偏好",
      body: "用中文回答",
      howToApply: "所有回答默认中文",
    });
    const dirs = { userDir: join(dir, "memory") };
    let records = listMemoryRecords(dirs);
    expect(records).toHaveLength(1);
    expect(records[0]?.body).toBe("用中文回答");
    expect(records[0]?.howToApply).toBe("所有回答默认中文");

    await rpc(library, "memory.update", { name: "team-language", body: "用简体中文回答" });
    records = listMemoryRecords(dirs);
    expect(records[0]?.body).toBe("用简体中文回答");

    const removed = await rpc<{ removed: boolean; trashId?: string }>(library, "memory.remove", { name: "team-language" });
    expect(removed.removed).toBe(true);
    expect(listMemoryRecords(dirs)).toHaveLength(0);
    expect(existsSync(join(dir, "outputs", ".trash", "memories", removed.trashId ?? "", "manifest.json"))).toBe(true);

    const again = await rpc<{ removed: boolean }>(library, "memory.remove", { name: "team-language" });
    expect(again.removed).toBe(false);
  });
});

describe("hooks library", () => {
  test("rejects invalid settings and persists a valid one atomically", async () => {
    const { library, dir } = await start();
    const bad = await rpcError(
      rpc(library, "hooks.save", {
        hooks: [{ id: "bad", event: "not-an-event", action: { type: "prompt", message: "x" } }],
      }),
    );
    expect(bad.code).toBe(INVALID_PARAMS);
    expect(existsSync(join(dir, "config", "hooks.json"))).toBe(false);

    const saved = await rpc<{ settings: { hooks: { id: string }[] } }>(library, "hooks.save", {
      hooks: [{ id: "rule-1", name: "提示", event: "turn_start", action: { type: "prompt", message: "hello" } }],
    });
    expect(saved.settings.hooks).toHaveLength(1);
    const onDisk = JSON.parse(readFileSync(join(dir, "config", "hooks.json"), "utf8")) as { hooks: { id: string }[] };
    expect(onDisk.hooks[0]?.id).toBe("rule-1");

    const listed = await rpc<{ hooks: { id: string; eventDispatched: boolean }[] }>(library, "hooks.list", {});
    expect(listed.hooks[0]?.id).toBe("rule-1");
    expect(listed.hooks[0]?.eventDispatched).toBe(true);

    const first = await rpc<{ removed: boolean }>(library, "hooks.remove", { id: "rule-1" });
    expect(first.removed).toBe(true);
    const second = await rpc<{ removed: boolean }>(library, "hooks.remove", { id: "rule-1" });
    expect(second.removed).toBe(false);
  });
});

describe("dashboard library", () => {
  test("CRUD on the old Dashboard path and a self-contained HTML export", async () => {
    const { library, fake, dir } = await start((method) => {
      if (method === "dashboard.exportHtml") {
        return {
          filename: "exported.html",
          html: [
            "<html><head>",
            '<link rel="stylesheet" href="https://cdn.example/x.css">',
            "</head><body>",
            '<img src="https://cdn.example/a.png">',
            '<script src="https://cdn.example/x.js"></script>',
            "<p>ok</p>",
            "</body></html>",
          ].join(""),
        };
      }
      return { ok: true };
    });

    const created = await rpc<{ id: string; name: string }>(library, "dashboard.create", {
      name: "销售 看板",
      widgets: [{ id: "w1", chart_type: "Bar_Chart", grid: { x: 0, y: 0, w: 6, h: 4 } }],
    });
    const storedPath = join(dir, "outputs", "Dashboard", `${created.id}.json`);
    expect(existsSync(storedPath)).toBe(true);
    const stored = JSON.parse(readFileSync(storedPath, "utf8")) as { name: string; widgets: unknown[] };
    expect(stored.name).toBe("销售 看板");
    expect(stored.widgets).toHaveLength(1);

    const got = await rpc<{ name: string; widgets: { id: string; grid: { x: number } }[] }>(library, "dashboard.get", {
      id: created.id,
    });
    expect(got.name).toBe("销售 看板");

    const updated = await rpc<{ ok: boolean; dashboard: { name: string; widgets: { id: string; grid: { x: number } }[] } }>(
      library,
      "dashboard.update",
      { id: created.id, name: "销售看板", widgets: [{ id: "w1", grid: { x: 1, y: 0, w: 5, h: 4 } }] },
    );
    expect(updated.ok).toBe(true);
    const after = await rpc<{ name: string; widgets: { grid: { x: number } }[] }>(library, "dashboard.get", {
      id: created.id,
    });
    expect(after.name).toBe("销售看板");
    expect(after.widgets[0]?.grid.x).toBe(1);

    const listed = await rpc<{ dashboards: { id: string; name: string; widget_count: number }[] }>(library, "dashboard.list", {});
    expect(listed.dashboards[0]).toMatchObject({ id: created.id, name: "销售看板", widget_count: 1 });

    const exported = await rpc<{ filename: string; html: string }>(library, "dashboard.exportHtml", { id: created.id });
    expect(exported.filename).toBe("exported.html");
    expect(exported.html).toContain("<p>ok</p>");
    expect(exported.html).not.toContain("https://");
    expect(exported.html).not.toContain("<link");
    expect(exported.html).toContain("Content-Security-Policy");
    expect(fake.calls.at(-1)?.params).toEqual({
      dashboard_id: created.id,
      chart_dir: join(dir, "outputs", "charts"),
    });

    const removed = await rpc<{ deleted: boolean }>(library, "dashboard.remove", { id: created.id });
    expect(removed.deleted).toBe(true);
    const repeated = await rpc<{ deleted: boolean }>(library, "dashboard.remove", { id: created.id });
    expect(repeated.deleted).toBe(false);
    const missing = await rpcError(rpc(library, "dashboard.get", { id: created.id }));
    expect(missing.data?.kind).toBe("not_found");
  });
});
