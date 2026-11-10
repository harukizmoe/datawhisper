/**
 * 工作流图的校验与就绪判定，语义取自旧 `agent/workflows/models.py` 与 `scheduler.py`：
 *
 * - 前向边（auto/approval）必须无环，节点必须从入口可达；
 * - `retry_loop` 边不参与前驱关系（旧 `_predecessors` 的规则）；
 * - 条件边：源节点未终态时下游继续等；源节点成功且 `output[field] === equals` 才算被选中；
 *   没有任何条件边被选中且没有未决源时，非入口节点被跳过；
 * - 前驱全部成功 → 就绪；前驱全部终态但不全成功 → 跳过，除非 `join_policy: "all_terminal"`
 *   且至少有一个前驱成功（旧 `_mark_ready_nodes`）。
 *
 * 审批（`run_policy.mode` 非 `full_auto`）本轮不执行：`validateWorkflowGraph` 明确报错，
 * 避免把需要人工确认的图当成全自动跑掉。
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  type EdgeType,
  type JoinPolicy,
  WorkflowError,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeStatus,
} from "./types.ts";

const EDGE_TYPES: Readonly<Record<string, true>> = { auto: true, conditional: true, approval: true, retry_loop: true };
const JOIN_POLICIES: Readonly<Record<string, true>> = { all_success: true, all_terminal: true };
const RUN_MODES: Readonly<Record<string, true>> = { full_auto: true, key_approval: true, exception_review: true };

function graphError(message: string): WorkflowError {
  return new WorkflowError("workflow_graph_invalid", message);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw graphError(`${field} must be a non-empty string`);
  return value;
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean" && typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  throw graphError(`${field} must be a positive integer`);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw graphError(`${field} must be a string array`);
  }
  return [...value];
}

/** 前驱表：与旧 `_predecessors` 一致，`retry_loop` 边不算前驱。 */
export function predecessors(graph: WorkflowGraph): Map<string, string[]> {
  const result = new Map<string, string[]>(graph.nodes.map((node) => [node.node_id, []]));
  for (const edge of graph.edges) {
    if (edge.type === "retry_loop") continue;
    result.get(edge.to_node)?.push(edge.from_node);
  }
  return result;
}

