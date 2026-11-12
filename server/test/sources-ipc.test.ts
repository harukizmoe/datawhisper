/**
 * P6.1：数据源 / 工作区 / 产物内部 API 的单元测试。
 *
 * compute 用假客户端（记录调用、回放固定结果），状态用内存文档宿主，配置存储用真实的
 * `SecretCredentialStore`（强制文件后端），这样「密钥不进 JSON、不进返回值」能被实际读到文件。
 */
import { validateWorkspacePath } from "../src/ipc/source-store.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLanguage } from "../src/i18n.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeError, type SourceDescriptor } from "../src/compute/client.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError } from "../src/ipc/errors.ts";
import { SecretCredentialStore } from "../src/models/credentials.ts";
import {
  createMemorySourceStore,
  createSourceConfigStore,
  turnStateFor,
  type MemorySourceDocStore,
  type SourceConfigStore,
} from "../src/ipc/source-store.ts";
import { sourceMethods, type ComputeSourceClient } from "../src/ipc/sources.ts";
import { createMemoryWorkspaceStore, type WorkspaceStore } from "../src/ipc/workspace-store.ts";
import { memoryServer, type MemoryServer, type RpcReply } from "./support/rpc.ts";

type Call = { method: string; params: Record<string, unknown> };

type FakeCompute = {
  client: ComputeSourceClient;
  calls: Call[];
  opened: Map<string, SourceDescriptor>;
  closed: string[];
};

/** compute worker 的替身：只认识本模块会调用的方法，返回固定但可断言的结构。 */
function fakeCompute(): FakeCompute {
  const calls: Call[] = [];
  const opened = new Map<string, SourceDescriptor>();
  const closed: string[] = [];
  const names = new Map<string, string>();
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    "upload.prepare": (params) => {
      const filePath = String(params.file_path);
      const kind = filePath.endsWith(".csv") ? "csv" : filePath.endsWith(".pdf") ? "pdf" : "excel";
      return { descriptor: { kind, file_path: filePath, name: params.name ?? "uploaded" } };
    },
    "source.schema": () => ({ schema: "Table: t1\n  a INTEGER" }),
    "source.tables": () => ({ tables: ["t1", "t2"] }),
    "source.preview": (params) => ({
      source_id: params.source_id,
      source_name: names.get(String(params.source_id)) ?? "fake",
      requires_table_selection: false,
      tables: [
        {
          name: "t1",
          columns: [{ name: "a", type: "INTEGER" }],
          total_rows: 2,
          source_id: params.source_id,
          source_name: "fake",
          selectable_for_analysis: false,
          selected_for_analysis: false,
        },
      ],
    }),
    "source.previewTable": (params) => ({
      name: params.table,
      columns: ["a"],
      rows: [["1"]],
      total_rows: 1,
    }),
    "source.setAnalysisTables": (params) => ({ source_id: params.source_id, tables: params.tables }),
    "source.test": (params) => {
      const connection = String((params.descriptor as SourceDescriptor).connection_string);
      // 模拟驱动只回显密码本身（而不是整条连接串）。
      if (connection.includes("leaky-pa55")) throw new ComputeError("认证失败：密码 leaky-pa55 不对", -32000, { kind: "open_failed" });
      return { name: "fake", tables: 3, server: "PostgreSQL 16.0" };
    },
    "tool.fetch_table_parse": (params) => {
      const dir = String(params.dump_dir);
      mkdirSync(dir, { recursive: true });
      const files = ["stores", "stocks"].map((table) => {
        const file = join(dir, `${table}.csv`);
        writeFileSync(file, "name,value\nalpha,1\n");
        return file;
      });
      return { text: "parsed 2 tables", files };
    },
    "workspace.sync": (params) => ({
      descriptor: {
        kind: "workspace_persistent",
        db_path: join(String(params.workdir), ".zhixi", "workspace.duckdb"),
        name: String(params.name),
      },
      tables: ["data"],
      added: [{ source_name: "data.csv", tables: ["data"] }],
      errors: [],
      skipped: 0,
      reused: 0,
    }),
  };
  const client: ComputeSourceClient = {
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`unexpected compute method: ${method}`);
      return (await handler(params)) as T;
    },
    async openSource(sourceId: string, descriptor: SourceDescriptor) {
      calls.push({ method: "source.open", params: { source_id: sourceId, descriptor } });
      if (typeof descriptor.connection_string === "string" && descriptor.connection_string.includes("leaky")) {
        // 模拟 SQLAlchemy 把 DSN 回显在异常里：主模块必须脱敏后再返回。
        throw new ComputeError(`连接失败：${descriptor.connection_string}`, -32000, { kind: "open_failed" });
      }
      opened.set(sourceId, descriptor);
      if (typeof descriptor.name === "string") names.set(sourceId, descriptor.name);
      return { name: typeof descriptor.name === "string" ? descriptor.name : "fake", tables: ["t1"] };
    },
    async closeSource(sourceId: string) {
      closed.push(sourceId);
      opened.delete(sourceId);
    },
  };
  return { client, calls, opened, closed };
}

function reasonOf(reply: RpcReply<unknown>): string | undefined {
  return (reply.error?.data as { reason?: string } | undefined)?.reason;
}

