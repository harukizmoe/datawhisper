/**
 * 工作流目录：保存的工作流定义 + 从定义启动运行。
 *
 * 旧实现把「已发布 Workflow」按工作区存在 SQLite 里，带版本历史。桌面应用是单用户，所以这里是
 * `<数据目录>/workflows/<id>.json` 一份一个文件：改图就是新建一份，不做版本。运行输入里的
 * `workflowVersionId` 就是定义 id，图的快照随运行任务一起不可变地保存，之后删除定义不影响历史运行。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { say } from "../i18n.ts";
import { validateWorkflowGraph } from "./graph.ts";
import type { Workflows } from "./service.ts";
import {
  buildTemplateGraph,
  normalizeMode,
  normalizeTemplate,
  WORKFLOW_MODES,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplate,
} from "./templates.ts";
import { WorkflowError, type WorkflowGraph, type WorkflowRunDetail } from "./types.ts";

export type WorkflowDefinition = {
  id: string;
  name: string;
  description: string;
  /** 内置模板名；自定义图为 `custom`。 */
  template: WorkflowTemplate | "custom";
  graph: WorkflowGraph;
  createdAt: string;
};

export type WorkflowCatalog = {
  create(request: { name?: string; description?: string; mode?: unknown; template?: unknown }): Promise<WorkflowDefinition>;
  createCustom(request: { name?: string; description?: string; graph: unknown }): Promise<WorkflowDefinition>;
  list(): Promise<WorkflowDefinition[]>;
  get(id: string): Promise<WorkflowDefinition>;
  remove(id: string): Promise<{ removed: boolean }>;
  /** 从定义启动一次运行；`businessContext` 作为入口节点的 `business_context` 输入。 */
  start(request: { workflowId: string; conversationId: number; businessContext?: string }): Promise<{ id: number }>;
  status(runId: number): Promise<WorkflowRunDetail>;
};

export type WorkflowCatalogOptions = {
  /** 定义目录（`<dataDir>/workflows`）。 */
  dir: string;
  workflows: Pick<Workflows, "start" | "get">;
  now?: () => Date;
  /** 生成定义 id；测试可固定。 */
  newId?: () => string;
};

/** id 同时是文件名：只允许这一组字符，杜绝路径穿越。 */
const ID_PATTERN = /^wf_[0-9a-f]{8,32}$/;

function readDefinition(file: string): WorkflowDefinition | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkflowDefinition>;
    if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.graph !== "object" || value.graph === null) return undefined;
    return {
      id: value.id,
      name: value.name,
      description: typeof value.description === "string" ? value.description : "",
      template: typeof value.template === "string" ? (value.template as WorkflowDefinition["template"]) : "custom",
      graph: value.graph,
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    };
  } catch {
    // 手工改坏的文件不该让整个列表不可用。
    return undefined;
  }
}

export function createWorkflowCatalog(options: WorkflowCatalogOptions): WorkflowCatalog {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `wf_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`);
  const fileOf = (id: string): string => join(options.dir, `${id}.json`);

  function save(definition: WorkflowDefinition): void {
    mkdirSync(options.dir, { recursive: true });
    // 先写临时文件再改名：崩溃时不会留下写了一半的定义。
    const tmp = `${fileOf(definition.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(definition, null, 2));
    renameSync(tmp, fileOf(definition.id));
  }

  function build(base: Omit<WorkflowDefinition, "id" | "createdAt">): WorkflowDefinition {
    const definition: WorkflowDefinition = { ...base, id: newId(), createdAt: now().toISOString() };
    save(definition);
    return definition;
  }

  function cleanName(value: unknown, fallback: string): string {
    return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 100) : fallback;
  }

  function get(id: string): WorkflowDefinition {
    const found = ID_PATTERN.test(id) && existsSync(fileOf(id)) ? readDefinition(fileOf(id)) : undefined;
    if (found === undefined) {
      throw new WorkflowError("workflow_resource_not_found", say(`workflow not found: ${id}`, `找不到工作流：${id}`));
    }
    return found;
  }

  return {
    async create(request) {
      const template = normalizeTemplate(request.template);
      if (template === undefined) {
        throw new WorkflowError(
          "workflow_graph_invalid",
          say(`workflow template must be one of ${WORKFLOW_TEMPLATES.join(", ")}`, `工作流模板必须是 ${WORKFLOW_TEMPLATES.join("、")} 之一`),
        );
      }
      const mode = normalizeMode(request.mode);
      if (mode === undefined) {
        throw new WorkflowError(
          "workflow_graph_invalid",
          say(`workflow mode must be one of ${WORKFLOW_MODES.join(", ")}`, `工作流模式必须是 ${WORKFLOW_MODES.join("、")} 之一`),
        );
      }
      // 模板图也过一遍校验：模板写错时在创建处就暴露，而不是等到第一次运行。
      const graph = validateWorkflowGraph(buildTemplateGraph(template, mode));
      const name = cleanName(request.name, say("Business analysis workflow", "经营分析工作流"));
      return build({
        name,
        description:
          typeof request.description === "string" && request.description.trim() !== ""
            ? request.description.trim()
            : say(`${template} workflow template in ${graph.run_policy?.mode ?? mode} mode`, `${graph.run_policy?.mode ?? mode} 模式的 ${template} 工作流模板`),
        template,
        graph,
      });
    },

    async createCustom(request) {
      if (typeof request.graph !== "object" || request.graph === null || Array.isArray(request.graph)) {
        throw new WorkflowError("workflow_graph_invalid", say("graph must be an object with nodes, edges and entry_node_ids", "graph 必须是含 nodes、edges、entry_node_ids 的对象"));
      }
      const graph = validateWorkflowGraph(request.graph as WorkflowGraph);
      return build({
        name: cleanName(request.name, say("Custom workflow", "自定义工作流")),
        description: typeof request.description === "string" ? request.description.trim() : "",
        template: "custom",
        graph,
      });
    },

    async list() {
      if (!existsSync(options.dir)) return [];
      const found: WorkflowDefinition[] = [];
      for (const name of readdirSync(options.dir)) {
        if (!name.endsWith(".json")) continue;
        const definition = readDefinition(join(options.dir, name));
        if (definition !== undefined && ID_PATTERN.test(definition.id)) found.push(definition);
      }
      return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    },

    async get(id) {
      return get(id);
    },

    async remove(id) {
      if (!ID_PATTERN.test(id) || !existsSync(fileOf(id))) return { removed: false };
      rmSync(fileOf(id));
      return { removed: true };
    },

    async start(request) {
      const definition = get(request.workflowId);
      const context = typeof request.businessContext === "string" ? request.businessContext.trim() : "";
      return options.workflows.start({
        conversationId: request.conversationId,
        workflowVersionId: definition.id,
        graph: definition.graph,
        inputs: context === "" ? {} : { business_context: context },
      });
    },

    status(runId) {
      return options.workflows.get(runId);
    },
  };
}