/** 拓扑序（忽略 `retry_loop`）：跳过判定需要按前驱先算。 */
export function topologicalOrder(graph: WorkflowGraph): string[] {
  const order: string[] = [];
  const indegree = new Map<string, number>(graph.nodes.map((node) => [node.node_id, 0]));
  const outgoing = new Map<string, string[]>(graph.nodes.map((node) => [node.node_id, []]));
  for (const edge of graph.edges) {
    if (edge.type === "retry_loop") continue;
    indegree.set(edge.to_node, (indegree.get(edge.to_node) ?? 0) + 1);
    outgoing.get(edge.from_node)?.push(edge.to_node);
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  return order;
}

export function nodeMaxAttempts(node: WorkflowNode): number {
  return positiveInt(node.max_attempts, `${node.node_id} max_attempts`) ?? 1;
}

export function nodeJoinPolicy(node: WorkflowNode): JoinPolicy {
  const policy = node.join_policy ?? "all_success";
  if (JOIN_POLICIES[policy] !== true) throw graphError(`unsupported join_policy for ${node.node_id}: ${policy}`);
  return policy;
}

/** 运行模式；没有显式声明时，有 approval 边就按旧规则视为 key_approval。 */
export function runMode(graph: WorkflowGraph): "full_auto" | "key_approval" | "exception_review" {
  const declared = graph.run_policy?.mode;
  if (declared !== undefined) {
    if (RUN_MODES[declared] !== true) throw graphError(`unsupported run mode: ${String(declared)}`);
    return declared;
  }
  return graph.edges.some((edge) => edge.type === "approval") ? "key_approval" : "full_auto";
}

/**
 * 校验并返回同一份图（不修改调用方数据）。只校验调度需要的结构；
 * 节点类型自身的参数校验属于工作流编辑/发布（P6/P8），这里不重复。
 */
export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowGraph {
  if (typeof graph !== "object" || graph === null || Array.isArray(graph)) throw graphError("workflow graph must be an object");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw graphError("workflow graph requires at least one node");
  if (!Array.isArray(graph.edges)) throw graphError("workflow graph edges must be an array");
  if (!Array.isArray(graph.entry_node_ids) || graph.entry_node_ids.length === 0) {
    throw graphError("workflow graph requires at least one entry node");
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (typeof node !== "object" || node === null) throw graphError("each workflow node must be an object");
    const id = requiredText(node.node_id, "workflow node node_id");
    if (nodeIds.has(id)) throw graphError(`duplicate node_id: ${id}`);
    nodeIds.add(id);
    positiveInt(node.max_attempts, `${id} max_attempts`);
    positiveInt(node.max_iterations, `${id} max_iterations`);
    nodeJoinPolicy(node);
    stringArray(node.input_contract, `${id} input_contract`);
    stringArray(node.output_contract, `${id} output_contract`);
    if (node.replay !== undefined && node.replay !== "safe" && node.replay !== "unsafe") {
      throw graphError(`${id} replay must be safe or unsafe`);
    }
    if (node.type === "verifier" && !(node.output_contract ?? []).includes("decision")) {
      throw graphError(`verifier node ${id} must list "decision" in output_contract`);
    }
  }

  const entries: string[] = [];
  for (const value of graph.entry_node_ids) {
    const id = requiredText(value, "entry node");
    if (!nodeIds.has(id)) throw graphError(`unknown entry node: ${id}`);
    if (!entries.includes(id)) entries.push(id);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (typeof edge !== "object" || edge === null) throw graphError("each workflow edge must be an object");
    const id = requiredText(edge.edge_id, "workflow edge edge_id");
    if (edgeIds.has(id)) throw graphError(`duplicate edge_id: ${id}`);
    edgeIds.add(id);
    const from = requiredText(edge.from_node, `edge ${id} from_node`);
    const to = requiredText(edge.to_node, `edge ${id} to_node`);
    if (!nodeIds.has(from) || !nodeIds.has(to)) throw graphError(`edge ${id} references an unknown node`);
    if (from === to) throw graphError(`self edge is not allowed: ${id}`);
    const type = edge.type ?? "auto";
    if (EDGE_TYPES[type] !== true) throw graphError(`unsupported edge type for ${id}: ${String(type)}`);
    if (type === "conditional") {
      const condition = edge.condition;
      if (typeof condition !== "object" || condition === null) throw graphError(`conditional edge ${id} requires condition`);
      requiredText(condition.field, `conditional edge ${id} condition.field`);
      if (condition.equals === undefined || typeof condition.equals === "object") {
        throw graphError(`conditional edge ${id} requires scalar condition.equals`);
      }
    }
    if (type === "retry_loop") positiveInt(edge.max_iterations, `edge ${id} max_iterations`);
  }

  const order = topologicalOrder(graph);
  if (order.length !== nodeIds.size) throw graphError("auto and approval edges must form an acyclic graph");
  const reachable = new Set(entries);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from_node) ?? [];
    list.push(edge.to_node);
    outgoing.set(edge.from_node, list);
  }
  const queue = [...entries];
  while (queue.length > 0) {
    for (const target of outgoing.get(queue.pop()!) ?? []) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  const missing = [...nodeIds].filter((id) => !reachable.has(id)).sort();
  if (missing.length > 0) throw graphError(`unreachable nodes: ${missing.join(", ")}`);

  const limits = graph.limits ?? {};
  positiveInt(limits.max_concurrent_node_runs, "limits.max_concurrent_node_runs");
  positiveInt(limits.max_total_tokens, "limits.max_total_tokens");
  positiveInt(limits.max_run_minutes, "limits.max_run_minutes");

  runMode(graph); // 声明了不认识的模式时在这里抛错
  return graph;
}

/** 节点是否有 `approval` 出边：`key_approval` 模式下它成功后要等人放行下游。 */
export function hasApprovalEdge(graph: WorkflowGraph, nodeId: string): boolean {
  return graph.edges.some((edge) => edge.type === "approval" && edge.from_node === nodeId);
}

