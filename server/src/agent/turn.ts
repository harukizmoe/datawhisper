import { defineDoc } from "@earendil-works/pi-durable";

/**
 * 当前轮次的上下文，供系统提示的 section 在没有用户消息参数的情况下读取。
 *
 * pi-durable 的 section 只在「发请求前」渲染，渲染时拿不到本轮用户消息；而旧实现的系统提示是按轮决定的
 * （意图匹配器、斜杠命令、skills、是否有数据源）。因此提交时把这一轮的判定依据写成会话文档，section 渲染时
 * 读它。它的值在每次 submit 时整体覆盖，`history: "latest"` + `fork: "current"` 因此足够：分支会继承现值。
 */
export type TurnContext = {
  /** 本轮用户消息原文（意图匹配器用它决定挂哪些提示块）。 */
  message: string;
  /** 斜杠命令名；没有则为 null。 */
  command: string | null;
  /** 来源：普通对话、按命令、按技能。技能名同时是输出类工具的解锁令牌。 */
  activation: { kind: "none" | "command" | "skill"; name: string };
  /** 是否已有可用数据源，以及数量（多源提示块按数量决定）。 */
  hasDataSource: boolean;
  sourceCount: number;
  hasWorkspace: boolean;
  /** 合并 schema 里有无名列（`col`、`col_1`）时挂对应提示块。 */
  hasUnnamedColumns: boolean;
  teamsEnabled: boolean;
  /** 已检索到的技能目录文本（旧实现的 SKILL_CATALOG_RULES 内容）；为空则不挂该块。 */
  skillCatalog: string;
  /** 本会话临时指令（旧实现的 temp_prompt），按 build_temp_prompt_section 包装后附在末尾。 */
  tempPrompt: string;
  /** 最近三轮的发现结果，越新越靠后（旧实现 `data/session.py` 的 3 轮 TTL）。 */
  discoveryTurns: string[][];
  /** 由 `discoveryTurns` 展平得到的当前有效发现集合，最常用的形式。 */
  discoveredTools: string[];
  /** 本轮序号，从 0 递增；每轮 submit 加一。 */
  turn: number;
};

export const EMPTY_TURN_CONTEXT: TurnContext = {
  message: "",
  command: null,
  activation: { kind: "none", name: "" },
  hasDataSource: false,
  sourceCount: 0,
  hasWorkspace: false,
  hasUnnamedColumns: false,
  teamsEnabled: false,
  skillCatalog: "",
  tempPrompt: "",
  discoveryTurns: [],
  discoveredTools: [],
  turn: 0,
};

export const TurnDoc = defineDoc<TurnContext>({
  kind: "dw.turn",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ ...EMPTY_TURN_CONTEXT }),
  // 每轮只写一次，没有增量可累积，不需要打基线检查点。
  checkpointWhen: () => false,
});