let dir: string;
let server: MemoryServer;
let compute: FakeCompute;
let store: MemorySourceDocStore;
let configs: SourceConfigStore;
let workspaces: WorkspaceStore;
let changed: number[];
/** 假飞书读取：记下被读的 `appToken/tableId`；`feishuError` 非空时模拟飞书拒绝。 */
let feishuReads: string[];
/** `sourceMethods` 装配时填进来的抓取/飞书端口（工具用它登记来源）。 */
let ingestPort: { ingest?: import("../src/tools/app/types.ts").IngestPort };
let feishuError: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-sources-"));
  mkdirSync(join(dir, "repo"));
  store = createMemorySourceStore([1, 2]);
  workspaces = createMemoryWorkspaceStore();
  const credentials = await SecretCredentialStore.open(
    join(dir, "credentials.json"),
    join(dir, "credentials.index.json"),
    { forceFile: true },
  );
  configs = createSourceConfigStore({ dataDir: dir, credentials });
  changed = [];
  feishuReads = [];
  feishuError = undefined;
  compute = fakeCompute();
  ingestPort = {};
  server = memoryServer(sourceMethods({
    compute: compute.client,
    state: store,
    configs,
    workspaces,
    conversationIds: async () => [1, 2],
    feishuRecords: async (appToken, tableId) => {
      feishuReads.push(`${appToken}/${tableId}`);
      if (feishuError !== undefined) throw new Error(feishuError);
      return {
        app_token: appToken,
        table_id: tableId,
        url: `https://feishu.cn/base/${appToken}?table=${tableId}`,
        records: [{ 地区: "East", 金额: 10, _feishu_record_id: "rec1" }],
        record_count: 1,
        limited: false,
      };
    },
    uploadsDir: join(dir, "uploads"),
    outputsDir: join(dir, "outputs"),
    projectRoot: join(dir, "repo"),
    maxUploadBytes: 64,
    uploadTtlMs: 60_000,
    onChanged: (conversationId) => changed.push(conversationId),
  }, ingestPort), (error) => error instanceof RpcError
    ? { code: error.code, message: error.message, data: error.data }
    : undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function upload(filename: string, content: string): Promise<{ uploadId: string; path: string }> {
  const begun = await server.call<{ uploadId: string; path: string }>("source.upload.begin", {
    conversationId: 1,
    filename,
    size: Buffer.byteLength(content),
  });
  expect(begun.error).toBeUndefined();
  writeFileSync(begun.result!.path, content);
  return begun.result!;
}

async function openUpload(filename: string, content: string): Promise<{ sourceId: string; reply: RpcReply<unknown> }> {
  const ticket = await upload(filename, content);
  const reply = await server.call<{ source: { id: string } }>("source.open", {
    conversationId: 1,
    uploadId: ticket.uploadId,
  });
  expect(reply.error).toBeUndefined();
  return { sourceId: reply.result!.source.id, reply };
}

describe("上传两段式", () => {
  test("begin → 界面写文件 → source.open 解析并落库", async () => {
    const ticket = await upload("sales.csv", "a,b\n1,2\n");
    expect(ticket.path.startsWith(join(dir, "uploads", "incoming"))).toBe(true);
    const reply = await server.call<{
      source: { id: string; kind: string; name: string; open: boolean; tables: string[] };
      sources: unknown[];
    }>("source.open", { conversationId: 1, uploadId: ticket.uploadId });

    expect(reply.error).toBeUndefined();
    expect(reply.result!.source).toMatchObject({
      kind: "csv",
      name: "sales.csv",
      open: true,
      tables: ["t1"],
    });
    expect(reply.result!.sources).toHaveLength(1);
    const descriptor = compute.opened.get(reply.result!.source.id)!;
    expect(String(descriptor.file_path).startsWith(join(dir, "uploads"))).toBe(true);
    // staging 文件必须已被移走。
    expect(() => readFileSync(ticket.path)).toThrow();
  });

  test("扩展名白名单、大小上限与空文件在 begin 阶段就拒绝", async () => {
    const badExt = await server.call("source.upload.begin", { conversationId: 1, filename: "run.exe", size: 10 });
    expect(badExt.error?.code).toBe(INVALID_PARAMS);
    expect(reasonOf(badExt)).toBe("unsupported_format");

    const tooLarge = await server.call("source.upload.begin", { conversationId: 1, filename: "big.csv", size: 65 });
    expect(tooLarge.error?.code).toBe(INVALID_PARAMS);
    expect(reasonOf(tooLarge)).toBe("file_too_large");

    const empty = await server.call("source.upload.begin", { conversationId: 1, filename: "empty.csv", size: 0 });
    expect(reasonOf(empty)).toBe("empty_file");
  });

  test("文件大小与声明不一致时拒绝并清理 staging", async () => {
    const ticket = await upload("short.csv", "1234");
    writeFileSync(ticket.path, "12345");
    const reply = await server.call("source.open", { conversationId: 1, uploadId: ticket.uploadId });
    expect(reply.error?.code).toBe(INVALID_PARAMS);
    expect(reasonOf(reply)).toBe("upload_size_mismatch");
    expect(() => readFileSync(ticket.path)).toThrow();
  });

  test("路径穿越：非法 uploadId、伪造 uploadId、符号链接都被拒绝", async () => {
    const traversal = await server.call("source.open", { conversationId: 1, uploadId: "../../etc/passwd" });
    expect(traversal.error?.code).toBe(INVALID_PARAMS);

    const forged = await server.call("source.open", { conversationId: 1, uploadId: "0".repeat(32) });
    expect(reasonOf(forged)).toBe("unknown_upload");

    const outside = join(dir, "outside.csv");
    writeFileSync(outside, "a,b\n");
    const ticket = await upload("link.csv", "a,b\n");
    rmSync(ticket.path, { force: true });
    symlinkSync(outside, ticket.path);
    const linked = await server.call("source.open", { conversationId: 1, uploadId: ticket.uploadId });
    expect(reasonOf(linked)).toBe("upload_not_file");
  });

  test("未知会话与缺失参数都按参数错误返回", async () => {
    expect((await server.call("source.list", { conversationId: 99 })).error?.data).toMatchObject({ kind: "not_found" });
    expect((await server.call("source.list", {})).error?.code).toBe(INVALID_PARAMS);
    const missing = await server.call("source.open", { conversationId: 1 });
    expect(missing.error?.code).toBe(INVALID_PARAMS);
  });
});

describe("来源生命周期与透传", () => {
  test("关闭后可重开；列表反映 open 状态", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const closed = await server.call<{ closed: boolean }>("source.close", { conversationId: 1, sourceId });
    expect(closed.result?.closed).toBe(true);
    expect(compute.closed).toContain(sourceId);

    const listed = await server.call<{ sources: { id: string; open: boolean }[] }>("source.list", { conversationId: 1 });
    expect(listed.result!.sources[0]).toMatchObject({ id: sourceId, open: false });

    const reopened = await server.call<{ source: { open: boolean } }>("source.open", { conversationId: 1, sourceId });
    expect(reopened.result!.source.open).toBe(true);
    expect(compute.opened.has(sourceId)).toBe(true);
  });

  test("schema / tables / previewTable 字段原样透传", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    expect(await server.call("source.schema", { conversationId: 1, sourceId })).toEqual({
      result: { source_id: sourceId, schema: "Table: t1\n  a INTEGER" },
    });
    expect(await server.call("source.tables", { conversationId: 1, sourceId })).toEqual({
      result: { source_id: sourceId, tables: ["t1", "t2"] },
    });
    expect(await server.call("source.previewTable", { conversationId: 1, sourceId, table: "t1" })).toEqual({
      result: { name: "t1", columns: ["a"], rows: [["1"]], total_rows: 1 },
    });
  });

  test("预览汇总只包含参与分析的来源；没有来源时报 not_found", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const preview = await server.call<{ tables: { source_id: string }[]; requires_table_selection: boolean }>("source.preview", {
      conversationId: 1,
    });
    expect(preview.result!.tables[0]!.source_id).toBe(sourceId);
    expect(preview.result!.requires_table_selection).toBe(false);

    await server.call("source.toggle", { conversationId: 1, sourceId, active: false });
    const hidden = await server.call("source.preview", { conversationId: 1 });
    expect(hidden.error?.code).toBe(APP_ERROR);
    expect(hidden.error?.data).toMatchObject({ kind: "not_found" });
  });

  test("toggle 与 remove", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const toggled = await server.call<{ active: boolean }>("source.toggle", { conversationId: 1, sourceId });
    expect(toggled.result?.active).toBe(false);
    const again = await server.call<{ active: boolean }>("source.toggle", { conversationId: 1, sourceId, active: true });
    expect(again.result?.active).toBe(true);

    const removed = await server.call<{ sources: unknown[] }>("source.remove", { conversationId: 1, sourceId });
    expect(removed.result!.sources).toHaveLength(0);
    expect(compute.closed).toContain(sourceId);
    const missing = await server.call("source.remove", { conversationId: 1, sourceId });
    expect(missing.error?.data).toMatchObject({ kind: "not_found" });
  });

  test("removeAll 清空来源并关闭 compute 连接", async () => {
    const first = await openUpload("a.csv", "a\n1\n");
    const second = await openUpload("b.csv", "b\n1\n");
    const reply = await server.call<{ removed: number; sources: unknown[] }>("source.removeAll", { conversationId: 1 });
    expect(reply.result).toMatchObject({ removed: 2 });
    expect(reply.result!.sources).toHaveLength(0);
    expect(compute.closed).toEqual(expect.arrayContaining([first.sourceId, second.sourceId]));
    expect(store.peek(1).sources).toHaveLength(0);
  });

  test("removeAll 保留工作区的共享来源，只清掉其余来源", async () => {
    const workdir = join(dir, "remove-all-ws");
    mkdirSync(workdir, { recursive: true });
    const created = await server.call<{ workspace: { workspace_id: string } }>("workspace.create", { path: workdir });
    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: created.result!.workspace.workspace_id });
    await openUpload("a.csv", "a\n1\n");
    await server.call("source.removeAll", { conversationId: 1 });
    expect(store.peek(1).sources.map((source) => source.kind)).toEqual(["workspace_persistent"]);
  });

  test("写入成功后通知宿主刷新 turnState，turnStateFor 反映当前来源", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    expect(changed.at(-1)).toBe(1);
    expect(turnStateFor(store.peek(1))).toMatchObject({
      hasDataSource: true,
      sourceCount: 1,
      hasWorkspace: false,
    });
    await server.call("source.toggle", { conversationId: 1, sourceId, active: false });
    expect(turnStateFor(store.peek(1))).toMatchObject({ hasDataSource: false, sourceCount: 0 });
  });

  test("分析表选择持久化到 descriptor，重开时带回", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const selected = await server.call<{ tables: string[] }>("source.setAnalysisTables", {
      conversationId: 1,
      sourceId,
      tables: ["t1"],
    });
    expect(selected.result?.tables).toEqual(["t1"]);
    await server.call("source.close", { conversationId: 1, sourceId });
    await server.call("source.open", { conversationId: 1, sourceId });
    expect(compute.opened.get(sourceId)?.analysis_tables).toEqual(["t1"]);
  });

  test("选完分析表后来源视图里的表清单同步更新，卡片不再说「还没选数据表」", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    await server.call("source.setAnalysisTables", { conversationId: 1, sourceId, tables: ["t1"] });
    expect(store.peek(1).sources.find((record) => record.id === sourceId)?.tables).toEqual(["t1"]);
    await server.call("source.setAnalysisTables", { conversationId: 1, sourceId, tables: [] });
    expect(store.peek(1).sources.find((record) => record.id === sourceId)?.tables).toEqual([]);
  });

  test("重命名后预览标题用新名字，而不是 compute 报告的旧名", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    await server.call("source.rename", { conversationId: 1, sourceId, name: "Shop" });
    const preview = await server.call<{ source_name: string }>("source.preview", { conversationId: 1, sourceId });
    expect(preview.result?.source_name).toBe("Shop");
  });
});

