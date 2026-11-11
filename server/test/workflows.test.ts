import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { APP_ERROR, INVALID_PARAMS } from "../src/ipc/errors.ts";
import { mapSettingsError } from "../src/ipc/methods.ts";
import { orchestrationMethods } from "../src/ipc/orchestration.ts";
import { createWorkflows, workflowsExtension, type Workflows } from "../src/workflows/service.ts";
import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeExecute,
  WorkflowNodeResult,
  WorkflowRunDetail,
  WorkflowQuotas,
} from "../src/workflows/types.ts";
import { whenAborted } from "./support/gates.ts";
import { memoryServer } from "./support/rpc.ts";

const ctx = BACKGROUND_CONTEXT;

type Behavior = (
  inputs: Record<string, JsonValue>,
  context: { nodeId: string; iteration: number; attempt: number; signal: AbortSignal },
) => Promise<WorkflowNodeResult>;

type Bench = {
  dir: string;
  registry: Registry;
  harness: Harness;
  workflows: Workflows;
  conversationId: number;
  clock: { now: number };
  behaviors: Map<string, Behavior>;
};

const benches: Bench[] = [];

async function openHarness(dir: string, clock: { now: number }): Promise<{ harness: Harness; registry: Registry }> {
  const registry = createRegistry();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "datawhisper.sqlite")),
    { models: createModels(), registry, identity: { attribution: null }, now: () => clock.now },
    ctx,
  );
  return { harness, registry };
}

function executeFrom(behaviors: Map<string, Behavior>): WorkflowNodeExecute {
  return async (node, inputs, context) => {
    const behavior = behaviors.get(node.node_id);
    if (behavior === undefined) throw new Error(`no behavior for ${node.node_id}`);
    return behavior(inputs, context);
  };
}

async function createBench(options: { quotas?: Partial<WorkflowQuotas> } = {}): Promise<Bench> {
  const dir = mkdtempSync(join(tmpdir(), "dw-workflows-test-"));
  const clock = { now: 1_700_000_000_000 };
  const behaviors = new Map<string, Behavior>();
  const { harness, registry } = await openHarness(dir, clock);
  const workflows = createWorkflows({
    harness,
    context: ctx,
    executeNode: executeFrom(behaviors),
    quotas: options.quotas,
    progressIntervalMs: 0,
    now: () => clock.now,
  });
  registry.install(workflowsExtension(workflows));
  const root = await harness.root(ctx);
  const bench: Bench = { dir, registry, harness, workflows, conversationId: root.id, clock, behaviors };
  benches.push(bench);
  return bench;
}

async function reopen(bench: Bench): Promise<void> {
  await bench.harness.close(ctx);
  const { harness, registry } = await openHarness(bench.dir, bench.clock);
  const workflows = createWorkflows({
    harness,
    context: ctx,
    executeNode: executeFrom(bench.behaviors),
    progressIntervalMs: 0,
    now: () => bench.clock.now,
  });
  registry.install(workflowsExtension(workflows));
  bench.harness = harness;
  bench.registry = registry;
  bench.workflows = workflows;
}

afterEach(async () => {
  for (const bench of benches.splice(0)) {
    await bench.harness.close(ctx).catch(() => undefined);
    rmSync(bench.dir, { recursive: true, force: true });
  }
});

/** 生成图：默认入口是没有入边的节点；边默认 auto。 */
function makeGraph(
  nodes: WorkflowNode[],
  edges: Array<Partial<WorkflowEdge> & { from_node: string; to_node: string }>,
  extra: Partial<WorkflowGraph> = {},
): WorkflowGraph {
  const entries = nodes.filter((node) => !edges.some((edge) => edge.to_node === node.node_id)).map((node) => node.node_id);
  return {
    nodes,
    edges: edges.map((edge, index) => ({ edge_id: `e${index}`, type: "auto", ...edge })),
    entry_node_ids: extra.entry_node_ids ?? entries,
    ...extra,
  };
}

