/**
 * A 类（纯 TS）工具装配点。
 *
 * `createAppTools(deps)` 返回 40 个 pi-durable 工具；它们只依赖注入的端口：
 * 工作区文件系统、pi-durable 文档、记忆/技能目录、画布、外溢结果、MCP 目录、fetch 与飞书机器人。
 */

import type { AppTool, AppToolDeps } from "./types.ts";
import { createWorkspaceTools } from "./workspace/tools.ts";
import { createTaskTools } from "./tasks.ts";
import { createTeamTools } from "./teams.ts";
import { createChartTool } from "./charts.ts";
import { createProposalTools } from "./proposals.ts";
import { createInteractionTools } from "./interaction.ts";
import { createArtifactTool } from "./artifacts.ts";
import { createMemoryTools } from "./memory.ts";
import { createWebTools } from "./web.ts";
import { createDiagramTools } from "./diagram/tools.ts";
import { createFeishuTools } from "../../feishu/tools.ts";
import { defaultFeishuService } from "../../feishu/service.ts";

/** 40 个 A 类工具（本批全部实现；`load_feishu_bitable` 是 compute 侧的 B 类工具，不在这里）。 */
export const APP_TOOL_NAMES = [
  "workspace_status",
  "workspace_glob",
  "workspace_grep",
  "workspace_read_file",
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_delete_file",
  "workspace_move_file",
  "workspace_bash",
  "structured_output",
  "load_analysis_skill",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
  "team_create",
  "team_delete",
  "team_list",
  "team_status",
  "send_message",
  "team_plan_create",
  "select_chart",
  "propose_excel_export",
  "propose_report_outline",
  "propose_ppt_outline",
  "set_ppt_color_scheme",
  "propose_dashboard_outline",
  "ask_user",
  "browse_webpage",
  "read_tool_result",
  "search_mcp_tools",
  "plan_complete",
  "display_diagram",
  "edit_diagram",
  "get_diagram",
  "memory_read",
  "list_feishu_bitable_tables",
  "create_feishu_bitable",
  "append_feishu_bitable_records",
  "update_feishu_bitable_record",
] as const satisfies readonly string[];

export type AppToolName = (typeof APP_TOOL_NAMES)[number];

/** 新建 40 个工具壳；壳本身无状态，可以跨会话共用（状态在注入的端口里）。 */
export function createAppTools(deps: AppToolDeps): AppTool[] {
  const effective: AppToolDeps = deps.colorScheme === undefined
    ? { ...deps, colorScheme: { value: "mckinsey" } }
    : deps;
  const feishu = effective.feishu ?? defaultFeishuService();
  const tools = [
    ...createWorkspaceTools(effective),
    ...createTaskTools(effective),
    ...createTeamTools(effective),
    ...createChartTool(effective),
    ...createProposalTools(effective),
    ...createInteractionTools(effective),
    ...createArtifactTool(effective),
    ...createMemoryTools(effective),
    ...createWebTools(effective),
    ...createDiagramTools(effective),
    ...createFeishuTools({ connections: () => feishu.connections() }),
  ];
  const order = new Map<string, number>(APP_TOOL_NAMES.map((name, index) => [name, index]));
  return tools.sort((left, right) => (order.get(left.name) ?? 999) - (order.get(right.name) ?? 999));
}

export * from "./types.ts";
export * from "./docs.ts";
export * from "./workspace/fs.ts";
export * from "./workspace/tools.ts";
export * from "./tasks.ts";
export * from "./teams.ts";
export * from "./charts.ts";
export * from "./proposals.ts";
export * from "./interaction.ts";
export * from "./artifacts.ts";
export * from "./memory.ts";
export * from "./web.ts";
export * from "./diagram/canvas.ts";
export * from "./diagram/tools.ts";
