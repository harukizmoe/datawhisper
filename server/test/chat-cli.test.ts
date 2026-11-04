import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { TurnDoc } from "../src/agent/turn.ts";
import { type Service, startService } from "../src/service.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";
import { stubProvider } from "./support/stub-models.ts";

const TOKEN = "cli-test-token";
const SERVER_DIR = join(import.meta.dir, "..");

/**
 * 测试用的 `get_schema` 替身：名字取自真实注册表（`tools/registry.ts`），所以能通过工具暴露过滤；
 * 实现只回显参数，用来证明“模型调用工具 → 工具结果回到模型”这条链路通了。P4 会换成真正的实现。
 */
const fakeGetSchema: ToolRegistration = defineTool({
  name: "get_schema",
  description: "Return the schema of the current data source. (test double)",
  parameters: {
    type: "object",
    properties: { table: { type: "string", description: "Table name" } },
    required: ["table"],
  },
  replay: "safe",
  async execute(args: { table: string }) {
    return { output: [{ type: "text", text: `get_schema(${args.table}) = columns: id, amount` }] };
  },
});

let service: Service;
let stub: Stub;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-cli-test-"));
  stub = startStub({ chunkDelayMs: 0 });
  service = await startService(loadConfig({ DW_TOKEN: TOKEN, DW_DATA_DIR: dir, DW_PORT: "0" }), {
    forceFileCredentials: true,
    tools: [fakeGetSchema],
    // 真实工具的 `requires_data_source` 只在有数据源时暴露，这里模拟已连接一个数据源。
    turnState: () => ({ hasDataSource: true, sourceCount: 1, hasWorkspace: false, hasUnnamedColumns: false, teamsEnabled: false }),
  });
  await service.modelService.putProvider(stubProvider(stub.url));
});

afterAll(async () => {
  await service?.stop();
  stub?.stop();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 子进程必须异步启动：同进程里的服务要响应 CLI 的 HTTP 请求，`spawnSync` 会堵住事件循环，直接死锁。
 */
async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", "scripts/chat-cli.ts", ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("chat-cli", () => {
  test("一轮带工具调用的对话从命令行走通，工具结果回到模型", async () => {
    const run = await runCli(["CALL:get_schema{\"table\":\"orders\"} 查一下表结构", "--conversation", "root"], { DW_PORT: String(service.port), DW_TOKEN: TOKEN });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // 工具行说明模型真的调用了工具（工具集合与执行链路都通）。
    expect(run.stdout).toContain("[工具 get_schema: done]");
    // stub 在收到工具结果后会把结果原文写进回答，说明结果回到了模型。
    expect(run.stdout).toContain("get_schema(orders) = columns: id, amount");
    expect(run.stdout).toContain("stopReason=stop");
    expect(run.stdout).toContain("[用量]");
  }, 30_000);

  test("命令行的提交写下了本轮上下文，工具集按轮收敛", async () => {
    const run = await runCli(["再来一次", "--conversation", "root"], { DW_PORT: String(service.port), DW_TOKEN: TOKEN });
    expect(run.code).toBe(0);
    const root = await service.harness.root(ctx);
    const turn = await service.harness.snapshot(TurnDoc, root.id, ctx);
    expect(turn?.message).toBe("再来一次");
    expect(turn?.turn).toBeGreaterThanOrEqual(2);
    const agent = await root.agent(ctx);
    expect(agent.tools.map((tool) => tool.name)).toEqual(["get_schema"]);
  }, 30_000);

  test("没有模型时命令行以非零码退出并打印服务端错误", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dw-cli-nomodel-"));
    const bare = await startService(loadConfig({ DW_TOKEN: TOKEN, DW_DATA_DIR: emptyDir, DW_PORT: "0" }), { forceFileCredentials: true });
    try {
      const result = await runCli(["hi"], { DW_PORT: String(bare.port), DW_TOKEN: TOKEN });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("no_model");
    } finally {
      await bare.stop();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
