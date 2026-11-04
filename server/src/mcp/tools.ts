/**
 * MCP 工具的模型侧包装与目录（`mcp__<server>__<tool>`）。
 *
 * 行为基准：
 * - `agent/mcp_manager.py::mcp_tool_to_openai_schema / validate_mcp_args / format_mcp_error`：
 *   前缀命名、描述前缀、参数 schema 只透传 type/properties/required、失败文案。
 * - `agent/mcp_discovery.py::build_mcp_catalog / mcp_catalog_version / select_mcp_schemas`：
 *   无 schema 的紧凑目录、关键词、schema 哈希与「最近 5 个」选择。
 *
 * 注册策略：每个远端工具都是 pi-durable 的 `defineTool`，`deferred: true` + `replay: "unsafe"`。
 * - `deferred` 让模型默认看不到它；`search_mcp_tools` 的结果通过 `control.addTools` 把名字加进
 *   `modelTools.add`，下一次模型请求才会出现（这正是旧实现 “available on the next model step” 的语义）。
 *   用 `configure({ modelTools })` 不行：它是整体替换，每轮提交前由 `conversations/service.ts` 重算，
 *   工具执行中改不动。
 * - `replay: "unsafe"`：远端工具可能有副作用，崩溃后不自动重跑（旧实现也没有重放语义）。
 *
 * 超长结果：工具本身只返回远端文本，外溢由 P4.4 的 `tools/guard` 扩展在 `afterTool` 统一处理
 * （任何工具的长结果都会写成 `tr_<id>` 并换成预览 + 指路行），这里不重复实现。
 */

import { createHash } from "node:crypto";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { McpCatalogEntry } from "../tools/app/mcp.ts";
import type { McpServerClient, McpToolDef } from "./client.ts";

/** 旧 `mcp_tool_to_openai_schema` 产出的 OpenAPI function 片段（目录哈希也基于它）。 */
export type McpOpenAiSchema = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
};

const WORD_RE = /[a-z0-9]{2,}|[\u4e00-\u9fff]{2,}/gi;
const STOP_WORDS: Readonly<Record<string, true>> = {
  the: true,
  and: true,
  for: true,
  with: true,
  from: true,
  into: true,
  this: true,
  that: true,
  tool: true,
  use: true,
  using: true,
  get: true,
  list: true,
  create: true,
  return: true,
  returns: true,
};

/** 旧实现固定前缀：`mcp__<server_id>__<原始工具名>`。 */
export function mcpToolName(serverId: string, rawName: string): string {
  return `mcp__${serverId}__${rawName}`;
}

/** 旧 `format_mcp_error` 的逐字文案。 */
export function formatMcpError(serverId: string, toolName: string, reason: string): string {
  return (
    `[MCP ERROR] server=${serverId} tool=${toolName}\n`
    + `Error: ${reason}\n`
    + "The MCP tool call failed. Please inform the user and continue without this tool result."
  );
}

/** 旧 `mcp_tool_to_openai_schema`：只透传 type/properties/required，不把 $schema 等塞给模型。 */
export function mcpToolSchema(serverId: string, tool: McpToolDef): McpOpenAiSchema {
  const description = tool.description === "" ? tool.name : tool.description;
  const schema = tool.inputSchema;
  const properties = typeof schema.properties === "object" && schema.properties !== null && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const parameters: Record<string, unknown> = {
    type: typeof schema.type === "string" ? schema.type : "object",
    properties,
  };
  if (Array.isArray(schema.required)) parameters.required = schema.required;
  return {
    type: "function",
    function: {
      name: mcpToolName(serverId, tool.name),
      description: `[MCP:${serverId}] ${description}`,
      parameters,
    },
  };
}

/**
 * 旧 `validate_mcp_args`：必填字段与声明的类型。Harness 已经做过一次 schema 校验，
 * 这里保留旧文案，保证同样的输入得到同样的错误。
 */
export function validateMcpArgs(
  inputSchema: Readonly<Record<string, unknown>>,
  args: Readonly<Record<string, unknown>>,
): { ok: true } | { ok: false; error: string } {
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  for (const field of required) {
    if (!(String(field) in args)) return { ok: false, error: `缺少必填参数: ${String(field)}` };
  }
  // JSON 边界断言：下面是逐字段 typeof 校验，不是盲读。
  const properties = typeof inputSchema.properties === "object" && inputSchema.properties !== null && !Array.isArray(inputSchema.properties)
    ? (inputSchema.properties as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(args)) {
    const property = key in properties ? properties[key] : undefined;
    if (typeof property !== "object" || property === null || !("type" in property) || typeof property.type !== "string") continue;
    const expected = property.type;
    if (typeMismatch(expected, value)) return { ok: false, error: `参数 '${key}' 类型错误: 期望 ${expected}` };
  }
  return { ok: true };
}

