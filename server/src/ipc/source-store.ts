/**
 * 数据源 IPC 的持久化端口（P6.1）。
 *
 * 两层状态分开存放，因为生命周期与敏感度都不同：
 *
 * - **会话级来源/工作区**（`datawhisper.sources` 文档）：一份会话文档记录「打开了哪些来源、
 *   现在参与分析的来源、挂载过哪些工作目录」。写入时已脱敏，文件路径之外的字段都能给界面看。
 * - **数据源配置**（`<dataDir>/datasource-configs.json` + `SecretCredentialStore`）：
 *   非密字段（URL、表格地址、认证方式）写 JSON 文件；`connection_string`、`creds_json`、
 *   `auth_value` 只进系统钥匙串（不可用时回退 0600 文件），配置里只留字段名。
 *
 * 旧实现把来源挂在 Python 的 session 对象上，进程一重启就丢；这里改由 pi-durable 文档承载，
 * 崩溃回放后来源列表仍在，compute 侧只要按 descriptor 重新打开即可。
 */

import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { writePrivateJson } from "../models/credentials.ts";
import type { TurnState } from "../conversations/service.ts";
import { appError } from "./errors.ts";

/** compute 侧认识的来源类型（与 `compute/sources.py::restore_source` 一致）。 */
export type SourceKind = "csv" | "excel" | "pdf" | "sql" | "gsheets" | "feishu" | "http" | "workspace_persistent";

/** 需要凭据的远程来源。 */
export type RemoteSourceKind = "sql" | "gsheets" | "feishu" | "http";

/** 会话文档里的一条来源。`descriptor` 绝不包含凭据原文。 */
export type StoredSource = {
  id: string;
  kind: SourceKind;
  name: string;
  active: boolean;
  /** 交给 compute 打开的描述符；远程来源的密钥字段在配置里，打开时才合并。 */
  descriptor: Record<string, JsonValue>;
  /** 远程来源引用的配置 id。 */
  configId?: string;
  /** SQL 的分析表选择；重新打开时写回 `descriptor.analysis_tables`。 */
  analysisTables?: string[];
  /** 上传副本（`<dataDir>/uploads/…`），`source.remove` 时清理；工作目录文件不在这里。 */
  uploadPath?: string;
  /** 最近一次打开时 compute 报告的表名。 */
  tables?: string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspacePermission = "read_only" | "read_write";

/** 会话文档里的一条工作区记录。`mounted` 为 false 表示只保留发现记录。 */
export type WorkspaceRecord = {
  workspaceId: string;
  workdir: string;
  name: string;
  permission: WorkspacePermission;
  /** 对应的 `workspace_persistent` 来源；未挂载时为空。 */
  sourceId: string;
  mounted: boolean;
  mountedAt: string;
  updatedAt: string;
};

export type SourceDoc = {
  sources: StoredSource[];
  workspaces: WorkspaceRecord[];
};

/**
 * 从会话文档推导每轮工具暴露所需的 `TurnState`。
 *
 * 宿主在 `startService({ turnState })` 里只能同步返回，因此需要自己缓存最近一次结果：
 * 写入成功后收到 `sourceMethods` 的 `onChanged`，异步读一次文档并刷新缓存即可。
 */
export function turnStateFor(doc: SourceDoc, options: { teamsEnabled?: boolean; hasUnnamedColumns?: boolean } = {}): TurnState {
  const active = doc.sources.filter((source) => source.active).length;
  return {
    hasDataSource: active > 0,
    sourceCount: active,
    hasWorkspace: doc.workspaces.some((workspace) => workspace.mounted),
    hasUnnamedColumns: options.hasUnnamedColumns ?? false,
    teamsEnabled: options.teamsEnabled ?? false,
  };
}

/** 会话级文档的读写端口；`update` 在一次 pi-durable commit 内完成。 */
export type SourceDocStore = {
  read(conversationId: number): Promise<SourceDoc>;
  update<R>(conversationId: number, mutate: (draft: SourceDoc) => R | Promise<R>): Promise<R>;
};

/**
 * 会话来源/工作区文档。结构很小，每次提交都存完整基线，避免薄文档留下长增量链。
 */
export const SOURCE_DOC = defineDoc<SourceDoc>({
  kind: "datawhisper.sources",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ sources: [], workspaces: [] }),
  checkpointWhen: () => true,
});

