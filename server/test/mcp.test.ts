/**
 * MCP 客户端测试：用本地 stdio 假服务器（`test/fixtures/mcp-fake-server.mjs`，JSON-RPC over stdio）
 * 覆盖连接、列工具、调用、超时、崩溃重连、并发、空闲关闭与凭据不落明文。
 *
 * 不依赖网络，也不下载任何包：假服务器只要求 `node` 具备的基础 API。
 */

import { describe, expect, test } from "bun:test";
import { afterEach as restoreLanguage, beforeEach as useChinese } from "bun:test";
import { setLanguage } from "../src/i18n.ts";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SecretCredentialStore } from "../src/models/credentials.ts";
import type { AppToolDeps } from "../src/tools/app/types.ts";
import { createInteractionTools } from "../src/tools/app/interaction.ts";
import { McpServerClient, type McpClientOptions } from "../src/mcp/client.ts";
import {
  McpConfigStore,
  mcpSecretId,
  STDIO_ALLOWED_COMMANDS,
  validateServerInput,
  type McpServerConfig,
} from "../src/mcp/config.ts";
import { createMcpTools } from "../src/mcp/index.ts";
import {
  buildMcpCatalog,
  formatMcpError,
  mcpCatalogVersion,
  mcpToolName,
  mcpToolSchema,
  selectMcpSchemas,
  validateMcpArgs,
} from "../src/mcp/tools.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-fake-server.mjs");
/** 测试直接跑 Bun 自身作为 stdio 宿主；生产白名单仍是旧实现的 `STDIO_ALLOWED_COMMANDS`。 */
const TEST_COMMANDS: ReadonlySet<string> = new Set([...STDIO_ALLOWED_COMMANDS, "bun", basename(process.execPath)]);

function fakeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    server_id: "fake",
    label: "Fake",
    transport: "stdio",
    enabled: true,
    description: "",
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    url: "",
    headers: {},
    ...overrides,
  };
}

function clientOptions(overrides: Partial<McpClientOptions> = {}): McpClientOptions {
  return {
    allowedStdioCommands: TEST_COMMANDS,
    reconnectBaseDelayMs: 1,
    idleTimeoutMs: 0,
    requestTimeoutMs: 2_000,
    callTimeoutMs: 2_000,
    connectTimeoutMs: 5_000,
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dw-mcp-"));
}

/** 等一个状态出现（空闲关闭涉及真实计时器与子进程，等条件而不是猜固定时长）。 */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 10);
    await tick.promise;
  }
}

// 这个文件断言的是旧实现的中文文案（golden 或沿用旧文案的用例），所以按中文跑；英文输出另见 i18n 用例。
useChinese(() => setLanguage("zh"));
restoreLanguage(() => setLanguage("en"));

