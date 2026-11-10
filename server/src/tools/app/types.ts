/**
 * A 类（纯 TS）工具的公共契约：依赖注入面、details 形状与结果整形。
 *
 * 这 36 个工具只依赖宿主注入的几个端口：
 * - `WorkspaceFs`：工作区文件系统（根目录、越界检查、读写编辑移动删除、glob/grep）。
 * - `AppDocHost`：pi-durable 文档（任务板、团队、动态计划）的事务读写。
 * - 其余都是小端口：记忆目录、技能目录、画布存储、外溢结果、MCP 目录、fetch。
 *
 * 所有端口都由参数传入，工具模块不读 `~`、不读环境变量、不直接碰 `server/src/{service,app,…}`。
 */

import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ConversationDocToken,
  type JsonObject,
  type ToolControl,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { WorkspaceFs } from "./workspace/fs.ts";
import type { PlanStoreDoc, PlanUsage, TaskBoardDoc, TeamMember, TeamStoreDoc } from "./docs.ts";
import type { MemoryDirs } from "../../agent/memory.ts";
import type { SkillDirs } from "../../agent/skills.ts";
import type { CanvasStore } from "./diagram/canvas.ts";
import type { ToolResultArtifactSource } from "./artifacts.ts";
import type { McpCatalogReader } from "./mcp.ts";
import type { FeishuService } from "../../feishu/service.ts";

/** 工具失败时抛出的错误；`message` 一律沿用旧 Python 实现的原话。 */
export class AppToolError extends Error {}

/** details 必须是可 JSON 序列化的值；失败时带 `error`。 */
export type AppToolDetails = Readonly<Record<string, JsonValue>>;

/** `defineTool` 返回的注册项；details 比默认 `JsonValue` 更具体。 */
export type AppTool = ToolRegistration<object, AppToolDetails>;

/**
 * 工作区文件系统的结构化结果。字段名与 Python 返回值一致，避免模型看到两套名字。
 */
export type AppToolDeps = {
  /** 工作区文件系统。必填：文件类工具与 workspace_status 都依赖它。 */
  readonly workspace: WorkspaceFs;
  /**
   * 任务板/团队/动态计划文档的宿主。
   *
   * 文档是**会话级**的（每个会话一份任务板/团队表），所以这里按调用传入的执行上下文现取，
   * 而不是在装配时固定一份：一套工具对象要服务所有会话。测试可以返回 `createMemoryDocHost()`。
   * 省略时这些工具返回“no workspace is mounted…”风格的错误。
   */
  readonly docs?: (api: ToolExecutionApi<AppToolDetails>) => AppDocHosts;
  /** 长期记忆目录（user 作用域与 workspace 作用域）；省略时 memory_read 返回不可用文案。 */
  readonly memoryDirs?: MemoryDirs;
  /** 技能目录；省略时 load_analysis_skill 返回未知技能文案。 */
  readonly skillDirs?: SkillDirs;
  /** 已注册工具名集合，供技能激活时校验 allowed_tools；省略时取内置注册表。 */
  readonly knownToolNames?: ReadonlySet<string>;
  /** draw.io 画布存储；省略时 diagram 工具返回存储不可用。 */
  readonly canvas?: CanvasStore;
  /** 本仓库自带的 draw.io 形状库目录（`data/shape_libs`）。 */
  readonly shapeLibsDir?: string;
  /** 外溢工具结果的读取源（`tr_<id>`）。 */
  readonly artifacts?: ToolResultArtifactSource;
  /** 团队成员委托的执行端口；省略时 `team_delegate` 返回能力不可用。 */
  readonly teamDelegate?: TeamDelegationPort;
  /** MCP 工具目录读取端。 */
  readonly mcpCatalog?: McpCatalogReader;
  /** browse_webpage 使用的 fetch 实现；测试可注入。 */
  readonly fetch?: typeof fetch;
  /** 会话身份，写入文档/画布时使用。 */
  readonly sessionId: string;
  readonly workspaceId?: string;
  /** 会话级配色偏好；`set_ppt_color_scheme` 就地更新它，图表/PPT 读取。 */
  readonly colorScheme?: { value: string };
  /** 时钟；测试可固定，避免真实计时器。 */
  readonly now?: () => Date;
  /**
   * 飞书机器人的配置、凭据与幂等账本。省略时用 `defaultFeishuService()`（按 `DW_DATA_DIR`
   * 的默认数据目录取单例），测试可注入临时目录的实例。
   */
  readonly feishu?: FeishuService;
};