export type ConversationHarness = Pick<Harness, "snapshot" | "conversation">;

/** 生产宿主：读走 `snapshot`（不产生写入），写走 `conversation.commit`。 */
export function createConversationSourceStore(options: {
  readonly harness: ConversationHarness;
  readonly context: Context;
}): SourceDocStore {
  const { harness, context } = options;
  return {
    async read(conversationId: number): Promise<SourceDoc> {
      const id = conversationId as ConversationId;
      // `snapshot` 对不存在的文档返回 undefined，无法区分「会话不存在」；
      // 旧路由对未知会话回 404，这里显式核对一次。
      const conversation = await harness.conversation(id, context);
      if (conversation === undefined) throw appError("not_found", `conversation not found: ${conversationId}`);
      const value = await harness.snapshot(SOURCE_DOC, id, context);
      if (value === undefined) return { sources: [], workspaces: [] };
      return structuredClone(value) as SourceDoc;
    },
    async update<R>(conversationId: number, mutate: (draft: SourceDoc) => R | Promise<R>): Promise<R> {
      const id = conversationId as ConversationId;
      const conversation = await harness.conversation(id, context);
      if (conversation === undefined) throw appError("not_found", `conversation not found: ${conversationId}`);
      return await conversation.commit(async (tx) => {
        const draft = (await tx.doc(SOURCE_DOC, id)) as SourceDoc;
        draft.sources ??= [];
        draft.workspaces ??= [];
        // 返回给调用方的值必须在提交内脱开事务对象：提交结束后再读 draft 里的字段会抛
        // 「Cannot use a settled overlay」，调用方往往是在下一个 await 之后才读（例如拿着记录去调 compute）。
        return detach(await mutate(draft));
      }, context);
    },
  };
}

/**
 * 深拷贝事务里的返回值；不可序列化的值（函数等）原样返回。
 *
 * 用 JSON 往返而不是 `structuredClone`：事务里拿到的是 chord 的 overlay 代理，`structuredClone`
 * 对它自身会抛错（被这里的 catch 吞掉又返回原对象，等于没脱开），而 JSON 序列化在读属性时
 * 尚未落定，能够正常取到值。
 */
function detach<R>(value: R): R {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as R;
  } catch {
    return value;
  }
}

/** 内存宿主的公开类型：测试可 `peek` 读取脱敏后的文档。 */
export type MemorySourceDocStore = SourceDocStore & {
  peek(conversationId: number): SourceDoc;
};

