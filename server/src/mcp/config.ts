/**
 * MCP 服务器配置：校验、持久化与凭据解析。
 *
 * 行为基准来自两份旧实现：
 * - `LLM/mcp_config_manager.py`：服务器形状（server_id/label/transport/enabled/description/
 *   command/args/env/url/headers）与增删改的提示文案。
 * - `api/mcp.py`：stdio 白名单、shell 元字符、受保护环境变量、SSE 必填 url 的校验。
 *
 * 与旧实现的唯一实质差异：`env` / `headers` 的**值**不进配置文件，一律写入
 * `SecretCredentialStore`（系统钥匙串，缺失时回退到 0600 文件）；配置文件只保留键名。
 * 这样即使用户把 GitHub token 填在 env 里，`mcp_config.json` 也不会出现明文。
 *
 * 旧配置文件里已有明文值时，`open()` 会把它迁进凭据库并改写配置文件（一次迁移）。
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { writePrivateJson } from "../models/credentials.ts";

export type McpTransport = "stdio" | "sse";

/** 旧 `STDIO_ALLOWED_COMMANDS`；按 basename（去扩展名）比较，与旧实现一致。 */
export const STDIO_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "uvx",
  "uv",
  "npx",
  "npm",
  "node",
  "python",
  "python3",
  "deno",
]);