describe("config", () => {
  test("validates like the old API (whitelist, shell metacharacters, blocked env)", () => {
    expect(validateServerInput({ server_id: " ", transport: "stdio", command: "node" })).toEqual({
      ok: false,
      error: "server_id 不能为空",
    });
    expect(validateServerInput({ server_id: "x", transport: "http" as never, command: "node" })).toEqual({
      ok: false,
      error: "transport 必须是 'stdio' 或 'sse'",
    });
    const notAllowed = validateServerInput({ server_id: "x", transport: "stdio", command: "sh", args: [] });
    expect(notAllowed.ok).toBe(false);
    if (!notAllowed.ok) expect(notAllowed.error).toContain("不在安全白名单中（允许: deno, node, npm, npx, python, python3, uv, uvx）");
    expect(validateServerInput({ server_id: "x", transport: "stdio", command: "node", args: ["a;rm -rf /"] })).toEqual({
      ok: false,
      error: "参数包含不允许的 shell 特殊字符: 'a;rm -rf /'",
    });
    expect(validateServerInput({ server_id: "x", transport: "stdio", command: "node", env: { PATH: "/tmp" } })).toEqual({
      ok: false,
      error: "不允许覆盖环境变量: PATH",
    });
    expect(validateServerInput({ server_id: "x", transport: "stdio", command: "node", args: "nope" as never })).toEqual({
      ok: false,
      error: "args 必须是数组",
    });
    expect(validateServerInput({ server_id: "x", transport: "stdio", command: "node", env: [] as never })).toEqual({
      ok: false,
      error: "env 必须是对象",
    });
    expect(validateServerInput({ server_id: "x", transport: "sse", url: " " })).toEqual({
      ok: false,
      error: "SSE transport 需要 url",
    });
    expect(validateServerInput({ server_id: "x", transport: "sse", url: "http://127.0.0.1/sse", headers: [] as never })).toEqual({
      ok: false,
      error: "headers 必须是对象",
    });
  });

  test("persists server shape, keeps secrets in the credential store, and reuses old messages", async () => {
    const dir = tempDir();
    try {
      const credentials = await SecretCredentialStore.open(join(dir, "credentials.json"), join(dir, "credentials.index.json"), {
        forceFile: true,
      });
      const filePath = join(dir, "mcp_config.json");
      const store = await McpConfigStore.open(filePath, credentials);

      expect(
        await store.add({
          server_id: "github",
          label: "GitHub",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_plain_secret" },
        }),
      ).toEqual({ ok: true, message: "服务器 'github' 已添加" });

      const raw = readFileSync(filePath, "utf8");
      expect(raw).not.toContain("ghp_plain_secret");
      expect(raw).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect((await credentials.read(mcpSecretId("github", "env", "GITHUB_PERSONAL_ACCESS_TOKEN")))?.type).toBe("api_key");

      // 运行时解析出真实值；同样的值不进配置文件。
      const resolved = await store.get("github");
      expect(resolved?.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_plain_secret" });
      expect(resolved?.args).toEqual(["server.mjs"]);

      // 名字冲突沿用旧文案。
      expect(await store.add({ server_id: "github", transport: "stdio", command: "node" })).toEqual({
        ok: false,
        error: "服务器 'github' 已存在",
      });

      // SSE 的 header 同理。
      expect(
        await store.add({
          server_id: "remote",
          transport: "sse",
          url: "http://127.0.0.1:9/sse",
          headers: { Authorization: "Bearer header_secret" },
        }),
      ).toEqual({ ok: true, message: "服务器 'remote' 已添加" });
      expect(readFileSync(filePath, "utf8")).not.toContain("header_secret");
      expect((await store.get("remote"))?.headers).toEqual({ Authorization: "Bearer header_secret" });

      expect(await store.setEnabled("remote", false)).toEqual({ ok: true, message: "已更新" });
      expect((await store.enabled()).map((server) => server.server_id)).toEqual(["github"]);
      expect(await store.update("github", { label: "GitHub 2" })).toEqual({ ok: true, message: "已更新" });
      expect((await store.get("github"))?.label).toBe("GitHub 2");
      // 只改标签不能把已存的密钥写没。
      expect((await store.get("github"))?.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_plain_secret" });
      expect(await store.update("ghost", { label: "x" })).toEqual({ ok: false, error: "服务器 'ghost' 不存在" });
      expect(await store.remove("remote")).toEqual({ ok: true, message: "服务器 'remote' 已删除" });
      expect(await store.get("remote")).toBeUndefined();
      expect(await credentials.read(mcpSecretId("remote", "header", "Authorization"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrates plaintext env values from an old config file", async () => {
    const dir = tempDir();
    try {
      const filePath = join(dir, "mcp_config.json");
      writeFileSync(filePath, JSON.stringify({
        servers: {
          legacy: {
            server_id: "legacy",
            label: "Legacy",
            transport: "stdio",
            enabled: true,
            description: "",
            command: "node",
            args: [],
            env: { LEGACY_TOKEN: "legacy_plain_secret" },
            url: "",
            headers: {},
          },
        },
      }), "utf8");
      const credentials = await SecretCredentialStore.open(
        join(dir, "credentials.json"),
        join(dir, "credentials.index.json"),
        { forceFile: true },
      );
      const store = await McpConfigStore.open(filePath, credentials);
      expect((await store.get("legacy"))?.env).toEqual({ LEGACY_TOKEN: "legacy_plain_secret" });
      expect(readFileSync(filePath, "utf8")).not.toContain("legacy_plain_secret");
      expect((await credentials.read(mcpSecretId("legacy", "env", "LEGACY_TOKEN")))?.type).toBe("api_key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalog", () => {
  test("builds schema-free entries, versions them, and selects the last five", () => {
    const tool = {
      name: "create_issue",
      description: "Create an issue in a repository. Requires write access.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    };
    const schema = mcpToolSchema("github", tool);
    expect(schema.function.name).toBe("mcp__github__create_issue");
    expect(schema.function.description).toBe("[MCP:github] Create an issue in a repository. Requires write access.");
    expect(schema.function.parameters).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });

    const catalog = buildMcpCatalog([schema]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.server).toBe("github");
    // 旧实现的摘要基于已加前缀的描述，因此前缀保留在 summary 里。
    expect(catalog[0]!.summary).toBe("[MCP:github] Create an issue in a repository.");
    expect(catalog[0]!.keywords).toContain("github");
    expect(catalog[0]!.schema_hash).toHaveLength(16);

    const version = mcpCatalogVersion(catalog);
    expect(version).toHaveLength(16);
    expect(mcpCatalogVersion(buildMcpCatalog([schema]))).toBe(version);

    const many = Array.from({ length: 7 }, (_, index) => mcpToolSchema("srv", {
      name: `tool_${index}`,
      description: "",
      inputSchema: {},
    }));
    const names = many.map((item) => item.function.name);
    expect(selectMcpSchemas(many, names, 5).map((item) => item.function.name)).toEqual(names.slice(2));
    expect(selectMcpSchemas(many, [names[0]!, "mcp__srv__missing"], 5)).toHaveLength(1);
  });

  test("validates arguments with the old messages", () => {
    const schema = mcpToolSchema("fake", {
      name: "add",
      description: "",
      inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
    }).function.parameters;
    expect(validateMcpArgs(schema, { a: 1 })).toEqual({ ok: false, error: "缺少必填参数: b" });
    expect(validateMcpArgs(schema, { a: 1, b: "2" })).toEqual({ ok: false, error: "参数 'b' 类型错误: 期望 integer" });
    expect(validateMcpArgs(schema, { a: 1, b: 2 })).toEqual({ ok: true });
  });
});

describe("stdio client", () => {
  test("connects, lists tools, calls them, and formats server errors", async () => {
    const client = new McpServerClient(fakeConfig(), clientOptions());
    try {
      expect(await client.connectNow()).toBe(true);
      expect(client.status).toBe("connected");
      expect(client.tools.map((tool) => tool.name)).toContain("echo");

      expect(await client.callTool("echo", { message: "hi" })).toEqual({ text: "hi", failed: false });
      expect(await client.callTool("add", { a: 2, b: 3 })).toEqual({ text: "5", failed: false });

      const toolError = await client.callTool("fail", {});
      expect(toolError.failed).toBe(true);
      expect(toolError.text).toBe(formatMcpError("fake", "fail", "boom from fake server"));

      const rpcError = await client.callTool("rpc_fail", {});
      expect(rpcError.failed).toBe(true);
      expect(rpcError.text).toContain("Error: rpc exploded");
      // JSON-RPC error 不触发重连重试：进程仍然是原来那个连接。
      expect(client.status).toBe("connected");

      const missing = await client.callTool("echo", {});
      expect(missing.text).toBe(formatMcpError("fake", "echo", "参数校验失败: 缺少必填参数: message"));
    } finally {
      await client.close();
    }
  });

  test("does not serialize concurrent tool calls", async () => {
    const client = new McpServerClient(fakeConfig(), clientOptions());
    try {
      expect(await client.connectNow()).toBe(true);
      const startedAt = performance.now();
      const [first, second] = await Promise.all([
        client.callTool("slow", { delay_ms: 150 }),
        client.callTool("slow", { delay_ms: 150 }),
      ]);
      const elapsed = performance.now() - startedAt;
      expect(first.text).toBe("slept 150");
      expect(second.text).toBe("slept 150");
      expect(elapsed).toBeLessThan(280);
    } finally {
      await client.close();
    }
  });

  test("times out and reports the retry failure", async () => {
    const client = new McpServerClient(fakeConfig(), clientOptions({ callTimeoutMs: 120 }));
    try {
      expect(await client.connectNow()).toBe(true);
      const outcome = await client.callTool("slow", { delay_ms: 600 });
      expect(outcome.failed).toBe(true);
      expect(outcome.text).toContain("重连后重试仍失败");
      expect(outcome.text).toContain("MCP 请求超时");
    } finally {
      await client.close();
    }
  });

  test("reconnects after the server crashes", async () => {
    const dir = tempDir();
    const starts = join(dir, "starts.log");
    const client = new McpServerClient(fakeConfig({ env: { FAKE_START_FILE: starts } }), clientOptions());
    try {
      expect(await client.connectNow()).toBe(true);
      const crashed = await client.callTool("crash", {});
      expect(crashed.failed).toBe(true);
      expect(crashed.text).toContain("重连后重试仍失败");

      expect(await client.callTool("echo", { message: "after" })).toEqual({ text: "after", failed: false });
      const spawned = readFileSync(starts, "utf8").trim().split("\n").filter((line) => line !== "").length;
      expect(spawned).toBeGreaterThanOrEqual(3);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closes an idle connection and reconnects on demand", async () => {
    const client = new McpServerClient(fakeConfig(), clientOptions({ idleTimeoutMs: 60 }));
    try {
      expect(await client.connectNow()).toBe(true);
      expect((await client.callTool("echo", { message: "first" })).text).toBe("first");
      await until(() => client.status === "disconnected");
      expect((await client.callTool("echo", { message: "second" })).text).toBe("second");
      expect(client.status).toBe("connected");
    } finally {
      await client.close();
    }
  });

  test("reports a missing command instead of hanging", async () => {
    const client = new McpServerClient(fakeConfig({ command: process.execPath, args: ["/nonexistent/mcp-server.mjs"] }), clientOptions());
    try {
      // 命令存在（Bun），文件不存在会让子进程立刻退出：连接失败，文案来自旧实现的启动失败提示。
      const connected = await client.connectNow();
      if (!connected) {
        expect(client.status).toBe("error");
        expect(client.lastError).not.toBe("");
      } else {
        expect(client.tools).toEqual([]);
      }
    } finally {
      await client.close();
    }
  });
});

describe("createMcpTools", () => {
  test("exposes deferred registrations, the catalog, and full-name calls", async () => {
    const mcp = await createMcpTools({ servers: [fakeConfig()], client: clientOptions() });
    try {
      const registrations = mcp.tools();
      const echo = registrations.find((tool) => tool.name === mcpToolName("fake", "echo"));
      expect(echo).toBeDefined();
      expect(echo!.deferred).toBe(true);
      expect(echo!.replay).toBe("unsafe");
      expect(echo!.description.startsWith("[MCP:fake]")).toBe(true);

      const snapshot = await mcp.catalog.read();
      expect(snapshot.version).toHaveLength(16);
      expect(snapshot.catalog.map((entry) => entry.name)).toContain("mcp__fake__echo");

      expect(await mcp.call("mcp__fake__echo", { message: "hey" })).toBe("hey");
      expect(await mcp.call("not-a-tool", {})).toBe(
        formatMcpError("unknown", "not-a-tool", "无效的 MCP 工具名格式: not-a-tool"),
      );
      expect(await mcp.call("mcp__ghost__x", {})).toBe(formatMcpError("ghost", "x", "服务器未注册"));

      expect(await mcp.discover("please echo something")).toEqual(["mcp__fake__echo"]);
      expect(mcp.recentNames()).toEqual(["mcp__fake__echo"]);

      const names = registrations.map((tool) => tool.name);
      mcp.catalog.record?.(names);
      expect(mcp.recentNames()).toEqual(names.slice(-5));
      const selected = mcp.selectForTurn([...names, names[0]!], 5).map((tool) => tool.name);
      expect(selected).toEqual(names.slice(-5));
    } finally {
      await mcp.close();
    }
  });

  test("search_mcp_tools loads matches through control.addTools", async () => {
    const mcp = await createMcpTools({ servers: [fakeConfig()], client: clientOptions() });
    try {
      const deps = { mcpCatalog: mcp.catalog } as unknown as AppToolDeps;
      const tool = createInteractionTools(deps).find((candidate) => candidate.name === "search_mcp_tools");
      expect(tool).toBeDefined();
      const result = await tool!.execute({ query: "echo" }, undefined as never, undefined as never);
      const text = result.output?.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n") ?? "";
      const parsed = JSON.parse(text) as { matches: { name: string }[]; hint: string };
      expect(parsed.matches[0]?.name).toBe("mcp__fake__echo");
      expect(parsed.hint).toBe("Matched tools will be available on the next model step.");
      expect(result.control?.addTools).toEqual(["mcp__fake__echo"]);
      expect(mcp.recentNames()).toEqual(["mcp__fake__echo"]);

      const empty = await tool!.execute({ query: "no-such-capability" }, undefined as never, undefined as never);
      expect(empty.control).toBeUndefined();
    } finally {
      await mcp.close();
    }
  });
});

describe("sse transport", () => {
  test("discovers the endpoint event, lists tools, and calls them", async () => {
    // 旧实现的 SSE 传输：GET 流里等 endpoint，之后全部 POST。这里用一个进程内的最小 SSE 服务验证。
    const tools = [
      { name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
    ];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/sse") {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        if (request.method !== "POST" || url.pathname !== "/messages") return new Response("not found", { status: 404 });
        const message = (await request.json()) as { id?: number; method: string; params?: { name?: string; arguments?: { message?: string } } };
        if (message.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (message.method === "notifications/initialized") return Response.json({ ok: true });
        if (message.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools } });
        }
        if (message.method === "tools/call") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: String(message.params?.arguments?.message ?? "") }] },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
      },
    });
    const client = new McpServerClient(
      fakeConfig({ transport: "sse", url: `http://127.0.0.1:${server.port}/sse`, command: "", args: [] }),
      clientOptions(),
    );
    try {
      expect(await client.connectNow()).toBe(true);
      expect(client.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(await client.callTool("echo", { message: "over sse" })).toEqual({ text: "over sse", failed: false });
    } finally {
      await client.close();
      server.stop(true);
    }
  });
});
