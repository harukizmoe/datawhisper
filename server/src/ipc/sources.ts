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

import { say } from "../i18n.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { BitableRead } from "../feishu/bitable.ts";
import { ComputeError, type SourceDescriptor } from "../compute/client.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError, appError, invalidParams } from "./errors.ts";
import { checkParams, CONVERSATION_ID_RULE, SOURCE_ID_RULE, workspaceIdParam, type ParamRules } from "./params.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import {
  ARTIFACT_CONTENT_TYPES,
  CONFIG_ID_PATTERN,
  NON_SECRET_FIELDS,
  SECRET_FIELDS,
  SOURCE_ID_PATTERN,
  WORKSPACE_ID_PATTERN,
  type RemoteSourceKind,
  type SourceConfig,
  type SourceConfigKind,
  type SourceConfigStore,
  type SourceDoc,
  type SourceDocStore,
  type SourceKind,
  type StoredSource,
  displayNameFrom,
  randomId,
  realPath,
  suffixOf,
  validateWorkspacePath,
  within,
} from "./source-store.ts";
import { sqlConfigProblem, sqlConnectionString } from "./sql-connection.ts";
import { isDirectory, workspaceIdFor, type WorkspaceRecord, type WorkspaceStore } from "./workspace-store.ts";

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
  /** 工作区注册表：工作区是全局的，对话只在文档里记 `scope`。 */
  readonly workspaces: WorkspaceStore;
  /** 全部对话 id；判断某个工作区是否还有对话在用。省略时视为没有。 */
  readonly conversationIds?: () => Promise<readonly number[]>;
  /**
   * 飞书多维表格的记录读取。凭据与网络都在 server 一侧，compute 只拿到读好的记录，
   * 因此打开 feishu 来源前必须有这个端口；省略时打开会报「飞书不可用」。
   */
  readonly feishuRecords?: (appToken: string, tableId: string) => Promise<BitableRead>;
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

/** 抓取工具的结果正文：compute 的解析摘要 + 已登记进本会话的来源清单（模型据此知道新的来源 id）。 */
function ingestedText(added: readonly { name: string; tables: readonly string[] }[], computeText: string): string {
  const lines = added.map((item) => `- ${item.name}: ${item.tables.join(", ") || "(no tables)"}`);
  return `${computeText}\n\nAttached to this conversation: \n${lines.join("\n")}`;
}

