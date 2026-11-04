/**
 * Dynamic tool exposure for each conversation turn (port of `agent/tools/exposure.py`, plus the
 * workflow-stage gate from `agent/workflow_stage.py` and the artifact-reader scope from
 * `agent/agent.py::_scope_tool_result_reader`).
 *
 * The pipeline is ordered and each stage can only shrink the previous one:
 *
 *   schemas -> filterToolsForTurn (command / skill / data / workspace / teams / discovery)
 *           -> filterToolsForStage (workflow stage)
 *           -> scopeToolResultReader (read_tool_result needs a real `tr_*` artifact)
 *           -> limitToolsForTurn (MAX_VISIBLE_TOOLS cap with deterministic priority)
 *
 * Input order is preserved everywhere so prompt caching stays stable. Python truthiness is load
 * bearing: an empty `skillAllowedTools` set means "no restriction", not "allow nothing".
 */
import { PY_SPACE, pyCompare, pyStr, pyStrip } from "../agent/py-compat.ts";
import { messageNeedsKnowledge } from "../agent/prompts.ts";
import { BUILTIN_TOOL_REGISTRY, type ToolSpec } from "./registry.ts";

export const MAX_VISIBLE_TOOLS = 20;

/** Built-in discoveries stay effective for this many user turns (`data/session.py`). */
export const DISCOVERED_TOOL_TTL_TURNS = 3;
/** LRU bound on the flattened discovery view (`data/session.py`). */
export const MAX_ACTIVE_DISCOVERED_TOOLS = 20;