describe("workflows", () => {
  test("线性 DAG：节点输入按契约传递，运行与节点记录完整", async () => {
    const bench = await createBench();
    const seen: Record<string, Record<string, JsonValue>> = {};
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    bench.behaviors.set("b", async (inputs) => {
      seen.b = inputs;
      return { output: { b: 2 } };
    });
    bench.behaviors.set("c", async (inputs) => {
      seen.c = inputs;
      return { output: { c: 3 } };
    });
    const graph = makeGraph(
      [
        { node_id: "a", output_contract: ["a"] },
        { node_id: "b", input_contract: ["a"], output_contract: ["b"] },
        { node_id: "c", input_contract: ["b"], output_contract: ["c"] },
      ],
      [
        { from_node: "a", to_node: "b" },
        { from_node: "b", to_node: "c" },
      ],
      { output_schema: { properties: { a: 1, b: 1, c: 1 }, required: ["a", "b", "c"] } },
    );

    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-v1",
      graph,
      inputs: {},
      startedBy: "tester",
      workspaceId: "ws-1",
    });
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);

    expect(detail.status).toBe("succeeded");
    expect(detail.failure).toBeNull();
    expect(detail.outputs).toEqual({ a: 1, b: 2, c: 3 });
    expect(seen.b).toEqual({ a: 1 });
    expect(seen.c).toEqual({ b: 2 });
    expect(detail.startedBy).toBe("tester");
    expect(detail.workspaceId).toBe("ws-1");
    expect(detail.workflowVersionId).toBe("wf-v1");
    expect(detail.startedAt).not.toBeNull();
    expect(detail.endedAt).not.toBeNull();
    expect(detail.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    for (const node of detail.nodes) {
      expect(node.nodeRunId).not.toBeNull();
      expect(node.attempt).toBe(1);
      expect(node.iteration).toBe(1);
      expect(node.startedAt).not.toBeNull();
      expect(node.endedAt).not.toBeNull();
      expect(node.error).toBe("");
    }

    const list = await bench.workflows.list({ status: "succeeded" });
    expect(list.runs.map((run) => run.id)).toEqual([id]);
    expect((await bench.workflows.list({ conversationId: bench.conversationId + 1 })).runs).toHaveLength(0);
    expect((await bench.workflows.list({ status: "failed" })).runs).toHaveLength(0);
  });

  test("节点失败按 max_attempts 重试，每次 attempt 都留在记录里", async () => {
    const bench = await createBench();
    let attempts = 0;
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    bench.behaviors.set("b", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`boom ${attempts}`);
      return { output: { b: attempts } };
    });
    const graph = makeGraph(
      [
        { node_id: "a" },
        { node_id: "b", max_attempts: 3 },
      ],
      [{ from_node: "a", to_node: "b" }],
    );
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-retry",
      graph,
    });
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);

    expect(detail.status).toBe("succeeded");
    expect(detail.outputs).toEqual({ a: 1, b: 3 });
    const bNodes = detail.nodes.filter((node) => node.nodeId === "b");
    expect(bNodes.map((node) => node.attempt)).toEqual([1, 2, 3]);
    expect(bNodes.map((node) => node.status)).toEqual(["failed", "failed", "succeeded"]);
    expect(bNodes[0]?.error).toContain("boom 1");
    expect(bNodes[1]?.error).toContain("boom 2");
  });

  test("失败用尽 attempts 后下游跳过、运行终止失败", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    bench.behaviors.set("b", async () => {
      throw new Error("node exploded");
    });
    bench.behaviors.set("c", async () => ({ output: { c: 3 } }));
    bench.behaviors.set("d", async () => ({ output: { d: 4 } }));
    bench.behaviors.set("e", async () => ({ output: { e: 5 } }));
    const graph = makeGraph(
      [{ node_id: "a" }, { node_id: "b" }, { node_id: "c" }, { node_id: "d" }, { node_id: "e" }],
      [
        { from_node: "a", to_node: "b" },
        { from_node: "b", to_node: "c" },
        { from_node: "a", to_node: "d" },
        { from_node: "d", to_node: "e" },
      ],
    );
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-skip",
      graph,
    });
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);

    expect(detail.status).toBe("failed");
    expect(detail.failure?.code).toBe("workflow_node_failed");
    const byId = new Map(detail.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get("b")?.status).toBe("failed");
    expect(byId.get("b")?.error).toContain("node exploded");
    expect(byId.get("c")?.status).toBe("skipped");
    // 与失败节点无关的分支照常跑完（旧实现的并行分支语义）。
    expect(byId.get("d")?.status).toBe("succeeded");
    expect(byId.get("e")?.status).toBe("succeeded");
  });

  test("join_policy=all_terminal：任一前驱成功即可继续，运行仍因失败节点终止", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    bench.behaviors.set("b", async () => {
      throw new Error("bad branch");
    });
    bench.behaviors.set("d", async () => ({ output: { d: 4 } }));
    bench.behaviors.set("f", async () => ({ output: { f: 6 } }));
    const graph = makeGraph(
      [{ node_id: "a" }, { node_id: "b" }, { node_id: "d" }, { node_id: "f", join_policy: "all_terminal" }],
      [
        { from_node: "a", to_node: "b" },
        { from_node: "a", to_node: "d" },
        { from_node: "b", to_node: "f" },
        { from_node: "d", to_node: "f" },
      ],
    );
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-join",
      graph,
    });
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);
    const byId = new Map(detail.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get("f")?.status).toBe("succeeded");
    expect(detail.status).toBe("failed");
    expect(detail.failure?.code).toBe("workflow_node_failed");
  });

  test("limits.max_concurrent_node_runs 限制本运行同时在跑的节点数", async () => {
    const bench = await createBench();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const started = new Map<string, PromiseWithResolvers<void>>();
    for (const id of ["a", "b", "c"]) {
      gates.set(id, Promise.withResolvers<void>());
      started.set(id, Promise.withResolvers<void>());
      bench.behaviors.set(id, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        log.push(`${id}:start`);
        started.get(id)!.resolve();
        await gates.get(id)!.promise;
        log.push(`${id}:end`);
        active -= 1;
        return { output: { [id]: true } };
      });
    }
    const graph = makeGraph([{ node_id: "a" }, { node_id: "b" }, { node_id: "c" }], [], {
      limits: { max_concurrent_node_runs: 1 },
    });
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-cap",
      graph,
    });
    bench.harness.resume();
    await started.get("a")!.promise;
    gates.get("a")!.resolve();
    await started.get("b")!.promise;
    gates.get("b")!.resolve();
    await started.get("c")!.promise;
    gates.get("c")!.resolve();
    const detail = await bench.workflows.wait(id);
    expect(detail.status).toBe("succeeded");
    expect(maxActive).toBe(1);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("profile 配额：同一 profile 的节点不并发，不同 profile 可以", async () => {
    const bench = await createBench({ quotas: { profile: 1, run: 3, workspace: 3, global: 3 } });
    const log: string[] = [];
    const gates = new Map<string, PromiseWithResolvers<void>>();
    const started = new Map<string, PromiseWithResolvers<void>>();
    for (const id of ["a1", "a2", "b"]) {
      gates.set(id, Promise.withResolvers<void>());
      started.set(id, Promise.withResolvers<void>());
      bench.behaviors.set(id, async () => {
        log.push(`${id}:start`);
        started.get(id)!.resolve();
        await gates.get(id)!.promise;
        log.push(`${id}:end`);
        return { output: { [id]: true } };
      });
    }
    const graph = makeGraph(
      [
        { node_id: "a1", agent_profile_id: "p" },
        { node_id: "a2", agent_profile_id: "p" },
        { node_id: "b", agent_profile_id: "q" },
      ],
      [],
    );
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-quota",
      graph,
    });
    bench.harness.resume();
    await Promise.all([started.get("a1")!.promise, started.get("b")!.promise]);
    expect(log).not.toContain("a2:start");
    gates.get("a1")!.resolve();
    await started.get("a2")!.promise;
    expect(log.indexOf("a2:start")).toBeGreaterThan(log.indexOf("a1:end"));
    gates.get("b")!.resolve();
    gates.get("a2")!.resolve();
    const detail = await bench.workflows.wait(id);
    expect(detail.status).toBe("succeeded");
  });

  test("取消运行会中止节点执行器，节点与运行都记为 canceled", async () => {
    const bench = await createBench();
    const started = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    bench.behaviors.set("a", async (_inputs, context) => {
      started.resolve();
      await whenAborted(context.signal);
      observed.resolve();
      return { output: { a: 1 } };
    });
    const graph = makeGraph([{ node_id: "a" }], []);
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-cancel",
      graph,
    });
    bench.harness.resume();
    await started.promise;
    const detail = await bench.workflows.cancel(id);
    await observed.promise;
    expect(detail.status).toBe("canceled");
    expect(detail.failure).toBeNull();
    expect(detail.nodes[0]?.status).toBe("canceled");
  });

  test("conversation.abort 不会取消后台工作流运行（只有显式 cancel 才停）", async () => {
    const bench = await createBench();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    bench.behaviors.set("a", async () => {
      started.resolve();
      await release.promise;
      return { output: { a: 1 } };
    });
    const graph = makeGraph([{ node_id: "a" }], []);
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-background",
      graph,
    });
    bench.harness.resume();
    await started.promise;
    await (await bench.harness.root(ctx)).abort(ctx);
    release.resolve();
    const detail = await bench.workflows.wait(id);
    expect(detail.status).toBe("succeeded");
  });

  test("token 预算与缺失最终输出都终止运行并给出旧错误码", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { a: 1 }, usage: { input_tokens: 400, output_tokens: 200 } }));
    const budgetGraph = makeGraph([{ node_id: "a" }], [], { limits: { max_total_tokens: 500 } });
    const budget = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-budget",
      graph: budgetGraph,
    });
    bench.harness.resume();
    const budgetDetail = await bench.workflows.wait(budget.id);
    expect(budgetDetail.status).toBe("failed");
    expect(budgetDetail.failure?.code).toBe("workflow_token_budget_exceeded");
    expect(budgetDetail.outputs).toEqual({});

    bench.behaviors.set("b", async () => ({ output: { other: 1 } }));
    const missingGraph = makeGraph([{ node_id: "b" }], [], {
      output_schema: { properties: { report: 1 }, required: ["report"] },
    });
    const missing = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-missing",
      graph: missingGraph,
    });
    bench.harness.resume();
    const missingDetail = await bench.workflows.wait(missing.id);
    expect(missingDetail.status).toBe("failed");
    expect(missingDetail.failure?.code).toBe("workflow_final_output_missing");
    expect(missingDetail.failure?.message).toContain("report");
  });

  test("条件边未选中时下游跳过，运行继续成功", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { route: "skip" } }));
    bench.behaviors.set("b", async () => ({ output: { b: 2 } }));
    bench.behaviors.set("c", async () => ({ output: { c: 3 } }));
    const graph = makeGraph(
      [{ node_id: "a" }, { node_id: "b" }, { node_id: "c" }],
      [
        { from_node: "a", to_node: "b", type: "conditional", condition: { field: "route", equals: "go" } },
        { from_node: "a", to_node: "c" },
      ],
    );
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-conditional",
      graph,
    });
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);
    const byId = new Map(detail.nodes.map((node) => [node.nodeId, node]));
    expect(detail.status).toBe("succeeded");
    expect(byId.get("b")?.status).toBe("skipped");
    expect(byId.get("c")?.status).toBe("succeeded");
  });

  test("非法图在启动时明确拒绝", async () => {
    const bench = await createBench();
    const unknownMode = makeGraph([{ node_id: "a" }], [], { run_policy: { mode: "whenever" as never } });
    await expect(
      bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf-mode", graph: unknownMode }),
    ).rejects.toMatchObject({ code: "workflow_graph_invalid" });

    const cyclic = makeGraph(
      [{ node_id: "a" }, { node_id: "b" }],
      [
        { from_node: "a", to_node: "b" },
        { from_node: "b", to_node: "a" },
      ],
      { entry_node_ids: ["a"] },
    );
    await expect(
      bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf-cyclic", graph: cyclic }),
    ).rejects.toMatchObject({ code: "workflow_graph_invalid" });
  });

  test("崩溃后 resume()：节点从索引恢复并继续运行", async () => {
    const bench = await createBench();
    let calls = 0;
    const started = Promise.withResolvers<void>();
    bench.behaviors.set("a", async (_inputs, context) => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await whenAborted(context.signal);
        return { output: null };
      }
      return { output: { a: calls } };
    });
    const graph = makeGraph([{ node_id: "a" }], []);
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-crash",
      graph,
    });
    bench.harness.resume();
    await started.promise;
    await reopen(bench);
    bench.harness.resume();
    const detail = await bench.workflows.wait(id);
    expect(calls).toBe(2);
    expect(detail.status).toBe("succeeded");
    expect(detail.outputs).toEqual({ a: 2 });
  });

  test("IPC 查询面：workflow.runs.list / get / cancel 的参数与错误码", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    const graph = makeGraph([{ node_id: "a" }], []);
    const { id } = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf-ipc",
      graph,
    });
    bench.harness.resume();
    await bench.workflows.wait(id);

    const server = memoryServer(orchestrationMethods({ workflows: bench.workflows }), mapSettingsError);
    const listed = await server.call<{ runs: { id: number; status: string }[] }>("workflow.runs.list", { limit: 5 });
    expect(listed.result?.runs).toEqual([expect.objectContaining({ id, status: "succeeded" })]);

    const got = await server.call<{ id: number; nodes: { nodeId: string }[] }>("workflow.runs.get", { id });
    expect(got.result?.nodes.map((node) => node.nodeId)).toEqual(["a"]);

    expect((await server.call("workflow.runs.get", { id: -1 })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("workflow.runs.list", { status: "bogus" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("workflow.runs.list", { limit: 501 })).error?.code).toBe(INVALID_PARAMS);
    const missing = await server.call("workflow.runs.get", { id: 999_999 });
    expect(missing.error).toMatchObject({ code: APP_ERROR, data: { kind: "not_found" } });

    const canceled = await server.call<{ status: string }>("workflow.runs.cancel", { id });
    expect(canceled.result?.status).toBe("succeeded");
  });
});

