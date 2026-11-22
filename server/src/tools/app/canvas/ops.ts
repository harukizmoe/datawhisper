/**
 * 画布操作集：界面与 agent 共用同一批原子操作。
 *
 * 每个操作只改内存里的副本；整批执行完后统一校验，因此任何一步失败都不会留下半成品。
 * 并发由调用方先比较 `baseRevision`，本模块只负责文档语义。
 */

import {
  CANVAS_LIMITS,
  normalizeEdge,
  normalizeNode,
  validateCanvas,
  type CanvasEdge,
  type CanvasNode,
  type CanvasRecord,
} from "./document.ts";

export type CanvasOp =
  | { op: "add_node"; node?: unknown }
  | { op: "update_node"; id?: unknown; patch?: unknown }
  | { op: "delete_node"; id?: unknown }
  | { op: "add_edge"; edge?: unknown }
  | { op: "update_edge"; id?: unknown; patch?: unknown }
  | { op: "delete_edge"; id?: unknown };

export class CanvasOpError extends Error {
  constructor(readonly index: number, message: string) {
    super(`operation ${index}: ${message}`);
    this.name = "CanvasOpError";
  }
}

export type CanvasOpResult = {
  canvas: CanvasRecord;
  createdNodeIds: string[];
  createdEdgeIds: string[];
  changedNodeIds: string[];
  changedEdgeIds: string[];
  deletedNodeIds: string[];
  deletedEdgeIds: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opName(value: unknown): string {
  if (!isObject(value) || typeof value.op !== "string") throw new Error("operation must have an op name");
  return value.op;
}

function requiredId(op: Record<string, unknown>): string {
  if (typeof op.id !== "string" || op.id === "") throw new Error("id is required");
  return op.id;
}

function patchOf(op: Record<string, unknown>): Record<string, unknown> {
  if (op.patch === undefined) return {};
  if (!isObject(op.patch)) throw new Error("patch must be an object");
  return op.patch;
}

function nodeById(canvas: CanvasRecord, id: string, index: number): CanvasNode {
  const node = canvas.nodes.find((item) => item.id === id);
  if (node === undefined) throw new CanvasOpError(index, `node not found: ${id}`);
  return node;
}

function edgeById(canvas: CanvasRecord, id: string, index: number): CanvasEdge {
  const edge = canvas.edges.find((item) => item.id === id);
  if (edge === undefined) throw new CanvasOpError(index, `edge not found: ${id}`);
  return edge;
}

function addUnique(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

/** 删除节点时级联：子节点、以及挂在被删节点上的连线。 */
function deleteNode(canvas: CanvasRecord, id: string): { nodes: string[]; edges: string[] } {
  const removed = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of canvas.nodes) {
      if (!removed.has(node.id) && removed.has(node.parent)) {
        removed.add(node.id);
        grew = true;
      }
    }
  }
  const edges = canvas.edges.filter((edge) => removed.has(edge.from) || removed.has(edge.to)).map((edge) => edge.id);
  canvas.nodes = canvas.nodes.filter((node) => !removed.has(node.id));
  canvas.edges = canvas.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to));
  return { nodes: [...removed], edges };
}

export function applyCanvasOps(canvas: CanvasRecord, ops: readonly unknown[], now: Date): CanvasOpResult {
  // 事务里的文档是 pi-durable 的 draft 视图，不能 structuredClone；文档本身是纯 JSON。
  const draft = JSON.parse(JSON.stringify(canvas)) as CanvasRecord;
  const result: CanvasOpResult = {
    canvas: draft,
    createdNodeIds: [],
    createdEdgeIds: [],
    changedNodeIds: [],
    changedEdgeIds: [],
    deletedNodeIds: [],
    deletedEdgeIds: [],
  };

  ops.forEach((raw, index) => {
    try {
      const name = opName(raw);
      const op = raw as Record<string, unknown>;
      switch (name) {
        case "add_node": {
          if (!isObject(op.node)) throw new Error("node is required");
          const node = normalizeNode(op.node as Partial<CanvasNode>, draft.nodes.length);
          if (draft.nodes.some((item) => item.id === node.id)) throw new Error(`duplicate node id: ${node.id}`);
          draft.nodes.push(node);
          result.createdNodeIds.push(node.id);
          break;
        }
        case "update_node": {
          const id = requiredId(op);
          const current = nodeById(draft, id, index);
          const patch = patchOf(op);
          const next = normalizeNode({ ...current, ...patch, id, style: { ...current.style, ...(isObject(patch.style) ? patch.style : {}) } }, 0);
          draft.nodes[draft.nodes.indexOf(current)] = next;
          addUnique(result.changedNodeIds, id);
          break;
        }
        case "delete_node": {
          const id = requiredId(op);
          nodeById(draft, id, index);
          const removed = deleteNode(draft, id);
          for (const node of removed.nodes) addUnique(result.deletedNodeIds, node);
          for (const edge of removed.edges) addUnique(result.deletedEdgeIds, edge);
          break;
        }
        case "add_edge": {
          if (!isObject(op.edge)) throw new Error("edge is required");
          const edge = normalizeEdge(op.edge as Partial<CanvasEdge> & { from: string; to: string }, draft.edges.length);
          if (draft.edges.some((item) => item.id === edge.id)) throw new Error(`duplicate edge id: ${edge.id}`);
          draft.edges.push(edge);
          result.createdEdgeIds.push(edge.id);
          break;
        }
        case "update_edge": {
          const id = requiredId(op);
          const current = edgeById(draft, id, index);
          const patch = patchOf(op);
          const next = normalizeEdge({ ...current, ...patch, id, style: { ...current.style, ...(isObject(patch.style) ? patch.style : {}) } }, 0);
          draft.edges[draft.edges.indexOf(current)] = next;
          addUnique(result.changedEdgeIds, id);
          break;
        }
        case "delete_edge": {
          const id = requiredId(op);
          edgeById(draft, id, index);
          draft.edges = draft.edges.filter((edge) => edge.id !== id);
          addUnique(result.deletedEdgeIds, id);
          break;
        }
        default:
          throw new Error(`unknown operation: ${name}`);
      }
    } catch (error) {
      if (error instanceof CanvasOpError) throw error;
      throw new CanvasOpError(index, error instanceof Error ? error.message : String(error));
    }
  });

  draft.revision = canvas.revision + 1;
  draft.updated_at = now.toISOString();
  if (draft.nodes.length > CANVAS_LIMITS.nodes) throw new CanvasOpError(ops.length - 1, `too many nodes (max ${CANVAS_LIMITS.nodes})`);
  if (draft.edges.length > CANVAS_LIMITS.edges) throw new CanvasOpError(ops.length - 1, `too many edges (max ${CANVAS_LIMITS.edges})`);
  const invalid = validateCanvas(draft);
  if (invalid !== null) throw new CanvasOpError(ops.length - 1, invalid);
  return result;
}
