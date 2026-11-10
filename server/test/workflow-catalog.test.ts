import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLanguage } from "../src/i18n.ts";
import { workflowMethods } from "../src/ipc/workflows.ts";
import { createWorkflowCatalog } from "../src/workflows/catalog.ts";
import { validateWorkflowGraph } from "../src/workflows/graph.ts";
import { buildTemplateGraph, WORKFLOW_MODES, WORKFLOW_TEMPLATES } from "../src/workflows/templates.ts";
import type { WorkflowGraph, WorkflowRunDetail, WorkflowStartRequest } from "../src/workflows/types.ts";
import { filterToolsForTurn } from "../src/tools/exposure.ts";
import { createWorkflowTools } from "../src/tools/app/workflows.ts";
import type { AppToolDeps } from "../src/tools/app/types.ts";
import { memoryServer } from "./support/rpc.ts";
import { mapSettingsError } from "../src/ipc/methods.ts";

const dirs: string[] = [];
afterEach(() => {
  setLanguage("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bench() {
  const dir = mkdtempSync(join(tmpdir(), "dw-wf-catalog-"));
  dirs.push(dir);
  const started: WorkflowStartRequest[] = [];
  let nextId = 0;
  const catalog = createWorkflowCatalog({
    dir: join(dir, "workflows"),
    workflows: {
      start: async (request) => {
        started.push(request);
        return { id: 40 + started.length };
      },
      get: async (id) => ({ id, status: "running", nodes: [], approvals: [], outputs: {}, failure: null }) as unknown as WorkflowRunDetail,
    },
    now: () => new Date("2026-11-10T00:00:00Z"),
    newId: () => `wf_${(++nextId).toString(16).padStart(8, "0")}`,
  });
  return { dir, catalog, started };
}

describe("工作流目录", () => {
  test("三个全自动模板建出来都过图校验，保存后能读回", async () => {
    const { catalog } = bench();
    for (const template of ["analysis", "insight", "report"]) {
      const definition = await catalog.create({ name: template, template });
      expect(definition.template).toBe(template as never);
      expect(definition.graph.nodes.length).toBeGreaterThan(0);
      expect((await catalog.get(definition.id)).graph).toEqual(definition.graph);
    }
    expect((await catalog.list()).map((item) => item.name).sort()).toEqual(["analysis", "insight", "report"]);
  });

  test("别名与默认值：中文模板名、缺省模板与模式", async () => {
    const { catalog } = bench();
    expect((await catalog.create({ template: "洞察" })).template).toBe("insight");
    const plain = await catalog.create({});
    expect(plain.template).toBe("analysis");
    expect(plain.graph.run_policy?.mode).toBe("full_auto");
    await expect(catalog.create({ template: "nope" })).rejects.toMatchObject({ code: "workflow_graph_invalid" });
    await expect(catalog.create({ mode: "sometimes" })).rejects.toMatchObject({ code: "workflow_graph_invalid" });
  });

  test("自定义图要过校验：缺入口、成环都被拒绝，且不落盘", async () => {
    const { catalog, dir } = bench();
    await expect(catalog.createCustom({ graph: "x" })).rejects.toMatchObject({ code: "workflow_graph_invalid" });
    const cyclic: WorkflowGraph = {
      entry_node_ids: ["a"],
      nodes: [{ node_id: "a" }, { node_id: "b" }],
      edges: [
        { edge_id: "e1", from_node: "a", to_node: "b", type: "auto" },
        { edge_id: "e2", from_node: "b", to_node: "a", type: "auto" },
      ],
    };
    await expect(catalog.createCustom({ graph: cyclic })).rejects.toMatchObject({ code: "workflow_graph_invalid" });
    expect(existsSync(join(dir, "workflows"))).toBe(false);
    const ok = await catalog.createCustom({ name: "mine", graph: { entry_node_ids: ["a"], nodes: [{ node_id: "a", prompt: "go" }], edges: [] } });
    expect(ok.template).toBe("custom");
  });

  test("id 就是文件名：路径穿越与未知 id 都当作不存在", async () => {
    const { catalog, dir } = bench();
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ id: "x", name: "x", graph: { nodes: [], edges: [], entry_node_ids: [] } }));
    await expect(catalog.get("../secret")).rejects.toMatchObject({ code: "workflow_resource_not_found" });
    await expect(catalog.get("wf_deadbeef")).rejects.toMatchObject({ code: "workflow_resource_not_found" });
    expect(await catalog.remove("../secret")).toEqual({ removed: false });
    expect(existsSync(join(dir, "secret.json"))).toBe(true);
  });

  test("删除只影响定义；启动把业务背景交给入口节点，并记下定义 id", async () => {
    const { catalog, started } = bench();
    const definition = await catalog.create({ template: "insight" });
    const run = await catalog.start({ workflowId: definition.id, conversationId: 7, businessContext: "  Q3 revenue  " });
    expect(run.id).toBe(41);
    expect(started[0]).toMatchObject({ conversationId: 7, workflowVersionId: definition.id, inputs: { business_context: "Q3 revenue" } });
    await catalog.start({ workflowId: definition.id, conversationId: 7 });
    expect(started[1]?.inputs).toEqual({});
    expect(await catalog.remove(definition.id)).toEqual({ removed: true });
    await expect(catalog.start({ workflowId: definition.id, conversationId: 7 })).rejects.toMatchObject({ code: "workflow_resource_not_found" });
  });

  test("损坏的定义文件不拖垮列表；错误文案跟随界面语言", async () => {
    const { catalog, dir } = bench();
    await catalog.create({ name: "good", template: "report" });
    writeFileSync(join(dir, "workflows", "wf_ffffffff.json"), "{ not json");
    expect((await catalog.list()).map((item) => item.name)).toEqual(["good"]);
    await expect(catalog.get("wf_00000099")).rejects.toThrow("workflow not found");
    setLanguage("zh");
    await expect(catalog.get("wf_00000099")).rejects.toThrow("找不到工作流");
  });
});

