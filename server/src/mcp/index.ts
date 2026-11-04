/**
 * MCP 客户端装配点：`createMcpTools(config)`。
 *
 * 把一组服务器配置变成（1）pi-durable 工具注册项、（2）`search_mcp_tools` 需要的紧凑目录、
 * （3）旧 `MCPManager.call_tool` 的等价入口。
 *
 * 暴露路径（为什么这样接）：
 * - 工具以 `deferred: true` 注册；`search_mcp_tools` 命中后把名字放进工具结果的
 *   `control.addTools`，pi-durable 会写进会话的 `modelTools.add`，下一次模型请求就能看到它们。
 *   这是唯一能在「一轮运行中间」改变模型可见工具集的机制；`configure({ modelTools })` 是整体替换，
 *   由 `conversations/service.ts` 在提交前重算，工具里改不动它。
 * - 旧实现每轮只暴露「最近发现的 5 个」（`select_mcp_schemas(..., limit=5)`）。这里同样提供
 *   `recentNames(limit=5)` 与 `selectMcpSchemas`，供暴露层（`tools/exposure.ts` 的
 *   `allowedMcpTools`）使用；那两处属于 P3.4/P4 接线，本模块不越界修改。`control.addTools` 本身
 *   只能追加、无法移除，所以「最近 5 个」的最终裁剪必须发生在每轮的 `modelTools` 计算里。
 * - 发现状态（旧 `discovered_mcp_tools` + `mcp_catalog_version_seen`）由宿主通过 `discovery` /
 *   `onDiscover` 持久化；目录版本一变，旧发现全部作废（旧实现的行为）。
 */

import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { type McpCatalogEntry, type McpCatalogReader, searchMcpCatalog } from "../tools/app/mcp.ts";
import { type McpClientOptions, McpServerClient } from "./client.ts";
import type { McpServerConfig } from "./config.ts";
import {
  buildMcpCatalog,
  createMcpToolRegistration,
  formatMcpError,
  mcpCatalogVersion,
  mcpToolSchema,
  type McpOpenAiSchema,
} from "./tools.ts";

export type McpDiscoveryState = { readonly names: readonly string[]; readonly version: string };

export type McpToolsConfig = {
  /** 服务器清单；给函数时每次 `refresh()` 重新取（设置界面保存后生效）。 */
  readonly servers: readonly McpServerConfig[] | (() => Promise<readonly McpServerConfig[]>);
  readonly client?: McpClientOptions;
  /** 旧 `_mcp_discovery_recorder`：把本回合发现的工具名与目录版本交给宿主持久化。 */
  readonly onDiscover?: (names: readonly string[], version: string) => void;
  /** 上次进程留下的发现状态；目录版本不匹配时自动作废。 */
  readonly discovery?: McpDiscoveryState;
  /** 连接失败后的冷却时间，避免每次目录读取都卡在同一个坏服务器上。默认 30s。 */
  readonly connectCooldownMs?: number;
  readonly now?: () => number;
};

export type McpTools = {
  /** 供 `search_mcp_tools` 的 `AppToolDeps.mcpCatalog`。 */
  readonly catalog: McpCatalogReader;
  /** 当前已发现的工具注册项（按服务器/工具名的稳定顺序）。 */
  tools(): ToolRegistration[];
  /** 把当前工具集装进一个扩展；宿主在 `Harness.open` 的 registry 或 `configure({ extensions })` 里安装。 */
  extension(): Extension;
  /** 重新读服务器清单、重连、重建注册项。 */
  refresh(): Promise<ToolRegistration[]>;
  /** 并行连接所有启用的服务器（失败只记状态，不抛）。 */
  connectAll(): Promise<void>;
  /** 旧 `MCPManager.call_tool`：完整名调用，永不抛异常，始终返回模型文本。 */
  call(fullName: string, args: Record<string, unknown>): Promise<string>;
  /**
   * 旧实现每轮开头的 `search_mcp_catalog(catalog, user_message, limit=5)`：按用户消息预发现，
   * 结果进入最近列表。暴露层可用它的返回值作为本轮 `allowedMcpTools`。
   */
  discover(message: string): Promise<readonly string[]>;
  /** 最近发现的工具名（旧 `_turn_discovered_mcp[-5:]`）；目录版本变了则为空。 */
  recentNames(limit?: number): readonly string[];
  /** 当前所有已连接工具的 OpenAPI schema 片段（暴露层拼接用）。 */
  schemas(): McpOpenAiSchema[];
  /** 按「最近使用顺序」选出最多 5 个工具的注册项（`selectMcpSchemas` 的对象版）。 */
  selectForTurn(names: readonly string[], limit?: number): ToolRegistration[];
  close(): Promise<void>;
};

const DISCOVERY_LIMIT = 10;

