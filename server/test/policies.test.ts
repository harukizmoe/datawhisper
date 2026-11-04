import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { TurnDoc } from "../src/agent/turn.ts";
import { loadConfig } from "../src/config.ts";
import { type Service, startService } from "../src/service.ts";
import { stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

/**
 * 三条输出侧策略的端到端用例：走真实服务 + 桩模型 + 桩工具，断言的是模型实际看到的内容
 * （工具结果里的 `[SYSTEM BLOCK]`、后续请求里的 `[QUALITY GATE]` / `[SYSTEM NOTE]`），不是内部函数返回值。
 */

type Running = { service: Service; stub: Stub; dir: string };
const running: Running[] = [];

afterEach(async () => {
  for (const { service, stub, dir } of running.splice(0)) {
    await service.stop();
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function tool(name: string, text: string): ToolRegistration {
  return defineTool({
    name,
    description: `Test double for ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    replay: "safe",
    async execute() {
      return { output: [{ type: "text", text }] };
    },
  });
}

async function start(options: { tools: ToolRegistration[]; answerText?: string }): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "dw-policy-test-"));
  const stub = startStub({ chunkDelayMs: 0, answerText: options.answerText });
  const service = await startService(loadConfig({ DW_DATA_DIR: dir }), {
    tools: options.tools,
    turnState: () => ({ hasDataSource: true, sourceCount: 1, hasWorkspace: false, hasUnnamedColumns: false, teamsEnabled: false }),
  });
  await service.modelService.putProvider(stubProvider(stub.url));
  const r = { service, stub, dir };
  running.push(r);
  return r;
}

/**
 * 提交一轮并等它空闲。
 *
 * `modelTools` 显式给出时覆盖本轮的暴露结果——策略层要守的正是「模型能调到本不该调的工具」这种情况，而暴露
 * 算法本身已有独立 golden 覆盖（`exposure.test.ts`），这里不去重复验证它。
 */
async function turn(service: Service, text: string, options: { command?: string; modelTools?: ToolRegistration[] } = {}): Promise<void> {
  const root = await service.harness.root(ctx);
  const agent = await root.agent(ctx);
  if (agent.model === undefined) await root.configure((await service.modelService.defaultAgent())!, ctx);
  if (options.modelTools !== undefined) await root.configure({ modelTools: options.modelTools }, ctx);
  await service.submitTurn(root.id, { requestId: crypto.randomUUID(), text, ...(options.command === undefined ? {} : { command: options.command }) });
  await root.waitForIdle(ctx);
}

/** 直接经 Harness 提交一轮（不经过本服务的暴露层），用来构造"模型拿到了不该给的工具"。 */
async function rawTurn(service: Service, text: string, modelTools: ToolRegistration[], command?: string): Promise<void> {
  const root = await service.harness.root(ctx);
  const agent = await root.agent(ctx);
  if (agent.model === undefined) await root.configure((await service.modelService.defaultAgent())!, ctx);
  if (command !== undefined) {
    await root.commit(async (tx) => {
      const doc = await tx.doc(TurnDoc, root.id);
      doc.command = command;
      doc.activation = { kind: "command", name: command };
    }, ctx);
  }
  await root.configure({ modelTools }, ctx);
  await root.submit({ type: "input", content: text, requestId: crypto.randomUUID() }, ctx);
  await root.waitForIdle(ctx);
}

describe("输出类工具守卫", () => {
  test("普通对话里调用 generate_ppt 被拦下，模型收到 SYSTEM BLOCK", async () => {
    const ppt = tool("generate_ppt", "幻灯片已生成");
    const { service, stub } = await start({ tools: [ppt] });
    // 绕过本服务的暴露层直接给模型这个工具：守卫要防的正是「模型调到了本不该被提供的工具」。
    await rawTurn(service, "CALL:generate_ppt 帮我做个 PPT", [ppt]);
    const toolResult = stub.log.at(-1)?.lastTool ?? "";
    expect(toolResult).toContain("[SYSTEM BLOCK]");
    expect(toolResult).toContain("Do NOT call output tools in regular chat.");
  }, 30_000);

  test("用 /ppt 命令时同一个工具会被执行", async () => {
    const ppt = tool("generate_ppt", "幻灯片已生成");
    const { service, stub } = await start({ tools: [ppt] });
    await rawTurn(service, "CALL:generate_ppt 做个 PPT", [ppt], "ppt_confirm");
    const toolResult = stub.log.at(-1)?.lastTool ?? "";
    expect(toolResult).toContain("幻灯片已生成");
    expect(toolResult).not.toContain("[SYSTEM BLOCK]");
  }, 30_000);
});

describe("数字溯源核对", () => {
  test("回答里的数字没有工具出处时会补一轮修复，且只补一轮", async () => {
    const query = tool("query_data", "rows: 1,956");
    const { service, stub } = await start({ tools: [query], answerText: "## 结论\n\n总订单 2,956 单，明显高于预期。" });
    await turn(service, "CALL:query_data 查一下订单数", { modelTools: [query] });
    const gateRequests = stub.log.filter((r) => r.lastUser.startsWith("[QUALITY GATE]"));
    expect(gateRequests).toHaveLength(1);
    expect(gateRequests[0]!.lastUser).toContain("2956");
    // 修复轮就是最后一次请求：模型随后给出回答，且不会再有第二条门禁消息（旧实现同样只补一轮）。
    expect(stub.log.at(-1)).toBe(gateRequests[0]!);
  }, 30_000);

  test("数字能在工具结果里找到出处时不补轮", async () => {
    const query = tool("query_data", "rows: 2,956");
    const { service, stub } = await start({ tools: [query], answerText: "## 结论\n\n总订单 2,956 单。" });
    await turn(service, "CALL:query_data 查一下订单数", { modelTools: [query] });
    expect(stub.log.filter((r) => r.lastUser.startsWith("[QUALITY GATE]"))).toHaveLength(0);
  }, 30_000);
});

describe("文本形式工具调用", () => {
  test("正文里写伪 XML 调用时提醒改用原生工具调用，且只提醒一次", async () => {
    const { service, stub } = await start({
      tools: [tool("display_diagram", "已显示")],
      answerText: '<display_diagram><parameter name="xml">&lt;mxfile/&gt;</parameter></display_diagram>',
    });
    await turn(service, "画个图");
    const notes = stub.log.filter((r) => r.lastUser.startsWith("[SYSTEM NOTE]"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.lastUser).toContain("display_diagram");
    expect(notes[0]!.lastUser).toContain("原生工具调用");
  }, 30_000);
});
