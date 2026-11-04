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
import { defineTool, type ConversationDocToken, type JsonObject, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkspaceFs } from "./workspace/fs.ts";
import type { PlanStoreDoc, TaskBoardDoc, TeamStoreDoc } from "./docs.ts";
import type { MemoryDirs } from "../../agent/memory.ts";
import type { SkillDirs } from "../../agent/skills.ts";
import type { CanvasStore } from "./diagram/canvas.ts";
import type { ToolResultArtifactSource } from "./artifacts.ts";
import type { McpCatalogReader } from "./mcp.ts";

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
   * 任务板/团队/动态计划文档的宿主。会话里由 pi-durable conversation 文档实现；
   * 测试可以用 `createMemoryDocHost()`。省略时这些工具返回“no workspace is mounted…”风格的错误。
   */
  readonly docs?: AppDocHosts;
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
  /** MCP 工具目录读取端。 */
  readonly mcpCatalog?: McpCatalogReader;
  /** browse_webpage 使用的 fetch 实现；测试可注入。 */
  readonly fetch?: typeof fetch;
  /** 会话身份，写入文档/画布时使用。 */
  readonly sessionId: string;
  readonly workspaceId?: string;
  /** 用户界面语言：影响 PPT 布局标签（`_tt` 语义）。 */
  readonly uiLang?: "zh" | "en";
  /** 会话级配色偏好；`set_ppt_color_scheme` 就地更新它，图表/PPT 读取。 */
  readonly colorScheme?: { value: string };
  /** 时钟；测试可固定，避免真实计时器。 */
  readonly now?: () => Date;
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
 */
export function makeAppTool<Args extends object>(spec: {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
  readonly replay: "safe" | "unsafe";
  readonly execute: (args: Args) => Promise<{ output: { type: "text"; text: string }[]; details: AppToolDetails } | {
    isError: true;
    output: { type: "text"; text: string }[];
    details: AppToolDetails;
  }>;
}): AppTool {
  return defineTool<object, AppToolDetails>({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    replay: spec.replay,
    async execute(args) {
      return await spec.execute(args as Args);
    },
  });
}