describe("verifier 打回", () => {
  const verifierGraph = (limit: number, extra: Partial<WorkflowGraph> = {}): WorkflowGraph =>
    makeGraph(
      [
        { node_id: "propose", input_contract: ["revision_request"], output_contract: ["plan"] },
        { node_id: "verify", type: "verifier", input_contract: ["plan"], output_contract: ["decision", "issues", "evidence"] },
        { node_id: "apply", input_contract: ["plan"], output_contract: ["done"] },
      ],
      [
        { from_node: "propose", to_node: "verify" },
        { from_node: "propose", to_node: "apply" },
        { from_node: "verify", to_node: "apply" },
        { from_node: "verify", to_node: "propose", type: "retry_loop", max_iterations: limit },
      ],
      { entry_node_ids: ["propose"], ...extra },
    );

  test("rework 后重做目标与 verifier，修改意见交给目标；通过后下游才开始", async () => {
    const bench = await createBench();
    const proposeInputs: Record<string, JsonValue>[] = [];
    const verifyIterations: number[] = [];
    let applyRuns = 0;
    bench.behaviors.set("propose", async (inputs) => {
      proposeInputs.push(inputs);
      return { output: { plan: `plan v${proposeInputs.length}` } };
    });
    bench.behaviors.set("verify", async (_inputs, context) => {
      verifyIterations.push(context.iteration);
      return {
        output:
          context.iteration === 1
            ? { decision: "rework", issues: ["no rollback path"], evidence: ["step 3"] }
            : { decision: "pass", issues: [], evidence: ["ok"] },
      };
    });
    bench.behaviors.set("apply", async () => {
      applyRuns += 1;
      return { output: { done: "yes" } };
    });

    const { id } = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph: verifierGraph(3), inputs: {} });
    const detail = await bench.workflows.wait(id);

    expect(detail.status).toBe("succeeded");
    expect(proposeInputs).toHaveLength(2);
    expect(proposeInputs[0]?.revision_request).toBeUndefined();
    expect(String(proposeInputs[1]?.revision_request)).toContain("no rollback path");
    expect(String(proposeInputs[1]?.revision_request)).toContain("step 3");
    expect(verifyIterations).toEqual([1, 2]);
    // 下游只在通过之后跑一次，并且拿到的是第二版方案。
    expect(applyRuns).toBe(1);
    expect(detail.nodes.filter((node) => node.nodeId === "apply").map((node) => node.input)).toEqual([{ plan: "plan v2" }]);
    expect(detail.nodes.filter((node) => node.nodeId === "propose").map((node) => node.iteration)).toEqual([1, 2]);
  });

  test("轮数用完仍要求 rework：运行失败，下游从未开始", async () => {
    const bench = await createBench();
    let applyRuns = 0;
    bench.behaviors.set("propose", async () => ({ output: { plan: "p" } }));
    bench.behaviors.set("verify", async () => ({ output: { decision: "rework", issues: ["still bad"], evidence: [] } }));
    bench.behaviors.set("apply", async () => {
      applyRuns += 1;
      return { output: { done: "yes" } };
    });
    const { id } = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph: verifierGraph(2), inputs: {} });
    const detail = await bench.workflows.wait(id);
    expect(detail.status).toBe("failed");
    expect(detail.failure?.code).toBe("workflow_iteration_limit_reached");
    expect(applyRuns).toBe(0);
    expect(detail.nodes.filter((node) => node.nodeId === "verify")).toHaveLength(2);
  });

  test("环里有多个节点时，中间节点一起重做", async () => {
    const bench = await createBench();
    const runs: string[] = [];
    bench.behaviors.set("draft", async () => {
      runs.push("draft");
      return { output: { draft: "d" } };
    });
    bench.behaviors.set("polish", async () => {
      runs.push("polish");
      return { output: { polished: "p" } };
    });
    bench.behaviors.set("verify", async (_inputs, context) => {
      runs.push("verify");
      return { output: { decision: context.iteration === 1 ? "rework" : "pass", issues: ["x"], evidence: [] } };
    });
    const graph = makeGraph(
      [
        { node_id: "draft", output_contract: ["draft"] },
        { node_id: "polish", input_contract: ["draft"], output_contract: ["polished"] },
        { node_id: "verify", type: "verifier", input_contract: ["polished"], output_contract: ["decision", "issues", "evidence"] },
      ],
      [
        { from_node: "draft", to_node: "polish" },
        { from_node: "polish", to_node: "verify" },
        { from_node: "verify", to_node: "draft", type: "retry_loop", max_iterations: 2 },
      ],
      { entry_node_ids: ["draft"] },
    );
    const { id } = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    expect((await bench.workflows.wait(id)).status).toBe("succeeded");
    expect(runs).toEqual(["draft", "polish", "verify", "draft", "polish", "verify"]);
  });

  test("没有 retry_loop 的 verifier 只交出 decision，不触发重做", async () => {
    const bench = await createBench();
    let propose = 0;
    bench.behaviors.set("propose", async () => {
      propose += 1;
      return { output: { plan: "p" } };
    });
    bench.behaviors.set("verify", async () => ({ output: { decision: "rework", issues: [], evidence: [] } }));
    const graph = makeGraph(
      [
        { node_id: "propose", output_contract: ["plan"] },
        { node_id: "verify", type: "verifier", input_contract: ["plan"], output_contract: ["decision", "issues", "evidence"] },
      ],
      [{ from_node: "propose", to_node: "verify" }],
    );
    const { id } = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    expect((await bench.workflows.wait(id)).status).toBe("succeeded");
    expect(propose).toBe(1);
  });

  test("verifier 必须在 output_contract 里声明 decision", async () => {
    const bench = await createBench();
    const graph = makeGraph([{ node_id: "v", type: "verifier", output_contract: ["issues"] }], []);
    await expect(bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} })).rejects.toMatchObject({
      code: "workflow_graph_invalid",
    });
  });
});

