import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_RULES } from "../src/agent/prompts.ts";
import { readTurnResult, verifierDecision } from "../src/workflows/agent-node.ts";
import { loadConfig } from "../src/config.ts";
import { createConversationSourceStore } from "../src/ipc/source-store.ts";
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

  test("节点会话不进会话列表；只看到自己的工具名单；带着发起会话的数据源", async () => {
    const host = await service.conversations.create({});
    const store = createConversationSourceStore({ harness: service.harness, context: service.context });
    await store.update(host.id, (draft) => {
      draft.sources.push({
        id: "s_wf1",
        kind: "csv",
        name: "sales.csv",
        active: true,
        descriptor: { kind: "csv", file_path: "/x/sales.csv" },
        tables: ["sales"],
        createdAt: "2026-11-10T00:00:00Z",
        updatedAt: "2026-11-10T00:00:00Z",
      });
      draft.sources.push({
        id: "s_wf2",
        kind: "csv",
        name: "off.csv",
        active: false,
        descriptor: { kind: "csv", file_path: "/x/off.csv" },
        createdAt: "2026-11-10T00:00:00Z",
        updatedAt: "2026-11-10T00:00:00Z",
      });
    });
    const before = (await service.conversations.list()).conversations.length;
    const mark = stub.log.length;
    const started = await service.workflows.start({
      workflowVersionId: "wf-node-3",
      graph: {
        nodes: [
          { node_id: "look", prompt: "NODE-LOOK inspect the schema.", output_contract: ["notes"], allowed_tools: ["get_schema"] },
          { node_id: "write", prompt: "NODE-WRITE summarize.", input_contract: ["notes"], output_contract: ["summary"], allowed_tools: [] },
          { node_id: "dflt", prompt: "NODE-DEFAULT check the data.", input_contract: ["notes"], output_contract: ["more"] },
        ],
        edges: [
          { edge_id: "e1", from_node: "look", to_node: "write", type: "auto" },
          { edge_id: "e2", from_node: "look", to_node: "dflt", type: "auto" },
        ],
        entry_node_ids: ["look"],
      },
      inputs: {},
      startedBy: "test",
      workspaceId: "",
      conversationId: host.id,
    });
    expect((await service.workflows.wait(started.id)).status).toBe("succeeded");

    // 三个节点各建了一个会话，但列表里一个都没有多出来。
    expect((await service.conversations.list()).conversations.length).toBe(before);

    const requests = stub.log.slice(mark);
    const forNode = (marker: string) => requests.find((request) => request.lastUser.includes(marker));
    expect(forNode("NODE-LOOK")?.tools).toEqual(["get_schema"]);
    expect(forNode("NODE-WRITE")?.tools).toEqual([]);
    // 没写 allowed_tools 的节点只拿到只读的数据工具，不会有写文件、导出之类。
    expect(forNode("NODE-DEFAULT")?.tools.sort()).toEqual(["get_schema", "get_table_detail", "profile_data", "query_data", "query_knowledge"]);

    // 发起会话里启用的数据源被带进节点：系统提示里挂了数据规则块（TurnDoc 的 hasDataSource 为真）。
    const system = (request: typeof requests[number] | undefined) => {
      const first = (request?.body.messages as { role: string; content: unknown }[])[0];
      return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content);
    };
    expect(system(forNode("NODE-LOOK"))).toContain(DATA_RULES.slice(0, 60));
  });
});

describe("verifier 与 validation 节点", () => {
  test("validation 节点不调模型：规则通过时给下游一句说明，缺输入或为空时节点失败", async () => {
    const host = await service.conversations.create({});
    const mark = stub.log.length;
    const run = async (inputs: Record<string, string>, validation: Record<string, string[]>) => {
      const started = await service.workflows.start({
        workflowVersionId: "wf-validation",
        graph: {
          nodes: [{ node_id: "check", type: "validation", input_contract: ["goal"], output_contract: ["validated"], validation, max_attempts: 1 }],
          edges: [],
          entry_node_ids: ["check"],
        },
        inputs,
        startedBy: "test",
        workspaceId: "",
        conversationId: host.id,
      });
      return service.workflows.wait(started.id);
    };

    const ok = await run({ goal: "Q3" }, { required: ["goal"], non_empty: ["goal"] });
    expect(ok.status).toBe("succeeded");
    expect(ok.outputs.validated).toBe("Validated inputs: goal");

    const missing = await run({}, { required: ["goal"] });
    expect(missing.status).toBe("failed");
    expect(missing.nodes[0]?.error).toContain("required input is missing: goal");

    const blank = await run({ goal: "   " }, { non_empty: ["goal"] });
    expect(blank.status).toBe("failed");
    expect(blank.nodes[0]?.error).toContain("input must not be empty: goal");

    expect(stub.log.length).toBe(mark);
  });

  test("verifier 的 decision 忽略大小写；取值之外的一律让节点失败，不当成通过", () => {
    const node = { node_id: "v", type: "verifier" };
    expect(verifierDecision(node, " REWORK ")).toBe("rework");
    expect(verifierDecision(node, "pass")).toBe("pass");
    expect(verifierDecision(node, "escalate")).toBe("escalate");
    for (const bad of ["approved", "", undefined, 1, ["pass"]]) {
      expect(() => verifierDecision(node, bad as never)).toThrow("expected one of pass, rework, escalate");
    }
  });
});

describe("readTurnResult", () => {
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({ kind: "pi.assistant", model: [{ content, ...extra }] });

  test("只认最后一条助手消息：它出错没有正文时，不拿工具调用前的评论顶替，并带出结束原因", () => {
    const result = readTurnResult([
      assistant([{ type: "text", text: "Let me check the schema." }, { type: "toolCall" }], { stopReason: "toolUse" }),
      { kind: "pi.tool-call" },
      assistant([], { stopReason: "error", errorMessage: "upstream timeout" }),
    ]);
    expect(result).toMatchObject({ text: "", stopReason: "error", errorMessage: "upstream timeout", usage: { tool_calls: 1 } });
  });

  test("正常结束时取最后一条的正文", () => {
    const result = readTurnResult([
      assistant([{ type: "text", text: "draft" }], { stopReason: "toolUse" }),
      assistant([{ type: "text", text: "final" }], { stopReason: "stop" }),
    ]);
    expect(result).toMatchObject({ text: "final", stopReason: "stop" });
  });
});