export async function createMcpTools(config: McpToolsConfig): Promise<McpTools> {
  const now = config.now ?? (() => Date.now());
  const cooldownMs = config.connectCooldownMs ?? 30_000;
  const clients = new Map<string, McpServerClient>();
  const failureAt = new Map<string, number>();
  let discoveryNames: string[] = [...(config.discovery?.names ?? [])];
  let discoveryVersion = config.discovery?.version ?? "";
  let catalogVersion = "";

  const readServers = async (): Promise<readonly McpServerConfig[]> =>
    typeof config.servers === "function" ? await config.servers() : config.servers;

  const syncClients = async (): Promise<void> => {
    const servers = await readServers();
    const enabled = new Set<string>();
    for (const server of servers) {
      if (!server.enabled) continue;
      enabled.add(server.server_id);
      const previous = clients.get(server.server_id);
      if (previous === undefined) {
        clients.set(server.server_id, new McpServerClient(server, config.client));
      } else if (JSON.stringify(previous.config) !== JSON.stringify(server)) {
        // 配置变了：拆掉旧连接，等下一次按需连新配置。
        void previous.close();
        clients.set(server.server_id, new McpServerClient(server, config.client));
        failureAt.delete(server.server_id);
      }
    }
    for (const serverId of [...clients.keys()]) {
      if (enabled.has(serverId)) continue;
      const client = clients.get(serverId);
      clients.delete(serverId);
      await client?.close();
    }
  };

  const connectAll = async (): Promise<void> => {
    await Promise.allSettled(
      [...clients.values()].map(async (client) => {
        if (client.status === "connected") return;
        const failedAt = failureAt.get(client.serverId);
        if (failedAt !== undefined && now() - failedAt < cooldownMs) return;
        const ok = await client.connectNow();
        if (ok) failureAt.delete(client.serverId);
        else failureAt.set(client.serverId, now());
      }),
    );
  };

  const connectedSchemas = (): McpOpenAiSchema[] =>
    [...clients.values()]
      .filter((client) => client.status === "connected")
      .flatMap((client) => client.tools.map((tool) => mcpToolSchema(client.serverId, tool)));

  const catalogReader: McpCatalogReader = {
    async read(): Promise<{ catalog: readonly McpCatalogEntry[]; version: string }> {
      await connectAll();
      const catalog = buildMcpCatalog(connectedSchemas());
      catalogVersion = mcpCatalogVersion(catalog);
      return { catalog, version: catalogVersion };
    },
    record(names: readonly string[]): void {
      // 目录版本变了（新服务器/工具增删）：旧发现作废，与旧实现的 version 比较一致。
      if (discoveryVersion !== "" && catalogVersion !== "" && discoveryVersion !== catalogVersion) {
        discoveryNames = [];
      }
      if (catalogVersion !== "") discoveryVersion = catalogVersion;
      for (const name of names) {
        discoveryNames = discoveryNames.filter((item) => item !== name);
        discoveryNames.push(name);
      }
      discoveryNames = discoveryNames.slice(-DISCOVERY_LIMIT);
      config.onDiscover?.(names, discoveryVersion);
    },
  };

  const recentNames = (limit = 5): readonly string[] => {
    if (discoveryVersion === "" || catalogVersion === "" || discoveryVersion !== catalogVersion) return [];
    return discoveryNames.slice(-Math.max(1, Math.min(DISCOVERY_LIMIT, Math.trunc(limit) || 5)));
  };

  /** 名字冲突：同一前缀来自重复的 server_id 或远端 tools/list 重复项时，保留第一条并告警。 */
  const buildRegistrations = (): ToolRegistration[] => {
    const seen = new Set<string>();
    const registrations: ToolRegistration[] = [];
    for (const client of clients.values()) {
      for (const tool of client.tools) {
        const name = mcpToolSchema(client.serverId, tool).function.name;
        if (seen.has(name)) {
          config.client?.onLog?.("warn", `[mcp] duplicate tool name ignored: ${name}`);
          continue;
        }
        seen.add(name);
        registrations.push(createMcpToolRegistration(client, tool));
      }
    }
    return registrations;
  };

  await syncClients();
  await connectAll();

  const api: McpTools = {
    catalog: catalogReader,
    tools: buildRegistrations,
    extension: () => defineExtension({ name: "datawhisper-mcp", tools: buildRegistrations() }),
    async refresh() {
      await syncClients();
      failureAt.clear();
      await connectAll();
      return buildRegistrations();
    },
    connectAll,
    async call(fullName, args) {
      try {
        // Python `split("__", 2)`：只切前两个分隔符，原始工具名里的 `__` 保留。
        const parts = fullName.split("__");
        if (parts.length < 3 || parts[0] !== "mcp") {
          return formatMcpError("unknown", fullName, `无效的 MCP 工具名格式: ${fullName}`);
        }
        const serverId = parts[1]!;
        const rawName = parts.slice(2).join("__");
        const client = clients.get(serverId);
        if (client === undefined) return formatMcpError(serverId, rawName, "服务器未注册");
        return (await client.callTool(rawName, args)).text;
      } catch (error) {
        return formatMcpError("unknown", fullName, error instanceof Error ? error.message : String(error));
      }
    },
    async discover(message) {
      const { catalog } = await catalogReader.read();
      const matches = searchMcpCatalog(catalog, message, "", 5);
      const names = matches.map((match) => match.name);
      catalogReader.record?.(names);
      return names;
    },
    recentNames,
    schemas: connectedSchemas,
    selectForTurn(names, limit = 5) {
      const byName = new Map(buildRegistrations().map((registration) => [registration.name, registration]));
      const ordered: string[] = [];
      for (const name of names) {
        if (byName.has(name) && !ordered.includes(name)) ordered.push(name);
      }
      const bounded = Math.max(1, Math.min(5, Math.trunc(limit) || 5));
      return ordered.slice(-bounded).flatMap((name) => {
        const registration = byName.get(name);
        return registration === undefined ? [] : [registration];
      });
    },
    async close() {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
    },
  };

  return api;
}

export * from "./config.ts";
export * from "./client.ts";
export * from "./tools.ts";