describe("工作流工具", () => {
  function tools() {
    const { catalog, started } = bench();
    const deps = { workflows: { current: catalog } } as unknown as AppToolDeps;
    const list = createWorkflowTools(deps);
    const run = async (name: string, args: Record<string, unknown>, conversationId = 3) => {
      const tool = list.find((item) => item.name === name)!;
      const result = await (tool as unknown as { execute: (a: unknown, api: unknown) => Promise<{ output: { text: string }[]; isError?: boolean }> }).execute(
        args,
        { conversationId },
      );
      return { text: result.output[0]!.text, isError: result.isError === true };
    };
    return { run, started, names: list.map((item) => item.name) };
  }

  test("创建、列出、启动、查看；启动用调用方所在的会话", async () => {
    const { run, started, names } = tools();
    expect(names).toEqual(["workflow_create", "workflow_create_custom", "workflow_list", "workflow_start", "workflow_status"]);
    const created = JSON.parse((await run("workflow_create", { name: "Weekly", template: "insight" })).text);
    expect(created.nodes).toEqual(["inspect_data", "analyze_metrics"]);
    expect(JSON.parse((await run("workflow_list", {})).text).workflows).toHaveLength(1);
    const startedRun = JSON.parse((await run("workflow_start", { workflow_id: created.workflow_id, business_context: "goal" }, 9)).text);
    expect(startedRun.run_id).toBe(41);
    expect(started[0]?.conversationId).toBe(9);
    expect(JSON.parse((await run("workflow_status", { run_id: 41 })).text)).toMatchObject({ run_id: 41, status: "running" });
  });

  test("失败给出稳定错误码；没有目录时明确说不可用", async () => {
    const { run } = tools();
    const bad = await run("workflow_create", { template: "nope" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("workflow_graph_invalid");
    expect((await run("workflow_start", { workflow_id: "wf_00000001" })).text).toContain("workflow_resource_not_found");
    const none = createWorkflowTools({} as AppToolDeps).find((item) => item.name === "workflow_list")!;
    const result = await (none as unknown as { execute: (a: unknown, api: unknown) => Promise<{ output: { text: string }[] }> }).execute({}, {});
    expect(result.output[0]!.text).toContain("not available");
  });
});

describe("工具暴露", () => {
  const names = [{ function: { name: "workflow_list" } }, { function: { name: "workflow_start" } }, { function: { name: "query_data" } }];
  const exposed = (options: { workflowsAvailable?: boolean }) =>
    filterToolsForTurn(names, { userMessage: "list my workflows", hasDataSource: true, hasWorkspace: false, ...options }).map((tool) => tool.function.name);

  test("默认仍要求挂载工作区；宿主声明有工作流目录后，发现词才能带出工作流工具", () => {
    expect(exposed({})).not.toContain("workflow_list");
    expect(exposed({ workflowsAvailable: true })).toContain("workflow_list");
  });
});

describe("工作流 IPC", () => {
  test("列表、读取、删除、启动，错误码与运行方法一致", async () => {
    const { catalog, started } = bench();
    const server = memoryServer(workflowMethods(catalog), mapSettingsError);
    const definition = await catalog.create({ template: "report" });
    expect((await server.call<{ workflows: unknown[] }>("workflow.definitions.list")).result?.workflows).toHaveLength(1);
    expect((await server.call<{ id: string }>("workflow.definitions.get", { id: definition.id })).result?.id).toBe(definition.id);
    expect((await server.call("workflow.definitions.get", { id: "wf_00000099" })).error?.data?.kind).toBe("not_found");
    expect((await server.call("workflow.start", { workflowId: definition.id })).error?.code).toBe(-32602);
    const startedRun = await server.call("workflow.start", { workflowId: definition.id, conversationId: 5, businessContext: "x" });
    expect(startedRun.result).toEqual({ id: 41 });
    expect(started[0]?.conversationId).toBe(5);
    expect((await server.call("workflow.definitions.remove", { id: definition.id })).result).toEqual({ removed: true });
  });
});

describe("模板图", () => {
  test("四个模板在三种模式下都是能启动的合法图（含审批边）", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      for (const mode of WORKFLOW_MODES) {
        expect(() => validateWorkflowGraph(buildTemplateGraph(template, mode)), `${template}/${mode}`).not.toThrow();
      }
    }
  });
});