describe("SQL 连接是全应用共享的记录", () => {
  async function connect(conversationId: number, name: string): Promise<string> {
    const opened = await server.call<{ source: { id: string }; configId: string }>("source.open", {
      conversationId,
      kind: "sql",
      name,
      driver: "postgresql",
      host: "db.internal",
      port: "5432",
      database: "sales",
      username: "analyst",
      password: "pw",
    });
    expect(opened.error).toBeUndefined();
    return opened.result!.source.id;
  }

  test("在一个会话里连上，别的会话也列出来，但默认未启用", async () => {
    const sourceId = await connect(1, "销售库");
    const other = await server.call<{ sources: { id: string; name: string; active: boolean; configId?: string }[] }>("source.list", {
      conversationId: 2,
    });
    expect(other.error).toBeUndefined();
    const shared = other.result!.sources.find((item) => item.id === sourceId);
    expect(shared).toMatchObject({ name: "销售库", active: false });
    expect(shared?.configId).toBeTruthy();
    // 新会话列出来但未启用：store 里没有它的记录。
    expect(store.peek(2).sources).toHaveLength(0);
  });

  test("在另一个会话里启用：compute 只打开一次，两边都能用", async () => {
    const sourceId = await connect(1, "销售库");
    const opensBefore = compute.calls.filter((call) => call.method === "source.open").length;
    const toggled = await server.call<{ active: boolean; sources: { id: string; active: boolean }[] }>("source.toggle", {
      conversationId: 2,
      sourceId,
      active: true,
    });
    expect(toggled.error).toBeUndefined();
    expect(toggled.result!.active).toBe(true);
    expect(compute.calls.filter((call) => call.method === "source.open").length).toBe(opensBefore);
    expect(store.peek(2).sources.find((item) => item.id === sourceId)?.active).toBe(true);
    expect(store.peek(1).sources.find((item) => item.id === sourceId)?.active).toBe(true);
  });

  test("从一个会话移除不会删掉配置：别的会话仍能看到它，重连也不用再填字段", async () => {
    const sourceId = await connect(1, "销售库");
    const removed = await server.call<{ sources: { id: string }[] }>("source.remove", { conversationId: 1, sourceId });
    expect(removed.error).toBeUndefined();
    expect(store.peek(1).sources).toHaveLength(0);
    const listed = await server.call<{ configs: { id: string }[] }>("source.config.list", {});
    expect(listed.result!.configs).toHaveLength(1);
    const other = await server.call<{ sources: { id: string; active: boolean }[] }>("source.list", { conversationId: 2 });
    expect(other.result!.sources.find((item) => item.id === sourceId)?.active).toBe(false);
    // 配置里的字段还在：重新连接时只传 configId 就够。
    const configId = listed.result!.configs[0]!.id;
    const reopened = await server.call<{ source: { id: string } }>("source.open", { conversationId: 2, kind: "sql", configId });
    expect(reopened.error).toBeUndefined();
    expect(reopened.result!.source.id).toBe(sourceId);
  });
});

