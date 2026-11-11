import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  buildTempPromptSection,
  getSystemPrompt,
  messageNeedsBrowserRules,
  messageNeedsChartRules,
  messageNeedsDiagramRules,
  messageNeedsHooksRules,
  messageNeedsIngestRules,
  messageNeedsWorkspaceRules,
  type PromptContext,
} from "./prompts.ts";
import type { TurnContext } from "./turn.ts";

/**
 * 由「本轮上下文 + 本次请求实际提供的工具」推导旧实现的 `PromptContext`。
 *
 * 旧代码用技能激活时声明的 `_requested_tools` 判断要不要挂工作区、图表、输出等提示块；新实现的等价物是
 * 「本次请求真的给了模型哪些工具」（`agent.tools`）。两者在多数情况下一致，差异是：新实现不会因为技能声明了
 * 但最终没暴露的工具而多挂提示块——这更贴近模型实际能力。技能的 `requestedTools` 仍会在工具暴露阶段生效
 * （见 tools/exposure.ts 的 `filterToolsForTurn`），所以提示块与工具集不会自相矛盾。
 */

/** 旧实现里会触发「输出」提示块的工具（propose 与 generate/export 成对出现）。 */
const OUTPUT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "propose_ppt_outline",
  "generate_ppt",
  "propose_report_outline",
  "export_report",
  "propose_excel_export",
  "export_excel",
  "propose_dashboard_outline",
  "generate_dashboard",
]);

/** 旧实现里会触发对应提示块的工具分组。 */
const WORKSPACE_TOOLS = ["workspace_status", "workspace_glob", "workspace_grep", "workspace_read_file"];
const CHART_TOOLS = ["select_chart", "generate_chart"];
const HOOKS_TOOLS = ["browse_webpage", "configure_hooks"];
const BROWSER_TOOLS = ["browser_search", "browser_navigate", "browser_click", "browser_fill", "browser_extract", "browser_screenshot"];
const INGEST_TOOLS = ["fetch_table", "browser_extract_tables"];
const DIAGRAM_TOOLS = ["display_diagram", "edit_diagram"];

/** 旧实现里 `_PROPOSE_CMDS`：这些命令本身就要走“先提案再生成”的流程。 */
const PROPOSE_COMMANDS: ReadonlySet<string> = new Set(["ppt", "ppt_revise", "export", "excel_revise", "report", "report_revise"]);

/** 旧实现里允许解锁图表类提示块的可信技能（`has_canvas_skill`）。 */
const CANVAS_SKILLS: ReadonlySet<string> = new Set(["business-model-canvas", "bcg-matrix", "swot-analysis", "value-proposition"]);

const hasAny = (names: ReadonlySet<string>, group: readonly string[]): boolean => group.some((name) => names.has(name));

export function promptContextFor(turn: TurnContext, offeredTools: readonly string[]): PromptContext {
  const offered = new Set(offeredTools);
  const message = turn.message;
  return {
    hasDataSource: turn.hasDataSource,
    sourceCount: turn.sourceCount,
    hasWorkspace: turn.hasWorkspace,
    needsWorkspace: hasAny(offered, WORKSPACE_TOOLS) || messageNeedsWorkspaceRules(message, { hasWorkspace: turn.hasWorkspace }),
    teamsEnabled: turn.teamsEnabled,
    activationKind: turn.activation.kind,
    activationName: turn.activation.name,
    needsChart: hasAny(offered, CHART_TOOLS) || messageNeedsChartRules(message),
    needsOutput: [...OUTPUT_TOOL_NAMES].some((name) => offered.has(name)) || (turn.command !== null && PROPOSE_COMMANDS.has(turn.command)),
    needsHooks: hasAny(offered, HOOKS_TOOLS) || messageNeedsHooksRules(message),
    needsBrowser: hasAny(offered, BROWSER_TOOLS) || messageNeedsBrowserRules(message),
    needsIngest: hasAny(offered, INGEST_TOOLS) || messageNeedsIngestRules(message),
    // 旧实现无条件挂知识库提示块（只声明能力，不读内容）：知识内容通过检索结果进入用户消息。
    hasKnowledge: true,
    hasUnnamedColumns: turn.hasUnnamedColumns,
    needsDiagram: hasAny(offered, DIAGRAM_TOOLS) || messageNeedsDiagramRules(message, { hasCanvasSkill: CANVAS_SKILLS.has(turn.activation.name) }),
    skillCatalog: turn.skillCatalog,
  };
}

/** 系统提示正文：静态块（按本轮能力裁剪）+ 会话临时指令。 */
export function renderSystemPrompt(turn: TurnContext, offeredTools: readonly ToolRegistration[] | readonly string[]): string {
  const names = (offeredTools as readonly (ToolRegistration | string)[]).map((tool) => (typeof tool === "string" ? tool : tool.name));
  const prompt = getSystemPrompt(promptContextFor(turn, names));
  return prompt + buildTempPromptSection(turn.tempPrompt) + (turn.workspaceSection ?? "");
}