/** A prompt-facing OpenAI-style function schema; only `function.name` is read here. */
export interface ToolSchema {
  type?: string;
  function: {
    name: string;
    parameters?: { properties?: Record<string, unknown>; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ActivationContext {
  readonly skillName?: string;
  readonly commandName?: string;
  readonly internalAction?: string;
}

const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`);

export function toolName(schema: ToolSchema): string {
  return (schema.function?.name ?? "").trim();
}

function normalizeDiscoveryText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replaceAll("_", " ")
    .split(PY_SPACE_RUN)
    .filter((part) => part !== "")
    .join(" ");
}

const READ_ACTION_RE = /(查看|读取|打开|读一下|看一下|看下|看看|read|open|view)/iu;
const FILE_OBJECT_RE = /(说明(?:文件|文档)?|文件|文档|资料|正文|内容|file|document|doc(?:x)?|txt|md)/iu;
// Python `\b` is Unicode-aware (it treats CJK letters as word characters), JS `\b` is ASCII-only.
const DOCUMENT_SUFFIX_RE = /\.(?:docx?|txt|md)(?![\p{L}\p{N}_])/iu;
const WEB_CONTEXT_RE = new RegExp(`(https?://|网页|网站|浏览器|website|web[${PY_SPACE}]*page|browser)`, "iu");
const WORKSPACE_CONTEXT_RE = /(工作区|工作目录|本地|文件|目录|file|folder|workspace|workdir|grep)/iu;
const STRONG_DIAGRAM_RE = new RegExp(
  `(商业模式画布|价值主张画布|bcg[${PY_SPACE}]*矩阵|swot|四象限|draw\\.?io|diagram|` +
    `画布|框架图|战略图|形状库|shape[${PY_SPACE}]*library)`,
  "iu",
);

export const TEAM_TOOLS: ReadonlySet<string> = new Set([
  "team_create", "team_delete", "team_list", "team_status", "send_message",
  "agent_delegate", "team_plan_create", "team_delegate",
]);
export const TASK_TOOLS: ReadonlySet<string> = new Set(["task_create", "task_get", "task_list", "task_update"]);
export const WORKFLOW_TOOLS: ReadonlySet<string> = new Set([
  "workflow_create", "workflow_create_custom", "workflow_list", "workflow_start", "workflow_status",
]);
export const FEISHU_TOOLS: ReadonlySet<string> = new Set([
  "create_feishu_bitable", "list_feishu_bitable_tables",
  "load_feishu_bitable", "append_feishu_bitable_records",
  "update_feishu_bitable_record",
]);

const DIAGRAM_TOOLS: ReadonlySet<string> = new Set(["display_diagram", "edit_diagram", "get_diagram"]);

export function looksLikeWorkspaceFileReadRequest(query: string): boolean {
  const text = String(query ?? "");
  if (!pyStrip(text)) return false;
  if (DOCUMENT_SUFFIX_RE.test(text)) return true;
  return READ_ACTION_RE.test(text) && FILE_OBJECT_RE.test(text);
}

/** Return discoverable built-in tools mentioned by the user query. */
export function discoverToolNamesForQuery(query: string): Set<string> {
  const haystack = normalizeDiscoveryText(query);
  if (!haystack) return new Set();
  const discovered = new Set<string>();
  if (looksLikeWorkspaceFileReadRequest(query)) discovered.add("workspace_read_file");
  const raw = String(query ?? "").toLowerCase();
  for (const spec of BUILTIN_TOOL_REGISTRY.all()) {
    if (!spec.discoverable) continue;
    for (const term of spec.discoveryTerms) {
      const termText = pyStrip(term);
      if (!termText) continue;
      const normalizedTerm = normalizeDiscoveryText(termText);
      if (normalizedTerm && haystack.includes(normalizedTerm)) {
        discovered.add(spec.name);
        break;
      }
      if (raw.includes(termText.toLowerCase())) {
        discovered.add(spec.name);
        break;
      }
    }
  }

  // Resolve broad lexical collisions after candidate discovery. Capability
  // context wins over generic words such as "搜索", "打开", and "图表".
  if (WORKSPACE_CONTEXT_RE.test(raw) && !WEB_CONTEXT_RE.test(raw)) {
    discovered.delete("browser_search");
    discovered.delete("browser_navigate");
    if (/(修改|编辑|替换|edit|patch)/iu.test(raw)) discovered.add("workspace_edit_file");
    if (/(删除|移除|delete|remove|(?<![\p{L}\p{N}_])rm(?![\p{L}\p{N}_]))/iu.test(raw)) discovered.add("workspace_delete_file");
    if (/(移动|重命名|move|rename)/iu.test(raw)) discovered.add("workspace_move_file");
    if (/(新建|创建|写入|保存|create|write|save)/iu.test(raw)) discovered.add("workspace_write_file");
  }
  if (WEB_CONTEXT_RE.test(raw) && !WORKSPACE_CONTEXT_RE.test(raw)) {
    discovered.delete("workspace_glob");
    discovered.delete("workspace_grep");
    discovered.delete("workspace_read_file");
  }
  if (discovered.has("browse_webpage") && discovered.has("browser_navigate")) {
    if (/(读取|分析|总结|配置|文档|接口|read|analy[sz]|summari[sz]|config|docs?)/iu.test(raw)) {
      discovered.delete("browser_navigate");
    } else if (new RegExp(`(打开|访问|跳转|navigate|go[${PY_SPACE}]+to|浏览器)`, "iu").test(raw)) {
      discovered.delete("browse_webpage");
    } else {
      discovered.delete("browser_navigate");
    }
  }

  if (!STRONG_DIAGRAM_RE.test(raw)) {
    for (const name of DIAGRAM_TOOLS) discovered.delete(name);
  } else if ([...DIAGRAM_TOOLS].some((name) => discovered.has(name))) {
    for (const name of DIAGRAM_TOOLS) discovered.delete(name);
    if (/(修改|编辑|调整|edit|update)/iu.test(raw)) {
      discovered.add("get_diagram");
      discovered.add("edit_diagram");
    } else if (/(查看|读取|获取|view|get|read)/iu.test(raw)) {
      discovered.add("get_diagram");
    } else {
      discovered.add("display_diagram");
    }
  }

  // CRUD families should expose the requested action, not every tool sharing
  // the family noun. Teams mode remains an authorization gate in
  // `filterToolsForTurn`.
  if ([...TEAM_TOOLS].some((name) => discovered.has(name))) {
    if (/(删除|移除|delete|remove).{0,12}(团队|team)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("team_delete");
      discovered.add("team_status");
    } else if (/(查看|查询|状态|status).{0,12}(团队|team)|(团队|team).{0,12}(状态|status)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("team_status");
    } else if (/(列出|列表|有哪些|list).{0,12}(团队|team)|(团队|team).{0,12}(列表|list)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("team_list");
    } else if (/(发送|发消息|send|message|mailbox|收件箱)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("send_message");
    } else if (new RegExp(`(并行|并发|批量|parallel|team[${PY_SPACE}]*delegate)`, "iu").test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("team_delegate");
    } else if (/(委派|子任务|delegate)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("agent_delegate");
    } else if (/(创建|新建|create).{0,12}(团队|team)|(团队|team).{0,12}(创建|新建|create)/iu.test(raw)) {
      for (const name of TEAM_TOOLS) discovered.delete(name);
      discovered.add("team_create");
    }
  }

  if ([...TASK_TOOLS].some((name) => discovered.has(name))) {
    for (const name of TASK_TOOLS) discovered.delete(name);
    if (/(创建|新建|添加|create|add)/iu.test(raw)) discovered.add("task_create");
    else if (/(更新|完成|修改|update|complete)/iu.test(raw)) discovered.add("task_update");
    else if (new RegExp(`(详情|查看.{0,8}任务|task[${PY_SPACE}]*detail)`, "iu").test(raw)) discovered.add("task_get");
    else discovered.add("task_list");
  }

  if ([...WORKFLOW_TOOLS].some((name) => discovered.has(name))) {
    for (const name of WORKFLOW_TOOLS) discovered.delete(name);
    if (/(状态|进度|status|progress)/iu.test(raw)) discovered.add("workflow_status");
    else if (/(运行|启动|执行|run|start)/iu.test(raw)) discovered.add("workflow_start");
    else if (/(创建|新建|create)/iu.test(raw)) {
      discovered.add(new RegExp(`(自定义|custom|agent[${PY_SPACE}]*workflow)`, "iu").test(raw) ? "workflow_create_custom" : "workflow_create");
    } else discovered.add("workflow_list");
  }

  if ([...FEISHU_TOOLS].some((name) => discovered.has(name))) {
    for (const name of FEISHU_TOOLS) discovered.delete(name);
    if (/(创建|新建|create)/iu.test(raw)) discovered.add("create_feishu_bitable");
    else if (/(追加|写入|回写|append)/iu.test(raw)) discovered.add("append_feishu_bitable_records");
    else if (/(更新|编辑|修改|update)/iu.test(raw)) discovered.add("update_feishu_bitable_record");
    else if (/(表格列表|数据表|tables?|list)/iu.test(raw)) discovered.add("list_feishu_bitable_tables");
    else discovered.add("load_feishu_bitable");
  }
  return discovered;
}

export interface FilterToolsOptions {
  command?: string;
  activation?: ActivationContext | null;
  /** Empty (or omitted) means no restriction: a Skill can only reduce an authorized set. */
  skillAllowedTools?: ReadonlySet<string> | null;
  trustedSkill?: string;
  userMessage?: string;
  discoveredTools?: Iterable<string> | null;
  hasDataSource?: boolean;
  hasWorkspace?: boolean;
  teamsEnabled?: boolean;
  includeMcp?: boolean;
  allowedMcpTools?: Iterable<string> | null;
}

/** Return only tools useful for the current turn. */
export function filterToolsForTurn(tools: readonly ToolSchema[], options: FilterToolsOptions = {}): ToolSchema[] {
  const policyCommand = options.activation
    ? options.activation.commandName || options.activation.internalAction || ""
    : options.command || "";
  const trustedSkill = options.trustedSkill ?? "";
  const discovered = new Set(options.discoveredTools ?? []);
  if (!policyCommand && !trustedSkill) {
    for (const name of discoverToolNamesForQuery(options.userMessage ?? "")) discovered.add(name);
  }
  const allowed = BUILTIN_TOOL_REGISTRY.exposedNames({
    command: policyCommand,
    hasDataSource: options.hasDataSource === true,
    hasWorkspace: options.hasWorkspace === true,
    skill: trustedSkill,
    discoveredTools: discovered,
  });
  if (options.teamsEnabled !== true) {
    for (const name of TEAM_TOOLS) allowed.delete(name);
  } else if (options.hasWorkspace === true) {
    // Teams mode authorizes coordination but does not expose every CRUD
    // action on every turn.
    allowed.add("team_status");
    allowed.add("agent_delegate");
    allowed.add("team_delegate");
  }
  const restriction =
    options.skillAllowedTools !== null && options.skillAllowedTools !== undefined && options.skillAllowedTools.size > 0
      ? options.skillAllowedTools
      : null;
  if (restriction) {
    for (const name of allowed) {
      if (!restriction.has(name)) allowed.delete(name);
    }
  }
  const selectedMcp = new Set(options.allowedMcpTools ?? []);

  const filtered: ToolSchema[] = [];
  for (const schema of tools) {
    const name = toolName(schema);
    if (!name) continue;
    if (name.startsWith("mcp__")) {
      if (
        options.includeMcp !== false &&
        selectedMcp.has(name) &&
        (!restriction || restriction.has(name))
      ) {
        filtered.push(schema);
      }
      continue;
    }
    if (allowed.has(name)) filtered.push(schema);
  }

  // Copy so callers can safely tweak descriptions later without mutating the global schema list.
  return structuredClone(filtered);
}

// ── Workflow stage (agent/workflow_stage.py) ────────────────────────────────────────────────────

export const STAGES = [
  "general", "understand", "inspect", "analyze", "visualize", "propose_output", "generate_output", "verify",
] as const;
export type WorkflowStage = (typeof STAGES)[number];

const ALWAYS_AVAILABLE: ReadonlySet<string> = new Set([
  "ask_user",
  "workspace_status",
  "workspace_glob",
  "workspace_grep",
  "workspace_read_file",
  "read_tool_result",
  "search_mcp_tools",
  "browse_webpage",
  "configure_hooks",
  "browser_search",
  "browser_navigate",
  "browser_click",
  "browser_fill",
  "browser_extract",
  "browser_extract_tables",
  "browser_screenshot",
  "browser_close",
  "fetch_table",
  "team_create",
  "team_delete",
  "team_list",
  "team_status",
  "send_message",
  "agent_delegate",
  "team_plan_create",
  "team_delegate",
  "workflow_create",
  "workflow_create_custom",
  "workflow_list",
  "workflow_start",
  "workflow_status",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_move_file",
  "workspace_bash",
  "create_feishu_bitable",
  "list_feishu_bitable_tables",
  "load_feishu_bitable",
  "append_feishu_bitable_records",
  "update_feishu_bitable_record",
  "load_analysis_skill",
  "memory_read",
  "set_ppt_color_scheme",
  "structured_output",
  "plan_complete",
  "display_diagram",
  "edit_diagram",
  "get_diagram",
]);

const INSPECT_TOOLS: ReadonlySet<string> = new Set([
  "query_knowledge",
  "get_schema",
  "get_table_detail",
  // Providers that emit schema + query in one valid batch must not pay an avoidable extra round trip.
  "query_data",
  "profile_data",
]);

const ANALYZE_TOOLS: ReadonlySet<string> = new Set([
  "get_schema",
  "get_table_detail",
  "query_data",
  "create_analysis_table",
  "delete_analysis_tables",
  "run_analysis",
  "profile_data",
  "clean_data",
]);

const CHART_TOOLS: ReadonlySet<string> = new Set(["select_chart", "generate_chart"]);

const PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  "propose_ppt_outline",
  "propose_report_outline",
  "propose_excel_export",
  "propose_dashboard_outline",
  "set_ppt_color_scheme",
]);

const GENERATION_TOOLS: ReadonlySet<string> = new Set([
  "generate_ppt", "export_report", "export_excel", "generate_dashboard",
]);

export interface WorkflowStageContext {
  readonly stage: WorkflowStage;
  readonly needsChart?: boolean;
  readonly needsOutput?: boolean;
}

/** Tool names from assistant calls, without reading result bodies. */
export function completedToolNames(messages: readonly { role?: string; tool_calls?: readonly { function?: { name?: string } | null }[] }[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      const name = (call.function?.name ?? "").trim();
      if (name) names.add(name);
    }
  }
  return names;
}

export interface InferWorkflowStageInput {
  activation?: ActivationContext | null;
  userMessage?: string;
  hasDataSource?: boolean;
  needsChart?: boolean;
  needsOutput?: boolean;
  completedTools?: Iterable<string>;
}

/** Infer a conservative stage from immutable turn evidence. */
export function inferWorkflowStage(input: InferWorkflowStageInput): Required<WorkflowStageContext> {
  const done = new Set(input.completedTools ?? []);
  const activation = input.activation ?? {};
  const action = activation.internalAction ?? "";
  const kind = activation.skillName ? "skill" : activation.commandName ? "command" : activation.internalAction ? "internal_action" : "none";
  const needsChart = input.needsChart === true;
  const needsOutput = input.needsOutput === true;
  const has = (names: ReadonlySet<string>): boolean => names.size > 0 && [...done].some((name) => names.has(name));
  const context = (stage: WorkflowStage, chart: boolean, output: boolean): Required<WorkflowStageContext> => ({
    stage,
    needsChart: chart,
    needsOutput: output,
  });
  if (action.endsWith("_confirm")) return context("generate_output", needsChart, true);
  if (has(GENERATION_TOOLS)) return context("verify", needsChart, needsOutput);
  if (has(PROPOSAL_TOOLS)) return context("propose_output", needsChart, true);
  if (needsChart && ["query_data", "run_analysis", "create_analysis_table"].some((name) => done.has(name))) {
    return context("visualize", true, needsOutput);
  }
  if (["get_schema", "get_table_detail", "query_data", "run_analysis"].some((name) => done.has(name))) {
    return context("analyze", needsChart, needsOutput);
  }
  if (
    input.hasDataSource === true &&
    (messageNeedsKnowledge(input.userMessage ?? "") || kind === "skill" || kind === "command" || needsChart || needsOutput)
  ) {
    return context("inspect", needsChart, needsOutput);
  }
  if (needsOutput) return context("propose_output", needsChart, true);
  return context("general", needsChart, needsOutput);
}

/** Remove schemas that cannot be useful in the current workflow stage. */
export function filterToolsForStage(tools: readonly ToolSchema[], context: WorkflowStageContext): ToolSchema[] {
  if (context.stage === "general" || context.stage === "verify") return [...tools];

  const allowed = new Set(ALWAYS_AVAILABLE);
  const add = (names: ReadonlySet<string>): void => {
    for (const name of names) allowed.add(name);
  };
  if (context.stage === "understand" || context.stage === "inspect") {
    add(INSPECT_TOOLS);
  } else if (context.stage === "analyze") {
    add(ANALYZE_TOOLS);
    if (context.needsChart) add(CHART_TOOLS);
    if (context.needsOutput) add(PROPOSAL_TOOLS);
  } else if (context.stage === "visualize") {
    add(ANALYZE_TOOLS);
    add(CHART_TOOLS);
    if (context.needsOutput) add(PROPOSAL_TOOLS);
  } else if (context.stage === "propose_output") {
    add(ANALYZE_TOOLS);
    add(CHART_TOOLS);
    add(PROPOSAL_TOOLS);
  } else if (context.stage === "generate_output") {
    add(GENERATION_TOOLS);
  }

  if (context.needsChart) {
    // A chart request is already served by the built-in chart registry and renderer.
    add(CHART_TOOLS);
    allowed.delete("search_mcp_tools");
  }

  return tools.filter((schema) => toolName(schema).startsWith("mcp__") || allowed.has(toolName(schema)));
}

/** Hide the artifact reader until `tr_*` artifacts exist, then enum-scope its input. */
export function scopeToolResultReader(
  tools: readonly ToolSchema[],
  allowedArtifacts: readonly { artifact_id?: string }[] | null | undefined,
): ToolSchema[] {
  const artifactIds = [
    ...new Set(
      (allowedArtifacts ?? [])
        .map((item) => String(item.artifact_id ?? ""))
        .filter((id) => id.startsWith("tr_")),
    ),
  ];
  const scoped: ToolSchema[] = [];
  for (const schema of tools) {
    if (toolName(schema) !== "read_tool_result") {
      scoped.push(schema);
      continue;
    }
    if (artifactIds.length === 0) continue;
    const clone = structuredClone(schema);
    const parameters = (clone.function.parameters ??= {});
    const properties = (parameters.properties ??= {});
    const artifactParam = (properties.artifact_id ??= {}) as Record<string, unknown>;
    artifactParam.enum = artifactIds.slice(-20);
    scoped.push(clone);
  }
  return scoped;
}

// ── Visibility cap (agent/tools/exposure.py::limit_tools_for_turn) ──────────────────────────────

export const ESSENTIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ask_user", "workspace_status", "read_tool_result", "search_mcp_tools",
  "query_knowledge", "get_schema", "query_data", "load_analysis_skill",
]);