describe("数据源配置：密钥只进不出", () => {
  test("保存、列表、连接、重开都不回显连接串", async () => {
    const marker = "s3cr3t-marker";
    const secret = `postgresql://analyst:${marker}@db.internal:5432/sales`;
    const saved = await server.call<{ config: { id: string; secretFields: string[] }; configs: unknown[] }>(
      "source.config.save",
      { kind: "sql", name: "prod", fields: {}, secret: { connection_string: secret } },
    );
    expect(saved.error).toBeUndefined();
    const configId = saved.result!.config.id;
    expect(saved.result!.config.secretFields).toEqual(["connection_string"]);
    expect(JSON.stringify(saved.result)).not.toContain(marker);

    const listed = await server.call<{ configs: unknown[] }>("source.config.list", {});
    expect(JSON.stringify(listed.result)).not.toContain(marker);
    expect(readFileSync(join(dir, "datasource-configs.json"), "utf8")).not.toContain(marker);

    const opened = await server.call<{ source: { id: string }; sources: unknown[] }>("source.open", {
      conversationId: 1,
      kind: "sql",
      configId,
      name: "销售库",
    });
    expect(opened.error).toBeUndefined();
    expect(JSON.stringify(opened.result)).not.toContain(marker);
    expect(JSON.stringify(store.peek(1))).not.toContain(marker);
    const sourceId = opened.result!.source.id;
    expect(compute.opened.get(sourceId)?.connection_string).toBe(secret);

    // 重新打开时密钥从配置里取回，仍然不出现在结果里。
    await server.call("source.close", { conversationId: 1, sourceId });
    const reopened = await server.call("source.open", { conversationId: 1, sourceId });
    expect(reopened.error).toBeUndefined();
    expect(JSON.stringify(reopened.result)).not.toContain(marker);
    expect(compute.opened.get(sourceId)?.connection_string).toBe(secret);
  });

  test("内联连接串自动保存为配置；fields 里的密字段会被挪进凭据库", async () => {
    const marker = "inline-marker";
    const opened = await server.call<{ configId: string }>("source.open", {
      conversationId: 1,
      kind: "sql",
      connection_string: `postgresql://u:${marker}@h/db`,
    });
    expect(opened.error).toBeUndefined();
    expect(JSON.stringify(store.peek(1))).not.toContain(marker);
    expect(JSON.stringify(opened.result)).not.toContain(marker);
    expect(opened.result!.configId).toBeString();

    const saved = await server.call<{ config: { secretFields: string[] } }>("source.config.save", {
      kind: "sql",
      fields: { connection_string: `postgresql://u:${marker}@h/db` },
    });
    expect(saved.result!.config.secretFields).toEqual(["connection_string"]);
    expect(readFileSync(join(dir, "datasource-configs.json"), "utf8")).not.toContain(marker);
  });

  test("无效配置与缺失字段被拒绝；删除会同时清掉凭据", async () => {
    const badHttp = await server.call("source.open", {
      conversationId: 1,
      kind: "http",
      url: "ftp://example.com/x",
      auth_type: "none",
    });
    expect(reasonOf(badHttp)).toBe("invalid_url");

    const badAuth = await server.call("source.open", {
      conversationId: 1,
      kind: "http",
      url: "https://example.com/x",
      auth_type: "magic",
    });
    expect(reasonOf(badAuth)).toBe("invalid_auth_type");

    const unknownField = await server.call("source.config.save", {
      kind: "http",
      fields: { url: "https://example.com/x", auth_type: "none", runner: "x" },
    });
    expect(unknownField.error?.code).toBe(INVALID_PARAMS);
    const unknownSecret = await server.call("source.config.save", {
      kind: "sql",
      secret: { password: "x" },
    });
    expect(unknownSecret.error?.code).toBe(INVALID_PARAMS);
    const unknownOpenSecret = await server.call("source.open", {
      conversationId: 1,
      kind: "sql",
      connection_string: "postgresql://u:p@h/db",
      secret: { kind: "csv" },
    });
    expect(unknownOpenSecret.error?.code).toBe(INVALID_PARAMS);

    const saved = await server.call<{ config: { id: string } }>("source.config.save", {
      kind: "http",
      name: "api",
      fields: { url: "https://example.com/x", auth_type: "bearer" },
      secret: { auth_value: "token-abc" },
    });
    const configId = saved.result!.config.id;
    const renamed = await server.call<{ config: { name: string; secretFields: string[] } }>("source.config.save", {
      id: configId,
      kind: "http",
      name: "api-2",
    });
    expect(renamed.result!.config).toMatchObject({ name: "api-2", secretFields: ["auth_value"] });
    expect(await configs.secret(configId)).toEqual({ auth_value: "token-abc" });
    const credentials = await SecretCredentialStore.open(
      join(dir, "credentials.json"),
      join(dir, "credentials.index.json"),
      { forceFile: true },
    );
    expect(await credentials.read(`datasource:${configId}`)).toBeDefined();

    const removed = await server.call("source.config.remove", { id: configId });
    expect(removed.error).toBeUndefined();
    expect(await credentials.read(`datasource:${configId}`)).toBeUndefined();
    expect((await server.call("source.config.remove", { id: configId })).error?.data).toMatchObject({ kind: "not_found" });
  });

  test("打开失败时错误文案里的凭据被替换掉", async () => {
    const reply = await server.call("source.open", {
      conversationId: 1,
      kind: "sql",
      connection_string: "postgresql://u:leaky-pw@h/db",
    });
    expect(reply.error?.code).toBe(APP_ERROR);
    expect(reply.error?.message).not.toContain("leaky-pw");
    expect(reply.error?.message).toContain("***");
    // 打开失败不应留下配置或来源。
    expect(store.peek(1).sources).toHaveLength(0);
    expect(await configs.list()).toHaveLength(0);
  });

  test("gsheets 的服务账号 JSON 以对象传入时转成字符串保存，打开时还原为对象", async () => {
    const opened = await server.call<{ source: { id: string }; configId: string }>("source.open", {
      conversationId: 1,
      kind: "gsheets",
      spreadsheet: "sheet-123",
      creds_json: { client_email: "svc@example.com", private_key: "key-material" },
    });
    expect(opened.error).toBeUndefined();
    expect(JSON.stringify(opened.result)).not.toContain("key-material");
    const descriptor = compute.opened.get(opened.result!.source.id)!;
    expect(descriptor.spreadsheet).toBe("sheet-123");
    expect(descriptor.creds_dict).toEqual({ client_email: "svc@example.com", private_key: "key-material" });
  });

  test("飞书链接解析出 app_token/table；缺少 table 时明确报错", async () => {
    const opened = await server.call("source.open", {
      conversationId: 1,
      kind: "feishu",
      bitable: "https://acme.feishu.cn/base/appToken123?table=tblABC",
    });
    expect(opened.error).toBeUndefined();
    const stored = store.peek(1).sources[0]!;
    expect(stored.descriptor).toMatchObject({ kind: "feishu", app_token: "appToken123", table_id: "tblABC" });

    const missing = await server.call("source.open", {
      conversationId: 1,
      kind: "feishu",
      bitable: "https://acme.feishu.cn/base/appToken123",
    });
    expect(reasonOf(missing)).toBe("missing_table");
  });

  test("飞书来源打开时由 server 读好记录交给 compute，记录本身不落进会话文档", async () => {
    const opened = await server.call<{ source: { id: string } }>("source.open", {
      conversationId: 1,
      kind: "feishu",
      bitable: "https://acme.feishu.cn/base/appToken123?table=tblABC",
    });
    expect(opened.error).toBeUndefined();
    expect(feishuReads).toEqual(["appToken123/tblABC"]);
    expect(compute.opened.get(opened.result!.source.id)?.records).toEqual([
      { 地区: "East", 金额: 10, _feishu_record_id: "rec1" },
    ]);
    expect(JSON.stringify(store.peek(1))).not.toContain("rec1");
  });

  test("飞书读取失败时来源不被登记，错误文案原样返回", async () => {
    feishuError = "飞书拒绝读取飞书多维表格记录（错误码 91402）：NOTEXIST";
    const opened = await server.call("source.open", {
      conversationId: 1,
      kind: "feishu",
      bitable: "https://acme.feishu.cn/base/appToken123?table=tblABC",
    });
    expect(opened.error?.message).toContain("91402");
    expect(reasonOf(opened)).toBe("open_failed");
    expect(store.peek(1).sources).toEqual([]);
    expect(compute.opened.size).toBe(0);
  });
});

