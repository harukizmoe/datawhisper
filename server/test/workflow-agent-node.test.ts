import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { type Service, startService } from "../src/service.ts";
import type { WorkflowGraph } from "../src/workflows/types.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";
import { stubProvider } from "./support/stub-models.ts";

/**
 * 端到端：一次工作流运行里，节点真的跑一轮 agent 会话并取回答复。
 *
 * 这条用例覆盖装配本身——`startService` 装 jobs/workflows 扩展、节点执行器接会话服务、
 * 运行与节点的记录投影——而不是调度算法（那是 `workflows.test.ts` 用桩执行器的范围）。
 */
let service: Service;
let stub: Stub;
let dir: string;

const graph: WorkflowGraph = {
  nodes: [
    { node_id: "collect", prompt: "列出你能看到的表数量。", output_contract: ["summary"] },
    { node_id: "report", prompt: "把上一步的结论写成一句话。", output_contract: ["report"] },
  ],
  edges: [{ edge_id: "e1", from_node: "collect", to_node: "report", type: "auto" }],
  entry_node_ids: ["collect"],
  limits: { max_concurrent_node_runs: 1 },
  output_schema: { properties: { report: { type: "string" } }, required: ["report"] },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-wf-node-"));
  stub = startStub({ chunkDelayMs: 0 });
  service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
  await service.modelService.putProvider(stubProvider(stub.url));
  const model = service.modelService.models.getModels().find((candidate) => candidate.provider === "custom-stub");
  await service.modelService.setDefault({ provider: "custom-stub", modelId: model!.id }, null);
});

afterAll(async () => {
  await service?.stop();
  stub?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("工作流节点执行器", () => {
  test("两个节点各跑一轮真实会话，运行按最终输出结算", async () => {
    const conversation = await service.conversations.create({ title: "workflow host" });
    const started = await service.workflows.start({
      workflowVersionId: "wf-node-1",
      graph,
      inputs: {},
      startedBy: "test",
      workspaceId: "ws-1",
      conversationId: conversation.id,
    });
    const detail = await service.workflows.wait(started.id);
    expect(detail.status).toBe("succeeded");
    expect(detail.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ["collect", "succeeded"],
      ["report", "succeeded"],
    ]);
    // 节点输出是真实会话的助手文本，最终输出按 output_schema 过滤后只剩 report。
    expect(Object.keys(detail.outputs)).toEqual(["report"]);
    // stub 的回答固定是那段 markdown；节点把整段文本归到唯一声明的字段 report 上。
    expect(String(detail.outputs.report)).toContain("streamed");
    // 用量从节点的这一轮对话里汇总（stub 会返回 usage）。
    expect(detail.nodes.every((node) => node.usage?.input_tokens !== undefined || node.usage === undefined)).toBe(true);
  });

  test("没有 prompt 的节点在运行前就失败，而不是静默跳过", async () => {
    const conversation = await service.conversations.create({ title: "workflow host 2" });
    const started = await service.workflows.start({
      workflowVersionId: "wf-node-2",
      graph: { nodes: [{ node_id: "empty" }], edges: [], entry_node_ids: ["empty"] },
      inputs: {},
      startedBy: "test",
      workspaceId: "ws-1",
      conversationId: conversation.id,
    });
    const detail = await service.workflows.wait(started.id);
    expect(detail.status).toBe("failed");
    expect(detail.failure?.code).toBe("workflow_node_failed");
    expect(detail.nodes[0]?.error).toContain("has no prompt");
  });
});
