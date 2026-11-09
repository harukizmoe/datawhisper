/**
 * P6.1：数据源 / 工作区 / 产物内部 API 的单元测试。
 *
 * compute 用假客户端（记录调用、回放固定结果），状态用内存文档宿主，配置存储用真实的
 * `SecretCredentialStore`（强制文件后端），这样「密钥不进 JSON、不进返回值」能被实际读到文件。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
let changed: number[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-sources-"));
  mkdirSync(join(dir, "repo"));
  store = createMemorySourceStore([1, 2]);
  const credentials = await SecretCredentialStore.open(
    join(dir, "credentials.json"),
    join(dir, "credentials.index.json"),
    { forceFile: true },
  );
  configs = createSourceConfigStore({ dataDir: dir, credentials });
  changed = [];
  compute = fakeCompute();
  server = memoryServer(sourceMethods({
    compute: compute.client,
    state: store,
    configs,
    uploadsDir: join(dir, "uploads"),
    outputsDir: join(dir, "outputs"),
    projectRoot: join(dir, "repo"),
    maxUploadBytes: 64,
    uploadTtlMs: 60_000,
    onChanged: (conversationId) => changed.push(conversationId),
  }), (error) => error instanceof RpcError
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

  test("removeAll 同时清空工作区挂载记录", async () => {
    const workdir = join(dir, "remove-all-ws");
    mkdirSync(workdir, { recursive: true });
    await server.call("workspace.mount", { conversationId: 1, path: workdir });
    await openUpload("a.csv", "a\n1\n");
    await server.call("source.removeAll", { conversationId: 1 });
    const listed = await server.call<{ workspace: unknown }>("workspace.list", { conversationId: 1 });
    expect(listed.result!.workspace).toBeNull();
    expect(store.peek(1).workspaces.every((record) => record.sourceId === "")).toBe(true);
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
});

describe("工作区", () => {
  function makeWorkspace(name: string): string {
    const workdir = join(dir, name);
    mkdirSync(join(workdir, "artifacts"), { recursive: true });
    writeFileSync(join(workdir, "data.csv"), "a,b\n1,2\n");
    writeFileSync(join(workdir, "artifacts", "summary.md"), "# 结果\n");
    return workdir;
  }

  test("mount 同步数据并把持久化来源挂进会话", async () => {
    const workdir = makeWorkspace("project");
    const mounted = await server.call<{
      workspace: { workspace_id: string; workdir: string; mounted: boolean; permission: string };
      sources: { kind: string; open: boolean }[];
      added: { source_name: string; tables?: string[] }[];
    }>("workspace.mount", { conversationId: 1, path: workdir, permission: "read_write" });
    expect(mounted.error).toBeUndefined();
    expect(mounted.result!.workspace).toMatchObject({ workdir, mounted: true, permission: "read_write" });
    expect(mounted.result!.workspace.workspace_id).toMatch(/^ws_[a-f0-9]{16}$/);
    expect(mounted.result!.sources[0]).toMatchObject({ kind: "workspace_persistent", open: true });
    expect(mounted.result!.added).toEqual([{ source_name: "data.csv", tables: ["data"] }]);
    const sync = compute.calls.find((call) => call.method === "workspace.sync")!;
    expect(sync.params).toMatchObject({ workspace_id: mounted.result!.workspace.workspace_id, workdir });
    expect(sync.params.source_id).toBeUndefined();
  });

  test("重复挂载复用同一来源；rename / setPermission / unmount / remove", async () => {
    const workdir = makeWorkspace("project");
    await server.call("workspace.mount", { conversationId: 1, path: workdir });
    const again = await server.call<{ workspace: { workspace_id: string } }>("workspace.mount", {
      conversationId: 1,
      path: workdir,
    });
    const workspaceId = again.result!.workspace.workspace_id;
    // 第二次挂载把已打开的 source 作为导入目标，而不是重新 open。
    expect(compute.calls.filter((call) => call.method === "workspace.sync").at(-1)!.params.source_id).toBeString();
    expect(compute.calls.filter((call) => call.method === "source.open")).toHaveLength(1);

    const renamed = await server.call<{ workspace: { name: string } }>("workspace.rename", {
      conversationId: 1,
      workspaceId,
      name: "  年度   报表 ",
    });
    expect(renamed.result!.workspace.name).toBe("年度 报表");

    const badName = await server.call("workspace.rename", {
      conversationId: 1,
      workspaceId,
      name: "x".repeat(81),
    });
    expect(reasonOf(badName)).toBe("invalid_workspace_name");

    const permission = await server.call<{ workspace: { permission: string } }>("workspace.setPermission", {
      conversationId: 1,
      workspaceId,
      permission: "read_only",
    });
    expect(permission.result!.workspace.permission).toBe("read_only");
    const badPermission = await server.call("workspace.setPermission", {
      conversationId: 1,
      workspaceId,
      permission: "admin",
    });
    expect(badPermission.error?.code).toBe(INVALID_PARAMS);

    const beforeUnmount = await server.call("workspace.remove", { conversationId: 1, workspaceId, confirmed: true });
    expect(reasonOf(beforeUnmount)).toBe("workspace_connected");

    const unmounted = await server.call<{ workspace: { mounted: boolean }; sources: unknown[] }>("workspace.unmount", {
      conversationId: 1,
    });
    expect(unmounted.result!.workspace.mounted).toBe(false);
    expect(unmounted.result!.sources).toHaveLength(0);

    const notConfirmed = await server.call("workspace.remove", { conversationId: 1, workspaceId });
    expect(reasonOf(notConfirmed)).toBe("confirmation_required");
    const removed = await server.call<{ removed_workspace_id: string }>("workspace.remove", {
      conversationId: 1,
      workspaceId,
      confirmed: true,
    });
    expect(removed.result!.removed_workspace_id).toBe(workspaceId);
    expect(store.peek(1).workspaces).toHaveLength(0);
  });

  test("切换工作区会关闭旧的持久化来源", async () => {
    const first = makeWorkspace("one");
    const second = makeWorkspace("two");
    await server.call("workspace.mount", { conversationId: 1, path: first });
    const oldSource = store.peek(1).sources[0]!.id;
    await server.call("workspace.mount", { conversationId: 1, path: second });
    expect(compute.closed).toContain(oldSource);
    expect(store.peek(1).sources).toHaveLength(1);
    expect(store.peek(1).workspaces.filter((record) => record.mounted)).toHaveLength(1);
  });

  test("拒绝相对路径、项目根内路径与不存在的目录", async () => {
    const relative = await server.call("workspace.mount", { conversationId: 1, path: "relative/dir" });
    expect(reasonOf(relative)).toBe("invalid_workdir");
    const insideRepo = await server.call("workspace.mount", { conversationId: 1, path: join(dir, "repo") });
    expect(reasonOf(insideRepo)).toBe("invalid_workdir");
    const missing = await server.call("workspace.mount", { conversationId: 1, path: join(dir, "nope") });
    expect(reasonOf(missing)).toBe("invalid_workdir");
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
    const mounted = await server.call<{ workspace: { workspace_id: string } }>("workspace.mount", {
      conversationId: 1,
      path: workdir,
    });
    const workspaceId = mounted.result!.workspace.workspace_id;
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
  });
});
