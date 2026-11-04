/**
 * 库视图的 IPC 方法表（P6 第二片）：会话库、知识库、记忆、技能/命令目录、Hook 配置与仪表盘。
 *
 * 分工：
 * - 会话本身由 pi-durable 持久化；这里只维护用户元数据与墓碑（`library/sessions.ts`）。
 * - 知识库以 Python compute 为准，全部透传（`library/knowledge.ts`）。
 * - 记忆复用 `agent/memory.ts` 的读取与校验，写入侧在 `library/memory.ts`。
 * - 技能/命令列表只做字段裁剪（`library/catalog.ts`）；Hook 配置写旧 `config/hooks.json`。
 * - 仪表盘文件与 compute 共用 `<dataRoot>/outputs/Dashboard`（`library/dashboard.ts`）。
 *
 * 集成者只需把 `libraryMethods(deps)` 展开进 `createMethods()` 的返回值；本文件不修改 methods.ts。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandDirs } from "../agent/commands.ts";
import type { MemoryDirs } from "../agent/memory.ts";
import type { SkillDirs } from "../agent/skills.ts";
import type { Conversations } from "../conversations/service.ts";
import type { ComputeClient } from "../compute/client.ts";
import { loadConfig } from "../config.ts";
import { invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import { CatalogLibrary } from "../library/catalog.ts";
import { DashboardLibrary } from "../library/dashboard.ts";
import { HooksLibrary } from "../library/hooks.ts";
import { KnowledgeLibrary } from "../library/knowledge.ts";
import { MemoryLibrary, type MemoryWriteParams } from "../library/memory.ts";
import { SessionLibrary } from "../library/sessions.ts";
import { LibraryStore } from "../library/store.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

export type LibraryDeps = {
  harness: Harness;
  context: Context;
  conversations: Conversations;
  /** 只用到 `call`：测试可以直接传假 compute 客户端。 */
  compute: Pick<ComputeClient, "call">;
  /** agent 服务的数据目录（`datawhisper.sqlite`、`library.sqlite` 都在这里）；省略时用 `loadConfig()`。 */
  dataDir?: string;
  /**
   * compute worker 的 `BAA_DATA_DIR`；仪表盘、图表、记忆回收站与 hooks.json 用它定位。
   * 省略时依次取 `BAA_DATA_DIR`、`dataDir`。
   */
  dataRoot?: string;
  libraryDbPath?: string;
  dashboardDir?: string;
  chartDir?: string;
  hooksPath?: string;
  trashDir?: string;
  memoryDirs?: MemoryDirs;
  skillDirs?: SkillDirs;
  commandDirs?: CommandDirs;
};

export type Library = {
  methods: Record<string, RpcMethod>;
  close(): void;
};