/** 在已有来源里找一个不重名的显示名：先原名，再 `名 (2)`、`名 (3)`…… */
function uniqueSourceName(existing: readonly StoredSource[], name: string): string {
  const taken = new Set(existing.map((item) => item.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** 工作区显示名：1-80 个字符，无控制字符，连续空白折叠成一个空格。 */
function cleanWorkspaceName(raw: string): string {
  const message = say(
    "The working directory display name must be 1-80 characters and cannot contain control characters.",
    "工作目录显示名称长度必须为 1-80 个字符，且不能包含控制字符。",
  );
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw invalidReason(message, "invalid_workspace_name");
  const name = raw.trim().split(/\s+/).join(" ");
  if (name === "" || name.length > 80) throw invalidReason(message, "invalid_workspace_name");
  return name;
}

const MAX_WORKSPACE_INSTRUCTIONS = 8000;

/** 工作区说明：可以多行，但不能含 NUL，长度有上限（它会并入每一轮的系统提示）。 */
function cleanWorkspaceInstructions(raw: string): string {
  if (raw.includes("\u0000") || raw.length > MAX_WORKSPACE_INSTRUCTIONS) {
    throw invalidReason(
      say(`Workspace instructions must be at most ${MAX_WORKSPACE_INSTRUCTIONS} characters.`, `工作区说明最多 ${MAX_WORKSPACE_INSTRUCTIONS} 个字符。`),
      "invalid_workspace_instructions",
    );
  }
  return raw.trim();
}

/** `current` 是发起请求的对话所属的工作区 id（没有或不在工作区时为 undefined）。 */
function publicWorkspace(record: WorkspaceRecord, current: string | undefined): Record<string, JsonValue> {
  return {
    workspace_id: record.workspaceId,
    workdir: record.workdir,
    name: record.name,
    instructions: record.instructions,
    source_id: record.sourceId,
    available: isDirectory(record.workdir),
    current: record.workspaceId === current,
    last_synced_at: record.lastSyncedAt,
    updated_at: record.updatedAt,
  };
}

function requireStoredSource(doc: SourceDoc, sourceId: string): StoredSource {
  const record = doc.sources.find((item) => item.id === sourceId);
  if (record === undefined) throw appError("not_found", `data source not found: ${sourceId}`);
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
    if (!has("spreadsheet")) throw invalidReason(say("Spreadsheet URL or ID cannot be empty", "电子表格 URL 或 ID 不能为空"), "missing_spreadsheet");
    if (!has("creds_json")) throw invalidReason(say("Service account JSON cannot be empty", "服务账号 JSON 不能为空"), "missing_credentials");
    const raw = secret.creds_json ?? fields.creds_json ?? "";
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    } catch {
      throw invalidReason(say("Service account JSON is invalid", "服务账号 JSON 格式无效"), "invalid_credentials");
    }
    return;
  }
  if (kind === "feishu") {
    if (!has("bitable")) {
      throw invalidReason(say("Feishu Bitable link or app_token cannot be empty", "飞书多维表格链接或 app_token 不能为空"), "missing_bitable");
    }
    return;
  }
  if (!has("url")) throw invalidReason(say("API URL cannot be empty", "API URL 不能为空"), "missing_url");
  const url = fields.url ?? secret.url ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidReason(say("API URL is invalid", "API URL 格式无效"), "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidReason(say("API URL only supports http/https", "API URL 只支持 http/https"), "invalid_url");
  }
  const authType = fields.auth_type ?? "none";
  if (authType !== "none" && authType !== "bearer" && authType !== "api_key") {
    throw invalidReason(say("Invalid auth type; supported: none / bearer / api_key", "认证方式无效，支持: none / bearer / api_key"), "invalid_auth_type");
  }
  if (authType !== "none" && !has("auth_value")) {
    throw invalidReason(say("Auth value cannot be empty", "认证值不能为空"), "missing_auth_value");
  }
}

/** 解析飞书多维表格引用：完整链接里取 app_token 与 `?table=`，否则按 app_token 处理。 */
function parseBitableReference(value: string, table: string | undefined): { appToken: string; tableId: string } {
  const raw = value.trim();
  if (raw === "") throw invalidReason(say("Feishu Bitable link or app_token cannot be empty", "飞书多维表格链接或 app_token 不能为空"), "missing_bitable");
  let appToken = raw;
  let tableId = table?.trim() ?? "";
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw invalidReason(say("Feishu Bitable link is invalid", "飞书多维表格链接格式无效"), "invalid_bitable");
    }
    const match = /\/base\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
    if (match === null) throw invalidReason(say("Feishu Bitable link is invalid", "飞书多维表格链接格式无效"), "invalid_bitable");
    appToken = match[1]!;
    tableId = tableId === "" ? (parsed.searchParams.get("table") ?? "") : tableId;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(appToken)) {
    throw invalidReason(say("Feishu Bitable app_token is invalid", "飞书多维表格 app_token 格式无效"), "invalid_bitable");
  }
  if (tableId === "") {
    // 旧实现会调用飞书接口列出所有表让用户选；compute 侧还没有对应方法（见报告「未迁移项」）。
    throw invalidReason(say("Provide table_id (listing tables requires a new compute-side method)", "请提供 table_id（表选择列表需要 compute 侧新增方法）"), "missing_table");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(tableId)) {
    throw invalidReason(say("Feishu Bitable table_id is invalid", "飞书多维表格 table_id 格式无效"), "invalid_bitable");
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

/** 装配期填进来的抓取/飞书端口：工具拿不到会话文档与 compute，只有这里能安全地登记来源。 */
export type IngestPortHolder = { ingest?: import("../tools/app/types.ts").IngestPort };

export function sourceMethods(deps: SourcesDeps, ports: IngestPortHolder = {}): Record<string, RpcMethod> {
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
    let outgoing = descriptor;
    if (descriptor.kind === "feishu") {
      try {
        if (deps.feishuRecords === undefined) throw new Error(say("Feishu is not available", "飞书不可用"));
        const read = await deps.feishuRecords(String(descriptor.app_token ?? ""), String(descriptor.table_id ?? ""));
        outgoing = { ...descriptor, records: read.records };
      } catch (error) {
        throw appReason(error instanceof Error ? error.message : String(error), "open_failed");
      }
    }
    try {
      return await deps.compute.openSource(sourceId, outgoing);
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
          throw appReason(say("Service account JSON is invalid", "服务账号 JSON 格式无效"), "invalid_credentials");
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

  /** 抓取/飞书工具要的 compute 上下文：本会话参与分析的来源与工作区信息。 */
  const ingestContext = async (conversationId: number): Promise<Record<string, JsonValue>> => {
    const doc = await state.read(conversationId);
    const active = doc.sources.filter((source) => source.active);
    const tables: Record<string, JsonValue> = {};
    for (const source of active) tables[source.id] = [...(source.tables ?? [])];
    const workspace =
      doc.scope?.kind === "workspace" ? await deps.workspaces.get(doc.scope.workspaceId) : undefined;
    return {
      sources: active.map((source) => source.id),
      ...(active.length === 0 ? {} : { primary: active[0]!.id }),
      tables,
      ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId, workspaceRoot: workspace.workdir }),
    };
  };

  /** 把落盘的 CSV 逐张登记成会话来源；返回界面里看到的表名。 */
  const registerCsvFiles = async (
    conversationId: number,
    sourceName: string,
    files: readonly string[],
  ): Promise<{ name: string; tables: readonly string[] }[]> => {
    const added: { name: string; tables: readonly string[] }[] = [];
    for (const file of files) {
      const sourceId = randomId("s_");
      const descriptor: SourceDescriptor = { kind: "csv", file_path: file };
      const opened = await openCompute(sourceId, descriptor);
      openIds.add(sourceId);
      const fallback = basename(file).replace(/\.[^.]+$/u, "");
      const record: StoredSource = {
        id: sourceId,
        kind: "csv",
        name: sourceName === "" ? fallback : sourceName,
        active: true,
        descriptor,
        uploadPath: file,
        tables: opened.tables,
        createdAt: iso(),
        updatedAt: iso(),
      };
      await appendSource(conversationId, record);
      added.push({ name: record.name, tables: opened.tables });
    }
    return added;
  };

  /** 让 compute 把抓来的内容解析成表并落成 CSV（内存 source 重启就没了，文件才留得住）。 */
  const dumpIngest = async (
    conversationId: number,
    method: "tool.fetch_table_parse" | "tool.load_feishu_bitable",
    params: Record<string, unknown>,
  ): Promise<{ files: string[]; text: string }> => {
    const scratch = randomId("s_");
    const dumpDir = join(incomingDir, scratch);
    try {
      const result = await deps.compute.call<{ text: string; files?: string[] }>(method, {
        context: await ingestContext(conversationId),
        source_id: scratch,
        dump_dir: dumpDir,
        ...params,
      });
      return { files: result.files ?? [], text: result.text };
    } finally {
      // 这次解析用的内存 source 只为拿表；表已经写成 CSV，下面按文件来源重新登记。
      await deps.compute.closeSource(scratch).catch(() => undefined);
    }
  };

  ports.ingest = {
    async fetchTables(conversationId, request) {
      const dumped = await dumpIngest(conversationId, "tool.fetch_table_parse", {
        content_type: request.contentType,
        body_base64: Buffer.from(request.body).toString("base64"),
        args: { url: request.url, source_name: request.sourceName ?? "" },
      });
      if (dumped.files.length === 0) return { added: [], text: dumped.text };
      const added = await registerCsvFiles(conversationId, request.sourceName ?? "", dumped.files);
      return { added, text: ingestedText(added, dumped.text) };
    },
    async loadBitable(conversationId, read, sourceName) {
      const dumped = await dumpIngest(conversationId, "tool.load_feishu_bitable", {
        records: read,
        args: { bitable: read.url, source_name: sourceName ?? "" },
      });
      if (dumped.files.length === 0) return { added: [], text: dumped.text };
      const added = await registerCsvFiles(conversationId, sourceName ?? "", dumped.files);
      return { added, text: ingestedText(added, dumped.text) };
    },
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

  /**
   * 连接配置是全应用共享的：同一份配置在所有会话里用同一个来源 id。会话文档里没有它的记录时，
   * 面板仍然列出来（未启用），启用后才登记进该会话的文档。
   */
  const sharedSourceId = (configId: string): string => `s_${createHash("sha256").update(configId).digest("hex").slice(0, 8)}`;

  const sharedRecordFor = (config: SourceConfig): StoredSource => ({
    id: sharedSourceId(config.id),
    kind: config.kind as SourceKind,
    name: config.name,
    active: false,
    descriptor: { kind: config.kind, ...config.fields },
    configId: config.id,
    tables: [],
    createdAt: config.updatedAt,
    updatedAt: iso(),
  });

  /** 会话里已经登记的记录 + 还没启用的共享连接（按配置顺序）。 */
  const mergedView = async (doc: SourceDoc): Promise<Record<string, JsonValue>[]> => {
    const known = new Set(doc.sources.map((record) => record.configId).filter((id): id is string => id !== undefined));
    const pending = (await deps.configs.list()).filter((config) => !known.has(config.id)).map(sharedRecordFor);
    return [...doc.sources, ...pending].map((record) => publicSource(record, openIds));
  };

  /** 在文档里找到记录；找不到但它是共享连接的虚拟条目时，按配置补登记一条（未启用）。 */
  const ensureRecordFor = async (conversationId: number, sourceId: string): Promise<StoredSource> => {
    const configs = await deps.configs.list();
    return state.update(conversationId, (draft) => {
      const existing = draft.sources.find((item) => item.id === sourceId);
      if (existing !== undefined) return existing;
      const config = configs.find((item) => sharedSourceId(item.id) === sourceId);
      if (config === undefined) throw appError("not_found", `data source not found: ${sourceId}`);
      const record = sharedRecordFor(config);
      draft.sources.push(record);
      return record;
    });
  };

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

  // ── 工作区 ────────────────────────────────────────────────────────────────

  /** 共享来源的描述符：库文件固定在 `<目录>/.zhixi/workspace.duckdb`，所以随时可以重建。 */
  const workspaceDescriptor = (record: WorkspaceRecord): SourceDescriptor => ({
    kind: "workspace_persistent",
    db_path: join(record.workdir, ".zhixi", "workspace.duckdb"),
    name: record.name,
  });

  type WorkspaceSync = {
    descriptor: SourceDescriptor;
    tables: string[];
    added?: { source_name: string; tables: string[] }[];
    errors?: string[];
    skipped?: number;
    reused?: number;
  };

  const requireWorkspaceRecord = async (workspaceId: string): Promise<WorkspaceRecord> => {
    const record = await deps.workspaces.get(workspaceId);
    if (record === undefined) throw appError("not_found", `workspace not found: ${workspaceId}`);
    return record;
  };

  const requireAvailable = (record: WorkspaceRecord): void => {
    if (!isDirectory(record.workdir)) {
      throw appReason(say(`The workspace directory is not available: ${record.workdir}`, `工作区目录不可用：${record.workdir}`), "workspace_unavailable");
    }
  };

  /** 发起请求的对话所属的工作区 id；请求没带 `conversationId` 或对话不在工作区时为 undefined。 */
  const currentWorkspaceId = async (params: MethodParams): Promise<string | undefined> => {
    if (params.conversationId === undefined) return undefined;
    const scope = (await state.read(conversationIdParam(params))).scope;
    return scope?.kind === "workspace" ? scope.workspaceId : undefined;
  };

  /** 把目录里的数据文件增量导入持久化库，并在尚未打开时打开它；成功后写回注册表。 */
  const syncWorkspace = async (record: WorkspaceRecord, paths?: readonly string[]) => {
    const alreadyOpen = record.sourceId !== "" && openIds.has(record.sourceId);
    const sourceId = record.sourceId !== "" ? record.sourceId : randomId("s_");
    const syncParams: Record<string, unknown> = {
      workspace_id: record.workspaceId,
      workdir: record.workdir,
      name: record.name,
    };
    // 已打开的持久化连接直接作为导入目标；否则让 compute 只建库，随后再 open。
    if (alreadyOpen) syncParams.source_id = sourceId;
    // 指定文件时只导入这几项（workspace.importFiles）；不给就是整理目录。
    if (paths !== undefined) syncParams.paths = paths;
    const synced = await computeCall<WorkspaceSync>("workspace.sync", syncParams);
    const descriptor = synced.descriptor;
    if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
      throw appReason(say("Workspace sync returned no data source descriptor", "工作区同步没有返回数据源描述符"), "invalid_descriptor");
    }
    const opened = alreadyOpen
      ? { name: record.name, tables: synced.tables ?? [] }
      : await openCompute(sourceId, descriptor);
    if (!alreadyOpen) openIds.add(sourceId);
    const next: WorkspaceRecord = { ...record, sourceId, lastSyncedAt: iso() };
    try {
      await deps.workspaces.put(next);
    } catch (error) {
      // 注册表没写成功时，别在 compute 里留下一个无人登记的连接。
      if (!alreadyOpen) await closeCompute(sourceId);
      throw error;
    }
    return { record: next, synced, tables: opened.tables };
  };

  /** 保证共享来源在 compute 里已打开，但不重新导入文件；库文件被删或打不开时重建。 */
  const ensureWorkspaceOpen = async (record: WorkspaceRecord): Promise<{ record: WorkspaceRecord; tables: string[] }> => {
    if (record.sourceId !== "" && openIds.has(record.sourceId)) {
      const listed = await computeCall<{ tables: string[] }>("source.tables", { source_id: record.sourceId });
      return { record, tables: listed.tables };
    }
    if (record.sourceId !== "") {
      try {
        const opened = await openCompute(record.sourceId, workspaceDescriptor(record));
        openIds.add(record.sourceId);
        return { record, tables: opened.tables };
      } catch {
        // 库文件被删或打不开：下面重新导入一遍。
      }
    }
    const synced = await syncWorkspace(record);
    return { record: synced.record, tables: synced.tables };
  };

  const workspaceSourceRecord = (record: WorkspaceRecord, tables: string[], existing?: StoredSource): StoredSource => ({
    id: record.sourceId,
    kind: "workspace_persistent",
    name: record.name,
    active: true,
    descriptor: workspaceDescriptor(record),
    tables,
    createdAt: existing?.createdAt ?? iso(),
    updatedAt: iso(),
  });

  const artifactRoots = async (doc: SourceDoc, workspaceId?: string): Promise<{ label: string; path: string; workspaceId?: string }[]> => {
    const roots: { label: string; path: string; workspaceId?: string }[] = [];
    if (doc.scope?.kind === "workspace" && (workspaceId === undefined || workspaceId === doc.scope.workspaceId)) {
      const record = await deps.workspaces.get(doc.scope.workspaceId);
      if (record !== undefined) {
        roots.push({
          label: record.name || basename(record.workdir),
          path: join(record.workdir, "artifacts"),
          workspaceId: record.workspaceId,
        });
      }
    }
    if (workspaceId === undefined) roots.push({ label: "exports", path: exportsDir });
    return roots;
  };

  const resolveArtifact = async (doc: SourceDoc, params: MethodParams): Promise<{ path: string; workspaceId?: string }> => {
    const name = optionalStringParam(params, "name");
    const rawPath = optionalStringParam(params, "path");
    if (name === undefined && rawPath === undefined) throw invalidParams("'name' or 'path' is required");
    if (name !== undefined && rawPath !== undefined) throw invalidParams("'name' and 'path' are mutually exclusive");
    const roots = await artifactRoots(doc);
    if (name !== undefined) {
      if (name.length > 255 || name.includes("\u0000") || /[\\/]/.test(name) || name === "." || name === "..") {
        throw invalidReason(say("Invalid artifact name", "产物名不合法"), "invalid_artifact_name");
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
      throw invalidReason(say("Artifact path must be absolute", "产物路径必须是绝对路径"), "invalid_artifact_path");
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
      if (!info.isFile()) throw invalidReason(say("Artifact path is not a file", "产物路径不是文件"), "invalid_artifact_path");
      return { path: real, workspaceId: root.workspaceId };
    }
    throw invalidReason(say("Artifact is outside the allowed directories", "产物不在允许的目录内"), "artifact_outside_root");
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
      if (config.kind !== kind) throw invalidReason(say(`Config ${explicitConfigId} is not of type ${kind}`, `配置 ${explicitConfigId} 不是 ${kind} 类型`), "config_kind_mismatch");
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
        throw invalidReason(say("Service account JSON is invalid", "服务账号 JSON 格式无效"), "invalid_credentials");
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

  /**
   * 记录一条新来源；返回更新后的来源列表。
   * 同一会话里名字重复时自动加后缀（`a.csv (2)`）：同一个文件导入两次，界面和 agent 的 schema 里
   * 才分得清是哪一份。用户之后自己改名不受这条限制。
   */
  const appendSource = async (conversationId: number, record: StoredSource): Promise<Record<string, JsonValue>[]> => {
    return state.update(conversationId, (draft) => {
      record.name = uniqueSourceName(draft.sources, record.name);
      draft.sources.push(record);
      return sourceView(draft);
    });
  };

  const openUploaded = async (conversationId: number, params: MethodParams): Promise<Record<string, JsonValue>> => {
    const uploadId = patternParam(params, "uploadId", UPLOAD_ID_PATTERN, say("32 hex characters", "32 位十六进制"));
    const ticket = uploads.get(uploadId);
    if (ticket === undefined) throw invalidReason(say("Upload ticket is invalid or expired; upload again", "上传凭据无效或已过期，请重新上传"), "unknown_upload");
    uploads.delete(uploadId);
    if (ticket.expiresAt <= now().getTime()) {
      try {
        unlinkSync(ticket.path);
      } catch {
        // 过期文件可能已被回收。
      }
      throw invalidReason(say("Upload ticket has expired; upload again", "上传凭据已过期，请重新上传"), "upload_expired");
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
      return reject(invalidReason(say("The uploaded file does not exist; upload again", "上传文件不存在，请重新上传"), "upload_missing"));
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return reject(invalidReason(say("Upload target must be a regular file", "上传目标必须是普通文件"), "upload_not_file"));
    const real = realpathSync.native(ticket.path);
    if (!within(realPath(incomingDir), real)) return reject(invalidReason(say("Upload path is outside the allowed directory", "上传路径越界"), "upload_outside_root"));
    if (stats.size !== ticket.declaredSize) {
      return reject(invalidReason(say(`The uploaded file size does not match the declared size (declared ${ticket.declaredSize}, actual ${stats.size})`, `上传文件大小与声明不一致（声明 ${ticket.declaredSize}，实际 ${stats.size}）`), "upload_size_mismatch"));
    }
    if (stats.size === 0) return reject(invalidReason(say("The file is empty", "文件为空"), "empty_file"));
    if (stats.size > maxUploadBytes) {
      return reject(invalidReason(say(`The file exceeds the size limit (${Math.floor(maxUploadBytes / (1024 * 1024))} MiB)`, `文件超过大小上限（${Math.floor(maxUploadBytes / (1024 * 1024))} MiB）`), "file_too_large"));
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
        throw appReason(say("Upload parsing returned no data source descriptor", "上传解析没有返回数据源描述符"), "invalid_descriptor");
      }
      const kind = descriptor.kind;
      if (kind !== "csv" && kind !== "excel" && kind !== "pdf") {
        throw appReason(say(`Unsupported data source type: ${String(kind)}`, `不支持的数据源类型：${String(kind)}`), "invalid_descriptor");
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
    const before = new Set((await deps.configs.list()).map((config) => config.id));
    // 先落配置：连接信息要跨会话、跨重启保留；共享来源的 id 由配置 id 派生。
    const saved = await deps.configs.save({
      id: prepared.configId,
      kind,
      name: prepared.name,
      fields: prepared.fields,
      secret: prepared.secret,
    });
    const created = !before.has(saved.id);
    const sourceId = sharedSourceId(saved.id);
    // compute 里按来源 id 只打开一次；别的会话已经打开时直接沿用。
    let opened: { name: string; tables: string[] };
    try {
      opened = openIds.has(sourceId) ? { name: saved.name, tables: [] } : await openCompute(sourceId, prepared.descriptor);
    } catch (error) {
      // 连不上时不能留下空配置：下次打开同一个连接会以为已经配好了。
      if (created) await deps.configs.remove(saved.id).catch(() => undefined);
      throw error;
    }
    openIds.add(sourceId);
    try {
      const existing = await state.read(conversationId);
      const record = existing.sources.find((item) => item.id === sourceId);
      if (record !== undefined) {
        const updated = await state.update(conversationId, (draft) => {
          const item = draft.sources.find((candidate) => candidate.id === sourceId);
          if (item !== undefined) {
            item.active = true;
            if (opened.tables.length > 0) item.tables = opened.tables;
            item.updatedAt = iso();
            return item;
          }
          return record;
        });
        const doc = await state.read(conversationId);
        return { source: publicSource(updated, openIds), sources: await mergedView(doc), configId: saved.id };
      }
      const stored: StoredSource = {
        id: sourceId,
        kind,
        name: saved.name || opened.name,
        active: true,
        descriptor: prepared.stored,
        configId: saved.id,
        tables: opened.tables,
        createdAt: iso(),
        updatedAt: iso(),
      };
      const sources = await appendSource(conversationId, stored);
      return { source: publicSource(stored, openIds), sources, configId: saved.id };
    } catch (error) {
      // 登记失败时把刚打开的 compute 来源关掉；新建的配置也删掉，避免留下空配置。
      openIds.delete(sourceId);
      await closeCompute(sourceId);
      if (created) await deps.configs.remove(saved.id).catch(() => undefined);
      throw error;
    }
  };

  // 入参形状集中声明：方法体里仍做语义检查（来源是否存在、配置是否匹配），这里只挡形状。
  const SHAPES: Record<string, ParamRules> = {
    "source.list": { conversationId: CONVERSATION_ID_RULE },
    "source.removeAll": { conversationId: CONVERSATION_ID_RULE },
    "source.open": { conversationId: CONVERSATION_ID_RULE },
    "source.close": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.remove": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.toggle": {
      conversationId: CONVERSATION_ID_RULE,
      sourceId: SOURCE_ID_RULE,
      active: { type: "boolean", optional: true, message: "'active' must be a boolean" },
    },
    "source.rename": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.schema": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.tables": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    // 不带 sourceId 时是「所有参与分析的来源」的汇总预览，所以这个 id 是可选的。
    "source.preview": { conversationId: CONVERSATION_ID_RULE, sourceId: { ...SOURCE_ID_RULE, optional: true } },
    "source.previewTable": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.setAnalysisTables": { conversationId: CONVERSATION_ID_RULE, sourceId: SOURCE_ID_RULE },
    "source.upload.begin": {
      conversationId: CONVERSATION_ID_RULE,
      filename: { type: "string", minLength: 1, message: "'filename' must be a non-empty string" },
      size: { type: "integer", message: "'size' must be an integer" },
    },
  };

  const methods: Record<string, RpcMethod> = {
    "source.upload.begin": async (params) => {
      const conversationId = conversationIdParam(params);
      await state.read(conversationId);
      sweepUploads();
      const filename = stringParam(params, "filename");
      const suffix = suffixOf(filename);
      if (UPLOAD_SUFFIXES[suffix] !== true) {
        throw invalidReason(say("Only .xlsx / .xls / .csv / .pdf files are supported", "仅支持 .xlsx / .xls / .csv / .pdf 文件"), "unsupported_format");
      }
      const declaredSize = integerParam(params, "size");
      if (declaredSize <= 0) throw invalidReason(say("The file is empty", "文件为空"), "empty_file");
      if (declaredSize > maxUploadBytes) {
        throw invalidReason(say(`The file exceeds the size limit (${Math.floor(maxUploadBytes / (1024 * 1024))} MiB)`, `文件超过大小上限（${Math.floor(maxUploadBytes / (1024 * 1024))} MiB）`), "file_too_large");
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
        const record = await ensureRecordFor(conversationId, sourceId);
        const tables = await ensureOpen(record);
        record.tables = tables;
        const doc = await state.read(conversationId);
        return { source: publicSource(record, openIds), sources: await mergedView(doc) };
      }
      if (params.uploadId !== undefined) return openUploaded(conversationId, params);
      if (params.kind === undefined) throw invalidParams("'kind' or 'uploadId' or 'sourceId' is required");
      return openRemoteSource(conversationId, params);
    },

    "source.list": async (params) => {
      const conversationId = conversationIdParam(params);
      const doc = await state.read(conversationId);
      return { sources: await mergedView(doc) };
    },

    "source.close": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const doc = await state.read(conversationId);
      const record = requireStoredSource(doc, sourceId);
      const wasOpen = openIds.has(sourceId);
      if (record.configId === undefined) {
        await closeCompute(sourceId);
        return { ok: true, closed: wasOpen, sources: await mergedView(doc) };
      }
      // 连接配置是全应用共享的：关掉会波及别的会话，所以这里只在本会话停用。
      await state.update(conversationId, (draft) => {
        const item = draft.sources.find((candidate) => candidate.id === sourceId);
        if (item !== undefined) {
          item.active = false;
          item.updatedAt = iso();
        }
      });
      return { ok: true, closed: true, sources: await mergedView(await state.read(conversationId)) };
    },

    "source.remove": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const removed = await state.update(conversationId, (draft) => {
        const index = draft.sources.findIndex((item) => item.id === sourceId);
        if (index < 0) throw appError("not_found", `data source not found: ${sourceId}`);
        if (draft.sources[index]!.kind === "workspace_persistent") {
          throw invalidReason(
            say("The workspace data belongs to the workspace and cannot be removed from one conversation.", "工作区数据属于工作区，不能从单个对话里移除。"),
            "workspace_source",
          );
        }
        const [record] = draft.sources.splice(index, 1);
        return record!;
      });
      // 共享连接属于配置，不随一个会话移除：配置还在，别的会话照用，本会话下次列出来是未启用状态。
      if (removed.configId === undefined) {
        await closeCompute(removed.id);
        deleteUploadCopy(removed);
      }
      const doc = await state.read(conversationId);
      return { ok: true, sources: await mergedView(doc) };
    },

    /** 对应旧 `DELETE /api/session/<sid>/datasource`：断开并清空本会话的全部来源。 */
    "source.removeAll": async (params) => {
      const conversationId = conversationIdParam(params);
      const removed = await state.update(conversationId, (draft) => {
        // 工作区的共享来源属于工作区，不随「清空来源」一起删。
        const records = draft.sources.filter((item) => item.kind !== "workspace_persistent");
        draft.sources = draft.sources.filter((item) => item.kind === "workspace_persistent");
        return records;
      });
      for (const record of removed) {
        if (record.configId !== undefined) continue;
        await closeCompute(record.id);
        deleteUploadCopy(record);
      }
      return { ok: true, removed: removed.length, sources: await mergedView(await state.read(conversationId)) };
    },

    "source.toggle": async (params) => {
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const requested = optionalBooleanParam(params, "active");
      const current = await ensureRecordFor(conversationId, sourceId);
      const next = requested ?? !current.active;
      // 共享连接在第一次启用时打开：compute 里按来源 id 打开一次，所有会话都用同一份。
      if (next && !openIds.has(sourceId)) {
        const record = await state.update(conversationId, (draft) => {
          const item = draft.sources.find((candidate) => candidate.id === sourceId);
          if (item === undefined) throw appError("not_found", `data source not found: ${sourceId}`);
          return item;
        });
        const tables = await ensureOpen(structuredClone(record));
        await state.update(conversationId, (draft) => {
          const item = draft.sources.find((candidate) => candidate.id === sourceId);
          if (item !== undefined) item.tables = tables;
        });
      }
      const updated = await state.update(conversationId, (draft) => {
        const item = draft.sources.find((candidate) => candidate.id === sourceId);
        if (item === undefined) throw appError("not_found", `data source not found: ${sourceId}`);
        item.active = next;
        item.updatedAt = iso();
        return item;
      });
      const doc = await state.read(conversationId);
      return { ok: true, active: updated.active, source: publicSource(updated, openIds), sources: await mergedView(doc) };
    },

    "source.rename": async (params) => {
      // 只改界面里显示的来源名；连接设置的修改走 source.update。文件来源也能改名。
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const name = stringParam(params, "name");
      if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
        throw invalidReason(say("The name must be at most 200 characters and cannot contain control characters", "名称最多 200 个字符，且不能含控制字符"), "invalid_name");
      }
      await state.update(conversationId, (draft) => {
        const record = requireStoredSource(draft, sourceId);
        record.name = name;
        record.updatedAt = iso();
      });
      const doc = await state.read(conversationId);
      return { source: publicSource(requireStoredSource(doc, sourceId), openIds), sources: sourceView(doc) };
    },

    "source.update": async (params) => {
      // 改一个已连接来源的连接设置（主机、端口、库名、凭据、名称……）：先用新设置试连，
      // 通过了才保存配置、关掉旧连接并重新打开；试连失败时旧设置原样保留。
      const conversationId = conversationIdParam(params);
      const sourceId = patternParam(params, "sourceId", SOURCE_ID_PATTERN, "s_xxxxxxxx");
      const before = requireStoredSource(await state.read(conversationId), sourceId);
      const kind = before.kind;
      if (before.configId === undefined || !Object.hasOwn(REMOTE_KINDS, kind)) {
        throw invalidReason(say("This data source has no editable connection settings", "这个数据源没有可修改的连接设置"), "not_editable");
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
        // 显示名以本会话里存的为准：重命名只改存储记录，compute 那边报告的仍是打开时的旧名。
        if (sourceName === "") sourceName = record.name;
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
        // 来源视图里的表清单就是 agent 看得到的表：不同步的话选完表卡片仍写「还没选数据表」。
        target.tables = selected;
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
        throw invalidReason(say(`Config ${id} is not of type ${kind}`, `配置 ${id} 不是 ${kind} 类型`), "config_kind_mismatch");
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
      const current = await currentWorkspaceId(params);
      const records = await deps.workspaces.list();
      const active = records.find((record) => record.workspaceId === current);
      return {
        workspace: active === undefined ? null : publicWorkspace(active, current),
        workspaces: records.map((record) => publicWorkspace(record, current)),
      };
    },

    /** 登记一个目录并导入其中的数据文件；同一目录已登记过时原样返回，不重复导入。 */
    "workspace.create": async (params) => {
      const checked = validateWorkspacePath(stringParam(params, "path"), {
        projectRoot: deps.projectRoot,
        blockedRoots: deps.blockedWorkspaceRoots,
      });
      if (!checked.ok) throw invalidReason(checked.message, "invalid_workdir");
      const workspaceId = workspaceIdFor(checked.path);
      const existing = await deps.workspaces.get(workspaceId);
      if (existing !== undefined) {
        return { existing: true, workspace: publicWorkspace(existing, undefined), added: [], errors: [], skipped: 0, reused: 0 };
      }
      const display = optionalStringParam(params, "name");
      const instructions = optionalStringParam(params, "instructions");
      const stamp = iso();
      const base: WorkspaceRecord = {
        workspaceId,
        workdir: checked.path,
        name: cleanWorkspaceName(display === undefined || display.trim() === "" ? basename(checked.path).slice(0, 80) : display),
        instructions: instructions === undefined ? "" : cleanWorkspaceInstructions(instructions),
        sourceId: "",
        lastSyncedAt: "",
        createdAt: stamp,
        updatedAt: stamp,
      };
      const result = await syncWorkspace(base);
      return {
        existing: false,
        workspace: publicWorkspace(result.record, undefined),
        added: result.synced.added ?? [],
        errors: result.synced.errors ?? [],
        skipped: result.synced.skipped ?? 0,
        reused: result.synced.reused ?? 0,
      };
    },

    "workspace.update": async (params) => {
      const record = await requireWorkspaceRecord(workspaceIdParam(params));
      const next: WorkspaceRecord = { ...record, updatedAt: iso() };
      if (params.name !== undefined) next.name = cleanWorkspaceName(stringParam(params, "name"));
      if (params.instructions !== undefined) {
        if (typeof params.instructions !== "string") throw invalidParams("'instructions' must be a string");
        next.instructions = cleanWorkspaceInstructions(params.instructions);
      }
      await deps.workspaces.put(next);
      // 请求方对话文档里的共享来源跟着改显示名；其他对话下次进入时刷新。
      if (params.name !== undefined && params.conversationId !== undefined && next.sourceId !== "") {
        await state.update(conversationIdParam(params), (draft) => {
          const source = draft.sources.find((item) => item.id === next.sourceId);
          if (source === undefined) return;
          source.name = next.name;
          // 重开时 compute 用 descriptor 的 name；保持与界面显示名一致。
          source.descriptor = { ...source.descriptor, name: next.name };
        });
      }
      const current = await currentWorkspaceId(params);
      return {
        ok: true,
        workspace: publicWorkspace(next, current),
        workspaces: (await deps.workspaces.list()).map((item) => publicWorkspace(item, current)),
      };
    },

    /** 重新导入目录里新增或变化的数据文件（刷新）。 */
    "workspace.sync": async (params) => {
      const record = await requireWorkspaceRecord(workspaceIdParam(params));
      requireAvailable(record);
      const result = await syncWorkspace(record);
      const current = await currentWorkspaceId(params);
      return {
        ok: true,
        workspace: publicWorkspace(result.record, current),
        tables: result.tables,
        added: result.synced.added ?? [],
        errors: result.synced.errors ?? [],
        skipped: result.synced.skipped ?? 0,
        reused: result.synced.reused ?? 0,
      };
    },

    /** 建对话之前先确认工作区可用、共享来源已打开：失败时不会留下一个空对话。 */
    /** 只导入指定文件（界面里的「Import」）；路径是相对工作区根的文件名。 */
    "workspace.importFiles": async (params) => {
      const record = await requireWorkspaceRecord(workspaceIdParam(params));
      requireAvailable(record);
      const raw = params.paths;
      if (!Array.isArray(raw) || raw.length === 0) throw invalidParams("'paths' must be a non-empty array");
      if (raw.length > 200) throw invalidParams("'paths' accepts at most 200 files");
      const paths = raw.map((item) => {
        if (typeof item !== "string") throw invalidParams("'paths' must contain only strings");
        const rel = item.replace(/\\/g, "/").trim();
        if (rel === "" || rel.startsWith("/") || rel.split("/").some((part) => part === "" || part === "..")) {
          throw invalidReason(say(`Not a path inside the workspace: ${item}`, `不是工作区内的路径：${item}`), "invalid_path");
        }
        return rel;
      });
      const result = await syncWorkspace(record, paths);
      const current = await currentWorkspaceId(params);
      return {
        ok: true,
        workspace: publicWorkspace(result.record, current),
        tables: result.tables,
        added: result.synced.added ?? [],
        errors: result.synced.errors ?? [],
        skipped: result.synced.skipped ?? 0,
        reused: result.synced.reused ?? 0,
      };
    },

    "workspace.prepare": async (params) => {
      const record = await requireWorkspaceRecord(workspaceIdParam(params));
      requireAvailable(record);
      const ready = await ensureWorkspaceOpen(record);
      return { workspace: publicWorkspace(ready.record, undefined) };
    },

    /** 把普通聊天移入工作区（单向）：写下 scope，并把工作区的共享来源挂进本对话。 */
    "conversation.moveToWorkspace": async (params) => {
      const conversationId = conversationIdParam(params);
      const workspaceId = workspaceIdParam(params);
      const doc = await state.read(conversationId);
      if (doc.scope?.kind === "workspace" && doc.scope.workspaceId !== workspaceId) {
        throw invalidReason(say("This conversation already belongs to another workspace.", "该对话已属于另一个工作区。"), "already_in_workspace");
      }
      const record = await requireWorkspaceRecord(workspaceId);
      requireAvailable(record);
      const ready = await ensureWorkspaceOpen(record);
      const sources = await state.update(conversationId, (draft) => {
        draft.scope = { kind: "workspace", workspaceId };
        const existing = draft.sources.find((item) => item.id === ready.record.sourceId);
        draft.sources = draft.sources.filter((item) => item.id !== ready.record.sourceId);
        draft.sources.push(workspaceSourceRecord(ready.record, ready.tables, existing));
        return sourceView(draft);
      });
      return { ok: true, workspace: publicWorkspace(ready.record, workspaceId), sources };
    },

    "workspace.remove": async (params) => {
      const workspaceId = workspaceIdParam(params);
      if (params.confirmed !== true) throw invalidReason(say("Removal must be explicitly confirmed first.", "移除前必须明确确认。"), "confirmation_required");
      const record = await requireWorkspaceRecord(workspaceId);
      for (const id of (await deps.conversationIds?.()) ?? []) {
        const scope = (await state.read(id).catch(() => undefined))?.scope;
        if (scope?.kind === "workspace" && scope.workspaceId === workspaceId) {
          throw invalidReason(say("Conversations still belong to this workspace; delete them first.", "仍有对话属于该工作区，请先删除这些对话。"), "workspace_in_use");
        }
      }
      if (record.sourceId !== "") await closeCompute(record.sourceId);
      await deps.workspaces.remove(workspaceId);
      return {
        ok: true,
        removed_workspace_id: workspaceId,
        // 只删注册记录：物理目录（含其中的产物、知识库与记忆）由用户掌握，绝不代删。
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
      const roots = await artifactRoots(doc, workspaceId);
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
      const resolved = await resolveArtifact(doc, params);
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
        throw appReason(say(`The artifact exceeds the text read limit (${Math.floor(MAX_ARTIFACT_TEXT_BYTES / 1024)} KiB); read it by path`, `产物超过文本读取上限（${Math.floor(MAX_ARTIFACT_TEXT_BYTES / 1024)} KiB），请用路径读取`), "file_too_large");
      }
      return { ...base, text: readFileSync(resolved.path, "utf8") };
    },
  };

  // 统一入口校验：声明过的形状先过一遍，再过方法体自己的语义检查。
  for (const [name, rules] of Object.entries(SHAPES)) {
    const handler = methods[name];
    if (handler === undefined) continue;
    methods[name] = (params) => {
      checkParams(params, rules);
      return handler(params);
    };
  }
  return methods;
}