describe("数据库表单字段", () => {
  const form = { driver: "postgresql", host: "db.internal", port: "5433", database: "shop", username: "demo", ssl: "true" };

  test("字段拼成连接串：特殊字符密码原样还原，配置里只有非密字段", async () => {
    const password = "p@ss/w#rd%1";
    const opened = await server.call<{ source: { id: string }; configId: string }>("source.open", {
      conversationId: 1,
      kind: "sql",
      name: "shop",
      fields: form,
      secret: { password },
    });
    expect(opened.error).toBeUndefined();
    const connection = String(compute.opened.get(opened.result!.source.id)?.connection_string);
    const parsed = new URL(connection);
    expect(parsed.protocol).toBe("postgresql+psycopg:");
    expect(decodeURIComponent(parsed.username)).toBe("demo");
    expect(decodeURIComponent(parsed.password)).toBe(password);
    expect(parsed.host).toBe("db.internal:5433");
    expect(parsed.pathname).toBe("/shop");
    expect(parsed.searchParams.get("sslmode")).toBe("require");

    const configs = await server.call<{ configs: { fields: Record<string, string>; secretFields: string[] }[] }>("source.config.list", {});
    expect(configs.result!.configs[0]).toMatchObject({ fields: form, secretFields: ["password"] });
    expect(readFileSync(join(dir, "datasource-configs.json"), "utf8")).not.toContain("w#rd");

    // 关闭后重开：连接串由配置里的字段与凭据库里的密码重新拼出。
    await server.call("source.close", { conversationId: 1, sourceId: opened.result!.source.id });
    const reopened = await server.call("source.open", { conversationId: 1, sourceId: opened.result!.source.id });
    expect(reopened.error).toBeUndefined();
    expect(compute.opened.get(opened.result!.source.id)?.connection_string).toBe(connection);
  });

  test("无密码的 SQLite 也能重开", async () => {
    const opened = await server.call<{ source: { id: string } }>("source.open", {
      conversationId: 1,
      kind: "sql",
      fields: { driver: "sqlite", file: "/data/demo.db" },
    });
    expect(opened.error).toBeUndefined();
    const id = opened.result!.source.id;
    expect(compute.opened.get(id)?.connection_string).toBe("sqlite:////data/demo.db");
    await server.call("source.close", { conversationId: 1, sourceId: id });
    expect((await server.call("source.open", { conversationId: 1, sourceId: id })).error).toBeUndefined();
    expect(compute.opened.get(id)?.connection_string).toBe("sqlite:////data/demo.db");
  });

  test("不合法的组合在连接前就被拒绝，并给出具体原因", async () => {
    const attempt = (fields: Record<string, string>) =>
      server.call("source.open", { conversationId: 1, kind: "sql", fields, secret: { connection_string: "", password: "" } });
    expect(reasonOf(await attempt({}))).toBe("missing_driver");
    expect(reasonOf(await attempt({ driver: "oracle", host: "h" }))).toBe("unsupported_driver");
    expect(reasonOf(await attempt({ driver: "postgresql", host: "" }))).toBe("missing_host");
    expect(reasonOf(await attempt({ driver: "mysql", host: "h", port: "70000" }))).toBe("invalid_port");
    expect(reasonOf(await attempt({ driver: "sqlite", file: "" }))).toBe("missing_file");
    expect(compute.calls.some((call) => call.method === "source.open")).toBe(false);
  });

  test("测试连接不保存配置也不登记来源，失败文案里没有密码", async () => {
    const tested = await server.call<{ tables: number; server: string }>("source.test", {
      kind: "sql",
      fields: form,
      secret: { password: "tester-pw" },
    });
    expect(tested.error).toBeUndefined();
    expect(tested.result).toMatchObject({ tables: 3, server: "PostgreSQL 16.0" });
    expect(store.peek(1).sources).toEqual([]);
    expect((await server.call<{ configs: unknown[] }>("source.config.list", {})).result!.configs).toEqual([]);
    expect(compute.opened.size).toBe(0);

    const failed = await server.call("source.test", { kind: "sql", fields: form, secret: { password: "leaky-pa55" } });
    expect(failed.error?.message).not.toContain("leaky-pa55");
    expect(failed.error?.message).toContain("认证失败");
  });

  test("source.update：只改主机，密码沿用；试连失败时旧设置原样保留", async () => {
    const opened = await server.call<{ source: { id: string; configId: string; open: boolean } }>("source.open", {
      conversationId: 1,
      kind: "sql",
      name: "shop",
      fields: form,
      secret: { password: "kept-pw-1" },
    });
    const id = opened.result!.source.id;
    const configId = opened.result!.source.configId;
    expect(configId).toMatch(/^ds_/);
    // 刚连上的远程来源在 compute 里已经打开，界面不能显示成「已关闭」。
    expect(opened.result!.source.open).toBe(true);
    const hostOf = () => new URL(String(compute.opened.get(id)?.connection_string)).host;
    expect(hostOf()).toBe("db.internal:5433");

    // 失败的修改（新密码被 compute 拒绝）：报错、不泄露密码，连接与配置都没变。
    const failed = await server.call("source.update", {
      conversationId: 1,
      sourceId: id,
      fields: { ...form, host: "db.moved" },
      secret: { password: "leaky-pa55" },
    });
    expect(failed.error?.message).toContain("认证失败");
    expect(failed.error?.message).not.toContain("leaky-pa55");
    expect(hostOf()).toBe("db.internal:5433");
    const unchanged = await server.call<{ configs: { fields: Record<string, string> }[] }>("source.config.list", {});
    expect(unchanged.result!.configs[0]!.fields.host).toBe("db.internal");

    // 成功的修改：不带密码就沿用已保存的那个；来源重开、改名、配置原地更新而不是新增一条。
    const updated = await server.call<{ source: { id: string; name: string; configId: string; open: boolean } }>("source.update", {
      conversationId: 1,
      sourceId: id,
      name: "shop (moved)",
      fields: { ...form, host: "db.moved", port: "6543" },
    });
    expect(updated.error).toBeUndefined();
    expect(updated.result!.source).toMatchObject({ id, name: "shop (moved)", configId, open: true });
    expect(hostOf()).toBe("db.moved:6543");
    expect(decodeURIComponent(new URL(String(compute.opened.get(id)?.connection_string)).password)).toBe("kept-pw-1");
    expect(compute.closed).toContain(id);
    const configs = await server.call<{ configs: { id: string; name: string; fields: Record<string, string> }[] }>("source.config.list", {});
    expect(configs.result!.configs).toHaveLength(1);
    expect(configs.result!.configs[0]).toMatchObject({ id: configId, name: "shop (moved)", fields: { host: "db.moved", port: "6543" } });
    expect(store.peek(1).sources[0]!.name).toBe("shop (moved)");
  });

  test("source.rename：文件来源也能改名；空名和过长的名被拒绝", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const renamed = await server.call<{ source: { name: string }; sources: { id: string; name: string }[] }>("source.rename", {
      conversationId: 1,
      sourceId,
      name: "  月度销售  ",
    });
    expect(renamed.error).toBeUndefined();
    expect(renamed.result!.source.name).toBe("月度销售");
    expect(store.peek(1).sources.find((item) => item.id === sourceId)!.name).toBe("月度销售");
    expect((await server.call("source.rename", { conversationId: 1, sourceId, name: "   " })).error).toBeDefined();
    expect(reasonOf(await server.call("source.rename", { conversationId: 1, sourceId, name: "x".repeat(201) }))).toBe("invalid_name");
    expect(reasonOf(await server.call("source.rename", { conversationId: 1, sourceId, name: "a\nb" }))).toBe("invalid_name");
    expect(store.peek(1).sources.find((item) => item.id === sourceId)!.name).toBe("月度销售");
  });

  test("同一个文件导入多次：名字自动加序号，删掉后序号可复用", async () => {
    const first = await openUpload("a.csv", "a\n1\n");
    const second = await openUpload("a.csv", "a\n2\n");
    const third = await openUpload("a.csv", "a\n3\n");
    const names = () => store.peek(1).sources.map((item) => item.name);
    expect(names()).toEqual(["a.csv", "a.csv (2)", "a.csv (3)"]);
    // 返回给界面的是去重后的名字，而不是文件原名。
    expect((second.reply.result as { source: { name: string } }).source.name).toBe("a.csv (2)");

    await server.call("source.remove", { conversationId: 1, sourceId: second.sourceId });
    const again = await openUpload("a.csv", "a\n4\n");
    expect(names()).toEqual(["a.csv", "a.csv (3)", "a.csv (2)"]);
    expect(again.sourceId).not.toBe(first.sourceId);
    expect(third.sourceId).not.toBe(again.sourceId);
  });

  test("上传的文件没有连接设置可改", async () => {
    const { sourceId } = await openUpload("a.csv", "a\n1\n");
    const reply = await server.call("source.update", { conversationId: 1, sourceId, fields: {} });
    expect(reasonOf(reply)).toBe("not_editable");
  });
});

