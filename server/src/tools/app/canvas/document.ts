/**
 * 原生画布的文档模型、校验与模板。
 *
 * 画布是会话级 durable 文档（`datawhisper.canvas`），一张文档里可以有多张画布。
 * 这里只放纯逻辑：不读文件、不碰会话服务，便于单测与后续的编辑操作复用。
 */

import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";

export const CANVAS_LIMITS = {
  canvases: 20,
  nodes: 500,
  edges: 2000,
  text: 2000,
  title: 120,
  identifier: 64,
  fontMin: 8,
  fontMax: 48,
} as const;

export const CANVAS_NODE_KINDS = ["rect", "round", "ellipse", "diamond", "text", "note", "container"] as const;
export type CanvasNodeKind = (typeof CANVAS_NODE_KINDS)[number];

export const CANVAS_ROLES = ["default", "accent", "success", "warning", "danger", "muted"] as const;
export type CanvasRole = (typeof CANVAS_ROLES)[number];

export const CANVAS_ROUTES = ["straight", "orthogonal", "curve"] as const;
export type CanvasRoute = (typeof CANVAS_ROUTES)[number];

export const CANVAS_ARROWS = ["none", "end", "both"] as const;
export type CanvasArrow = (typeof CANVAS_ARROWS)[number];

export type CanvasStyle = {
  fill: CanvasRole;
  border: CanvasRole;
  text: CanvasRole;
};

export type CanvasNode = {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  parent: string;
  pinned: boolean;
  style: CanvasStyle;
  fontSize: number;
};

export type CanvasEdge = {
  id: string;
  from: string;
  to: string;
  route: CanvasRoute;
  arrow: CanvasArrow;
  dashed: boolean;
  label: string;
  style: CanvasStyle;
};

export type CanvasRecord = {
  id: string;
  title: string;
  revision: number;
  template_id: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  updated_at: string;
};

export type CanvasDoc = { canvases: CanvasRecord[] } & JsonObject;

/** 模型可写的输入形状；缺省字段由 normalize 补齐。 */
export type CanvasNodeInput = Partial<CanvasNode> & { id?: string; kind?: CanvasNodeKind };
export type CanvasEdgeInput = Partial<CanvasEdge> & { from: string; to: string };

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,64}$/;

const DEFAULT_STYLE: CanvasStyle = { fill: "default", border: "default", text: "default" };

