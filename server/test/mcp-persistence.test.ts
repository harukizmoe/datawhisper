/**
 * 发现状态写进会话文档：桌面端重启服务后，同一会话仍按上次发现的工具名曝光。
 * 这里用真实服务 + 假 MCP 服务器 + 桩模型跑两个进程生命周期。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { runChatCli } from "../scripts/chat-cli.ts";
import { loadConfig } from "../src/config.ts";
import { TurnDoc } from "../src/agent/turn.ts";
import { type Service, startService } from "../src/service.ts";
import { connectToService } from "./support/pipe.ts";
import { stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-fake-server.mjs");
const NODE = "node";

type CliRun = { code: number; stdout: string; stderr: string };

async function runCli(target: Service, args: string[]): Promise<CliRun> {
  const pipe = connectToService(target);
  let stdout = "";
  let stderr = "";
  try {
    const code = await runChatCli(args, {
      connect: async () => ({ client: pipe.client, close: () => pipe.close() }),
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  } finally {
    pipe.close();
  }
}

const cleanup: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of cleanup.splice(0)) await item.stop();
});

describe("MCP 发现的持久化", () => {
  test("重启服务后同一会话仍保留上次发现的工具", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-mcp-persist-"));
    const stub: Stub = startStub({ chunkDelayMs: 0 });
    cleanup.push({ stop: async () => stub.stop() });

    let service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
    cleanup.push({ stop: async () => service.stop() });
    try {
      await service.modelService.putProvider(stubProvider(stub.url));
      const added = await service.mcp.store.add({
        server_id: "fake",
        label: "Fake",
        transport: "stdio",
        command: NODE,
        args: [FIXTURE],
      });
      expect(added.ok).toBe(true);
      await service.mcp.refresh();

      const root = await service.harness.root(ctx);
      const first = await runCli(service, ["echo a message", "--conversation", `${root.id}`]);
      expect(first.code).toBe(0);

      const before = await service.harness.snapshot(TurnDoc, root.id, ctx);
      expect(before?.mcpDiscovery?.names).toContain("mcp__fake__echo");
      const version = before!.mcpDiscovery!.version;
      expect(version).not.toBe("");

      // 第二个进程生命周期：同一数据目录、同一会话。
      await service.stop();
      service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
      const second = await runCli(service, ["hello", "--conversation", `${root.id}`]);
      expect(second.code).toBe(0);

      const after = await service.harness.snapshot(TurnDoc, root.id, ctx);
      expect(after?.mcpDiscovery?.version).toBe(version);
      expect(after?.mcpDiscovery?.names).toContain("mcp__fake__echo");
    } finally {
      await service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