export interface LimitToolsOptions {
  userMessage?: string;
  recentDiscoveredTools?: readonly string[] | null;
  command?: string;
  trustedSkill?: string;
  requiredTools?: ReadonlySet<string> | null;
  maxTools?: number | null;
}

/**
 * Apply a deterministic hard cap after all exposure/stage gates.
 *
 * Explicit command/Skill requirements, MCP selections and current-turn intent outrank older
 * discoveries. Returned schemas retain their canonical input order for stable prompt caching.
 */
export function limitToolsForTurn(tools: readonly ToolSchema[], options: LimitToolsOptions = {}): ToolSchema[] {
  const bounded = Math.max(1, Math.trunc(options.maxTools || MAX_VISIBLE_TOOLS));
  if (tools.length <= bounded) return [...tools];

  const current = discoverToolNamesForQuery(options.userMessage ?? "");
  const recentRank = new Map<string, number>();
  (options.recentDiscoveredTools ?? []).forEach((name, index) => recentRank.set(name, index));
  const required = options.requiredTools ?? new Set<string>();
  const command = options.command ?? "";
  const trustedSkill = options.trustedSkill ?? "";

  const ranked = tools.map((schema, index) => {
    const name = toolName(schema);
    const spec: ToolSpec | undefined = BUILTIN_TOOL_REGISTRY.get(name);
    let score: number;
    if (required.has(name)) score = 1_000;
    else if (name.startsWith("mcp__")) score = 900;
    else if (spec && (spec.commands.has(command) || spec.skills.has(trustedSkill))) score = 850;
    else if (current.has(name)) score = 800;
    else if (ESSENTIAL_TOOL_NAMES.has(name)) score = 750;
    else if (recentRank.has(name)) score = 700 + recentRank.get(name)!;
    else if (spec && spec.defaultExposed) score = 500;
    else score = 100;
    return { score, index, name };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index || pyCompare(b.name, a.name));

  const selected = new Set(ranked.slice(0, bounded).map((item) => item.name));
  return tools.filter((schema) => selected.has(toolName(schema)));
}

// ── Discovery persistence (data/session.py) ─────────────────────────────────────────────────────

export interface DiscoveredToolState {
  /** Flattened LRU view, most recent last. */
  readonly discovered: readonly string[];
  /** Per-turn discovery, oldest first, at most DISCOVERED_TOOL_TTL_TURNS entries. */
  readonly turns: readonly (readonly string[])[];
}

function flattenTurns(turns: readonly (readonly string[])[]): string[] {
  const active: string[] = [];
  for (const turn of turns) {
    for (const name of turn) {
      const previous = active.indexOf(name);
      if (previous >= 0) active.splice(previous, 1);
      active.push(name);
    }
  }
  return active.slice(-MAX_ACTIVE_DISCOVERED_TOOLS);
}

/**
 * `SessionState.record_discovered_tools`: every user turn advances the three-turn TTL. Explicit
 * commands/Skills pass an empty message so they record an empty discovery turn.
 */
export function recordDiscoveredToolTurn(
  state: DiscoveredToolState,
  message: string,
): { state: DiscoveredToolState; added: string[] } {
  const discovered = [...discoverToolNamesForQuery(message)].sort(pyCompare);
  const previous = new Set(state.discovered);
  const turns = state.turns.slice(-(DISCOVERED_TOOL_TTL_TURNS - 1)).map((turn) => [...turn]);
  turns.push(discovered);
  const nextTurns = turns.slice(-DISCOVERED_TOOL_TTL_TURNS);
  return {
    state: { discovered: flattenTurns(nextTurns), turns: nextTurns },
    added: discovered.filter((name) => !previous.has(name)),
  };
}

/** `SessionState` load: prefer per-turn history, fall back to the legacy flattened list. */
export function restoreDiscoveredToolState(
  rawTurns: readonly unknown[] | null | undefined,
  legacyDiscovered: readonly unknown[] | null | undefined,
): DiscoveredToolState {
  const turns: string[][] = [];
  if ((rawTurns ?? []).length > 0) {
    for (const turn of (rawTurns ?? []).slice(-DISCOVERED_TOOL_TTL_TURNS)) {
      if (!Array.isArray(turn)) continue;
      turns.push(turn.map((name) => pyStr(name)).filter((name) => name !== ""));
    }
  } else {
    const legacy = (legacyDiscovered ?? []).map((name) => pyStr(name)).filter((name) => name !== "");
    if (legacy.length > 0) turns.push(legacy.slice(-MAX_ACTIVE_DISCOVERED_TOOLS));
  }
  return { discovered: flattenTurns(turns), turns };
}
