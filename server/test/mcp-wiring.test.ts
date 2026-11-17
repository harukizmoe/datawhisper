/**
 * MCP 接线：不是客户端的单元测试（那在 `mcp.test.ts`），而是「配置进来 → 连上 → 注册表有工具 →
 * 本轮暴露层能选中 → IPC 能读状态」这条生产路径。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createMethods } from "../src/ipc/methods.ts";
import type { MethodParams, RpcMethod } from "../src/ipc/rpc.ts";
import { startService, type Service } from "../src/service.ts";
import { toolsForTurn } from "../src/tools/select.ts";
import { connectToService } from "./support/pipe.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-fake-server.mjs");
// 生产白名单只认 node/npx/uvx 等；测试用 node 跑同一份假服务器（bun 不在旧实现的白名单里）。
const NODE = "node";

let dir = "";
let service: Service;
let methods: Record<string, RpcMethod>;

const call = async (method: string, params: MethodParams = {}) => {
  const impl = methods[method];
  if (impl === undefined) throw new Error(`missing method ${method}`);
  return impl(params);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-mcp-wiring-"));
  service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
  methods = createMethods({
    harness: service.harness,
    compute: service.compute,
    modelService: service.modelService,
    conversations: service.conversations,
    context: service.context,
    publish: () => undefined,
    dataDir: dir,
    mcp: service.mcp,
  });
});

afterAll(async () => {
  await service?.stop();
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

describe("MCP 生产接线", () => {
  test("保存配置后连上，列表显示状态与工具数，且密钥值不出现在返回值里", async () => {
    const result = (await call("mcp.upsert", {
      server: {
        server_id: "fake",
        label: "Fake",
        transport: "stdio",
        command: NODE,
        args: [FIXTURE],
        env: { FAKE_TOKEN: "s3cret" },
      },
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const view = (await call("mcp.list")) as {
      servers: { server_id: string; status: string; tools: number; envKeys: string[] }[];
    };
    const server = view.servers.find((item) => item.server_id === "fake");
    expect(server).toBeDefined();
    expect(server!.status).toBe("connected");
    expect(server!.tools).toBeGreaterThan(0);
    expect(server!.envKeys).toEqual(["FAKE_TOKEN"]);
    expect(JSON.stringify(view)).not.toContain("s3cret");
  }, 30_000);

  test("目录可读，工具真的在注册表里，暴露层选中后才是模型可见", async () => {
    const snapshot = await service.mcp.tools.catalog.read();
    const echo = snapshot.catalog.find((entry) => entry.name.endsWith("__echo"));
    expect(echo).toBeDefined();

    const name = echo!.name;
    const registrations = service.mcp.tools.tools();
    expect(registrations.map((tool) => tool.name)).toContain(name);

    // 预发现把名字放进最近列表；暴露层按 includeMcp + allowedMcpTools 选中。
    await service.mcp.tools.discover("echo a message");
    const visible = toolsForTurn(registrations, {
      userMessage: "echo a message",
      hasDataSource: false,
      hasWorkspace: false,
      teamsEnabled: false,
      includeMcp: true,
      allowedMcpTools: service.mcp.tools.recentNames(5),
    });
    expect(visible.map((tool) => tool.name)).toContain(name);
  }, 30_000);

  test("测试连接不落盘；坏配置返回 ok:false 而不是抛协议错误", async () => {
    const good = (await call("mcp.test", {
      server: { server_id: "probe", transport: "stdio", command: NODE, args: [FIXTURE] },
    })) as { ok: boolean; tools: number };
    expect(good.ok).toBe(true);
    expect(good.tools).toBeGreaterThan(0);

    const bad = (await call("mcp.test", {
      server: { server_id: "probe2", transport: "stdio", command: "bash", args: ["-lc", "echo hi"] },
    })) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
    expect(bad.error ?? "").not.toBe("");

    const view = (await call("mcp.list")) as { servers: { server_id: string }[] };
    expect(view.servers.map((item) => item.server_id)).not.toContain("probe");
  }, 30_000);

  test("attachIpc 注册了 mcp.* 方法（界面能直接调用）", async () => {
    const pipe = connectToService(service, { dataDir: dir });
    try {
      const list = await pipe.client.request<{ servers: { server_id: string }[] }>("mcp.list");
      expect(Array.isArray(list.servers)).toBe(true);
      const view = await pipe.client.request<{ servers: unknown[] }>("mcp.refresh");
      expect(Array.isArray(view.servers)).toBe(true);
    } finally {
      pipe.close();
    }
  }, 30_000);

  test("删除后从列表与注册表消失", async () => {
    const removed = (await call("mcp.remove", { serverId: "fake" })) as { ok: boolean };
    expect(removed.ok).toBe(true);
    const view = (await call("mcp.list")) as { servers: { server_id: string }[] };
    expect(view.servers.map((item) => item.server_id)).not.toContain("fake");
    expect(service.mcp.tools.tools().map((tool) => tool.name)).not.toContain("mcp__fake__echo");
  }, 30_000);
});
