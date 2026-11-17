/** MCP 设置界面用到的 IPC 方法：配置的增删改查、连接状态与「保存后立即重连」。 */
import { McpServerClient } from "../mcp/client.ts";
import { type McpServerConfig, type McpServerInput, validateServerInput } from "../mcp/config.ts";
import { invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import type { McpRuntime } from "../service.ts";

/**
 * 对外形状里不出现 env/header 的值：设置界面只回显键名，用户重填时覆盖旧值。
 * （配置存储会沿用未给出的密钥；这里给出键名是为了让人知道哪些已配置。）
 */
async function mcpView(runtime: McpRuntime) {
  const [servers, statuses] = await Promise.all([runtime.store.list(), runtime.tools.status()]);
  const byId = new Map(statuses.map((status) => [status.server_id, status]));
  return {
    servers: servers.map((server) => {
      const status = byId.get(server.server_id);
      return {
        server_id: server.server_id,
        label: server.label,
        transport: server.transport,
        enabled: server.enabled,
        description: server.description,
        command: server.command,
        args: [...server.args],
        envKeys: Object.keys(server.env),
        url: server.url,
        headerNames: Object.keys(server.headers),
        status: status?.status ?? "disconnected",
        tools: status?.tools ?? 0,
        lastError: status?.lastError ?? "",
      };
    }),
  };
}

function serverInput(params: MethodParams): McpServerInput {
  const server = params.server;
  if (typeof server !== "object" || server === null || Array.isArray(server)) throw invalidParams("'server' must be an object");
  const input = server as McpServerInput;
  if (typeof input.server_id !== "string" || input.server_id.trim() === "") throw invalidParams("'server.server_id' must be a non-empty string");
  if (input.transport !== "stdio" && input.transport !== "sse") throw invalidParams("'server.transport' must be \"stdio\" or \"sse\"");
  return input;
}

/** 测试连接用的配置：与存储层同样的默认值，但不落盘、不碰已保存的密钥。 */
function configFromInput(input: McpServerInput): McpServerConfig {
  const serverId = input.server_id.trim();
  const stdio = input.transport === "stdio";
  return {
    server_id: serverId,
    label: (input.label ?? serverId).trim() || serverId,
    transport: input.transport,
    enabled: true,
    description: input.description ?? "",
    command: stdio ? (input.command ?? "").trim() : "",
    args: stdio ? [...(input.args ?? [])] : [],
    env: input.env ?? {},
    url: stdio ? "" : (input.url ?? "").trim(),
    headers: input.headers ?? {},
  };
}

export function mcpMethods(runtime: McpRuntime): Record<string, RpcMethod> {
  return {
    "mcp.list": () => mcpView(runtime),
    /** 保存（新增或整体更新）；`server_id` 已存在时走更新，避免界面区分两条路径。 */
    "mcp.upsert": async (params) => {
      const server = serverInput(params);
      const result = runtime.store.has(server.server_id)
        ? await runtime.store.update(server.server_id, server)
        : await runtime.store.add(server);
      if (result.ok) await runtime.refresh();
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    },
    "mcp.remove": async (params) => {
      const serverId = params.serverId;
      if (typeof serverId !== "string" || serverId === "") throw invalidParams("'serverId' must be a non-empty string");
      const result = await runtime.store.remove(serverId);
      if (result.ok) await runtime.refresh();
      return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
    },
    /** 手动重连并返回最新状态：保存密钥、改了服务端环境后不必重启进程。 */
    "mcp.refresh": async () => {
      await runtime.refresh();
      return mcpView(runtime);
    },
    /** 不保存的连通性测试：连上后 `tools/list` 的条数就是界面要显示的结果。 */
    "mcp.test": async (params) => {
      const server = serverInput(params);
      const validation = validateServerInput(server);
      if (!validation.ok) return { ok: false, tools: 0, error: validation.error };
      const client = new McpServerClient(configFromInput(server));
      try {
        const connected = await client.connectNow();
        if (!connected) return { ok: false, tools: 0, error: client.lastError || "connection failed" };
        return { ok: true, tools: client.tools.length };
      } finally {
        await client.close();
      }
    },
  };
}
