/**
 * 工作流的 5 个模型工具：创建（模板 / 自定义图）、列出、启动、查看状态。
 *
 * 旧实现（`agent/tools/workflow.py`）按工作区保存「已发布 Workflow」；这里改成应用数据目录里的
 * 工作流目录（`workflows/catalog.ts`）。目录与会话服务同期装配，工具先于它创建，所以走迟绑定端口。
 * 审批、重试等人工操作不在工具里：它们是界面上的动作，模型只负责建、启动与查看。
 */

import type { JsonValue } from "@earendil-works/chord";
import { say } from "../../i18n.ts";
import type { WorkflowCatalog, WorkflowDefinition } from "../../workflows/catalog.ts";
import { WorkflowError, type WorkflowRunDetail } from "../../workflows/types.ts";
import { errorResult, jsonText, makeAppTool, okResult, type AppTool, type AppToolDeps } from "./types.ts";

function definitionView(definition: WorkflowDefinition): Record<string, JsonValue> {
  return {
    workflow_id: definition.id,
    name: definition.name,
    description: definition.description,
    template: definition.template,
    mode: definition.graph.run_policy?.mode ?? "full_auto",
    nodes: definition.graph.nodes.map((node) => node.node_id),
    created_at: definition.createdAt,
  };
}

/** 给模型看的运行状态：不带整张图与每个节点的完整输入，输出只在运行结束后给。 */
function runView(run: WorkflowRunDetail): Record<string, JsonValue> {
  const finished = run.status === "succeeded" || run.status === "failed" || run.status === "canceled";
  return {
    run_id: run.id,
    workflow_id: run.workflowVersionId,
    status: run.status,
    failure: run.failure === null ? null : { code: run.failure.code, message: run.failure.message },
    nodes: run.nodes.map((node) => ({
      node_id: node.nodeId,
      status: node.status,
      iteration: node.iteration,
      attempt: node.attempt,
      ...(node.error === "" ? {} : { error: node.error }),
    })),
    ...(finished ? { outputs: run.outputs } : {}),
  };
}