describe("工作区", () => {
  function makeWorkspace(name: string): string {
    const workdir = join(dir, name);
    mkdirSync(join(workdir, "artifacts"), { recursive: true });
    writeFileSync(join(workdir, "data.csv"), "a,b\n1,2\n");
    writeFileSync(join(workdir, "artifacts", "summary.md"), "# 结果\n");
    return workdir;
  }

  type PublicWorkspace = {
    workspace_id: string;
    workdir: string;
    name: string;
    instructions: string;
    source_id: string;
    available: boolean;
    current: boolean;
  };

  async function createWorkspace(name: string, extra: Record<string, unknown> = {}) {
    const workdir = makeWorkspace(name);
    const reply = await server.call<{
      existing: boolean;
      workspace: PublicWorkspace;
      added: { source_name: string; tables?: string[] }[];
    }>("workspace.create", { path: workdir, ...extra });
    expect(reply.error).toBeUndefined();
    return { workdir, result: reply.result!, id: reply.result!.workspace.workspace_id };
  }

  const callsOf = (method: string) => compute.calls.filter((call) => call.method === method);

  test("create 登记目录并导入数据；同一目录再次 create 原样返回、不重复导入", async () => {
    const { workdir, result, id } = await createWorkspace("project", { instructions: " 只看 data.csv " });
    expect(id).toMatch(/^ws_[a-f0-9]{16}$/);
    expect(result).toMatchObject({
      existing: false,
      workspace: { workdir, name: "project", instructions: "只看 data.csv", available: true, current: false },
    });
    expect(result.added).toEqual([{ source_name: "data.csv", tables: ["data"] }]);
    expect(callsOf("workspace.sync")).toHaveLength(1);
    expect(callsOf("workspace.sync")[0]!.params.source_id).toBeUndefined();
    expect(callsOf("source.open")).toHaveLength(1);
    expect(result.workspace.source_id).toStartWith("s_");

    const again = await server.call<{ existing: boolean; workspace: PublicWorkspace }>("workspace.create", { path: workdir });
    expect(again.result).toMatchObject({ existing: true, workspace: { workspace_id: id } });
    expect(callsOf("workspace.sync")).toHaveLength(1);
    expect(await workspaces.list()).toHaveLength(1);
  });

  test("moveToWorkspace 写 scope 并挂上共享来源；第二个对话复用同一来源", async () => {
    const { id } = await createWorkspace("project");
    const moved = await server.call<{ workspace: PublicWorkspace; sources: { kind: string; open: boolean }[] }>(
      "conversation.moveToWorkspace",
      { conversationId: 1, workspaceId: id },
    );
    expect(moved.error).toBeUndefined();
    expect(moved.result!.workspace.current).toBe(true);
    expect(moved.result!.sources[0]).toMatchObject({ kind: "workspace_persistent", open: true });
    expect(store.peek(1).scope).toEqual({ kind: "workspace", workspaceId: id });
    expect(turnStateFor(store.peek(1))).toMatchObject({ hasWorkspace: true, hasDataSource: true });

    await server.call("conversation.moveToWorkspace", { conversationId: 2, workspaceId: id });
    expect(store.peek(2).sources[0]!.id).toBe(store.peek(1).sources[0]!.id);
    expect(callsOf("workspace.sync")).toHaveLength(1);
    expect(callsOf("source.open")).toHaveLength(1);

    const mine = await server.call<{ workspace: PublicWorkspace | null; workspaces: PublicWorkspace[] }>("workspace.list", {
      conversationId: 1,
    });
    expect(mine.result!.workspace).toMatchObject({ workspace_id: id, current: true });
    const chat = await server.call<{ workspace: unknown; workspaces: unknown[] }>("workspace.list", {});
    expect(chat.result!.workspace).toBeNull();
    expect(chat.result!.workspaces).toHaveLength(1);
  });

  test("对话已属于某个工作区后不能改挂另一个；重复挂同一个是幂等的", async () => {
    const first = await createWorkspace("one");
    const second = await createWorkspace("two");
    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: first.id });
    const again = await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: first.id });
    expect(again.error).toBeUndefined();
    expect(store.peek(1).sources).toHaveLength(1);
    const other = await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: second.id });
    expect(reasonOf(other)).toBe("already_in_workspace");
    expect(store.peek(1).scope).toEqual({ kind: "workspace", workspaceId: first.id });
  });

  test("update 改名与说明；非法值被拒绝；带 conversationId 时共享来源跟着改名", async () => {
    const { id } = await createWorkspace("project");
    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: id });

    const renamed = await server.call<{ workspace: PublicWorkspace }>("workspace.update", {
      conversationId: 1,
      workspaceId: id,
      name: "  年度   报表 ",
      instructions: " 结果写进 artifacts ",
    });
    expect(renamed.result!.workspace).toMatchObject({ name: "年度 报表", instructions: "结果写进 artifacts" });
    expect(store.peek(1).sources[0]!.name).toContain("年度 报表");

    const badName = await server.call("workspace.update", { workspaceId: id, name: "x".repeat(81) });
    expect(reasonOf(badName)).toBe("invalid_workspace_name");
    const badInstructions = await server.call("workspace.update", { workspaceId: id, instructions: "a\u0000b" });
    expect(badInstructions.error).toBeDefined();
    expect((await workspaces.get(id))!.instructions).toBe("结果写进 artifacts");
  });

  test("sync 把已打开的共享来源作为导入目标；未知 id 报 not_found", async () => {
    const { id } = await createWorkspace("project");
    const synced = await server.call<{ ok: boolean; added: unknown[] }>("workspace.sync", { workspaceId: id });
    expect(synced.result!.ok).toBe(true);
    expect(callsOf("workspace.sync")).toHaveLength(2);
    expect(callsOf("workspace.sync")[1]!.params.source_id).toBeString();
    expect(callsOf("source.open")).toHaveLength(1);

    const unknown = await server.call("workspace.sync", { workspaceId: "ws_0000000000000000" });
    expect(unknown.error?.data).toMatchObject({ kind: "not_found" });
    const malformed = await server.call("workspace.sync", { workspaceId: "nope" });
    expect(malformed.error?.code).toBe(INVALID_PARAMS);
  });

  test("importFiles 只把指定文件交给 compute；路径与数量都校验", async () => {
    const { id } = await createWorkspace("project");
    const imported = await server.call<{ ok: boolean; added: { source_name: string }[] }>("workspace.importFiles", {
      workspaceId: id,
      paths: ["data.csv", "sub/report.xlsx"],
    });
    expect(imported.error).toBeUndefined();
    expect(imported.result!.ok).toBe(true);
    expect(callsOf("workspace.sync").at(-1)!.params.paths).toEqual(["data.csv", "sub/report.xlsx"]);
    // 已经打开过的工作区仍然是同一个导入目标。
    expect(callsOf("workspace.sync").at(-1)!.params.source_id).toBeString();

    // 普通 sync 不带 paths：compute 会整理整个目录。
    await server.call("workspace.sync", { workspaceId: id });
    expect(callsOf("workspace.sync").at(-1)!.params.paths).toBeUndefined();

    for (const paths of [[], [".."], ["/etc/passwd"], ["a/../../b"], [""], [1]]) {
      const reply = await server.call("workspace.importFiles", { workspaceId: id, paths });
      expect(reply.error?.code).toBe(INVALID_PARAMS);
    }
    expect(reasonOf(await server.call("workspace.importFiles", { workspaceId: id, paths: [".."] }))).toBe("invalid_path");
    expect((await server.call("workspace.importFiles", { workspaceId: "nope", paths: ["a.csv"] })).error?.code).toBe(INVALID_PARAMS);
  });

  test("目录被删后报 workspace_unavailable，list 标出不可用，对话不会被悄悄挂上", async () => {
    const { workdir, id } = await createWorkspace("project");
    rmSync(workdir, { recursive: true, force: true });

    const synced = await server.call("workspace.sync", { workspaceId: id });
    expect(reasonOf(synced)).toBe("workspace_unavailable");
    const prepared = await server.call("workspace.prepare", { workspaceId: id });
    expect(reasonOf(prepared)).toBe("workspace_unavailable");
    const moved = await server.call("conversation.moveToWorkspace", { conversationId: 2, workspaceId: id });
    expect(reasonOf(moved)).toBe("workspace_unavailable");
    expect(store.peek(2).scope).toBeUndefined();

    const listed = await server.call<{ workspaces: PublicWorkspace[] }>("workspace.list", {});
    expect(listed.result!.workspaces[0]).toMatchObject({ workspace_id: id, available: false });
  });

  test("共享来源不能从对话里单独删；removeAll 也保留它", async () => {
    const { id } = await createWorkspace("project");
    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: id });
    const sourceId = store.peek(1).sources[0]!.id;
    const removed = await server.call("source.remove", { conversationId: 1, sourceId });
    expect(reasonOf(removed)).toBe("workspace_source");
    await openUpload("a.csv", "a\n1\n");
    await server.call("source.removeAll", { conversationId: 1 });
    expect(store.peek(1).sources.map((source) => source.id)).toEqual([sourceId]);
  });

  test("remove 需要确认；仍有对话属于它时拒绝；成功后只删注册记录、不动目录", async () => {
    const { workdir, id } = await createWorkspace("project");
    const unconfirmed = await server.call("workspace.remove", { workspaceId: id });
    expect(reasonOf(unconfirmed)).toBe("confirmation_required");

    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId: id });
    const inUse = await server.call("workspace.remove", { workspaceId: id, confirmed: true });
    expect(reasonOf(inUse)).toBe("workspace_in_use");
    expect(await workspaces.list()).toHaveLength(1);

    const lone = await createWorkspace("lone");
    const loneSource = lone.result.workspace.source_id;
    const removed = await server.call<{ removed_workspace_id: string; directory_deleted: boolean }>("workspace.remove", {
      workspaceId: lone.id,
      confirmed: true,
    });
    expect(removed.result).toMatchObject({ removed_workspace_id: lone.id, directory_deleted: false });
    expect(compute.closed).toContain(loneSource);
    expect((await workspaces.list()).map((record) => record.workspaceId)).toEqual([id]);
    expect(existsSync(lone.workdir)).toBe(true);
    expect(existsSync(workdir)).toBe(true);
  });

  test("拒绝相对路径、项目根内路径与不存在的目录", async () => {
    const relative = await server.call("workspace.create", { path: "relative/dir" });
    expect(reasonOf(relative)).toBe("invalid_workdir");
    const insideRepo = await server.call("workspace.create", { path: join(dir, "repo") });
    expect(reasonOf(insideRepo)).toBe("invalid_workdir");
    const missing = await server.call("workspace.create", { path: join(dir, "nope") });
    expect(reasonOf(missing)).toBe("invalid_workdir");
    expect(await workspaces.list()).toHaveLength(0);
  });
});