export function canvasId(): string {
  return `cv_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function itemId(prefix: "n" | "e"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function emptyCanvasDoc(): CanvasDoc {
  return { canvases: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function role(value: unknown): CanvasRole {
  return typeof value === "string" && (CANVAS_ROLES as readonly string[]).includes(value) ? (value as CanvasRole) : "default";
}

function kind(value: unknown): CanvasNodeKind {
  return typeof value === "string" && (CANVAS_NODE_KINDS as readonly string[]).includes(value)
    ? (value as CanvasNodeKind)
    : "rect";
}

export function normalizeNode(input: CanvasNodeInput, index: number): CanvasNode {
  const id = typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : itemId("n");
  const style: Record<string, unknown> = isRecord(input.style) ? input.style : {};
  const columns = 4;
  return {
    id,
    kind: kind(input.kind),
    x: finite(input.x, 40 + (index % columns) * 210),
    y: finite(input.y, 40 + Math.floor(index / columns) * 140),
    w: Math.max(20, finite(input.w, 180)),
    h: Math.max(20, finite(input.h, 96)),
    text: typeof input.text === "string" ? input.text.slice(0, CANVAS_LIMITS.text) : "",
    parent: typeof input.parent === "string" ? input.parent : "",
    pinned: input.pinned === true,
    style: { fill: role(style.fill), border: role(style.border), text: role(style.text) },
    fontSize: Math.min(CANVAS_LIMITS.fontMax, Math.max(CANVAS_LIMITS.fontMin, finite(input.fontSize, 14))),
  };
}

export function normalizeEdge(input: CanvasEdgeInput, index: number): CanvasEdge {
  const style: Record<string, unknown> = isRecord(input.style) ? input.style : {};
  return {
    id: typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : itemId("e"),
    from: String(input.from ?? ""),
    to: String(input.to ?? ""),
    route: typeof input.route === "string" && (CANVAS_ROUTES as readonly string[]).includes(input.route)
      ? (input.route as CanvasRoute)
      : "orthogonal",
    arrow: typeof input.arrow === "string" && (CANVAS_ARROWS as readonly string[]).includes(input.arrow)
      ? (input.arrow as CanvasArrow)
      : "end",
    dashed: input.dashed === true,
    label: typeof input.label === "string" ? input.label.slice(0, CANVAS_LIMITS.text) : "",
    style: { fill: role(style.fill), border: role(style.border), text: role(style.text) },
  };
}

function parentCycle(nodes: readonly CanvasNode[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const seen = new Set<string>();
    let current = node;
    while (current.parent !== "") {
      if (seen.has(current.id)) return true;
      seen.add(current.id);
      const parent = byId.get(current.parent);
      if (parent === undefined) return true;
      if (parent.kind !== "container") return true;
      current = parent;
    }
  }
  return false;
}

/** 返回人类可读的校验错误；合法返回 null。 */
export function validateCanvas(canvas: CanvasRecord): string | null {
  if (!IDENTIFIER_RE.test(canvas.id)) return `invalid canvas id: ${canvas.id}`;
  if (canvas.title.trim() === "") return "canvas title must not be empty";
  if (canvas.title.length > CANVAS_LIMITS.title) return `canvas title is too long (max ${CANVAS_LIMITS.title})`;
  if (!Number.isInteger(canvas.revision) || canvas.revision < 1) return "revision must be a positive integer";
  if (canvas.nodes.length > CANVAS_LIMITS.nodes) return `too many nodes (max ${CANVAS_LIMITS.nodes})`;
  if (canvas.edges.length > CANVAS_LIMITS.edges) return `too many edges (max ${CANVAS_LIMITS.edges})`;

  const nodeIds = new Set<string>();
  for (const node of canvas.nodes) {
    if (!IDENTIFIER_RE.test(node.id)) return `invalid node id: ${node.id}`;
    if (nodeIds.has(node.id)) return `duplicate node id: ${node.id}`;
    nodeIds.add(node.id);
    if (!CANVAS_NODE_KINDS.includes(node.kind)) return `invalid node kind: ${node.kind}`;
    if (![node.x, node.y, node.w, node.h].every(Number.isFinite)) return `node ${node.id} has a non-finite position`;
    if (node.w < 20 || node.h < 20) return `node ${node.id} is too small`;
    if (node.text.length > CANVAS_LIMITS.text) return `node ${node.id} text is too long`;
    if (!Number.isFinite(node.fontSize) || node.fontSize < CANVAS_LIMITS.fontMin || node.fontSize > CANVAS_LIMITS.fontMax) {
      return `node ${node.id} has an invalid font size`;
    }
    for (const roleName of [node.style.fill, node.style.border, node.style.text]) {
      if (!CANVAS_ROLES.includes(roleName)) return `node ${node.id} has an invalid style role`;
    }
  }
  if (parentCycle(canvas.nodes)) return "container parent relationship has a cycle or a non-container parent";

  const edgeIds = new Set<string>();
  for (const edge of canvas.edges) {
    if (!IDENTIFIER_RE.test(edge.id)) return `invalid edge id: ${edge.id}`;
    if (edgeIds.has(edge.id)) return `duplicate edge id: ${edge.id}`;
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return `edge ${edge.id} references a missing node`;
    if (!CANVAS_ROUTES.includes(edge.route)) return `edge ${edge.id} has an invalid route`;
    if (!CANVAS_ARROWS.includes(edge.arrow)) return `edge ${edge.id} has an invalid arrow`;
    if (edge.label.length > CANVAS_LIMITS.text) return `edge ${edge.id} label is too long`;
  }
  return null;
}

export function validateCanvasDoc(doc: CanvasDoc): string | null {
  if (doc.canvases.length > CANVAS_LIMITS.canvases) return `too many canvases (max ${CANVAS_LIMITS.canvases})`;
  const ids = new Set<string>();
  for (const canvas of doc.canvases) {
    if (ids.has(canvas.id)) return `duplicate canvas id: ${canvas.id}`;
    ids.add(canvas.id);
    const error = validateCanvas(canvas);
    if (error !== null) return error;
  }
  return null;
}

/** 模板骨架：先用简单分区布局，后续模板/布局票再细化视觉。 */
const TEMPLATES: Record<string, { title: string; nodes: Array<[string, string, number, number, number, number]> }> = {
  blank_canvas: { title: "Blank canvas", nodes: [] },
  business_model_canvas: {
    title: "Business Model Canvas",
    nodes: [
      ["key_partners", "Key partners", 20, 20, 250, 230],
      ["key_activities", "Key activities", 290, 20, 250, 110],
      ["key_resources", "Key resources", 290, 140, 250, 110],
      ["value_proposition", "Value proposition", 560, 20, 250, 410],
      ["customer_relationships", "Customer relationships", 830, 20, 250, 110],
      ["channels", "Channels", 830, 140, 250, 110],
      ["customer_segments", "Customer segments", 830, 260, 250, 170],
      ["cost_structure", "Cost structure", 20, 270, 520, 160],
      ["revenue_streams", "Revenue streams", 560, 450, 520, 160],
    ],
  },
  bcg_matrix: {
    title: "BCG matrix",
    nodes: [
      ["stars", "Stars", 20, 20, 520, 300],
      ["question_marks", "Question marks", 560, 20, 520, 300],
      ["cash_cows", "Cash cows", 20, 340, 520, 300],
      ["dogs", "Dogs", 560, 340, 520, 300],
    ],
  },
  swot_analysis: {
    title: "SWOT analysis",
    nodes: [
      ["strengths", "Strengths", 20, 20, 520, 300],
      ["weaknesses", "Weaknesses", 560, 20, 520, 300],
      ["opportunities", "Opportunities", 20, 340, 520, 300],
      ["threats", "Threats", 560, 340, 520, 300],
    ],
  },
  value_proposition: {
    title: "Value proposition",
    nodes: [
      ["product_service", "Product & service", 20, 20, 260, 260],
      ["customer_segments", "Customer segments", 300, 20, 260, 260],
      ["customer_jobs", "Customer jobs", 580, 20, 260, 260],
      ["pain_relievers", "Pain relievers", 20, 300, 260, 260],
      ["gain_creators", "Gain creators", 300, 300, 260, 260],
      ["competitors", "Competitors", 580, 300, 260, 260],
    ],
  },
};

export function templateIds(): string[] {
  return Object.keys(TEMPLATES);
}

export function canvasFromTemplate(
  templateId: string,
  title: string,
  content: Record<string, string> = {},
): { title: string; nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const template = TEMPLATES[templateId];
  if (template === undefined) throw new Error(`unknown canvas template: ${templateId}`);
  const nodes = template.nodes.map(([id, label, x, y, w, h], index) =>
    normalizeNode(
      {
        id,
        kind: id === "value_proposition" ? "round" : "rect",
        x,
        y,
        w,
        h,
        text: typeof content[id] === "string" && content[id] !== "" ? content[id] : label,
      },
      index,
    ),
  );
  return { title: title.trim() || template.title, nodes, edges: [] };
}

export function clampTitle(title: unknown, fallback: string): string {
  const text = typeof title === "string" ? title.trim() : "";
  const chosen = text === "" ? fallback : text;
  return chosen.slice(0, CANVAS_LIMITS.title);
}

/** 会话级画布文档：一张文档里有多张画布，每次提交写完整基线。 */
export const CANVAS_DOC = defineDoc<CanvasDoc>({
  kind: "datawhisper.canvas",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => emptyCanvasDoc(),
  checkpointWhen: () => true,
});