/** 内存宿主：单元测试与没有 durable 会话的嵌入场景；语义与生产宿主一致。 */
export function createMemorySourceStore(knownConversations: Iterable<number>): MemorySourceDocStore {
  const known = new Set(knownConversations);
  const docs = new Map<number, SourceDoc>();
  // 每次更新排队执行，模拟 commit 的串行语义，避免测试里的并发写入互相覆盖。
  let queue: Promise<unknown> = Promise.resolve();
  const require = (conversationId: number): SourceDoc => {
    if (!known.has(conversationId)) throw appError("not_found", `conversation not found: ${conversationId}`);
    let doc = docs.get(conversationId);
    if (doc === undefined) {
      doc = { sources: [], workspaces: [] };
      docs.set(conversationId, doc);
    }
    return doc;
  };
  return {
    async read(conversationId: number): Promise<SourceDoc> {
      return structuredClone(require(conversationId));
    },
    update<R>(conversationId: number, mutate: (draft: SourceDoc) => R | Promise<R>): Promise<R> {
      const run = queue.then(async () => {
        const draft = structuredClone(require(conversationId));
        const result = await mutate(draft);
        docs.set(conversationId, structuredClone(draft));
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    peek(conversationId: number): SourceDoc {
      return structuredClone(require(conversationId));
    },
  };
}

// ── 数据源配置（密钥只进不出） ───────────────────────────────────────────────

export type SourceConfigKind = RemoteSourceKind;

/** 可以出现在配置文件里的字段；其余字段一律进凭据库。 */
export const NON_SECRET_FIELDS: Readonly<Record<SourceConfigKind, readonly string[]>> = {
  sql: [],
  gsheets: ["spreadsheet"],
  feishu: ["bitable", "table"],
  http: ["url", "auth_type"],
};

/** 只进凭据库的字段名：连接串里的密码、服务账号私钥、API 认证值。 */
export const SECRET_FIELDS: readonly string[] = ["connection_string", "creds_json", "auth_value"];

/** 面向界面的配置视图：只有非密字段与「哪些密字段已保存」。 */
export type SourceConfig = {
  id: string;
  kind: SourceConfigKind;
  name: string;
  fields: Record<string, string>;
  /** 已保存的密字段名；值只在 `secret()` 里，绝不进返回值。 */
  secretFields: string[];
  updatedAt: string;
};

export type SourceConfigInput = {
  id?: string;
  kind: SourceConfigKind;
  name?: string;
  fields?: Record<string, unknown>;
  /** 提供即整体替换密文字段；省略则沿用已保存的值。 */
  secret?: Record<string, unknown>;
};

export type SourceConfigStore = {
  list(): Promise<SourceConfig[]>;
  get(id: string): Promise<SourceConfig | undefined>;
  save(input: SourceConfigInput): Promise<SourceConfig>;
  remove(id: string): Promise<boolean>;
  /** 仅打开来源时在进程内调用；返回值不得进入任何 IPC 结果。 */
  secret(id: string): Promise<Record<string, string> | undefined>;
};

type ConfigFile = { version: 1; configs: SourceConfig[] };

export const CONFIG_ID_PATTERN = /^ds_[a-f0-9]{8}$/;
export const SOURCE_ID_PATTERN = /^s_[a-f0-9]{8}$/;
export const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;

export function randomId(prefix: string, bytes = 4): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

/** 由绝对路径派生稳定的工作区 id：同一目录重复挂载得到同一个 id。 */
export function workspaceIdFor(workdir: string): string {
  return `ws_${createHash("sha256").update(workdir).digest("hex").slice(0, 16)}`;
}

function credentialId(configId: string): string {
  return `datasource:${configId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") result[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") result[key] = String(item);
    else return undefined;
  }
  return result;
}

function normalizeConfig(kind: SourceConfigKind, fields: Record<string, unknown> | undefined, secret: Record<string, string> | undefined): {
  fields: Record<string, string>;
  secret: Record<string, string>;
} {
  const allowed = new Set(NON_SECRET_FIELDS[kind]);
  const kept: Record<string, string> = {};
  const secretOut: Record<string, string> = {};
  for (const [key, raw] of Object.entries(secret ?? {})) {
    // 只接受已知密字段，避免把无关内容（尤其误传的对象）写进凭据库。
    if (SECRET_FIELDS.includes(key) && raw !== "") secretOut[key] = raw;
  }
  for (const [key, raw] of Object.entries(fields ?? {})) {
    if (typeof raw !== "string") continue;
    // 调用方把密字段误放在 fields 里时自动挪进凭据库，配置文件永远不含原文。
    if (SECRET_FIELDS.includes(key)) {
      if (raw !== "") secretOut[key] = raw;
    } else if (allowed.has(key)) kept[key] = raw;
  }
  return { fields: kept, secret: secretOut };
}

/**
 * 文件 + 凭据库的配置存储。
 *
 * 写入串行排队：配置文件是整体重写，两个并发保存会互相覆盖。
 */
export function createSourceConfigStore(options: {
  readonly dataDir: string;
  readonly credentials: CredentialStore;
  readonly now?: () => Date;
}): SourceConfigStore {
  const path = join(options.dataDir, "datasource-configs.json");
  const now = options.now ?? (() => new Date());
  const credentials = options.credentials;
  let queue: Promise<unknown> = Promise.resolve();

  const readFile = (): ConfigFile => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isObject(parsed) || !Array.isArray(parsed.configs)) return { version: 1, configs: [] };
      const configs: SourceConfig[] = [];
      for (const item of parsed.configs) {
        if (!isObject(item)) continue;
        const id = typeof item.id === "string" ? item.id : "";
        const kind = item.kind;
        if (!CONFIG_ID_PATTERN.test(id)) continue;
        if (kind !== "sql" && kind !== "gsheets" && kind !== "feishu" && kind !== "http") continue;
        const fields = stringRecord(item.fields) ?? {};
        const secretFields = Array.isArray(item.secretFields)
          ? item.secretFields.filter((name): name is string => typeof name === "string")
          : [];
        configs.push({
          id,
          kind,
          name: typeof item.name === "string" ? item.name : "",
          fields,
          secretFields,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
        });
      }
      return { version: 1, configs };
    } catch {
      return { version: 1, configs: [] };
    }
  };

  const writeFile = async (file: ConfigFile): Promise<void> => {
    await writePrivateJson(path, file);
  };

  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const store: SourceConfigStore = {
    async list(): Promise<SourceConfig[]> {
      return readFile().configs;
    },
    async get(id: string): Promise<SourceConfig | undefined> {
      return readFile().configs.find((config) => config.id === id);
    },
    save(input: SourceConfigInput): Promise<SourceConfig> {
      return serialized(async () => {
        const id = input.id ?? randomId("ds_");
        if (!CONFIG_ID_PATTERN.test(id)) throw new Error(`invalid data source config id: ${id}`);
        const file = readFile();
        const existing = file.configs.find((config) => config.id === id);
        // 显式 id 是「用这个 id 保存」而不是「必须已存在」：`source.open` 在打开
        // 远程来源前就生成 id，成功后用同一次保存落盘。
        // 省略一个桶表示沿用已保存的值；显式提供才整体替换。
        const mergedFields = input.fields === undefined ? (existing?.fields ?? {}) : input.fields;
        const { fields, secret } = normalizeConfig(input.kind, mergedFields, stringRecord(input.secret));
        // `fields` 里带密字段（如 connection_string）也算「提供了凭据」，否则会被当成
        // 「没改凭据」而丢掉刚挪进 secret 的值。
        const secretProvided = input.secret !== undefined
          || Object.keys(input.fields ?? {}).some((name) => SECRET_FIELDS.includes(name));
        const secretFields = secretProvided
          ? Object.keys(secret).filter((name) => secret[name] !== "")
          : (existing?.secretFields ?? []);
        if (secretProvided) {
          if (secretFields.length === 0) await credentials.delete(credentialId(id));
          else {
            await credentials.modify(credentialId(id), async () => ({
              type: "api_key",
              key: JSON.stringify(Object.fromEntries(secretFields.map((name) => [name, secret[name]!]))),
            }));
          }
        }
        const record: SourceConfig = {
          id,
          kind: input.kind,
          name: (input.name ?? existing?.name ?? "").trim().slice(0, 200),
          fields,
          secretFields,
          updatedAt: now().toISOString(),
        };
        const configs = file.configs.filter((config) => config.id !== id);
        configs.push(record);
        configs.sort((left, right) => left.id.localeCompare(right.id));
        await writeFile({ version: 1, configs });
        return record;
      });
    },
    remove(id: string): Promise<boolean> {
      return serialized(async () => {
        const file = readFile();
        const configs = file.configs.filter((config) => config.id !== id);
        if (configs.length === file.configs.length) return false;
        await writeFile({ version: 1, configs });
        await credentials.delete(credentialId(id));
        return true;
      });
    },
    async secret(id: string): Promise<Record<string, string> | undefined> {
      const credential = await credentials.read(credentialId(id));
      if (credential === undefined || credential.type !== "api_key" || credential.key === undefined) return undefined;
      try {
        return stringRecord(JSON.parse(credential.key));
      } catch {
        return undefined;
      }
    },
  };
  return store;
}

// ── 路径校验 ────────────────────────────────────────────────────────────────

/**
 * 等价于 Python `Path.resolve(strict=False)`：能解析的前缀跟随符号链接，不存在的尾部按
 * 父目录的真实路径拼接。安全校验必须用真实路径，否则指向工作区外的符号链接会绕过检查。
 */
export function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPath(parent), basename(path));
  }
}

export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const BLOCKED_FRAGMENTS = [".env", ".ssh", ".git", "__pycache__"];

function defaultBlockedRoots(): string[] {
  const roots = [
    "/etc",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/var/log",
    join(homedir(), ".ssh"),
    join(homedir(), ".gnupg"),
    join(homedir(), ".aws"),
    join(homedir(), ".config"),
  ];
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "windir"] as const) {
      const value = process.env[name];
      if (value) roots.push(value);
    }
  }
  return roots;
}

export type WorkspacePathCheck = { ok: true; path: string } | { ok: false; message: string };

/**
 * 校验工作目录（对应旧 `data/workspace.py::validate_workdir`）：
 * 绝对路径、存在且是目录、可读、不命中系统/敏感目录、不在仓库根内。
 * 与旧实现的差别：只接受绝对路径（界面本来就是选目录），避免相对路径随进程 cwd 漂移。
 */
export function validateWorkspacePath(
  input: string,
  options: { readonly projectRoot: string; readonly blockedRoots?: readonly string[] },
): WorkspacePathCheck {
  const raw = input.trim();
  if (raw === "") return { ok: false, message: "工作目录路径不能为空。" };
  const expanded = raw === "~" || raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) return { ok: false, message: `工作目录必须是绝对路径：${input}` };
  let resolved: string;
  try {
    resolved = realpathSync.native(resolve(expanded));
  } catch {
    return { ok: false, message: `路径不存在：${input}` };
  }
  let stats;
  try {
    stats = statSync(resolved);
    accessSync(resolved, constants.R_OK);
  } catch {
    return { ok: false, message: `目录不可读：${resolved}` };
  }
  if (!stats.isDirectory()) return { ok: false, message: `路径不是目录：${resolved}` };

  const parts = new Set(resolved.split(sep).map((part) => part.toLowerCase()));
  for (const fragment of BLOCKED_FRAGMENTS) {
    if (parts.has(fragment)) return { ok: false, message: `安全限制：不允许挂载系统/敏感目录：${resolved}` };
  }
  const blocked = [...defaultBlockedRoots(), ...(options.blockedRoots ?? [])];
  for (const root of blocked) {
    const candidateRoot = realPath(resolve(root));
    if (within(candidateRoot, resolved)) {
      return { ok: false, message: `安全限制：不允许挂载系统/敏感目录：${resolved}` };
    }
  }
  const project = realPath(resolve(options.projectRoot));
  if (within(project, resolved)) return { ok: false, message: `不允许挂载项目根目录：${resolved}` };
  return { ok: true, path: resolved };
}

/** 把界面传来的文件名清成安全的显示名：去掉目录与控制字符，限长 200。 */
export function displayNameFrom(filename: string, fallback: string): string {
  const cleaned = basename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (cleaned === "" || cleaned === "." || cleaned === ".." ? fallback : cleaned).slice(0, 200);
}

/** 扩展名（小写，含点）；没有扩展名时返回空串。 */
export function suffixOf(filename: string): string {
  const base = basename(filename);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index).toLowerCase();
}

/** 上传/产物里允许出现的扩展名与 content-type。 */
export const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};