describe("产物", () => {
  function writeExport(name: string, content: string | Buffer): string {
    mkdirSync(join(dir, "outputs", "exports"), { recursive: true });
    const path = join(dir, "outputs", "exports", name);
    writeFileSync(path, content);
    return path;
  }

  test("列表与文本读取；默认只给路径", async () => {
    const path = writeExport("report.csv", "a,b\n1,2\n");
    const listed = await server.call<{ artifacts: { name: string; path: string }[] }>("artifact.list", { conversationId: 1 });
    expect(listed.result!.artifacts.map((item) => item.name)).toEqual(["report.csv"]);

    const meta = await server.call<{ path: string; name: string; content_type: string; text?: string }>("artifact.read", {
      conversationId: 1,
      name: "report.csv",
    });
    expect(meta.result).toMatchObject({ path, name: "report.csv", content_type: "text/csv; charset=utf-8" });
    expect(meta.result!.text).toBeUndefined();

    const text = await server.call<{ text: string }>("artifact.read", {
      conversationId: 1,
      name: "report.csv",
      as: "text",
    });
    expect(text.result!.text).toBe("a,b\n1,2\n");
  });

  test("越界路径、穿越文件名与符号链接都被拒绝", async () => {
    writeExport("ok.csv", "a\n1\n");
    const outer = join(dir, "secret.txt");
    writeFileSync(outer, "top secret");

    const traversal = await server.call("artifact.read", { conversationId: 1, name: "../secret.txt" });
    expect(reasonOf(traversal)).toBe("invalid_artifact_name");

    const absolute = await server.call("artifact.read", { conversationId: 1, path: outer });
    expect(reasonOf(absolute)).toBe("artifact_outside_root");

    const etc = await server.call("artifact.read", { conversationId: 1, path: "/etc/passwd" });
    expect(reasonOf(etc)).toBe("artifact_outside_root");

    symlinkSync(outer, join(dir, "outputs", "exports", "link.txt"));
    const linked = await server.call("artifact.read", { conversationId: 1, name: "link.txt" });
    expect(linked.error?.data).toMatchObject({ kind: "not_found" });
  });

  test("文本读取有上限；超过时仍可用路径模式", async () => {
    const big = writeExport("big.txt", Buffer.alloc(1024 * 1024 + 1, 0x61));
    const text = await server.call("artifact.read", { conversationId: 1, name: "big.txt", as: "text" });
    expect(reasonOf(text)).toBe("file_too_large");
    const meta = await server.call<{ path: string; size: number }>("artifact.read", { conversationId: 1, name: "big.txt" });
    expect(meta.result).toMatchObject({ path: big, size: 1024 * 1024 + 1 });
  });

  test("工作目录的 artifacts/ 也在允许范围内", async () => {
    const workdir = join(dir, "project");
    mkdirSync(join(workdir, "artifacts"), { recursive: true });
    const artifact = join(workdir, "artifacts", "summary.md");
    writeFileSync(artifact, "# 结果\n");
    const created = await server.call<{ workspace: { workspace_id: string } }>("workspace.create", { path: workdir });
    const workspaceId = created.result!.workspace.workspace_id;
    await server.call("conversation.moveToWorkspace", { conversationId: 1, workspaceId });
    const listed = await server.call<{ artifacts: { name: string; workspace_id?: string }[] }>("artifact.list", {
      conversationId: 1,
      workspaceId,
    });
    expect(listed.result!.artifacts[0]).toMatchObject({ name: "summary.md", workspace_id: workspaceId });

    const read = await server.call<{ path: string; text: string }>("artifact.read", {
      conversationId: 1,
      name: "summary.md",
      as: "text",
    });
    expect(read.result).toMatchObject({ path: artifact, text: "# 结果\n" });

    const outsideName = await server.call("artifact.read", { conversationId: 1, name: "data.csv" });
    expect(outsideName.error?.code).toBe(APP_ERROR);

    // 不属于该工作区的对话读不到它的产物。
    const other = await server.call("artifact.read", { conversationId: 2, name: "summary.md" });
    expect(other.error?.code).toBe(APP_ERROR);
  });
});