/** 一次成员委托的请求；由工具层填好团队成员与提示，执行层只负责跑子会话。 */
export type TeamDelegateRequest = {
  readonly team_name: string;
  readonly member: TeamMember;
  readonly prompt: string;
  /** 任务标题；写进子会话提示，同时作为结果可读的说明。 */
  readonly description?: string;
  /** 已格式化的未读邮件上下文，追加到成员提示之后。 */
  readonly inbox_context?: string;
  /** 允许成员调用的工具名；省略时用委托的只读默认集。 */
  readonly allowed_tools?: readonly string[] | null;
  readonly timeout_seconds?: number;
  /** 工具轮次上限；映射到子会话的 `maxTurns`。 */
  readonly max_tool_calls?: number;
  /** 父会话：子会话继承它的模型；省略时走服务默认模型。 */
  readonly parent_conversation_id?: number;
  readonly request_id?: string;
  /** 子会话建好后的回调，供团队记录“正在运行”的子会话 id 与标题。 */
  readonly on_start?: (info: { conversation_id: number; title: string }) => void | Promise<void>;
};

export type TeamDelegateOutcome = "completed" | "failed" | "canceled";

/** 一次成员委托的结果；字段名与旧团队记录保持一致（`usage` 用 PlanUsage 的键）。 */
export type TeamDelegateResult = {
  status: TeamDelegateOutcome;
  /** 稳定错误码；成功时为空串。 */
  code: string;
  error: string;
  content: string;
  conversation_id: number;
  conversation_title: string;
  usage: PlanUsage;
  tool_events: JsonValue[];
};

/** 委托端口：工具层只依赖它，Harness/会话在宿主装配时注入。 */
export type TeamDelegationPort = {
  run(request: TeamDelegateRequest): Promise<TeamDelegateResult>;
  /** 取消某个团队（可限定成员）正在运行的委托；返回命中的数量。 */
  cancel(teamName: string, memberName?: string): Promise<number>;
  active(): readonly {
    conversation_id: number;
    team_name: string;
    member_name: string;
    title: string;
  }[];
};

/** 一份文档的读写端口：`update` 在一次 pi-durable commit 内完成。 */
export type AppDocHost<T extends JsonObject = JsonObject> = {
  read(): Promise<T>;
  update<R>(mutate: (draft: T) => R | Promise<R>): Promise<R>;
};

/** 三份文档各自的宿主端口。 */
export type AppDocHosts = {
  readonly tasks: AppDocHost<TaskBoardDoc>;
  readonly teams: AppDocHost<TeamStoreDoc>;
  readonly plans: AppDocHost<PlanStoreDoc>;
};

/** `defineDoc` 的 conversation 文档 token；由 `docs.ts` 定义。 */
export type AppDocToken<T extends JsonObject> = ConversationDocToken<T>;

/**
 * 工具结果：模型只看 `output` 文本，UI 看 `details`。
 *
 * 文本渲染沿用旧实现的 JSON 形状：dict/list → `json.dumps(..., ensure_ascii=False)`。
 */
export function okResult(tool: string, text: string, details: AppToolDetails): {
  output: { type: "text"; text: string }[];
  details: AppToolDetails;
} {
  return { output: [{ type: "text", text }], details };
}

export function errorResult(tool: string, message: string, extra?: Record<string, JsonValue>): {
  isError: true;
  output: { type: "text"; text: string }[];
  details: AppToolDetails;
} {
  return {
    isError: true,
    output: [{ type: "text", text: message }],
    details: { tool, error: { kind: "tool_error", message }, ...extra },
  };
}

/** Python `json.dumps(value, ensure_ascii=False)` 的等价渲染：紧凑分隔符与 Python 一致。 */
export function jsonText(value: JsonValue): string {
  return JSON.stringify(value);
}

/** 把旧实现的 dict/list 返回值渲染成模型文本。 */
export function renderValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  return jsonText(value);
}

/**
 * 把一个同步/异步执行函数包成 pi-durable 工具：
 * 校验参数已由 Harness 完成，这里只把异常换成旧实现的错误文案。
 *
 * `execute` 的第二个参数是 pi-durable 的调用 API（`taskId`/`callId`/`memo`/`commit`），
 * 只有需要跨重启幂等的工具（飞书写入）会用到。
 */
export function makeAppTool<Args extends object>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly replay: "safe" | "unsafe";
  readonly execute: (args: Args, api: ToolExecutionApi<AppToolDetails>) => Promise<{
    output: { type: "text"; text: string }[];
    details: AppToolDetails;
    /** 本轮之后的控制信号；目前只有 `search_mcp_tools` 用来加载 `deferred` 的 MCP 工具。 */
    control?: ToolControl;
  } | {
    isError: true;
    output: { type: "text"; text: string }[];
    details: AppToolDetails;
    control?: ToolControl;
  }>;
}): AppTool {
  return defineTool<object, AppToolDetails>({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    replay: spec.replay,
    async execute(args, api) {
      return await spec.execute(args as Args, api);
    },
  });
}
