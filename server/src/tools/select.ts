import type { ToolRegistration } from "@earendil-works/pi-durable";
import { messageNeedsChartRules } from "../agent/prompts.ts";
import {
  type ActivationContext,
  filterToolsForStage,
  filterToolsForTurn,
  inferWorkflowStage,
  limitToolsForTurn,
  MAX_VISIBLE_TOOLS,
  type ToolSchema,
  toolName,
} from "./exposure.ts";

/**
 * 把「全部可用工具 + 本轮证据」收敛成本轮要交给模型的工具集。
 *
 * 顺序与旧实现一致：先按命令/技能/数据源暴露范围过滤，再按工作流阶段裁剪，最后按上限截断。
 * 三处算法各自带 golden 对照（`server/test/exposure.test.ts`），这里只负责把它们串起来并映射回
 * pi-durable 的工具对象——`configure({ modelTools })` 需要对象本身，而不是名字。
 */
export type TurnToolInput = {
  /** 本轮用户消息，用于关键词发现与意图匹配。 */
  userMessage: string;
  /** 斜杠命令名（不含 `/`）。 */
  command?: string;
  activation?: ActivationContext | null;
  /** 技能声明的允许工具集；空集表示不限制（技能只能收窄，不能扩大）。 */
  skillAllowedTools?: ReadonlySet<string> | null;
  /** 可信的内置技能名，用于解锁提案类工具。 */
  trustedSkill?: string;
  hasDataSource: boolean;
  hasWorkspace: boolean;
  teamsEnabled: boolean;
  /** 跨轮保留的发现结果（exposure.ts 的 TTL 状态）。 */
  discoveredTools?: readonly string[];
  /** 本轮之前已经调用过的工具名，用于推断工作流阶段。 */
  completedTools?: readonly string[];
  /** 本轮是否要出图（默认按消息关键词判定）；显式传入可覆盖。 */
  needsChart?: boolean;
  /** 本轮是否要出报表/导出类产物。 */
  needsOutput?: boolean;
  /** 未超长时不再截断，显式指定的工具（命令/技能要求）永远保留。 */
  requiredTools?: ReadonlySet<string> | null;
  includeMcp?: boolean;
  allowedMcpTools?: Iterable<string> | null;
  /** 宿主有工作流目录：工作流工具不要求挂载工作区（见 `FilterToolsOptions.workflowsAvailable`）。 */
  workflowsAvailable?: boolean;
  maxTools?: number | null;
};

/** 仅暴露名字的形式，给只读工具名的算法（exposure.ts）用。 */
const asSchemas = (tools: readonly ToolRegistration[]): ToolSchema[] => tools.map((tool) => ({ function: { name: tool.name } }));

export function toolsForTurn(allTools: readonly ToolRegistration[], input: TurnToolInput): ToolRegistration[] {
  const schemas = asSchemas(allTools);
  const exposed = filterToolsForTurn(schemas, {
    command: input.command,
    activation: input.activation ?? null,
    skillAllowedTools: input.skillAllowedTools ?? null,
    trustedSkill: input.trustedSkill,
    userMessage: input.userMessage,
    discoveredTools: input.discoveredTools ?? null,
    hasDataSource: input.hasDataSource,
    hasWorkspace: input.hasWorkspace,
    workflowsAvailable: input.workflowsAvailable,
    teamsEnabled: input.teamsEnabled,
    includeMcp: input.includeMcp,
    allowedMcpTools: input.allowedMcpTools ?? null,
  });

  // 阶段只由「已经完成的工具调用」推断：同一轮里模型后续请求会看到更窄的集合，和旧实现一致。
  // 图/报表意图来自本轮用户消息（旧实现 `message_needs_chart_rules`）：不传的话，模型永远拿不到
  // `generate_chart` 这类工具——它会直接回答「可视化工具未连接」。
  const needsChart = input.needsChart ?? messageNeedsChartRules(input.userMessage);
  const stage = inferWorkflowStage({
    activation: input.activation ?? null,
    userMessage: input.userMessage,
    hasDataSource: input.hasDataSource,
    needsChart,
    needsOutput: input.needsOutput,
    completedTools: input.completedTools ?? [],
  });
  const staged = filterToolsForStage(exposed, stage);
  const limited = limitToolsForTurn(staged, {
    userMessage: input.userMessage,
    recentDiscoveredTools: input.discoveredTools ?? null,
    command: input.command,
    trustedSkill: input.trustedSkill,
    requiredTools: input.requiredTools ?? null,
    maxTools: input.maxTools ?? MAX_VISIBLE_TOOLS,
  });

  const keep = new Set(limited.map(toolName));
  return allTools.filter((tool) => keep.has(tool.name));
}