describe("节点重试", () => {
  test("重试的 attempt 拿到与第一次相同的上游输入", async () => {
    const bench = await createBench();
    const seen: Record<string, JsonValue>[] = [];
    bench.behaviors.set("a", async () => ({ output: { a: "from-a" } }));
    bench.behaviors.set("b", async (inputs) => {
      seen.push(inputs);
      if (seen.length === 1) throw new Error("flaky");
      return { output: { b: "ok" } };
    });
    const graph = makeGraph(
      [
        { node_id: "a", output_contract: ["a"] },
        { node_id: "b", input_contract: ["a"], output_contract: ["b"], max_attempts: 2 },
      ],
      [{ from_node: "a", to_node: "b" }],
    );
    const { id } = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    expect((await bench.workflows.wait(id)).status).toBe("succeeded");
    expect(seen).toEqual([{ a: "from-a" }, { a: "from-a" }]);
  });
});


/** 让出一个宏任务，调度器与存储的回调才有机会推进。 */
const yieldToScheduler = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 轮询到运行有一条待批审批；每轮让出一个宏任务，不依赖定时器。 */
async function pendingApproval(bench: Bench, runId: number): Promise<WorkflowRunDetail> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const detail = await bench.workflows.get(runId);
    if (detail.approvals.some((approval) => approval.decision === undefined)) return detail;
    if (detail.status !== "running") throw new Error(`run ended as ${detail.status} without an approval`);
    await yieldToScheduler();
  }
  throw new Error("approval never opened");
}