/** 节点的最新一次尝试：iteration、attempt 都更大者胜；同号用任务 id（创建顺序）决胜。 */
export function compareAttempt(
  a: { iteration: number; attempt: number; taskId: number },
  b: { iteration: number; attempt: number; taskId: number },
): number {
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  if (a.attempt !== b.attempt) return a.attempt - b.attempt;
  return a.taskId - b.taskId;
}

export const TERMINAL_NODE_STATUSES: Readonly<Record<WorkflowNodeStatus, true | undefined>> = {
  pending: undefined,
  queued: undefined,
  running: undefined,
  output_ready: undefined,
  waiting_approval: undefined,
  succeeded: true,
  rejected: true,
  skipped: true,
  failed: true,
  canceled: true,
};

export function isTerminalNodeStatus(status: WorkflowNodeStatus): boolean {
  return TERMINAL_NODE_STATUSES[status] === true;
}

/**
 * 运行最终输出：按图顺序合并各节点输出；声明了 `output_schema.properties` 时只保留声明过的键
 * （旧 `detail()` 的规则）。
 */
export function collectOutputs(
  graph: WorkflowGraph,
  outputs: ReadonlyMap<string, JsonValue>,
): Record<string, JsonValue> {
  const declared = Object.keys(graph.output_schema?.properties ?? {});
  const result: Record<string, JsonValue> = {};
  for (const node of graph.nodes) {
    const output = outputs.get(node.node_id);
    if (typeof output !== "object" || output === null || Array.isArray(output)) continue;
    for (const [name, value] of Object.entries(output)) {
      if (declared.length === 0 || declared.includes(name)) result[name] = value;
    }
  }
  return result;
}

export type ReadinessInput = {
  graph: WorkflowGraph;
  /** 每个节点的最新状态（没有记录且未跳过的节点不在表里）。 */
  statuses: ReadonlyMap<string, WorkflowNodeStatus>;
  /** 节点输出（条件边判定用）。 */
  outputs: ReadonlyMap<string, JsonValue>;
  /** 已经跳过的节点（来自运行索引）。 */
  skipped: ReadonlySet<string>;
};

export type ReadinessPlan = {
  /** 可以派发的节点，按图的拓扑顺序。 */
  ready: string[];
  /** 本次新判定为跳过的节点。 */
  skipped: string[];
};

/**
 * 就绪/跳过判定。按拓扑序推进，跳过的节点立刻按终态参与下游判定（旧实现每轮 `_mark_ready_nodes`
 * 也会在下一次调用看到新的 skipped）。
 */
export function planReadiness(input: ReadinessInput): ReadinessPlan {
  const { graph, outputs, skipped } = input;
  const statuses = new Map(input.statuses);
  const predecessorsOf = predecessors(graph);
  const entries = new Set(graph.entry_node_ids);
  const conditionalByTarget = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.type !== "conditional") continue;
    const list = conditionalByTarget.get(edge.to_node) ?? [];
    list.push(edge.from_node);
    conditionalByTarget.set(edge.to_node, list);
  }
  const ready: string[] = [];
  const newlySkipped: string[] = [];

  for (const nodeId of topologicalOrder(graph)) {
    if (skipped.has(nodeId)) {
      statuses.set(nodeId, "skipped");
      continue;
    }
    const known = statuses.get(nodeId);
    if (known !== undefined && known !== "pending") continue;

    const node = graph.nodes.find((item) => item.node_id === nodeId);
    if (node === undefined) continue;
    const required = [...(predecessorsOf.get(nodeId) ?? [])];
    const conditionalSources = conditionalByTarget.get(nodeId) ?? [];
    let resolvedRequired = required;

    if (conditionalSources.length > 0) {
      const selected: string[] = [];
      let unresolved = false;
      for (const edge of graph.edges) {
        if (edge.type !== "conditional" || edge.to_node !== nodeId) continue;
        const sourceStatus = statuses.get(edge.from_node);
        if (sourceStatus === undefined || !isTerminalNodeStatus(sourceStatus)) {
          unresolved = true;
          continue;
        }
        if (sourceStatus !== "succeeded") continue;
        const output = outputs.get(edge.from_node);
        if (
          typeof output === "object" &&
          output !== null &&
          !Array.isArray(output) &&
          edge.condition !== undefined &&
          output[edge.condition.field] === edge.condition.equals
        ) {
          selected.push(edge.from_node);
        }
      }
      resolvedRequired = required.filter((source) => !conditionalSources.includes(source)).concat(selected);
      if (selected.length === 0 && !unresolved && !entries.has(nodeId)) {
        statuses.set(nodeId, "skipped");
        newlySkipped.push(nodeId);
        continue;
      }
    }

    if (entries.has(nodeId) && resolvedRequired.length === 0) {
      statuses.set(nodeId, "pending");
      ready.push(nodeId);
      continue;
    }
    const states = resolvedRequired.map((source) => statuses.get(source));
    if (states.length > 0 && states.every((state) => state === "succeeded")) {
      statuses.set(nodeId, "pending");
      ready.push(nodeId);
      continue;
    }
    if (states.length > 0 && states.every((state) => state !== undefined && isTerminalNodeStatus(state))) {
      if (nodeJoinPolicy(node) === "all_terminal" && states.some((state) => state === "succeeded")) {
        statuses.set(nodeId, "pending");
        ready.push(nodeId);
      } else {
        statuses.set(nodeId, "skipped");
        newlySkipped.push(nodeId);
      }
    }
  }

  return { ready, skipped: newlySkipped };
}