/** 旧 `api/mcp.py::_SHELL_META_RE`：stdio 参数里不允许出现的 shell 元字符。 */
const SHELL_META_RE = /[;&|`$<>()\n]|\|\||&&/;

/** 旧 `api/mcp.py::_BLOCKED_ENV_KEYS`：这些环境变量不能由用户覆盖。 */
const BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
]);

/** 运行时使用的完整配置（env/headers 的值已从凭据库解析出来）。 */
export type McpServerConfig = {
  readonly server_id: string;
  readonly label: string;
  readonly transport: McpTransport;
  readonly enabled: boolean;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

/** 写入/更新时的输入；缺省字段按旧 API 的默认值补齐。 */
export type McpServerInput = {
  readonly server_id: string;
  readonly label?: string;
  readonly transport: McpTransport;
  readonly enabled?: boolean;
  readonly description?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export type McpConfigMutation = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly error: string };

/** 磁盘上的形状：与旧实现一致，只是 env/headers 的值恒为空串（真值在凭据库）。 */
type StoredServer = {
  server_id: string;
  label: string;
  transport: McpTransport;
  enabled: boolean;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
};

type StoredFile = { version: 2; servers: Record<string, StoredServer> };

export type McpSecretKind = "env" | "header";

/**
 * 凭据库里的条目 id。钥匙串条目是全局的，因此带上 server_id 与槽位（env/header）避免串号。
 * 用 `:` 分隔而不是 `__`，后者是 MCP 工具名的分隔符。
 */
export function mcpSecretId(serverId: string, kind: McpSecretKind, name: string): string {
  return `mcp:${serverId}:${kind}:${name}`;
}

/** 旧 `_validate_stdio`：命令白名单、参数元字符、受保护环境变量。 */
export function validateStdioServer(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string {
  const base = basename(command ?? "");
  const stem = extname(base) === "" ? base : base.slice(0, -extname(base).length);
  if (!STDIO_ALLOWED_COMMANDS.has(stem)) {
    return `命令 '${command}' 不在安全白名单中（允许: ${[...STDIO_ALLOWED_COMMANDS].sort().join(", ")}）`;
  }
  for (const arg of args) {
    if (SHELL_META_RE.test(String(arg))) return `参数包含不允许的 shell 特殊字符: '${arg}'`;
  }
  for (const key of Object.keys(env)) {
    if (BLOCKED_ENV_KEYS.has(key)) return `不允许覆盖环境变量: ${key}`;
  }
  return "";
}

/**
 * 校验一份输入。返回 `{ ok: false, error }` 时 `error` 与旧 API 的 400 文案逐字一致。
 */
export function validateServerInput(input: McpServerInput): { ok: true } | { ok: false; error: string } {
  const serverId = (input.server_id ?? "").trim();
  if (serverId === "") return { ok: false, error: "server_id 不能为空" };
  if (input.transport !== "stdio" && input.transport !== "sse") {
    return { ok: false, error: "transport 必须是 'stdio' 或 'sse'" };
  }
  if (input.transport === "stdio") {
    if (input.args !== undefined && !Array.isArray(input.args)) return { ok: false, error: "args 必须是数组" };
    if (input.env !== undefined && (typeof input.env !== "object" || input.env === null || Array.isArray(input.env))) {
      return { ok: false, error: "env 必须是对象" };
    }
    const error = validateStdioServer((input.command ?? "").trim(), input.args ?? [], input.env ?? {});
    return error === "" ? { ok: true } : { ok: false, error };
  }
  if ((input.url ?? "").trim() === "") return { ok: false, error: "SSE transport 需要 url" };
  if (input.headers !== undefined && (typeof input.headers !== "object" || input.headers === null || Array.isArray(input.headers))) {
    return { ok: false, error: "headers 必须是对象" };
  }
  return { ok: true };
}

/**
 * 服务器配置的持久化与凭据解析。
 *
 * 写操作串行执行（与 `SecretCredentialStore` 一样按 promise 排队），读操作每次从内存快照解析，
 * 因此并发的工具调用不会互相阻塞。
 */
export class McpConfigStore {
  private servers = new Map<string, StoredServer>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private readonly credentials: CredentialStore,
  ) {}

  static async open(filePath: string, credentials: CredentialStore): Promise<McpConfigStore> {
    const store = new McpConfigStore(filePath, credentials);
    await store.reload();
    return store;
  }

  /** 重新读盘。旧实现没有热加载；这里给设置界面保存后的刷新留入口。 */
  async reload(): Promise<void> {
    const data = await readStoredFile(this.filePath);
    this.servers = new Map(Object.entries(data.servers));
    await this.migrateInlineSecrets();
  }

  /** 所有服务器（含 disabled），值已解析。 */
  async list(): Promise<McpServerConfig[]> {
    return Promise.all([...this.servers.values()].map((server) => this.resolve(server)));
  }

  /** 旧 `get_enabled_servers()`。 */
  async enabled(): Promise<McpServerConfig[]> {
    const all = await this.list();
    return all.filter((server) => server.enabled);
  }

  async get(serverId: string): Promise<McpServerConfig | undefined> {
    const stored = this.servers.get(serverId);
    return stored === undefined ? undefined : this.resolve(stored);
  }

  has(serverId: string): boolean {
    return this.servers.has(serverId);
  }

  /** 旧 `add_server`：重复的 server_id 是「名字冲突」，文案保持一致。 */
  add(input: McpServerInput): Promise<McpConfigMutation> {
    return this.write(async () => {
      const validation = validateServerInput(input);
      if (!validation.ok) return { ok: false, error: validation.error };
      const serverId = input.server_id.trim();
      if (this.servers.has(serverId)) return { ok: false, error: `服务器 '${serverId}' 已存在` };
      const stored = emptyStored(serverId, input);
      await this.storeSecrets(stored, input);
      this.servers.set(serverId, stored);
      if (!(await this.save())) {
        this.servers.delete(serverId);
        return { ok: false, error: "保存配置失败" };
      }
      return { ok: true, message: `服务器 '${serverId}' 已添加` };
    });
  }

  /** 旧 `update_server`：整体替换 transport 相关字段，未给出的沿用旧值。 */
  update(serverId: string, patch: Partial<Omit<McpServerInput, "server_id">>): Promise<McpConfigMutation> {
    return this.write(async () => {
      const previous = this.servers.get(serverId);
      if (previous === undefined) return { ok: false, error: `服务器 '${serverId}' 不存在` };
      // 没给 env/headers 时要沿用**已解析**的值；直接用磁盘上的空串会把密钥写没。
      const resolved = await this.resolve(previous);
      const merged: McpServerInput = {
        server_id: serverId,
        label: patch.label ?? previous.label,
        transport: patch.transport ?? previous.transport,
        enabled: patch.enabled ?? previous.enabled,
        description: patch.description ?? previous.description,
        command: patch.command ?? previous.command,
        args: patch.args ?? previous.args,
        env: patch.env ?? resolved.env,
        url: patch.url ?? previous.url,
        headers: patch.headers ?? resolved.headers,
      };
      const validation = validateServerInput(merged);
      if (!validation.ok) return { ok: false, error: validation.error };
      const next = emptyStored(serverId, merged);
      // 旧值的键集合可能变化：先清掉不再存在的密钥，再写入新值。
      await this.dropSecrets(previous);
      await this.storeSecrets(next, merged);
      this.servers.set(serverId, next);
      if (!(await this.save())) {
        this.servers.set(serverId, previous);
        return { ok: false, error: "保存配置失败" };
      }
      return { ok: true, message: "已更新" };
    });
  }

  remove(serverId: string): Promise<McpConfigMutation> {
    return this.write(async () => {
      const previous = this.servers.get(serverId);
      if (previous === undefined) return { ok: false, error: `服务器 '${serverId}' 不存在` };
      this.servers.delete(serverId);
      if (!(await this.save())) {
        this.servers.set(serverId, previous);
        return { ok: false, error: "保存配置失败" };
      }
      await this.dropSecrets(previous);
      return { ok: true, message: `服务器 '${serverId}' 已删除` };
    });
  }

  setEnabled(serverId: string, enabled: boolean): Promise<McpConfigMutation> {
    return this.write(async () => {
      const previous = this.servers.get(serverId);
      if (previous === undefined) return { ok: false, error: `服务器 '${serverId}' 不存在` };
      const next: StoredServer = { ...previous, enabled };
      this.servers.set(serverId, next);
      if (!(await this.save())) {
        this.servers.set(serverId, previous);
        return { ok: false, error: "保存配置失败" };
      }
      return { ok: true, message: "已更新" };
    });
  }

  private write<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async save(): Promise<boolean> {
    const data: StoredFile = { version: 2, servers: Object.fromEntries(this.servers) };
    try {
      await writePrivateJson(this.filePath, data);
      return true;
    } catch {
      return false;
    }
  }

  /** 配置里的键名是权威：值一律从凭据库读。 */
  private async resolve(stored: StoredServer): Promise<McpServerConfig> {
    return {
      server_id: stored.server_id,
      label: stored.label,
      transport: stored.transport,
      enabled: stored.enabled,
      description: stored.description,
      command: stored.command,
      args: [...stored.args],
      env: await this.readSecrets(stored.server_id, "env", Object.keys(stored.env)),
      url: stored.url,
      headers: await this.readSecrets(stored.server_id, "header", Object.keys(stored.headers)),
    };
  }

  private async readSecrets(
    serverId: string,
    kind: McpSecretKind,
    names: readonly string[],
  ): Promise<Record<string, string>> {
    const entries = await Promise.all(
      names.map(async (name) => {
        const credential = await this.credentials.read(mcpSecretId(serverId, kind, name));
        if (credential === undefined || credential.type !== "api_key") return [name, ""] as const;
        return [name, credential.key ?? ""] as const;
      }),
    );
    const resolved: Record<string, string> = {};
    for (const [name, value] of entries) {
      if (value !== "") resolved[name] = value;
    }
    return resolved;
  }

  private async storeSecrets(stored: StoredServer, input: McpServerInput): Promise<void> {
    const env = input.env ?? {};
    for (const [name, value] of Object.entries(env)) {
      await this.credentials.modify(mcpSecretId(stored.server_id, "env", name), async () => ({
        type: "api_key",
        key: String(value),
      }));
    }
    const headers = input.headers ?? {};
    for (const [name, value] of Object.entries(headers)) {
      await this.credentials.modify(mcpSecretId(stored.server_id, "header", name), async () => ({
        type: "api_key",
        key: String(value),
      }));
    }
    stored.env = Object.fromEntries(Object.keys(env).map((name) => [name, ""]));
    stored.headers = Object.fromEntries(Object.keys(headers).map((name) => [name, ""]));
  }

  private async dropSecrets(stored: StoredServer): Promise<void> {
    for (const name of Object.keys(stored.env)) {
      await this.credentials.delete(mcpSecretId(stored.server_id, "env", name));
    }
    for (const name of Object.keys(stored.headers)) {
      await this.credentials.delete(mcpSecretId(stored.server_id, "header", name));
    }
  }

  /** 旧文件里的明文值搬进凭据库，并把配置文件改写成「只留键名」。 */
  private async migrateInlineSecrets(): Promise<void> {
    let changed = false;
    for (const server of this.servers.values()) {
      for (const kind of ["env", "header"] as const) {
        const slot = kind === "env" ? server.env : server.headers;
        for (const [name, value] of Object.entries(slot)) {
          if (value === "") continue;
          await this.credentials.modify(mcpSecretId(server.server_id, kind, name), async () => ({
            type: "api_key",
            key: value,
          }));
          slot[name] = "";
          changed = true;
        }
      }
    }
    if (changed) await this.save();
  }
}

function emptyStored(serverId: string, input: McpServerInput): StoredServer {
  const transport = input.transport;
  return {
    server_id: serverId,
    label: (input.label ?? serverId).trim() || serverId,
    transport,
    enabled: input.enabled ?? true,
    description: input.description ?? "",
    command: transport === "stdio" ? (input.command ?? "").trim() : "",
    args: transport === "stdio" ? [...(input.args ?? [])] : [],
    env: {},
    url: transport === "sse" ? (input.url ?? "").trim() : "",
    headers: {},
  };
}

/**
 * 读盘并归一化。兼容旧实现的 `{ servers: { … } }`；坏的记录直接跳过（旧实现整体加载失败，
 * 这里改成逐条容错，避免一条坏配置让所有服务器消失）。
 */
async function readStoredFile(path: string): Promise<StoredFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // 文件不存在或坏了都按空配置处理：一条坏配置不该让所有服务器消失。
    return { version: 2, servers: {} };
  }
  const servers: Record<string, StoredServer> = {};
  if (typeof raw !== "object" || raw === null || !("servers" in raw)) return { version: 2, servers };
  const source = raw.servers;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return { version: 2, servers };
  // JSON 边界的形状断言：下面每个字段仍逐个用 typeof 校验，缺省值按旧实现的 dataclass 默认值。
  const entries = Object.entries(source as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    servers[key] = {
      server_id: typeof record.server_id === "string" && record.server_id !== "" ? record.server_id : key,
      label: typeof record.label === "string" ? record.label : key,
      transport: record.transport === "sse" ? "sse" : "stdio",
      enabled: record.enabled !== false,
      description: typeof record.description === "string" ? record.description : "",
      command: typeof record.command === "string" ? record.command : "",
      args: Array.isArray(record.args) ? record.args.map((arg) => String(arg)) : [],
      env: toSecretKeys(record.env),
      url: typeof record.url === "string" ? record.url : "",
      headers: toSecretKeys(record.headers),
    };
  }
  return { version: 2, servers };
}

/** 键名保留、值只用于一次性的明文迁移；迁移后写回空串。 */
function toSecretKeys(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, typeof item === "string" ? item : ""]));
}