describe("审批", () => {
  const approvalGraph = (extra: Partial<WorkflowGraph> = {}, planNode: Partial<WorkflowNode> = {}): WorkflowGraph =>
    makeGraph(
      [
        { node_id: "plan", input_contract: ["revision_request"], output_contract: ["plan", "note"], ...planNode },
        { node_id: "apply", input_contract: ["plan"], output_contract: ["done"] },
      ],
      [{ from_node: "plan", to_node: "apply", type: "approval" }],
      extra,
    );

  function setup(bench: Bench) {
    const planRuns: Record<string, JsonValue>[] = [];
    const applyInputs: Record<string, JsonValue>[] = [];
    bench.behaviors.set("plan", async (inputs) => {
      planRuns.push(inputs);
      return { output: { plan: `plan v${planRuns.length}`, note: "n" } };
    });
    bench.behaviors.set("apply", async (inputs) => {
      applyInputs.push(inputs);
      return { output: { done: "yes" } };
    });
    return { planRuns, applyInputs };
  }

  const start = async (bench: Bench, graph: WorkflowGraph) => {
    const started = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    bench.harness.resume();
    return started;
  };

  test("approval 边：节点成功后停在 waiting_approval，下游不开始；approve 之后继续", async () => {
    const bench = await createBench();
    const { applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    const waiting = await pendingApproval(bench, id);

    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.nodes.find((node) => node.nodeId === "plan")?.status).toBe("waiting_approval");
    expect(waiting.nodes.find((node) => node.nodeId === "apply")?.status).toBe("pending");
    expect(waiting.approvals).toHaveLength(1);
    expect(waiting.approvals[0]).toMatchObject({ id: "ap_1", nodeId: "plan", kind: "key_approval", output: { plan: "plan v1", note: "n" } });
    expect(applyInputs).toHaveLength(0);

    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" });
    const done = await bench.workflows.wait(id);
    expect(done.status).toBe("succeeded");
    expect(applyInputs).toEqual([{ plan: "plan v1" }]);
    expect(done.approvals[0]).toMatchObject({ decision: "approve" });
  });

  test("approve_with_changes：改后的值传给下游，原输出留在审批记录里；越出 output_contract 的键被拒绝", async () => {
    const bench = await createBench();
    const { applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);

    await expect(
      bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve_with_changes", changes: { secret: "x" } }),
    ).rejects.toMatchObject({ code: "workflow_approval_invalid" });
    await expect(
      bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve_with_changes", changes: {} }),
    ).rejects.toMatchObject({ code: "workflow_approval_invalid" });
    // 被拒绝的决定不留痕：审批仍待批。
    expect((await bench.workflows.get(id)).approvals[0]?.decision).toBeUndefined();

    await bench.workflows.decide({
      runId: id,
      approvalId: "ap_1",
      decision: "approve_with_changes",
      changes: { plan: "edited by a human" },
      comment: "tightened",
    });
    const done = await bench.workflows.wait(id);
    expect(done.status).toBe("succeeded");
    expect(applyInputs).toEqual([{ plan: "edited by a human" }]);
    expect(done.approvals[0]).toMatchObject({ output: { plan: "plan v1", note: "n" }, changes: { plan: "edited by a human" }, comment: "tightened" });
    expect(done.nodes.find((node) => node.nodeId === "plan")?.output).toEqual({ plan: "edited by a human", note: "n" });
  });

  test("reject_and_retry：意见交给节点重做，新一轮产生新的审批；轮数用完后不能再重做", async () => {
    const bench = await createBench();
    const { planRuns, applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);
    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "reject_and_retry", comment: "add a rollback step" });

    // 等第二轮的审批打开。
    let second: WorkflowRunDetail | undefined;
    for (let attempt = 0; attempt < 2000 && second === undefined; attempt++) {
      const detail = await bench.workflows.get(id);
      if (detail.approvals.some((approval) => approval.id === "ap_2" && approval.decision === undefined)) second = detail;
      else await yieldToScheduler();
    }
    expect(second?.approvals.map((approval) => [approval.id, approval.iteration])).toEqual([["ap_2", 2], ["ap_1", 1]]);
    expect(planRuns[1]?.revision_request).toBe("add a rollback step");
    expect(applyInputs).toHaveLength(0);

    // 默认最多两轮：第二轮已经是上限，再要求重做会被拒绝，只能放行或终止。
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_2", decision: "reject_and_retry" })).rejects.toMatchObject({
      code: "workflow_iteration_limit_reached",
    });
    await bench.workflows.decide({ runId: id, approvalId: "ap_2", decision: "approve" });
    const done = await bench.workflows.wait(id);
    expect(done.status).toBe("succeeded");
    expect(applyInputs).toEqual([{ plan: "plan v2" }]);
  });

  test("reject_and_stop：运行失败，下游从未开始；已决定的审批不能再改", async () => {
    const bench = await createBench();
    const { applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);
    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "reject_and_stop", comment: "wrong table" });
    const done = await bench.workflows.wait(id);
    expect(done.status).toBe("failed");
    expect(done.failure).toMatchObject({ code: "workflow_approval_rejected" });
    expect(done.failure?.message).toContain("wrong table");
    expect(applyInputs).toHaveLength(0);
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" })).rejects.toMatchObject({
      code: "workflow_approval_invalid",
    });
  });

  test("决定一个已经决定过的审批、不存在的审批、不认识的决定都被拒绝", async () => {
    const bench = await createBench();
    setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_9", decision: "approve" })).rejects.toMatchObject({
      code: "workflow_resource_not_found",
    });
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "maybe" as never })).rejects.toMatchObject({
      code: "workflow_approval_invalid",
    });
    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" });
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" })).rejects.toMatchObject({
      code: "workflow_approval_already_decided",
    });
  });

  test("等待审批的运行可以取消；full_auto 模式忽略 approval 边", async () => {
    const bench = await createBench();
    const { applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);
    expect((await bench.workflows.cancel(id)).status).toBe("canceled");

    const auto = await start(bench, approvalGraph({ run_policy: { mode: "full_auto" } }));
    const done = await bench.workflows.wait(auto.id);
    expect(done.status).toBe("succeeded");
    expect(done.approvals).toEqual([]);
    expect(applyInputs).toEqual([{ plan: "plan v2" }]);
  });

  test("等待审批时进程重启：审批还在，重启后做的决定照样让运行继续", async () => {
    const bench = await createBench();
    const { applyInputs } = setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);

    await reopen(bench);
    bench.harness.resume();
    const waiting = await pendingApproval(bench, id);
    expect(waiting.status).toBe("waiting_approval");
    expect(applyInputs).toHaveLength(0);

    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" });
    expect((await bench.workflows.wait(id)).status).toBe("succeeded");
    expect(applyInputs).toEqual([{ plan: "plan v1" }]);
  });

  test("exception_review：节点用完重试仍失败时由人决定；不能「通过」一个失败的节点", async () => {
    const bench = await createBench();
    let attempts = 0;
    bench.behaviors.set("flaky", async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("db timeout");
      return { output: { rows: 3 } };
    });
    const graph = makeGraph([{ node_id: "flaky", output_contract: ["rows"], max_attempts: 2 }], [], {
      run_policy: { mode: "exception_review" },
    });
    const { id } = await start(bench, graph);
    const waiting = await pendingApproval(bench, id);
    expect(waiting.approvals[0]).toMatchObject({ kind: "exception_review", iteration: 1 });
    expect(String(waiting.approvals[0]?.output)).toContain("db timeout");
    expect(attempts).toBe(2);

    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" })).rejects.toMatchObject({
      code: "workflow_approval_invalid",
    });
    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "reject_and_retry", comment: "retry now" });
    const done = await bench.workflows.wait(id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ rows: 3 });
  });

  test("verifier 判 escalate：升级给人；full_auto 没人可升级则运行失败", async () => {
    const bench = await createBench();
    let propose = 0;
    bench.behaviors.set("propose", async (inputs) => {
      propose += 1;
      return { output: { plan: `v${propose}:${String(inputs.revision_request ?? "")}` } };
    });
    bench.behaviors.set("verify", async () => ({ output: { decision: "escalate", issues: ["unsure"], evidence: [] } }));
    const graph = (mode: "key_approval" | "full_auto") =>
      makeGraph(
        [
          { node_id: "propose", input_contract: ["revision_request"], output_contract: ["plan"] },
          { node_id: "verify", type: "verifier", input_contract: ["plan"], output_contract: ["decision", "issues", "evidence"] },
        ],
        [
          { from_node: "propose", to_node: "verify" },
          { from_node: "verify", to_node: "propose", type: "retry_loop", max_iterations: 3 },
        ],
        { entry_node_ids: ["propose"], run_policy: { mode } },
      );

    const auto = await start(bench, graph("full_auto"));
    const failed = await bench.workflows.wait(auto.id);
    expect(failed.failure).toMatchObject({ code: "workflow_escalation_required" });

    const { id } = await start(bench, graph("key_approval"));
    const waiting = await pendingApproval(bench, id);
    expect(waiting.approvals[0]).toMatchObject({ kind: "escalation", nodeId: "verify" });
    await expect(bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "approve" })).rejects.toMatchObject({
      code: "workflow_approval_invalid",
    });
    await bench.workflows.decide({ runId: id, approvalId: "ap_1", decision: "reject_and_stop" });
    expect((await bench.workflows.wait(id)).status).toBe("failed");
  });

  test("IPC：workflow.runs.approve 校验参数并落地决定", async () => {
    const bench = await createBench();
    setup(bench);
    const { id } = await start(bench, approvalGraph());
    await pendingApproval(bench, id);
    const server = memoryServer(orchestrationMethods({ workflows: bench.workflows }), mapSettingsError);

    const listed = await server.call<{ runs: { status: string }[] }>("workflow.runs.list", { status: "waiting_approval" });
    expect(listed.result?.runs).toHaveLength(1);

    expect((await server.call("workflow.runs.approve", { id, decision: "approve" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("workflow.runs.approve", { id, approvalId: "ap_1", decision: "maybe" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("workflow.runs.approve", { id, approvalId: "ap_1", decision: "approve_with_changes", changes: [] })).error?.code).toBe(
      INVALID_PARAMS,
    );
    const outside = await server.call("workflow.runs.approve", {
      id,
      approvalId: "ap_1",
      decision: "approve_with_changes",
      changes: { secret: 1 },
    });
    expect(outside.error).toMatchObject({ code: INVALID_PARAMS, data: { workflow_code: "workflow_approval_invalid" } });
    expect((await server.call("workflow.runs.approve", { id, approvalId: "ap_9", decision: "approve" })).error).toMatchObject({
      code: APP_ERROR,
      data: { kind: "not_found" },
    });

    const approved = await server.call<{ approvals: { decision: string }[] }>("workflow.runs.approve", {
      id,
      approvalId: "ap_1",
      decision: "approve",
      comment: "ok",
    });
    expect(approved.result?.approvals[0]).toMatchObject({ decision: "approve", comment: "ok" });
    expect((await bench.workflows.wait(id)).status).toBe("succeeded");
  });
});

describe("手动重试", () => {
  const chain = () =>
    makeGraph(
      [
        { node_id: "a", output_contract: ["a"] },
        { node_id: "side", output_contract: ["side"] },
        { node_id: "b", input_contract: ["a"], output_contract: ["b"], max_attempts: 1 },
        { node_id: "c", input_contract: ["b", "side"], output_contract: ["c"] },
      ],
      [
        { from_node: "a", to_node: "b" },
        { from_node: "b", to_node: "c" },
        { from_node: "side", to_node: "c" },
      ],
    );

  async function failedRun(bench: Bench, graph: WorkflowGraph) {
    const started = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    bench.harness.resume();
    const detail = await bench.workflows.wait(started.id);
    expect(detail.status).toBe("failed");
    return detail;
  }

  test("失败节点和它的下游重跑，其余成功的节点沿用旧输出，不再调用模型", async () => {
    const bench = await createBench();
    const calls: string[] = [];
    let bTries = 0;
    for (const name of ["a", "side", "c"]) {
      bench.behaviors.set(name, async (inputs) => {
        calls.push(name);
        return { output: { [name]: `${name}:${JSON.stringify(inputs)}` } };
      });
    }
    bench.behaviors.set("b", async (inputs) => {
      calls.push("b");
      bTries += 1;
      if (bTries === 1) throw new Error("warehouse offline");
      return { output: { b: `b:${JSON.stringify(inputs)}` } };
    });

    const failed = await failedRun(bench, chain());
    const failedNode = failed.nodes.find((node) => node.nodeId === "b");
    expect(failedNode?.status).toBe("failed");
    calls.length = 0;

    const { id } = await bench.workflows.retry({ runId: failed.id, nodeRunId: failedNode?.nodeRunId as number });
    const retried = await bench.workflows.wait(id);

    expect(retried.status).toBe("succeeded");
    expect(retried.retryOf).toEqual({ runId: failed.id, nodeId: "b" });
    expect(calls.sort()).toEqual(["b", "c"]);
    const byId = new Map(retried.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get("a")).toMatchObject({ status: "succeeded", reused: true });
    expect(byId.get("side")).toMatchObject({ status: "succeeded", reused: true });
    expect(byId.get("b")).toMatchObject({ status: "succeeded", reused: false });
    // b 拿到的是旧的 a 输出，c 同时拿到新的 b 和旧的 side。
    expect(byId.get("b")?.input).toEqual({ a: "a:{}" });
    expect(Object.keys(byId.get("c")?.input ?? {}).sort()).toEqual(["b", "side"]);
    expect(retried.outputs).toHaveProperty("c");
    // 原运行不受影响。
    expect((await bench.workflows.get(failed.id)).status).toBe("failed");
  });

  test("人批准、人改过的输出在重试里照样沿用，不会再来一次审批", async () => {
    const bench = await createBench();
    let applyTries = 0;
    let planRuns = 0;
    bench.behaviors.set("plan", async () => {
      planRuns += 1;
      return { output: { plan: "model plan", note: "n" } };
    });
    const applyInputs: Record<string, JsonValue>[] = [];
    bench.behaviors.set("apply", async (inputs) => {
      applyInputs.push(inputs);
      applyTries += 1;
      if (applyTries === 1) throw new Error("write failed");
      return { output: { done: "yes" } };
    });
    const graph = makeGraph(
      [
        { node_id: "plan", output_contract: ["plan", "note"] },
        { node_id: "apply", input_contract: ["plan"], output_contract: ["done"], max_attempts: 1 },
      ],
      [{ from_node: "plan", to_node: "apply", type: "approval" }],
    );
    const started = await bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf", graph, inputs: {} });
    bench.harness.resume();
    await pendingApproval(bench, started.id);
    await bench.workflows.decide({ runId: started.id, approvalId: "ap_1", decision: "approve_with_changes", changes: { plan: "human plan" } });
    const failed = await bench.workflows.wait(started.id);
    expect(failed.status).toBe("failed");

    const applyRun = failed.nodes.find((node) => node.nodeId === "apply");
    const { id } = await bench.workflows.retry({ runId: failed.id, nodeRunId: applyRun?.nodeRunId as number });
    const retried = await bench.workflows.wait(id);
    expect(retried.status).toBe("succeeded");
    expect(retried.approvals).toEqual([]);
    expect(planRuns).toBe(1);
    expect(applyInputs).toEqual([{ plan: "human plan" }, { plan: "human plan" }]);
  });

  test("没有失败的运行、不属于该运行的节点、不是失败的节点都不能重试", async () => {
    const bench = await createBench();
    bench.behaviors.set("a", async () => ({ output: { a: 1 } }));
    bench.behaviors.set("b", async () => {
      throw new Error("boom");
    });
    bench.behaviors.set("side", async () => ({ output: { side: 1 } }));
    bench.behaviors.set("c", async () => ({ output: { c: 1 } }));
    const failed = await failedRun(bench, chain());
    const ok = failed.nodes.find((node) => node.nodeId === "a");

    await expect(bench.workflows.retry({ runId: failed.id, nodeRunId: ok?.nodeRunId as number })).rejects.toMatchObject({
      code: "workflow_run_not_recoverable",
    });
    await expect(bench.workflows.retry({ runId: failed.id, nodeRunId: 999_999 })).rejects.toMatchObject({
      code: "workflow_resource_not_found",
    });

    const good = await bench.workflows.start({
      conversationId: bench.conversationId,
      workflowVersionId: "wf",
      graph: makeGraph([{ node_id: "a" }], []),
    });
    await bench.workflows.wait(good.id);
    await expect(bench.workflows.retry({ runId: good.id, nodeRunId: 1 })).rejects.toMatchObject({ code: "workflow_run_not_recoverable" });
  });

  test("IPC：workflow.runs.retry 校验参数并返回新运行", async () => {
    const bench = await createBench();
    let tries = 0;
    bench.behaviors.set("a", async () => {
      tries += 1;
      if (tries === 1) throw new Error("once");
      return { output: { a: 1 } };
    });
    const failed = await failedRun(bench, makeGraph([{ node_id: "a", output_contract: ["a"], max_attempts: 1 }], []));
    const server = memoryServer(orchestrationMethods({ workflows: bench.workflows }), mapSettingsError);

    expect((await server.call("workflow.runs.retry", { id: failed.id })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("workflow.runs.retry", { id: failed.id, nodeRunId: 999_999 })).error).toMatchObject({
      code: APP_ERROR,
      data: { kind: "not_found" },
    });
    const retried = await server.call<{ id: number }>("workflow.runs.retry", { id: failed.id, nodeRunId: failed.nodes[0]?.nodeRunId });
    expect(retried.result?.id).toBeGreaterThan(failed.id);
    expect((await bench.workflows.wait(retried.result?.id as number)).status).toBe("succeeded");
  });
});
