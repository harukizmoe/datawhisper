/**
 * 数据源 / 工作区 / 产物的内部 API（P6.1）。
 *
 * 旧实现把这三块拆在 `api/datasource.py`、`api/workspace.py`、`api/output.py` 三组 HTTP 路由里，
 * 状态直接挂在 Python session 对象上。这里改成：
 *
 * - 状态：会话级的 pi-durable 文档（见 `source-store.ts`），重启后仍在；
 * - 计算：把文件解析、schema、预览、工作区导入交给 compute worker 的既有 RPC（`source.*`、
 *   `upload.prepare`、`workspace.sync`），Bun 侧只做校验、编排与脱敏；
 * - 传输：JSONL 里不放文件字节。上传走「两段式本地路径交接」，
 *   协议见 `docs/refactor/ipc-uploads.md`。
 *
 * 任何返回值都不得包含凭据原文：远程来源的描述符只保存非密字段，密钥在
 * `SecretCredentialStore` 里，只在打开来源的一瞬间于进程内合并。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ComputeError, type SourceDescriptor } from "../compute/client.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError, appError, invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import {
  ARTIFACT_CONTENT_TYPES,
  CONFIG_ID_PATTERN,
  NON_SECRET_FIELDS,
  SECRET_FIELDS,
  SOURCE_ID_PATTERN,
  WORKSPACE_ID_PATTERN,
  type ConversationHarness,
  type RemoteSourceKind,
  type SourceConfig,
  type SourceConfigKind,
  type SourceConfigStore,
  type SourceDoc,
  type SourceDocStore,
  type SourceKind,
  type StoredSource,
  type WorkspacePermission,
  type WorkspaceRecord,
  createConversationSourceStore,
  createSourceConfigStore,
  displayNameFrom,
  randomId,
  realPath,
  suffixOf,
  validateWorkspacePath,
  within,
  workspaceIdFor,
} from "./source-store.ts";
import { sqlConfigProblem, sqlConnectionString } from "./sql-connection.ts";

/** 只下载/预览、可能很大的产物不放进 JSONL：`artifact.read` 返回服务端路径。 */
export const MAX_ARTIFACT_TEXT_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_ENTRIES = 500;
export const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;

const UPLOAD_SUFFIXES: Readonly<Record<string, true>> = { ".csv": true, ".xlsx": true, ".xls": true, ".pdf": true };
const UPLOAD_ID_PATTERN = /^[a-f0-9]{32}$/;
const REMOTE_KINDS: Readonly<Record<RemoteSourceKind, true>> = { sql: true, gsheets: true, feishu: true, http: true };

/** 本模块用到的 compute 能力；`ComputeClient` 结构上满足它，测试可以注入假实现。 */
export type ComputeSourceClient = {
  call<T = JsonValue>(method: string, params?: Record<string, unknown>): Promise<T>;
  openSource(sourceId: string, descriptor: SourceDescriptor): Promise<{ name: string; tables: string[] }>;
  closeSource(sourceId: string): Promise<void>;
};

export type SourcesDeps = {
  readonly compute: ComputeSourceClient;
  /** 会话级来源/工作区文档。 */
  readonly state: SourceDocStore;
  /** 数据源配置；密钥只进不出。 */
  readonly configs: SourceConfigStore;
  /** 上传副本目录（`<dataDir>/uploads`）。 */
  readonly uploadsDir: string;
  /** 导出产物根（`<dataDir>/outputs`，实际读取其下的 `exports/`）。 */
  readonly outputsDir: string;
  /** 仓库根：禁止把整个仓库挂成工作目录。 */
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly maxUploadBytes?: number;
  readonly uploadTtlMs?: number;
  /** 额外禁止挂载的根（测试可用来放行临时目录）。 */
  readonly blockedWorkspaceRoots?: readonly string[];
  /**
   * 会话来源/工作区发生变化后的回调。宿主可据此刷新每轮 `turnState()` 的同步缓存
   * （见 `turnStateFor`），保证工具暴露与这里返回的「当前来源」一致。
   */
  readonly onChanged?: (conversationId: number) => void;
};

export type SourceMethodsOptions = {
  readonly compute: ComputeSourceClient;
  readonly harness: ConversationHarness;
  readonly context: Context;
  readonly dataDir: string;
  readonly credentials: CredentialStore;
  readonly projectRoot?: string;
  readonly now?: () => Date;
  readonly maxUploadBytes?: number;
  readonly uploadTtlMs?: number;
  readonly blockedWorkspaceRoots?: readonly string[];
  readonly onChanged?: (conversationId: number) => void;
};

/** 仓库根：`server/src/ipc` 往上三级。整合者也可以显式传 `projectRoot`。 */
export const DEFAULT_PROJECT_ROOT = resolve(import.meta.dir, "../../..");

/** 生产装配点的便利入口：把文档、配置存储与目录默认值一次接好。 */
export function createSourceMethods(options: SourceMethodsOptions): Record<string, RpcMethod> {
  return sourceMethods({
    compute: options.compute,
    state: createConversationSourceStore({ harness: options.harness, context: options.context }),
    configs: createSourceConfigStore({
      dataDir: options.dataDir,
      credentials: options.credentials,
      now: options.now,
    }),
    uploadsDir: join(options.dataDir, "uploads"),
    outputsDir: join(options.dataDir, "outputs"),
    projectRoot: options.projectRoot ?? DEFAULT_PROJECT_ROOT,
    now: options.now,
    maxUploadBytes: options.maxUploadBytes,
    uploadTtlMs: options.uploadTtlMs,
    blockedWorkspaceRoots: options.blockedWorkspaceRoots,
    onChanged: options.onChanged,
  });
}

// ── 参数校验 ────────────────────────────────────────────────────────────────

function invalidReason(message: string, reason: string): RpcError {
  return new RpcError(message, INVALID_PARAMS, { kind: "invalid_input", reason });
}

function appReason(message: string, reason: string): RpcError {
  return new RpcError(message, APP_ERROR, { kind: "invalid_input", reason });
}

function conversationIdParam(params: MethodParams): number {
  const value = params.conversationId;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidParams("'conversationId' must be a positive integer");
  }
  return value;
}

function stringParam(params: MethodParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value.trim();
}

function optionalStringParam(params: MethodParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParams(`'${key}' must be a string`);
  return value.trim();
}

function optionalBooleanParam(params: MethodParams, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidParams(`'${key}' must be a boolean`);
  return value;
}

function integerParam(params: MethodParams, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalidParams(`'${key}' must be an integer`);
  return value;
}

function patternParam(params: MethodParams, key: string, pattern: RegExp, example: string): string {
  const value = stringParam(params, key);
  if (!pattern.test(value)) throw invalidParams(`'${key}' must look like ${example}`);
  return value;
}