/** 返回 true 表示类型不匹配。`integer` 接受没有小数部分的 number（旧实现用 isinstance(int)）。 */
function typeMismatch(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value !== "string";
    case "number":
      return typeof value !== "number" || Number.isNaN(value);
    case "integer":
      return typeof value !== "number" || !Number.isInteger(value);
    case "boolean":
      return typeof value !== "boolean";
    case "array":
      return !Array.isArray(value);
    case "object":
      return typeof value !== "object" || value === null || Array.isArray(value);
    default:
      return false;
  }
}

/** Python `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)` 的等价物。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 旧 `_summary`：压平空白，取第一句，最多 240 字。 */
function summarize(description: string): string {
  const text = description.replace(/\s+/g, " ").trim();
  const first = text.split(/(?<=[.!?。！？])\s+/u)[0] ?? "";
  return first.slice(0, 240);
}

/** 旧 `_keywords`：服务器名、原名及其分词、描述词；最多 16 个，覆盖词追加到 24 个。 */
function keywordsFor(name: string, server: string, description: string): string[] {
  const original = name.split("__").slice(2).join("__");
  const values = [server, original, ...original.split(/[_\-\s]+/)];
  values.push(...(description.match(WORD_RE) ?? []));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = String(value ?? "").trim().toLowerCase();
    if (item.length < 2 || STOP_WORDS[item] === true || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= 16) break;
  }
  return result;
}

/**
 * 旧 `build_mcp_catalog`：从当前连接到的工具生成无参数 schema 的目录。
 * 输入是 `mcpToolSchema` 的形状，哈希覆盖整份 schema（与旧实现一致）。
 */
export function buildMcpCatalog(
  schemas: readonly McpOpenAiSchema[],
  keywordOverrides: Readonly<Record<string, readonly string[]>> = {},
): McpCatalogEntry[] {
  const catalog: McpCatalogEntry[] = [];
  for (const schema of schemas) {
    const name = schema.function.name;
    if (!name.startsWith("mcp__")) continue;
    const parts = name.split("__");
    const server = parts.length >= 3 ? parts[1]! : "";
    const keywords = keywordsFor(name, server, schema.function.description);
    for (const value of keywordOverrides[name] ?? []) {
      const item = String(value ?? "").trim().toLowerCase();
      if (item !== "" && !keywords.includes(item)) keywords.push(item);
    }
    catalog.push({
      name,
      server,
      summary: summarize(schema.function.description),
      keywords: keywords.slice(0, 24),
      schema_hash: digest(stableStringify(schema)).slice(0, 16),
    });
  }
  return catalog.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** 旧 `mcp_catalog_version`：按 (name, schema_hash) 排序后哈希，取前 16 位。 */
export function mcpCatalogVersion(catalog: readonly McpCatalogEntry[]): string {
  const compact = catalog.map((item) => [item.name, item.schema_hash]).sort((left, right) => {
    const nameOrder = left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0;
    if (nameOrder !== 0) return nameOrder;
    return left[1]! < right[1]! ? -1 : left[1]! > right[1]! ? 1 : 0;
  });
  return digest(JSON.stringify(compact)).slice(0, 16);
}

/**
 * 旧 `select_mcp_schemas`：按调用方给的「最近使用」顺序取最后 N 个已连接的 schema。
 * 这是「每轮只暴露最近发现的 5 个 MCP 工具」的选片函数；暴露接线在宿主（见 index.ts 的说明）。
 */
export function selectMcpSchemas(
  schemas: readonly McpOpenAiSchema[],
  names: readonly string[],
  limit = 5,
): McpOpenAiSchema[] {
  const byName = new Map(schemas.map((schema) => [schema.function.name, schema]));
  const ordered: string[] = [];
  for (const name of names) {
    if (byName.has(name) && !ordered.includes(name)) ordered.push(name);
  }
  const bounded = Math.max(1, Math.min(5, Math.trunc(limit) || 5));
  return ordered.slice(-bounded).flatMap((name) => {
    const schema = byName.get(name);
    return schema === undefined ? [] : [schema];
  });
}

/**
 * 把一个远端工具包成 pi-durable 注册项。
 *
 * 失败时**不设** `isError`：旧实现的 `call_tool` 把 `[MCP ERROR] …` 当普通结果文本返回，
 * 由模型自己读文案；守卫仍会按 `[MCP ERROR]` 前缀把它识别为错误并截断过长文本。
 */
export function createMcpToolRegistration(client: McpServerClient, tool: McpToolDef): ToolRegistration {
  const schema = mcpToolSchema(client.serverId, tool);
  return defineTool({
    name: schema.function.name,
    description: schema.function.description,
    parameters: schema.function.parameters,
    replay: "unsafe",
    deferred: true,
    async execute(args: unknown) {
      const record = typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
      const outcome = await client.callTool(tool.name, record);
      return {
        output: [{ type: "text" as const, text: outcome.text }],
        details: {
          tool: schema.function.name,
          server: client.serverId,
          mcp_tool: tool.name,
          failed: outcome.failed,
        },
      };
    },
  });
}