function failure(tool: string, error: unknown): ReturnType<typeof errorResult> {
  if (error instanceof WorkflowError) return errorResult(tool, `${error.code}: ${error.message}`);
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createWorkflowTools(deps: AppToolDeps): AppTool[] {
  const catalog = (): WorkflowCatalog | undefined => deps.workflows?.current;
  const unavailable = (tool: string) =>
    errorResult(tool, say("Workflows are not available in this session.", "当前会话不能使用工作流。"));

  return [
    makeAppTool<{ name?: string; description?: string; mode?: string; template?: string }>({
      name: "workflow_create",
      description:
        "Create and save a standard multi-agent analysis workflow from a template. " +
        "Templates: analysis (inspect, metrics, anomalies, cross-check, report), insight (inspect, metrics), report (inspect, report), " +
        "cleaning_approval (cleaning plan, independent verifier, human approval, execution, report). " +
        "mode: full_auto (no stops), key_approval (a person approves the key steps) or exception_review (a person decides when a node keeps failing). " +
        "Only call this when the user explicitly asks to create a workflow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workflow name shown in the Data panel." },
          description: { type: "string" },
          template: { type: "string", enum: ["analysis", "insight", "report", "cleaning_approval"] },
          mode: { type: "string", enum: ["full_auto", "key_approval", "exception_review"] },
        },
      },
      // 重放会再存一份：崩溃后不自动重跑。
      replay: "unsafe",
      async execute(args) {
        const port = catalog();
        if (port === undefined) return unavailable("workflow_create");
        try {
          const definition = await port.create(args);
          return okResult("workflow_create", jsonText(definitionView(definition)), { tool: "workflow_create", workflow_id: definition.id });
        } catch (error) {
          return failure("workflow_create", error);
        }
      },
    }),

    makeAppTool<{ name?: string; description?: string; graph?: unknown }>({
      name: "workflow_create_custom",
      description:
        "Create and save a custom workflow from a graph you design with the user. " +
        "graph = {entry_node_ids, nodes, edges, run_policy?, limits?}. Each node: {node_id, type?: agent|verifier|validation, prompt, input_contract, output_contract, allowed_tools?, max_attempts?}. " +
        "A node's inputs come from upstream outputs whose names it lists in input_contract; a node with several output_contract names must answer with a JSON object keyed by them. " +
        "Edge types: auto, conditional ({condition: {field, equals}}), approval (a person approves the upstream node), retry_loop (rework loop, needs max_iterations). " +
        "A verifier node returns {decision: pass|rework|escalate, issues, evidence}; rework follows its retry_loop edge. " +
        "Only call this when the user explicitly asks to create a workflow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          graph: { type: "object", description: "The workflow graph." },
        },
        required: ["graph"],
      },
      replay: "unsafe",
      async execute(args) {
        const port = catalog();
        if (port === undefined) return unavailable("workflow_create_custom");
        try {
          const definition = await port.createCustom({ name: args.name, description: args.description, graph: args.graph });
          return okResult("workflow_create_custom", jsonText(definitionView(definition)), {
            tool: "workflow_create_custom",
            workflow_id: definition.id,
          });
        } catch (error) {
          return failure("workflow_create_custom", error);
        }
      },
    }),

    makeAppTool<Record<string, never>>({
      name: "workflow_list",
      description: "List the saved workflows (id, name, template, mode, node ids).",
      parameters: { type: "object", properties: {} },
      replay: "safe",
      async execute() {
        const port = catalog();
        if (port === undefined) return unavailable("workflow_list");
        try {
          const definitions = await port.list();
          return okResult("workflow_list", jsonText({ workflows: definitions.map(definitionView) }), {
            tool: "workflow_list",
            count: definitions.length,
          });
        } catch (error) {
          return failure("workflow_list", error);
        }
      },
    }),

    makeAppTool<{ workflow_id: string; business_context?: string }>({
      name: "workflow_start",
      description:
        "Start a saved workflow in the background and return its run id at once. The nodes use this conversation's data sources. " +
        "business_context is the goal, period and any rules the nodes should know. Use workflow_status to follow the run; " +
        "approvals are given by the user in the Data panel, not by you. Only call this when the user explicitly asks to run a workflow.",
      parameters: {
        type: "object",
        properties: {
          workflow_id: { type: "string", description: "The id returned by workflow_create or workflow_list." },
          business_context: { type: "string" },
        },
        required: ["workflow_id"],
      },
      // 启动是一次不可重复的副作用：崩溃后重放会再起一个运行。
      replay: "unsafe",
      async execute(args, api) {
        const port = catalog();
        if (port === undefined) return unavailable("workflow_start");
        try {
          const started = await port.start({
            workflowId: String(args.workflow_id ?? ""),
            conversationId: api.conversationId as unknown as number,
            ...(args.business_context === undefined ? {} : { businessContext: args.business_context }),
          });
          return okResult(
            "workflow_start",
            jsonText({
              run_id: started.id,
              status: "running",
              note: say(
                "The run is in the background. Check it with workflow_status; any approval is given by the user in the Data panel.",
                "运行已在后台开始。用 workflow_status 查看进度；需要审批时由用户在数据面板里操作。",
              ),
            }),
            { tool: "workflow_start", run_id: started.id },
          );
        } catch (error) {
          return failure("workflow_start", error);
        }
      },
    }),

    makeAppTool<{ run_id: number }>({
      name: "workflow_status",
      description:
        "Read a workflow run: its status (running, waiting_approval, succeeded, failed, canceled), each node's status, and the outputs once it has finished.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "integer", description: "The run id returned by workflow_start." } },
        required: ["run_id"],
      },
      replay: "safe",
      async execute(args) {
        const port = catalog();
        if (port === undefined) return unavailable("workflow_status");
        try {
          const run = await port.status(Number(args.run_id));
          return okResult("workflow_status", jsonText(runView(run)), { tool: "workflow_status", run_id: run.id, status: run.status });
        } catch (error) {
          return failure("workflow_status", error);
        }
      },
    }),
  ];
}