function objectParam(params: MethodParams, key: string): Record<string, unknown> {
  const value = params[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidParams(`'${key}' must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObjectParam(params: MethodParams, key: string): Record<string, unknown> | undefined {
  return params[key] === undefined ? undefined : objectParam(params, key);
}

function stringMapParam(params: MethodParams, key: string): Record<string, string> | undefined {
  const value = optionalObjectParam(params, key);
  if (value === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== "string") throw invalidParams(`'${key}.${name}' must be a string`);
    result[name] = item;
  }
  return result;
}

function remoteKindParam(params: MethodParams): RemoteSourceKind {
  const value = params.kind;
  if (typeof value !== "string" || !Object.hasOwn(REMOTE_KINDS, value)) {
    throw invalidParams("'kind' must be sql, gsheets, feishu, or http");
  }
  return value as RemoteSourceKind;
}

function permissionParam(params: MethodParams, fallback: WorkspacePermission): WorkspacePermission {
  const value = params.permission;
  if (value === undefined) return fallback;
  if (value !== "read_only" && value !== "read_write") {
    throw invalidParams("permission 必须是 read_only 或 read_write。");
  }
  return value;
}

function stringArrayParam(params: MethodParams, key: string): string[] {
  const value = params[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidParams(`'${key}' must be a list of strings`);
  }
  return value as string[];
}

// ── compute 错误翻译 ────────────────────────────────────────────────────────

/**
 * compute worker 的业务错误带 `data.kind`（如 `file_not_found`、`open_failed`）。
 * 只透出文案与细分原因，**不透出** `data` 里的原始异常：连接失败的异常文本里可能带 DSN。
 * `secrets` 是本次打开会用到的凭据原文，用于把错误文案里可能回显的部分替换掉。
 */
function mapComputeError(error: unknown, secrets: readonly string[] = []): unknown {
  if (!(error instanceof ComputeError)) return error;
  const data = error.data;
  let reason: string | undefined;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const kind = (data as Record<string, unknown>).kind;
    if (typeof kind === "string") reason = kind;
  }
  const appKind = reason === "source_not_open" || reason === "file_not_found" ? "not_found" : "invalid_input";
  let message = error.message;
  for (const secret of secrets) {
    // 太短的值替换会误伤正常文案；凭据字段本身不会这么短。
    if (secret.length < 4) continue;
    message = message.split(secret).join("***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) message = message.split(encoded).join("***");
  }
  return new RpcError(message, APP_ERROR, reason === undefined ? { kind: appKind } : { kind: appKind, reason });
}

/** 描述符里所有不该出现在错误文案中的值（含 Excel/Sheets 凭证 JSON 的私钥）。 */
function secretValues(descriptor: SourceDescriptor): string[] {
  const values: string[] = [];
  for (const name of ["connection_string", "auth_value", "creds_json"]) {
    const value = descriptor[name];
    if (typeof value === "string" && value.length >= 4) values.push(value);
  }
  // 表单模式下连接串是服务端拼的，密码要单独从中取出来，错误文案里才能把它遮住。
  const connection = descriptor.connection_string;
  if (typeof connection === "string") {
    try {
      const password = decodeURIComponent(new URL(connection).password);
      if (password.length >= 4) values.push(password);
    } catch {
      // 不是标准 URL（如 SQLite 文件路径）或没有密码：无需额外遮蔽。
    }
  }
  const creds = descriptor.creds_dict;
  if (typeof creds === "object" && creds !== null && !Array.isArray(creds)) {
    const record = creds as Record<string, unknown>;
    for (const name of ["private_key", "private_key_id", "client_secret"]) {
      const value = record[name];
      if (typeof value === "string" && value.length >= 4) values.push(value);
    }
  }
  return values;
}

// ── 文档视图 ────────────────────────────────────────────────────────────────

function publicSource(record: StoredSource, open: ReadonlySet<string>): Record<string, JsonValue> {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    active: record.active,
    open: open.has(record.id),
    // 配置 id 不是密钥；界面据此找到这个来源的连接设置，才能让用户改。
    ...(record.configId === undefined ? {} : { configId: record.configId }),
    ...(record.tables === undefined ? {} : { tables: record.tables }),
  };
}

function publicWorkspace(record: WorkspaceRecord): Record<string, JsonValue> {
  return {
    workspace_id: record.workspaceId,
    workdir: record.workdir,
    name: record.name,
    permission: record.permission,
    source_id: record.sourceId,
    mounted: record.mounted,
    mounted_at: record.mountedAt,
    updated_at: record.updatedAt,
  };
}

function requireStoredSource(doc: SourceDoc, sourceId: string): StoredSource {
  const record = doc.sources.find((item) => item.id === sourceId);
  if (record === undefined) throw appError("not_found", `data source not found: ${sourceId}`);
  return record;
}

function requireWorkspace(doc: SourceDoc, workspaceId: string): WorkspaceRecord {
  const record = doc.workspaces.find((item) => item.workspaceId === workspaceId);
  if (record === undefined) throw appError("not_found", `workspace not found: ${workspaceId}`);
  return record;
}

function requireRemoteConfig(kind: SourceConfigKind, fields: Record<string, string>, secret: Record<string, string>): void {
  const has = (name: string): boolean => (fields[name] ?? secret[name] ?? "") !== "";
  if (kind === "sql") {
    const problem = sqlConfigProblem(fields, secret);
    if (problem !== undefined) throw invalidReason(problem.message, problem.reason);
    return;
  }
  if (kind === "gsheets") {
    if (!has("spreadsheet")) throw invalidReason("电子表格 URL 或 ID 不能为空", "missing_spreadsheet");
    if (!has("creds_json")) throw invalidReason("服务账号 JSON 不能为空", "missing_credentials");
    const raw = secret.creds_json ?? fields.creds_json ?? "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    } catch {
      throw invalidReason("服务账号 JSON 格式无效", "invalid_credentials");
    }
    return;
  }
  if (kind === "feishu") {
    if (!has("bitable")) {
      throw invalidReason("飞书多维表格链接或 app_token 不能为空", "missing_bitable");
    }
    return;
  }
  if (!has("url")) throw invalidReason("API URL 不能为空", "missing_url");
  const url = fields.url ?? secret.url ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidReason("API URL 格式无效", "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidReason("API URL 只支持 http/https", "invalid_url");
  }
  const authType = fields.auth_type ?? "none";
  if (authType !== "none" && authType !== "bearer" && authType !== "api_key") {
    throw invalidReason("认证方式无效，支持: none / bearer / api_key", "invalid_auth_type");
  }
  if (authType !== "none" && !has("auth_value")) {
    throw invalidReason("认证值不能为空", "missing_auth_value");
  }
}

/** 解析飞书多维表格引用：完整链接里取 app_token 与 `?table=`，否则按 app_token 处理。 */
function parseBitableReference(value: string, table: string | undefined): { appToken: string; tableId: string } {
  const raw = value.trim();
  if (raw === "") throw invalidReason("飞书多维表格链接或 app_token 不能为空", "missing_bitable");
  let appToken = raw;
  let tableId = table?.trim() ?? "";
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw invalidReason("飞书多维表格链接格式无效", "invalid_bitable");
    }
    const match = /\/base\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
    if (match === null) throw invalidReason("飞书多维表格链接格式无效", "invalid_bitable");
    appToken = match[1]!;
    tableId = tableId === "" ? (parsed.searchParams.get("table") ?? "") : tableId;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(appToken)) {
    throw invalidReason("飞书多维表格 app_token 格式无效", "invalid_bitable");
  }
  if (tableId === "") {
    // 旧实现会调用飞书接口列出所有表让用户选；compute 侧还没有对应方法（见报告「未迁移项」）。
    throw invalidReason("请提供 table_id（表选择列表需要 compute 侧新增方法）", "missing_table");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(tableId)) {
    throw invalidReason("飞书多维表格 table_id 格式无效", "invalid_bitable");
  }
  return { appToken, tableId };
}

/** 远程来源的最终形态：`descriptor` 给 compute（含密钥），`stored` 写文档（脱敏）。 */
type PreparedRemote = {
  name: string;
  fields: Record<string, string>;
  secret: Record<string, string>;
  descriptor: SourceDescriptor;
  stored: Record<string, JsonValue>;
  configId: string;
};

// ── 上传暂存 ────────────────────────────────────────────────────────────────

type UploadTicket = {
  id: string;
  filename: string;
  displayName: string;
  suffix: string;
  declaredSize: number;
  expiresAt: number;
  path: string;
};

// ── 方法表 ──────────────────────────────────────────────────────────────────

export function sourceMethods(deps: SourcesDeps): Record<string, RpcMethod> {
  const now = deps.now ?? (() => new Date());
  const iso = (): string => now().toISOString();
  const maxUploadBytes = deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const uploadTtlMs = deps.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
  const incomingDir = join(deps.uploadsDir, "incoming");
  const exportsDir = join(deps.outputsDir, "exports");
  /** 已在 compute worker 里打开的 source id；避免每次调用都重开（重开会关闭旧连接）。 */
  const openIds = new Set<string>();
  /** 上传票据只活在进程内：进程重启后旧的 staging 文件本来也无法安全认领。 */
  const uploads = new Map<string, UploadTicket>();
  /**
   * 所有写入都经过这一层：提交成功后通知宿主刷新 `turnState` 缓存，失败时不通知。
   * 回调是旁观者，宿主抛错不能反过来让已经提交的写入报失败。
   */
  const state: SourceDocStore = {
    read: (conversationId) => deps.state.read(conversationId),
    async update<R>(conversationId: number, mutate: (draft: SourceDoc) => R | Promise<R>): Promise<R> {
      const result = await deps.state.update(conversationId, mutate);
      try {
        deps.onChanged?.(conversationId);
      } catch {
        // 宿主缓存刷新失败只影响下一轮工具暴露，不能让本次写入失败。
      }
      return result;
    },
  };

  const computeCall = async <T = JsonValue>(method: string, params: Record<string, unknown>): Promise<T> => {
    try {
      return await deps.compute.call<T>(method, params);
    } catch (error) {
      throw mapComputeError(error);
    }
  };

  const openCompute = async (sourceId: string, descriptor: SourceDescriptor): Promise<{ name: string; tables: string[] }> => {
    try {
      return await deps.compute.openSource(sourceId, descriptor);
    } catch (error) {
      // 远程连接失败时 compute 的文案可能回显 DSN；按本次描述符里的凭据原文做脱敏。
      throw mapComputeError(error, secretValues(descriptor));
    }
  };

  /** 合并配置里的密钥，得到真正交给 compute 的 descriptor。 */
  const descriptorFor = async (record: StoredSource): Promise<SourceDescriptor> => {
    const descriptor = structuredClone(record.descriptor) as SourceDescriptor;
    if (record.analysisTables !== undefined) descriptor.analysis_tables = [...record.analysisTables];
    if (record.configId === undefined) return descriptor;
    const config = await deps.configs.get(record.configId);
    if (config === undefined) throw appError("not_found", `data source config not found: ${record.configId}`);
    const secret = await deps.configs.secret(record.configId);
    if (secret === undefined && record.kind !== "sql") return descriptor;
    if (record.kind === "gsheets") {
      const creds = secret?.creds_json;
      if (creds !== undefined) {
        try {
          descriptor.creds_dict = JSON.parse(creds) as JsonValue;
        } catch {
          throw appReason("服务账号 JSON 格式无效", "invalid_credentials");
        }
      }
    } else if (record.kind === "sql") {
      // 表单字段在配置里，密码在凭据库；连接串在这一刻才拼出来，不落盘。
      descriptor.connection_string = sqlConnectionString(config.fields, secret ?? {});
    } else {
      for (const [key, value] of Object.entries(secret ?? {})) descriptor[key] = value;
    }
    return descriptor;
  };

  /** 保证记录在 compute 侧是打开的；返回 compute 报告的表名。 */
  const ensureOpen = async (record: StoredSource): Promise<string[]> => {
    if (openIds.has(record.id)) return record.tables ?? [];
    const opened = await openCompute(record.id, await descriptorFor(record));
    openIds.add(record.id);
    record.tables = opened.tables;
    return opened.tables;
  };

  const closeCompute = async (sourceId: string): Promise<void> => {
    openIds.delete(sourceId);
    try {
      await deps.compute.closeSource(sourceId);
    } catch {
      // worker 已经退出时关闭是 no-op；不能因此让界面删不掉来源。
    }
  };

  /** 只清理上传副本；工作目录里的原始文件不属于应用，不能删。 */
  const deleteUploadCopy = (record: StoredSource): void => {
    if (record.uploadPath === undefined) return;
    if (!within(realPath(deps.uploadsDir), realPath(record.uploadPath))) return;
    try {
      unlinkSync(record.uploadPath);
    } catch {
      // 文件可能已被外部清理。
    }
  };

  const sourceView = (doc: SourceDoc): Record<string, JsonValue>[] => doc.sources.map((record) => publicSource(record, openIds));

  const sweepUploads = (): void => {
    const at = now().getTime();
    for (const [id, ticket] of uploads) {
      if (ticket.expiresAt > at) continue;
      uploads.delete(id);
      try {
        lstatSync(ticket.path);
        unlinkSync(ticket.path);
      } catch {
        // 文件可能没写成功；过期回收入口不需要报错。
      }
    }
  };

  const artifactRoots = (doc: SourceDoc, workspaceId?: string): { label: string; path: string; workspaceId?: string }[] => {
    const roots: { label: string; path: string; workspaceId?: string }[] = [];
    for (const record of doc.workspaces) {
      if (workspaceId !== undefined && record.workspaceId !== workspaceId) continue;
      roots.push({
        label: record.name || basename(record.workdir),
        path: join(record.workdir, "artifacts"),
        workspaceId: record.workspaceId,
      });
    }
    if (workspaceId === undefined) roots.push({ label: "exports", path: exportsDir });
    return roots;
  };

  const resolveArtifact = (doc: SourceDoc, params: MethodParams): { path: string; workspaceId?: string } => {
    const name = optionalStringParam(params, "name");
    const rawPath = optionalStringParam(params, "path");
    if (name === undefined && rawPath === undefined) throw invalidParams("'name' or 'path' is required");
    if (name !== undefined && rawPath !== undefined) throw invalidParams("'name' and 'path' are mutually exclusive");
    const roots = artifactRoots(doc);
    if (name !== undefined) {
      if (name.length > 255 || name.includes("\u0000") || /[\\/]/.test(name) || name === "." || name === "..") {
        throw invalidReason("产物名不合法", "invalid_artifact_name");
      }
      for (const root of roots) {
        const candidate = join(root.path, name);
        if (!existsSync(candidate)) continue;
        const info = lstatSync(candidate);
        if (info.isSymbolicLink() || !info.isFile()) continue;
        const real = realpathSync.native(candidate);
        if (!within(realPath(root.path), real)) continue;
        return { path: real, workspaceId: root.workspaceId };
      }
      throw appError("not_found", `artifact not found: ${name}`);
    }
    if (!isAbsolute(rawPath!)) {
      throw invalidReason("产物路径必须是绝对路径", "invalid_artifact_path");
    }
    const real = realPath(rawPath!);
    for (const root of roots) {
      const rootReal = realPath(root.path);
      if (!within(rootReal, real)) continue;
      let info;
      try {
        info = statSync(real);
      } catch {
        throw appError("not_found", `artifact not found: ${rawPath}`);
      }
      if (!info.isFile()) throw invalidReason("产物路径不是文件", "invalid_artifact_path");
      return { path: real, workspaceId: root.workspaceId };
    }
    throw invalidReason("产物不在允许的目录内", "artifact_outside_root");
  };

  // ── 打开远程来源 ──────────────────────────────────────────────────────────

  const prepareRemote = async (kind: RemoteSourceKind, params: MethodParams): Promise<PreparedRemote> => {
    const explicitConfigId = optionalStringParam(params, "configId");
    let configId: string | undefined;
    let fallbackFields: Record<string, string> = {};
    let fallbackSecret: Record<string, string> = {};
    if (explicitConfigId !== undefined) {
      if (!CONFIG_ID_PATTERN.test(explicitConfigId)) throw invalidParams("'configId' must look like ds_xxxxxxxx");
      const config = await deps.configs.get(explicitConfigId);
      if (config === undefined) throw appError("not_found", `data source config not found: ${explicitConfigId}`);
      if (config.kind !== kind) throw invalidReason(`配置 ${explicitConfigId} 不是 ${kind} 类型`, "config_kind_mismatch");
      configId = config.id;
      fallbackFields = config.fields;
      fallbackSecret = (await deps.configs.secret(config.id)) ?? {};
    } else {
      // 与旧实现「留空则沿用上次保存的配置」一致：取同类型最近保存的一条。
      const candidates = (await deps.configs.list())
        .filter((config) => config.kind === kind)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
      const latest = candidates.at(-1);
      if (latest !== undefined) {
        configId = latest.id;
        fallbackFields = latest.fields;
        fallbackSecret = (await deps.configs.secret(latest.id)) ?? {};
      }
    }

    const incoming = optionalObjectParam(params, "fields");
    const fields: Record<string, string> = { ...fallbackFields };
    for (const name of NON_SECRET_FIELDS[kind]) {
      const raw = params[name];
      if (raw !== undefined) {
        if (typeof raw !== "string") throw invalidParams(`'${name}' must be a string`);
        fields[name] = raw.trim();
      }
    }
    if (incoming !== undefined) {
      for (const [name, raw] of Object.entries(incoming)) {
        if (!NON_SECRET_FIELDS[kind].includes(name)) {
          throw invalidParams(`unsupported field '${name}' for ${kind}`);
        }
        if (typeof raw !== "string") throw invalidParams(`'fields.${name}' must be a string`);
        fields[name] = raw.trim();
      }
    }

    const secret: Record<string, string> = { ...fallbackSecret };
    for (const name of ["connection_string", "creds_json", "auth_value"]) {
      const raw = params[name];
      if (raw === undefined) continue;
      if (typeof raw === "string") secret[name] = raw;
      else if (name === "creds_json" && typeof raw === "object" && raw !== null) secret[name] = JSON.stringify(raw);
      else throw invalidParams(`'${name}' must be a string`);
    }
    const incomingSecret = optionalObjectParam(params, "secret");
    if (incomingSecret !== undefined) {
      for (const [name, raw] of Object.entries(incomingSecret)) {
        if (raw === undefined) continue;
        if (!SECRET_FIELDS.includes(name)) throw invalidParams(`'secret.${name}' is not a secret field`);
        if (typeof raw !== "string") throw invalidParams(`'secret.${name}' must be a string`);
        secret[name] = raw;
      }
    }

    if (kind === "feishu") {
      // 兼容旧接口的 app_token/table_id 直传：统一归一化到 bitable/table 两个字段，
      // 这样保存下来的配置可以原样重开。
      const appTokenRaw = params.app_token;
      if (appTokenRaw !== undefined && typeof appTokenRaw !== "string") throw invalidParams("'app_token' must be a string");
      const tableIdRaw = params.table_id;
      if (tableIdRaw !== undefined && typeof tableIdRaw !== "string") throw invalidParams("'table_id' must be a string");
      if ((fields.bitable ?? "") === "" && appTokenRaw !== undefined) fields.bitable = appTokenRaw.trim();
      if ((fields.table ?? "") === "" && tableIdRaw !== undefined) fields.table = tableIdRaw.trim();
    }

    requireRemoteConfig(kind, fields, secret);
    const name = optionalStringParam(params, "name") ?? "";
    if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw invalidParams("'name' must be at most 200 characters without control characters");
    }
    let descriptor: SourceDescriptor;
    let stored: Record<string, JsonValue>;
    if (kind === "sql") {
      descriptor = { kind, connection_string: sqlConnectionString(fields, secret) };
      stored = { kind };
    } else if (kind === "gsheets") {
      let creds: JsonValue;
      try {
        creds = JSON.parse(secret.creds_json ?? "") as JsonValue;
      } catch {
        throw invalidReason("服务账号 JSON 格式无效", "invalid_credentials");
      }
      descriptor = { kind, spreadsheet: fields.spreadsheet ?? "", creds_dict: creds };
      stored = { kind, spreadsheet: fields.spreadsheet ?? "" };
    } else if (kind === "feishu") {
      const parsed = parseBitableReference(fields.bitable!, fields.table);
      descriptor = { kind, app_token: parsed.appToken, table_id: parsed.tableId };
      stored = { kind, app_token: parsed.appToken, table_id: parsed.tableId };
    } else {
      descriptor = {
        kind,
        url: fields.url ?? "",
        auth_type: fields.auth_type ?? "none",
        auth_value: secret.auth_value ?? "",
      };
      stored = { kind, url: fields.url ?? "", auth_type: fields.auth_type ?? "none" };
    }
    return {
      name,
      fields,
      secret,
      descriptor,
      stored,
      configId: configId ?? randomId("ds_"),
    };
  };

  /** 记录一条新来源；返回更新后的来源列表。 */
  const appendSource = async (conversationId: number, record: StoredSource): Promise<Record<string, JsonValue>[]> => {
    return state.update(conversationId, (draft) => {
      draft.sources.push(record);
      return sourceView(draft);
    });
  };

  const openUploaded = async (conversationId: number, params: MethodParams): Promise<Record<string, JsonValue>> => {
    const uploadId = patternParam(params, "uploadId", UPLOAD_ID_PATTERN, "32 位十六进制");
    const ticket = uploads.get(uploadId);
    if (ticket === undefined) throw invalidReason("上传凭据无效或已过期，请重新上传", "unknown_upload");
    uploads.delete(uploadId);
    if (ticket.expiresAt <= now().getTime()) {
      try {
        unlinkSync(ticket.path);
      } catch {
        // 过期文件可能已被回收。
      }
      throw invalidReason("上传凭据已过期，请重新上传", "upload_expired");
    }

    const reject = (error: RpcError): never => {
      try {
        unlinkSync(ticket.path);
      } catch {
        // staging 文件可能还没写成功。
      }
      throw error;
    };

    let stats;
    try {
      stats = lstatSync(ticket.path);
    } catch {
      return reject(invalidReason("上传文件不存在，请重新上传", "upload_missing"));
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return reject(invalidReason("上传目标必须是普通文件", "upload_not_file"));
    const real = realpathSync.native(ticket.path);
    if (!within(realPath(incomingDir), real)) return reject(invalidReason("上传路径越界", "upload_outside_root"));
    if (stats.size !== ticket.declaredSize) {
      return reject(invalidReason(`上传文件大小与声明不一致（声明 ${ticket.declaredSize}，实际 ${stats.size}）`, "upload_size_mismatch"));
    }
    if (stats.size === 0) return reject(invalidReason("文件为空", "empty_file"));
    if (stats.size > maxUploadBytes) {
      return reject(invalidReason(`文件超过大小上限（${Math.floor(maxUploadBytes / (1024 * 1024))} MiB）`, "file_too_large"));
    }

    mkdirSync(deps.uploadsDir, { recursive: true });
    const finalPath = join(deps.uploadsDir, `${uploadId}${ticket.suffix}`);
    renameSync(ticket.path, finalPath);

    let record: StoredSource;
    try {
      const prepared = await computeCall<{ descriptor: SourceDescriptor }>("upload.prepare", {
        file_path: finalPath,
        name: ticket.displayName,
      });
      const descriptor = prepared?.descriptor;
      if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
        throw appReason("上传解析没有返回数据源描述符", "invalid_descriptor");
      }
      const kind = descriptor.kind;
      if (kind !== "csv" && kind !== "excel" && kind !== "pdf") {
        throw appReason(`不支持的数据源类型：${String(kind)}`, "invalid_descriptor");
      }
      const sourceId = randomId("s_");
      const opened = await openCompute(sourceId, descriptor);
      openIds.add(sourceId);
      record = {
        id: sourceId,
        kind: kind as SourceKind,
        name: opened.name || ticket.displayName,
        active: true,
        descriptor,
        uploadPath: finalPath,
        tables: opened.tables,
        createdAt: iso(),
        updatedAt: iso(),
      };
    } catch (error) {
      try {
        unlinkSync(finalPath);
      } catch {
        // 解析失败时清理副本；失败本身已经要返回给界面。
      }
      throw error;
    }

    const sources = await appendSource(conversationId, record).catch(async (error: unknown) => {
      await closeCompute(record.id);
      throw error;
    });
    return { source: publicSource(record, openIds), sources };
  };

  const openRemoteSource = async (conversationId: number, params: MethodParams): Promise<Record<string, JsonValue>> => {
    const kind = remoteKindParam(params);
    const prepared = await prepareRemote(kind, params);
    const sourceId = randomId("s_");
    const opened = await openCompute(sourceId, prepared.descriptor);
    // 与上传一致：compute 里已经打开了，要登记，否则界面刚连上就显示「已关闭」，用到时还会被重复打开。
    openIds.add(sourceId);
    try {
      const saved = await deps.configs.save({
        id: prepared.configId,
        kind,
        name: prepared.name || opened.name,
        fields: prepared.fields,
        secret: prepared.secret,
      });
      const record: StoredSource = {
        id: sourceId,
        kind,
        name: prepared.name || opened.name,
        active: true,
        descriptor: prepared.stored,
        configId: saved.id,
        tables: opened.tables,
        createdAt: iso(),
        updatedAt: iso(),
      };
      const sources = await appendSource(conversationId, record);
      return { source: publicSource(record, openIds), sources, configId: saved.id };
    } catch (error) {
      // 配置或文档没写成功时，不能留下一个 compute 里打开、界面看不到的连接。
      openIds.delete(sourceId);
      await closeCompute(sourceId);
      throw error;
    }
  };

  return {
    "source.upload.begin": async (params) => {
      const conversationId = conversationIdParam(params);
      await state.read(conversationId);
      sweepUploads();
      const filename = stringParam(params, "filename");
      const suffix = suffixOf(filename);
      if (UPLOAD_SUFFIXES[suffix] !== true) {
        throw invalidReason("仅支持 .xlsx / .xls / .csv / .pdf 文件", "unsupported_format");
      }
      const declaredSize = integerParam(params, "size");
      if (declaredSize <= 0) throw invalidReason("文件为空", "empty_file");
      if (declaredSize > maxUploadBytes) {
        throw invalidReason(`文件超过大小上限（${Math.floor(maxUploadBytes / (1024 * 1024))} MiB）`, "file_too_large");
      }
      mkdirSync(incomingDir, { recursive: true });
      const id = randomId("", 16);
      const path = join(incomingDir, id);
      const expiresAt = now().getTime() + uploadTtlMs;
      uploads.set(id, {
        id,
        filename,
        displayName: displayNameFrom(filename, `upload${suffix}`),
        suffix,
        declaredSize,
        expiresAt,
        path,
      });
      return {
        uploadId: id,
        path,
        filename,
        maxBytes: maxUploadBytes,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },

    "source.open": async (params) => {
      const conversationId = conversationIdParam(params);
      await state.read(conversationId);
      if (params.sourceId !== undefined) {
        const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
        const doc = await state.read(conversationId);
        const record = requireStoredSource(doc, sourceId);
        const tables = await ensureOpen(record);
        record.tables = tables;
        return { source: publicSource(record, openIds), sources: sourceView(doc) };
      }
      if (params.uploadId !== undefined) return openUploaded(conversationId, params);
      if (params.kind === undefined) throw invalidParams("'kind' or 'uploadId' or 'sourceId' is required");
      return openRemoteSource(conversationId, params);
    },

    "source.list": async (params) => {
      const conversationId = conversationIdParam(params);
      const doc = await state.read(conversationId);
      return { sources: sourceView(doc) };
    },

    "source.close": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const doc = await state.read(conversationId);
      requireStoredSource(doc, sourceId);
      const wasOpen = openIds.has(sourceId);
      await closeCompute(sourceId);
      return { ok: true, closed: wasOpen, sources: sourceView(doc) };
    },

    "source.remove": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const removed = await state.update(conversationId, (draft) => {
        const index = draft.sources.findIndex((item) => item.id === sourceId);
        if (index < 0) throw appError("not_found", `data source not found: ${sourceId}`);
        const [record] = draft.sources.splice(index, 1);
        // 工作区来源被单独删掉后，挂载记录不能继续指向一个不存在的来源。
        for (const workspace of draft.workspaces) {
          if (workspace.sourceId !== sourceId) continue;
          workspace.sourceId = "";
          workspace.mounted = false;
          workspace.updatedAt = iso();
        }
        return record!;
      });
      await closeCompute(removed.id);
      deleteUploadCopy(removed);
      const doc = await state.read(conversationId);
      return { ok: true, sources: sourceView(doc) };
    },

    /** 对应旧 `DELETE /api/session/<sid>/datasource`：断开并清空本会话的全部来源。 */
    "source.removeAll": async (params) => {
      const conversationId = conversationIdParam(params);
      const removed = await state.update(conversationId, (draft) => {
        const records = draft.sources;
        draft.sources = [];
        for (const workspace of draft.workspaces) {
          workspace.sourceId = "";
          workspace.mounted = false;
          workspace.updatedAt = iso();
        }
        return records;
      });
      for (const record of removed) {
        await closeCompute(record.id);
        deleteUploadCopy(record);
      }
      return { ok: true, removed: removed.length, sources: [] };
    },

    "source.toggle": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const requested = optionalBooleanParam(params, "active");
      const updated = await state.update(conversationId, (draft) => {
        const record = requireStoredSource(draft, sourceId);
        record.active = requested ?? !record.active;
        record.updatedAt = iso();
        return record;
      });
      const doc = await state.read(conversationId);
      return { ok: true, active: updated.active, source: publicSource(updated, openIds), sources: sourceView(doc) };
    },

    "source.update": async (params) => {
      // 改一个已连接来源的连接设置（主机、端口、库名、凭据、名称……）：先用新设置试连，
      // 通过了才保存配置、关掉旧连接并重新打开；试连失败时旧设置原样保留。
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const before = requireStoredSource(await state.read(conversationId), sourceId);
      const kind = before.kind;
      if (before.configId === undefined || !Object.hasOwn(REMOTE_KINDS, kind)) {
        throw invalidReason("这个数据源没有可修改的连接设置", "not_editable");
      }
      const prepared = await prepareRemote(kind as RemoteSourceKind, { ...params, kind, configId: before.configId });
      try {
        await deps.compute.call("source.test", { descriptor: prepared.descriptor });
      } catch (error) {
        throw mapComputeError(error, secretValues(prepared.descriptor));
      }
      const name = prepared.name || before.name;
      await deps.configs.save({
        id: prepared.configId,
        kind: kind as RemoteSourceKind,
        name,
        fields: prepared.fields,
        secret: prepared.secret,
      });
      await closeCompute(sourceId);
      await state.update(conversationId, (draft) => {
        const record = requireStoredSource(draft, sourceId);
        record.name = name;
        record.descriptor = prepared.stored;
        record.updatedAt = iso();
      });
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      record.tables = await ensureOpen(record);
      return { source: publicSource(record, openIds), sources: sourceView(doc) };
    },

    "source.schema": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      await ensureOpen(record);
      const result = await computeCall<{ schema: string }>("source.schema", { source_id: sourceId });
      return { source_id: sourceId, schema: result.schema ?? "" };
    },

    "source.tables": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      await ensureOpen(record);
      const result = await computeCall<{ tables: string[] }>("source.tables", { source_id: sourceId });
      return { source_id: sourceId, tables: result.tables ?? [] };
    },

    /**
     * 数据预览：给 `sourceId` 时只取该来源；否则汇总所有「参与分析」的来源，
     * 与旧 `/preview` 返回的表元信息形状一致（每张表带 source_id/source_name）。
     */
    "source.preview": async (params) => {
      const conversationId = conversationIdParam(params);
      const doc = await state.read(conversationId);
      const single = params.sourceId === undefined
        ? undefined
        : patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      let targets: StoredSource[];
      if (single !== undefined) {
        targets = [requireStoredSource(doc, single)];
      } else {
        targets = doc.sources.filter((record) => record.active);
        if (targets.length === 0) throw appError("not_found", "no data source");
      }
      const tables: JsonValue[] = [];
      let requiresTableSelection = false;
      let sourceName = "";
      for (const record of targets) {
        await ensureOpen(record);
        const preview = await computeCall<{
          source_id?: string;
          source_name?: string;
          requires_table_selection?: boolean;
          tables?: JsonValue[];
        }>("source.preview", { source_id: record.id });
        if (sourceName === "") sourceName = preview.source_name ?? record.name;
        requiresTableSelection = requiresTableSelection || preview.requires_table_selection === true;
        for (const table of preview.tables ?? []) tables.push(table);
      }
      return {
        source_name: sourceName,
        requires_table_selection: requiresTableSelection,
        tables,
        sources: sourceView(doc),
      };
    },

    "source.previewTable": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const table = stringParam(params, "table");
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      await ensureOpen(record);
      const result = await computeCall<Record<string, JsonValue>>("source.previewTable", {
        source_id: sourceId,
        table,
      });
      return result ?? {};
    },

    "source.setAnalysisTables": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const tables = stringArrayParam(params, "tables");
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      await ensureOpen(record);
      const result = await computeCall<{ tables: string[] }>("source.setAnalysisTables", {
        source_id: sourceId,
        tables,
      });
      const selected = result.tables ?? [];
      await state.update(conversationId, (draft) => {
        const target = requireStoredSource(draft, sourceId);
        target.analysisTables = selected;
        target.descriptor = { ...target.descriptor, analysis_tables: selected };
        target.updatedAt = iso();
      });
      return { source_id: sourceId, tables: selected };
    },

    "source.test": async (params) => {
      // 与 source.open 同一套字段与凭据合并，但只在 compute 里试连一次就关，不保存配置也不登记来源。
      const kind = remoteKindParam(params);
      const prepared = await prepareRemote(kind, params);
      try {
        return await deps.compute.call<Record<string, JsonValue>>("source.test", { descriptor: prepared.descriptor });
      } catch (error) {
        throw mapComputeError(error, secretValues(prepared.descriptor));
      }
    },

    // ── 数据源配置（密钥只进不出） ──────────────────────────────────────────

    "source.config.list": async () => ({ configs: await deps.configs.list() }),

    "source.config.save": async (params) => {
      const kind = remoteKindParam(params);
      const id = optionalStringParam(params, "id");
      if (id !== undefined && !CONFIG_ID_PATTERN.test(id)) throw invalidParams("'id' must look like ds_xxxxxxxx");
      const existing = id === undefined ? undefined : await deps.configs.get(id);
      if (existing !== undefined && existing.kind !== kind) {
        throw invalidReason(`配置 ${id} 不是 ${kind} 类型`, "config_kind_mismatch");
      }
      // 只改名/改 URL 时，未提供的字段沿用已保存的值；未提供的密文保持不变。
      const fields = stringMapParam(params, "fields") ?? existing?.fields ?? {};
      const suppliedSecret = stringMapParam(params, "secret");
      const secret = suppliedSecret ?? {};
      const allowedFields = new Set([...NON_SECRET_FIELDS[kind], ...SECRET_FIELDS]);
      for (const name of Object.keys(fields)) {
        if (!allowedFields.has(name)) throw invalidParams(`unsupported field '${name}' for ${kind}`);
      }
      for (const name of Object.keys(secret)) {
        if (!SECRET_FIELDS.includes(name)) throw invalidParams(`'secret.${name}' is not a secret field`);
      }
      const existingSecret = id === undefined ? {} : ((await deps.configs.secret(id)) ?? {});
      requireRemoteConfig(kind, fields, { ...existingSecret, ...secret });
      let config: SourceConfig;
      try {
        config = await deps.configs.save({
          ...(id === undefined ? {} : { id }),
          kind,
          name: optionalStringParam(params, "name"),
          fields,
          // 省略 secret 表示保留现有凭据，而不是清空。
          ...(suppliedSecret === undefined ? {} : { secret }),
        });
      } catch (error) {
        // 存储层的 not-found 是业务错误；其余照原样抛出。
        if (error instanceof Error && error.message.startsWith("data source config not found")) {
          throw appError("not_found", error.message);
        }
        throw error;
      }
      return { config, configs: await deps.configs.list() };
    },

    "source.config.remove": async (params) => {
      const id = patternParam(params, "id", CONFIG_ID_PATTERN, "ds_xxxxxxxx");
      const removed = await deps.configs.remove(id);
      if (!removed) throw appError("not_found", `data source config not found: ${id}`);
      return { ok: true, removed: id, configs: await deps.configs.list() };
    },

    // ── 工作区 ──────────────────────────────────────────────────────────────

    "workspace.list": async (params) => {
      const conversationId = conversationIdParam(params);
      const doc = await state.read(conversationId);
      const current = doc.workspaces.find((record) => record.mounted) ?? null;
      return {
        workspace: current === null ? null : publicWorkspace(current),
        workspaces: doc.workspaces.map(publicWorkspace),
        sources: sourceView(doc),
      };
    },

    "workspace.mount": async (params) => {
      const conversationId = conversationIdParam(params);
      const permission = permissionParam(params, "read_only");
      const checked = validateWorkspacePath(stringParam(params, "path"), {
        projectRoot: deps.projectRoot,
        blockedRoots: deps.blockedWorkspaceRoots,
      });
      if (!checked.ok) throw invalidReason(checked.message, "invalid_workdir");
      const display = optionalStringParam(params, "name")?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
      const doc = await state.read(conversationId);
      const existing = doc.workspaces.find((record) => record.workdir === checked.path);
      const workspaceId = existing?.workspaceId ?? workspaceIdFor(checked.path);
      // 未提供新名字时保留已有记录的名字：重新挂载不该把用户改过的显示名改回目录名。
      const label = (display !== undefined && display !== "" ? display : existing?.name ?? basename(checked.path)).slice(0, 200);
      const sourceId = existing !== undefined && existing.sourceId !== "" ? existing.sourceId : randomId("s_");
      const alreadyOpen = openIds.has(sourceId);

      const syncParams: Record<string, unknown> = {
        workspace_id: workspaceId,
        workdir: checked.path,
        name: `📁 ${label}`,
      };
      // 已打开的持久化连接直接作为导入目标；否则让 compute 只建库，调用方随后 open。
      if (alreadyOpen) syncParams.source_id = sourceId;
      const synced = await computeCall<{
        descriptor: SourceDescriptor;
        tables: string[];
        added?: { source_name: string; tables: string[] }[];
        errors?: string[];
        skipped?: number;
        reused?: number;
      }>("workspace.sync", syncParams);
      const descriptor = synced.descriptor;
      if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
        throw appReason("工作区同步没有返回数据源描述符", "invalid_descriptor");
      }
      const opened = alreadyOpen ? { name: `📁 ${label}`, tables: synced.tables ?? [] } : await openCompute(sourceId, descriptor);
      if (!alreadyOpen) openIds.add(sourceId);

      const stale: string[] = [];
      const result = await state.update(conversationId, (draft) => {
        // 旧实现一次只挂一个工作区：切换时关闭旧工作区的持久化来源。
        for (const record of draft.workspaces) {
          if (!record.mounted || record.workdir === checked.path) continue;
          record.mounted = false;
          record.updatedAt = iso();
          if (record.sourceId !== "") {
            stale.push(record.sourceId);
            draft.sources = draft.sources.filter((source) => source.id !== record.sourceId);
          }
        }
        const priorSource = draft.sources.find((source) => source.id === sourceId);
        const sourceRecord: StoredSource = {
          id: sourceId,
          kind: "workspace_persistent",
          name: opened.name || `📁 ${label}`,
          active: true,
          descriptor,
          tables: opened.tables,
          createdAt: priorSource?.createdAt ?? iso(),
          updatedAt: iso(),
        };
        draft.sources = draft.sources.filter((source) => source.id !== sourceId);
        draft.sources.push(sourceRecord);
        const workspaceRecord: WorkspaceRecord = {
          workspaceId,
          workdir: checked.path,
          name: label,
          permission,
          sourceId,
          mounted: true,
          mountedAt: existing?.mountedAt ?? iso(),
          updatedAt: iso(),
        };
        draft.workspaces = draft.workspaces.filter((record) => record.workspaceId !== workspaceId);
        draft.workspaces.push(workspaceRecord);
        return { workspace: workspaceRecord, sources: sourceView(draft) };
      }).catch(async (error: unknown) => {
        // 文档没写成功时，别在 compute 里留下一个界面看不到的连接。
        if (!alreadyOpen) await closeCompute(sourceId);
        throw error;
      });
      for (const sourceIdToClose of stale) await closeCompute(sourceIdToClose);
      return {
        workspace: publicWorkspace(result.workspace),
        sources: result.sources,
        added: synced.added ?? [],
        errors: synced.errors ?? [],
        skipped: synced.skipped ?? 0,
        reused: synced.reused ?? 0,
      };
    },

    "workspace.unmount": async (params) => {
      const conversationId = conversationIdParam(params);
      const requested = optionalStringParam(params, "workspaceId");
      if (requested !== undefined && !WORKSPACE_ID_PATTERN.test(requested)) {
        throw invalidParams("'workspaceId' must look like ws_<16 hex>");
      }
      const doc = await state.read(conversationId);
      const target = requested === undefined
        ? doc.workspaces.find((record) => record.mounted)
        : doc.workspaces.find((record) => record.workspaceId === requested);
      if (target === undefined) throw invalidReason("未挂载工作目录。", "not_mounted");
      if (!target.mounted) throw invalidReason("未挂载工作目录。", "not_mounted");
      const removedSource = target.sourceId;
      const result = await state.update(conversationId, (draft) => {
        const record = requireWorkspace(draft, target.workspaceId);
        if (record.sourceId !== "") {
          draft.sources = draft.sources.filter((source) => source.id !== record.sourceId);
        }
        record.mounted = false;
        record.sourceId = "";
        record.updatedAt = iso();
        return { workspace: record, sources: sourceView(draft) };
      });
      if (removedSource !== "") await closeCompute(removedSource);
      return { ok: true, workspace: publicWorkspace(result.workspace), sources: result.sources };
    },

    "workspace.rename": async (params) => {
      const conversationId = conversationIdParam(params);
      const workspaceId = patternParam(params, "workspaceId", WORKSPACE_ID_PATTERN, "ws_<16 hex>");
      const raw = stringParam(params, "name");
      if (/[\u0000-\u001f\u007f]/.test(raw)) {
        throw invalidReason("工作目录显示名称长度必须为 1-80 个字符，且不能包含控制字符。", "invalid_workspace_name");
      }
      const name = raw.trim().split(/\s+/).join(" ");
      if (name === "" || name.length > 80) {
        throw invalidReason("工作目录显示名称长度必须为 1-80 个字符，且不能包含控制字符。", "invalid_workspace_name");
      }
      const result = await state.update(conversationId, (draft) => {
        const record = requireWorkspace(draft, workspaceId);
        record.name = name;
        record.updatedAt = iso();
        const source = draft.sources.find((item) => item.id === record.sourceId);
        if (source !== undefined) {
          source.name = `📁 ${name}`;
          // 重开时 compute 用 descriptor 的 name；保持与界面显示名一致。
          source.descriptor = { ...source.descriptor, name: `📁 ${name}` };
        }
        return { workspace: record, workspaces: draft.workspaces.map(publicWorkspace) };
      });
      return { ok: true, workspace: publicWorkspace(result.workspace), workspaces: result.workspaces };
    },

    "workspace.setPermission": async (params) => {
      const conversationId = conversationIdParam(params);
      const workspaceId = patternParam(params, "workspaceId", WORKSPACE_ID_PATTERN, "ws_<16 hex>");
      const permission = permissionParam(params, "read_only");
      if (params.permission === undefined) throw invalidParams("'permission' is required");
      const result = await state.update(conversationId, (draft) => {
        const record = requireWorkspace(draft, workspaceId);
        if (!record.mounted) throw invalidReason("未挂载工作目录。", "not_mounted");
        record.permission = permission;
        record.updatedAt = iso();
        return { workspace: record, workspaces: draft.workspaces.map(publicWorkspace) };
      });
      return { ok: true, workspace: publicWorkspace(result.workspace), workspaces: result.workspaces };
    },

    "workspace.remove": async (params) => {
      const conversationId = conversationIdParam(params);
      const workspaceId = patternParam(params, "workspaceId", WORKSPACE_ID_PATTERN, "ws_<16 hex>");
      if (params.confirmed !== true) throw invalidReason("移除前必须明确确认。", "confirmation_required");
      const doc = await state.read(conversationId);
      const target = requireWorkspace(doc, workspaceId);
      if (target.mounted) throw invalidReason("工作目录仍有会话连接，请先卸载。", "workspace_connected");
      const removedSource = target.sourceId;
      await state.update(conversationId, (draft) => {
        draft.workspaces = draft.workspaces.filter((record) => record.workspaceId !== workspaceId);
        if (removedSource !== "") draft.sources = draft.sources.filter((source) => source.id !== removedSource);
      });
      if (removedSource !== "") await closeCompute(removedSource);
      return {
        ok: true,
        removed_workspace_id: workspaceId,
        // 只隐藏发现记录：物理目录与其中的产物由用户掌握，绝不代删。
        files_deleted: 0,
        directory_deleted: false,
      };
    },

    // ── 产物 ────────────────────────────────────────────────────────────────

    "artifact.list": async (params) => {
      const conversationId = conversationIdParam(params);
      const workspaceId = optionalStringParam(params, "workspaceId");
      if (workspaceId !== undefined && !WORKSPACE_ID_PATTERN.test(workspaceId)) {
        throw invalidParams("'workspaceId' must look like ws_<16 hex>");
      }
      const limit = params.limit === undefined ? 200 : integerParam(params, "limit");
      if (limit < 1 || limit > MAX_ARTIFACT_ENTRIES) throw invalidParams(`'limit' must be 1-${MAX_ARTIFACT_ENTRIES}`);
      const doc = await state.read(conversationId);
      const roots = artifactRoots(doc, workspaceId);
      if (workspaceId !== undefined && roots.length === 0) {
        throw appError("not_found", `workspace not found: ${workspaceId}`);
      }
      const entries: { name: string; path: string; size: number; modified: string; root: string; workspace_id?: string; mtime: number }[] = [];
      for (const root of roots) {
        if (!existsSync(root.path)) continue;
        let dirents;
        try {
          dirents = readdirSync(root.path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const dirent of dirents) {
          if (!dirent.isFile() || dirent.isSymbolicLink()) continue;
          const full = join(root.path, dirent.name);
          let info;
          try {
            info = lstatSync(full);
          } catch {
            continue;
          }
          if (!info.isFile()) continue;
          entries.push({
            name: dirent.name,
            path: full,
            size: info.size,
            modified: info.mtime.toISOString(),
            root: root.label,
            ...(root.workspaceId === undefined ? {} : { workspace_id: root.workspaceId }),
            mtime: info.mtimeMs,
          });
        }
      }
      entries.sort((left, right) => right.mtime - left.mtime);
      return {
        artifacts: entries.slice(0, limit).map(({ mtime, workspace_id, ...rest }) => ({
          ...rest,
          ...(workspace_id === undefined ? {} : { workspace_id }),
        })),
      };
    },

    /**
     * 二进制不进 JSONL：默认只返回元数据与服务端绝对路径，界面（同一台机器）直接读文件；
     * 需要内联的小文本显式传 `as: "text"`，并受 1 MiB 上限约束。
     */
    "artifact.read": async (params) => {
      const conversationId = conversationIdParam(params);
      const as = params.as === undefined ? "path" : params.as;
      if (as !== "path" && as !== "text") throw invalidParams("'as' must be path or text");
      const doc = await state.read(conversationId);
      const resolved = resolveArtifact(doc, params);
      const info = statSync(resolved.path);
      const suffix = suffixOf(resolved.path);
      const base = {
        name: basename(resolved.path),
        path: resolved.path,
        size: info.size,
        modified: info.mtime.toISOString(),
        content_type: ARTIFACT_CONTENT_TYPES[suffix] ?? "application/octet-stream",
        ...(resolved.workspaceId === undefined ? {} : { workspace_id: resolved.workspaceId }),
      };
      if (as !== "text") return base;
      if (info.size > MAX_ARTIFACT_TEXT_BYTES) {
        throw appReason(`产物超过文本读取上限（${Math.floor(MAX_ARTIFACT_TEXT_BYTES / 1024)} KiB），请用路径读取`, "file_too_large");
      }
      return { ...base, text: readFileSync(resolved.path, "utf8") };
    },
  };
}
