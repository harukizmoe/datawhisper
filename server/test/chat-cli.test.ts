import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { runChatCli } from "../scripts/chat-cli.ts";
import { loadConfig } from "../src/config.ts";
import { TurnDoc } from "../src/agent/turn.ts";
import { type Service, startService } from "../src/service.ts";
import { connectToService } from "./support/pipe.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";
import { stubProvider } from "./support/stub-models.ts";

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
  service = await startService(loadConfig({ DW_DATA_DIR: dir }), {
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

/** 用内存管道把命令行接到给定服务上，输出收集到字符串里而不是终端。 */
async function runCli(target: Service, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe("chat-cli", () => {
  test("一轮带工具调用的对话从命令行走通，工具结果回到模型", async () => {
    const run = await runCli(service, ['CALL:get_schema{"table":"orders"} 查一下表结构', "--conversation", "root"]);
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
    const run = await runCli(service, ["再来一次", "--conversation", "root"]);
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
    const bare = await startService(loadConfig({ DW_DATA_DIR: emptyDir }), { forceFileCredentials: true });
    try {
      const result = await runCli(bare, ["hi"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("no_model");
    } finally {
      await bare.stop();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 30_000);
});
