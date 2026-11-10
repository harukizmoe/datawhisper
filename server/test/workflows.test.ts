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

  test("审批图与非法图在启动时明确拒绝", async () => {
    const bench = await createBench();
    const approval = makeGraph(
      [{ node_id: "a" }, { node_id: "b" }],
      [{ from_node: "a", to_node: "b", type: "approval" }],
    );
    await expect(
      bench.workflows.start({ conversationId: bench.conversationId, workflowVersionId: "wf-approval", graph: approval }),
    ).rejects.toMatchObject({ code: "workflow_approval_not_supported" });

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
