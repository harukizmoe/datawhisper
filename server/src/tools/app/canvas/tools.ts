/**
 * 原生画布工具：canvas_create / canvas_get。
 *
 * 画布属于会话文档（见 document.ts 与 docs.ts 的 CANVAS_DOC）；编辑器与 agent 看到同一份
 * 文档。本票只提供创建与读取，编辑在后续票里加入。
 */

import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  errorResult,
  makeAppTool,
  okResult,
  type AppDocHost,
  type AppTool,
  type AppToolDeps,
  type AppToolDetails,
} from "../types.ts";
import {
  CANVAS_LIMITS,
  canvasFromTemplate,
  canvasId,
  clampTitle,
  normalizeEdge,
  normalizeNode,
  templateIds,
  validateCanvas,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasEdgeInput,
  type CanvasNode,
  type CanvasNodeInput,
  type CanvasRecord,
} from "./document.ts";

type CreateArgs = {
  title?: unknown;
  template_id?: unknown;
  content?: unknown;
  nodes?: unknown;
  edges?: unknown;
};

type GetArgs = { canvas_id?: unknown };

function canvasRef(canvas: CanvasRecord): AppToolDetails {
  return {
    canvas_id: canvas.id,
    title: canvas.title,
    revision: canvas.revision,
    node_count: canvas.nodes.length,
    edge_count: canvas.edges.length,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canvasHost(deps: AppToolDeps, api: ToolExecutionApi<AppToolDetails>): AppDocHost<CanvasDoc> {
  const host = deps.docs?.(api).canvas;
  if (host === undefined) throw new Error("canvas storage is not available");
  return host;
}

function failure(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

function contentMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text === "string") out[key] = text.slice(0, CANVAS_LIMITS.text);
  }
  return out;
}

function edgeInputs(value: unknown): CanvasEdgeInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => item as CanvasEdgeInput);
}

function nodeInputs(value: unknown): CanvasNodeInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((item) => item as CanvasNodeInput);
}

export function createCanvasTools(deps: AppToolDeps): AppTool[] {
  const now = deps.now ?? (() => new Date());

  const create = makeAppTool<CreateArgs>({
    name: "canvas_create",
    description:
      "Create a canvas in the current conversation. Provide nodes and edges, or a template_id with optional content. "
      + "Nodes without coordinates are placed on a simple grid. Returns the canvas id, title, revision and counts.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: `Canvas title (max ${CANVAS_LIMITS.title} characters).` },
        template_id: {
          type: "string",
          enum: templateIds(),
          description: "Optional template skeleton: blank_canvas, business_model_canvas, bcg_matrix, swot_analysis, value_proposition.",
        },
        content: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Template content keyed by node id (e.g. key_partners, strengths).",
        },
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string", enum: ["rect", "round", "ellipse", "diamond", "text", "note", "container"] },
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
              text: { type: "string" },
              parent: { type: "string" },
              pinned: { type: "boolean" },
              fontSize: { type: "number", description: "Font size in DIPs (8-48)." },
              style: { type: "object" },
            },
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to"],
            properties: {
              id: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              route: { type: "string", enum: ["straight", "orthogonal", "curve"] },
              arrow: { type: "string", enum: ["none", "end", "both"] },
              dashed: { type: "boolean" },
              label: { type: "string" },
              style: { type: "object" },
            },
          },
        },
      },
    },
    replay: "unsafe",
    async execute(args, api) {
      try {
        const host = canvasHost(deps, api);
        const templateId = typeof args.template_id === "string" && args.template_id !== "" ? args.template_id : "blank_canvas";
        if (!templateIds().includes(templateId)) throw new Error(`unknown canvas template: ${templateId}`);

        let nodes: CanvasNode[];
        let edges: CanvasEdge[];
        if (Array.isArray(args.nodes) && args.nodes.length > 0) {
          nodes = nodeInputs(args.nodes).map((item, index) => normalizeNode(item, index));
          edges = edgeInputs(args.edges).map((item, index) => normalizeEdge(item, index));
        } else {
          const template = canvasFromTemplate(templateId, "", contentMap(args.content));
          nodes = template.nodes;
          edges = edgeInputs(args.edges).map((item, index) => normalizeEdge(item, index));
        }

        const canvas: CanvasRecord = {
          id: canvasId(),
          title: clampTitle(args.title, templateId === "blank_canvas" ? "Canvas" : templateId.replaceAll("_", " ")),
          revision: 1,
          template_id: templateId,
          nodes,
          edges,
          updated_at: now().toISOString(),
        };
        const validation = validateCanvas(canvas);
        if (validation !== null) return failure("canvas_create", validation);

        await host.update((doc) => {
          if (doc.canvases.length >= CANVAS_LIMITS.canvases) {
            throw new Error(`too many canvases (max ${CANVAS_LIMITS.canvases})`);
          }
          doc.canvases.push(canvas);
        });

        const text = JSON.stringify({
          canvas_id: canvas.id,
          title: canvas.title,
          revision: canvas.revision,
          node_count: canvas.nodes.length,
          edge_count: canvas.edges.length,
        });
        return okResult("canvas_create", text, canvasRef(canvas));
      } catch (error) {
        return failure("canvas_create", error);
      }
    },
  });

  const get = makeAppTool<GetArgs>({
    name: "canvas_get",
    description:
      "Read a canvas in the current conversation. Returns the full document (nodes, edges, style roles) and its revision; "
      + "the field names match what canvas_edit will accept.",
    parameters: {
      type: "object",
      properties: { canvas_id: { type: "string", description: "Canvas id returned by canvas_create." } },
      required: ["canvas_id"],
    },
    replay: "safe",
    async execute(args, api) {
      try {
        const canvasIdValue = typeof args.canvas_id === "string" ? args.canvas_id.trim() : "";
        if (canvasIdValue === "") throw new Error("canvas_id is required");
        const host = canvasHost(deps, api);
        const doc = await host.read();
        const canvas = doc.canvases.find((item) => item.id === canvasIdValue);
        if (canvas === undefined) throw new Error(`canvas not found: ${canvasIdValue}`);
        const value = JSON.parse(JSON.stringify(canvas)) as JsonValue;
        return okResult("canvas_get", JSON.stringify(value), canvasRef(canvas));
      } catch (error) {
        return failure("canvas_get", error);
      }
    },
  });

  return [create, get];
}