/** 向前边（不含 `retry_loop`）的邻接表。 */
function forwardAdjacency(graph: WorkflowGraph, reverse = false): Map<string, string[]> {
  const adjacency = new Map<string, string[]>(graph.nodes.map((node) => [node.node_id, []]));
  for (const edge of graph.edges) {
    if (edge.type === "retry_loop") continue;
    const [from, to] = reverse ? [edge.to_node, edge.from_node] : [edge.from_node, edge.to_node];
    adjacency.get(from)?.push(to);
  }
  return adjacency;
}

function reachableFrom(adjacency: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const pending = [...(adjacency.get(start) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return seen;
}

/** 节点的 `retry_loop` 出边指向的节点：打回时要重做的起点。 */
export function reworkTargets(graph: WorkflowGraph, nodeId: string): string[] {
  const targets: string[] = [];
  for (const edge of graph.edges) {
    if (edge.type === "retry_loop" && edge.from_node === nodeId && !targets.includes(edge.to_node)) targets.push(edge.to_node);
  }
  return targets;
}

/** 一次打回最多允许的总轮数：取该节点各条 `retry_loop` 边的最小 `max_iterations`，没有写时与旧实现一样是 2。 */
export function reworkLimit(graph: WorkflowGraph, nodeId: string): number {
  const limits = graph.edges
    .filter((edge) => edge.type === "retry_loop" && edge.from_node === nodeId && typeof edge.max_iterations === "number")
    .map((edge) => edge.max_iterations as number);
  if (limits.length > 0) return Math.min(...limits);
  const own = graph.nodes.find((node) => node.node_id === nodeId)?.max_iterations;
  return typeof own === "number" && own > 0 ? own : 2;
}

/**
 * 一次打回要重做的节点：每个打回目标、打回节点本身，以及两者之间的向前路径上的节点
 * （目标的后代 ∩ 打回节点的祖先）。旧实现只重开目标与自己，目标与自己不相邻时中间节点会带着旧输出继续。
 */
export function reworkNodes(graph: WorkflowGraph, nodeId: string): string[] {
  const ancestors = reachableFrom(forwardAdjacency(graph, true), nodeId);
  const forward = forwardAdjacency(graph);
  const loop = new Set<string>([nodeId]);
  for (const target of reworkTargets(graph, nodeId)) {
    loop.add(target);
    for (const between of reachableFrom(forward, target)) {
      if (ancestors.has(between)) loop.add(between);
    }
  }
  return graph.nodes.map((node) => node.node_id).filter((id) => loop.has(id));
}

/** 节点的全部下游（沿 auto / conditional / approval 边，不含 `retry_loop`），按图的节点顺序。 */
export function descendantsOf(graph: WorkflowGraph, nodeId: string): string[] {
  const reachable = reachableFrom(forwardAdjacency(graph), nodeId);
  return graph.nodes.map((node) => node.node_id).filter((id) => reachable.has(id));
}