function objectParam(params: MethodParams, key: string): Record<string, unknown> {
  const value = params[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParams(`'${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringParam(params: MethodParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value;
}

function optionalStringParam(params: MethodParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParams(`'${key}' must be a string`);
  return value;
}

function intParam(params: MethodParams, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`'${key}' must be a positive integer`);
  }
  return value;
}

function optionalIntParam(params: MethodParams, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidParams(`'${key}' must be a positive integer`);
  }
  return value;
}

function optionalBooleanParam(params: MethodParams, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidParams(`'${key}' must be a boolean`);
  return value;
}

/** `enabled` 既接受布尔（新界面），也接受 0/1（旧 Python 记录里的形状）。 */
function optionalEnabledParam(params: MethodParams): boolean | number | undefined {
  const value = params.enabled;
  if (value === undefined) return undefined;
  if (typeof value === "boolean" || value === 0 || value === 1) return value;
  throw invalidParams("'enabled' must be a boolean or 0/1");
}

/** 分类 id：新界面用 `categoryId`，旧路由用 `category_id`。 */
function categoryIdParam(params: MethodParams): number | undefined {
  return optionalIntParam(params, "categoryId") ?? optionalIntParam(params, "category_id");
}

/** 仪表盘 id：路径参数在旧路由里，新方法接受 `id` 或 `dashboardId`。 */
function dashboardIdParam(params: MethodParams): string {
  return params.id !== undefined ? stringParam(params, "id") : stringParam(params, "dashboardId");
}

/** 会话 id：数字、数字字符串或 `"root"`。 */
function conversationIdParam(params: MethodParams, key = "id"): string | number {
  const value = params[key] ?? (key === "id" ? params.conversationId : undefined);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && (value === "root" || /^[1-9][0-9]{0,15}$/.test(value))) return value;
  throw invalidParams(`'${key}' must be a conversation id or "root"`);
}

/** 检索词：新界面用 `query`，旧路由用 `q`，两者都接受。 */
function queryParam(params: MethodParams): string {
  const value = params.query ?? params.q;
  if (typeof value !== "string" || value.trim() === "") throw invalidParams("'query' must be a non-empty string");
  return value;
}

/** 知识库检索允许空串（Python 侧对空查询返回空结果，而不是报错）。 */
function knowledgeQueryParam(params: MethodParams): string {
  const value = params.query ?? params.q;
  if (typeof value !== "string") throw invalidParams("'query' must be a string");
  return value;
}

function memoryParams(params: MethodParams): MemoryWriteParams {
  return {
    name: optionalStringParam(params, "name"),
    type: optionalStringParam(params, "type"),
    title: optionalStringParam(params, "title"),
    body: optionalStringParam(params, "body"),
    why: optionalStringParam(params, "why"),
    howToApply: optionalStringParam(params, "howToApply") ?? optionalStringParam(params, "how_to_apply"),
    sourceSession: optionalStringParam(params, "sourceSession") ?? optionalStringParam(params, "source_session"),
  };
}

export function createLibrary(deps: LibraryDeps): Library {
  const dataDir = deps.dataDir ?? loadConfig().dataDir;
  const dataRoot = deps.dataRoot ?? process.env.BAA_DATA_DIR ?? dataDir;
  const store = new LibraryStore(deps.libraryDbPath ?? join(dataDir, "library.sqlite"));
  const sessions = new SessionLibrary({ harness: deps.harness, context: deps.context, conversations: deps.conversations, store });
  const knowledge = new KnowledgeLibrary({ compute: deps.compute });
  const memory = new MemoryLibrary({
    dirs: deps.memoryDirs ?? { userDir: join(dataDir, "memory") },
    trashDir: deps.trashDir ?? join(dataRoot, "outputs", ".trash", "memories"),
  });
  const catalog = new CatalogLibrary({
    skillDirs: deps.skillDirs ?? {
      builtinDir: join(REPO_ROOT, "skills"),
      userDir: process.env.BAA_SKILLS_DIR ?? join(homedir(), ".baa", "skills"),
    },
    commandDirs: deps.commandDirs ?? {
      builtinDir: join(REPO_ROOT, "commands"),
      userDir: process.env.BAA_COMMANDS_DIR ?? join(homedir(), ".baa", "commands"),
    },
  });
  const hooks = new HooksLibrary({ path: deps.hooksPath ?? join(dataRoot, "config", "hooks.json") });
  const dashboards = new DashboardLibrary({
    compute: deps.compute,
    dashboardDir: deps.dashboardDir ?? join(dataRoot, "outputs", "Dashboard"),
    chartDir: deps.chartDir ?? join(dataRoot, "outputs", "charts"),
  });

  const methods: Record<string, RpcMethod> = {
    // ── 会话库 ─────────────────────────────────────────────────────────────
    "session.list": (params) =>
      sessions.list({
        includeArchived: optionalBooleanParam(params, "includeArchived"),
        includeModel: optionalBooleanParam(params, "includeModel"),
      }),
    "session.rename": (params) => sessions.rename(conversationIdParam(params), stringParam(params, "title")),
    "session.pin": (params) => sessions.setPinned(conversationIdParam(params), optionalBooleanParam(params, "pinned")),
    "session.archive": (params) =>
      sessions.setArchived(conversationIdParam(params), optionalBooleanParam(params, "archived")),
    "session.delete": (params) => sessions.remove(conversationIdParam(params)),
    "session.export": (params) => {
      const format = optionalStringParam(params, "format") ?? "md";
      if (format !== "md" && format !== "json") throw invalidParams("'format' must be md or json");
      return sessions.exportSession(conversationIdParam(params), format);
    },
    "session.search": (params) =>
      sessions.search({
        query: queryParam(params),
        limit: optionalIntParam(params, "limit"),
        includeArchived: optionalBooleanParam(params, "includeArchived"),
      }),

    // ── 知识库（全部透传 compute） ─────────────────────────────────────────
    "knowledge.list": (params) =>
      knowledge.list({ kind: params.kind, categoryId: categoryIdParam(params) }),
    "knowledge.add": (params) =>
      knowledge.add({
        kind: params.kind,
        record: objectParam(params, "record"),
        categoryId: categoryIdParam(params),
      }),
    "knowledge.update": (params) =>
      knowledge.update({
        kind: params.kind,
        id: intParam(params, "id"),
        fields: objectParam(params, "fields"),
        categoryId: categoryIdParam(params),
      }),
    "knowledge.remove": (params) => knowledge.remove({ kind: params.kind, id: intParam(params, "id") }),
    "knowledge.search": (params) => knowledge.search({ query: knowledgeQueryParam(params) }),
    "knowledge.toggle": (params) => knowledge.toggle({ kind: params.kind, id: intParam(params, "id") }),
    "knowledge.parse": (params) =>
      knowledge.parse({
        filePath: params.filePath !== undefined ? stringParam(params, "filePath") : stringParam(params, "file_path"),
        name: optionalStringParam(params, "name"),
      }),
    "knowledge.files": () => knowledge.files(),
    "knowledge.extract": (params) => {
      const replies = params.replies;
      if (!Array.isArray(replies) || !replies.every((reply) => typeof reply === "string")) {
        throw invalidParams("'replies' must be a list of strings");
      }
      return knowledge.extract({ replies });
    },
    "knowledge.confirm": (params) => {
      const records = params.records;
      if (
        records !== undefined &&
        (!Array.isArray(records) ||
          !records.every((record) => typeof record === "object" && record !== null && !Array.isArray(record)))
      ) {
        throw invalidParams("'records' must be a list of objects");
      }
      return knowledge.confirm({
        records: records as Record<string, unknown>[] | undefined,
        filename: optionalStringParam(params, "filename"),
        categoryId: categoryIdParam(params),
      });
    },
    "knowledge.deleteFile": (params) => knowledge.deleteFile({ filename: stringParam(params, "filename") }),
    "knowledge.rebuildEmbeddings": () => knowledge.rebuildEmbeddings(),

    "knowledge.categories.list": () => knowledge.categories(),
    "knowledge.categories.add": (params) => knowledge.addCategory({ name: stringParam(params, "name") }),
    "knowledge.categories.update": (params) =>
      knowledge.updateCategory({
        id: intParam(params, "id"),
        name: optionalStringParam(params, "name"),
        enabled: optionalEnabledParam(params),
      }),
    "knowledge.categories.toggle": (params) => knowledge.toggleCategory({ id: intParam(params, "id") }),
    "knowledge.categories.remove": (params) => knowledge.removeCategory({ id: intParam(params, "id") }),

    // ── 记忆 ───────────────────────────────────────────────────────────────
    "memory.list": () => memory.list(),
    "memory.add": (params) => memory.add(memoryParams(params)),
    "memory.update": (params) => memory.update(stringParam(params, "name"), memoryParams(params)),
    "memory.remove": (params) => memory.remove(stringParam(params, "name")),

    // ── 技能 / 命令目录 ────────────────────────────────────────────────────
    "skill.list": () => catalog.skills(),
    "command.list": () => catalog.commands(),

    // ── Hook 配置 ──────────────────────────────────────────────────────────
    "hooks.list": () => hooks.list(),
    "hooks.save": (params) => hooks.save(params),
    "hooks.remove": (params) => hooks.remove(stringParam(params, "id")),

    // ── 仪表盘 ─────────────────────────────────────────────────────────────
    "dashboard.list": () => dashboards.list(),
    "dashboard.create": (params) => dashboards.create(params),
    "dashboard.get": (params) => dashboards.get(dashboardIdParam(params)),
    "dashboard.update": (params) => dashboards.update({ ...params, id: dashboardIdParam(params) }),
    "dashboard.remove": (params) => dashboards.remove(dashboardIdParam(params)),
    "dashboard.refresh": (params) =>
      dashboards.refresh({
        id: dashboardIdParam(params),
        sourceId:
          params.sourceId !== undefined ? stringParam(params, "sourceId") : stringParam(params, "source_id"),
        workspaceId: optionalStringParam(params, "workspaceId") ?? optionalStringParam(params, "workspace_id"),
        widgetId: optionalStringParam(params, "widgetId") ?? optionalStringParam(params, "widget_id"),
      }),
    "dashboard.exportHtml": (params) => dashboards.exportHtml(dashboardIdParam(params)),
  };

  return { methods, close: () => store.close() };
}

/** 只取方法表，供 `methods.ts` 展开；库的关闭由进程退出处理。 */
export function libraryMethods(deps: LibraryDeps): Record<string, RpcMethod> {
  return createLibrary(deps).methods;
}