describe("工作目录校验文案跟随界面语言", () => {
  test("English by default, Chinese when the UI language is zh", () => {
    const options = { projectRoot: "/nonexistent-project-root" };
    expect(validateWorkspacePath("", options)).toEqual({ ok: false, message: "The working directory path cannot be empty." });
    setLanguage("zh");
    try {
      expect(validateWorkspacePath("", options)).toEqual({ ok: false, message: "工作目录路径不能为空。" });
    } finally {
      setLanguage("en");
    }
  });
});

describe("入参形状在方法体之前被拦下", () => {
  test("来源 id、会话 id、上传参数各自给出旧实现的原话", async () => {
    const badId = await server.call("source.toggle", { conversationId: 1, sourceId: "nope" });
    expect(badId.error?.message).toBe("'sourceId' must look like s_xxxxxxxx");
    const noConversation = await server.call("source.list", {});
    expect(noConversation.error?.message).toBe("'conversationId' must be a positive integer");
    const noSize = await server.call("source.upload.begin", { conversationId: 1, filename: "a.csv" });
    expect(noSize.error?.message).toBe("'size' must be an integer");
    const badActive = await server.call("source.toggle", { conversationId: 1, sourceId: "s_00000001", active: "yes" });
    expect(badActive.error?.message).toBe("'active' must be a boolean");
  });

  test("workspace.importFiles 的 paths：非数组、空、超上限、非字符串各有原话", async () => {
    const workspaceId = "ws_0123456789abcdef";
    const notArray = await server.call("workspace.importFiles", { workspaceId, paths: "a.csv" });
    expect(notArray.error?.message).toBe("'paths' must be a non-empty array");
    const empty = await server.call("workspace.importFiles", { workspaceId, paths: [] });
    expect(empty.error?.message).toBe("'paths' must be a non-empty array");
    const tooMany = await server.call("workspace.importFiles", {
      workspaceId,
      paths: Array.from({ length: 201 }, (_value, index) => `f${index}.csv`),
    });
    expect(tooMany.error?.message).toBe("'paths' accepts at most 200 files");
    const notString = await server.call("workspace.importFiles", { workspaceId, paths: ["a.csv", 2] });
    expect(notString.error?.message).toBe("'paths' must contain only strings");
  });
});

describe("抓取工具登记来源", () => {
  test("解析结果落盘后逐张登记成 csv 来源，临时内存来源被关掉", async () => {
    const port = ingestPort.ingest;
    expect(port).toBeDefined();
    const result = await port!.fetchTables(1, {
      url: "https://example.com/stores.html",
      contentType: "text/html",
      body: new TextEncoder().encode("<html></html>"),
      sourceName: "stores_web",
    });
    expect(result.added.map((item) => item.tables)).toEqual([["t1"], ["t1"]]);
    const doc = store.peek(1);
    expect(doc.sources.map((source) => [source.kind, source.active])).toEqual([["csv", true], ["csv", true]]);
    expect(doc.sources.every((source) => source.uploadPath !== undefined && existsSync(source.uploadPath))).toBe(true);
    // 解析用的内存 source 以 `s_` 开头、不在文档里：登记后应当被关掉。
    const scratch = compute.closed.filter((id) => !doc.sources.some((source) => source.id === id));
    expect(scratch).toHaveLength(1);
    expect(result.text).toContain("Attached to this conversation");
  });
});
