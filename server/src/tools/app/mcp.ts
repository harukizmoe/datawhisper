/**
 * MCP 工具目录检索（无参数 schema 的紧凑目录）。
 *
 * 评分规则移植自 `agent/mcp_discovery.py::search_mcp_catalog`：精确名、原名、
 * 全文包含、关键词交集与名称/摘要子串。连接管理本身仍由宿主提供。
 */

export type McpCatalogEntry = {
  name: string;
  server: string;
  summary: string;
  keywords: readonly string[];
  schema_hash: string;
};

export type McpMatch = {
  name: string;
  server: string;
  summary: string;
  schema_hash: string;
};

export type McpCatalogReader = {
  read(): { catalog: readonly McpCatalogEntry[]; version: string } | Promise<{
    catalog: readonly McpCatalogEntry[];
    version: string;
  }>;
  /** 记录本回合发现的工具名，供下一轮曝光策略使用。 */
  record?(names: readonly string[]): void;
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

function tokens(text: string): string[] {
  return [...text.matchAll(WORD_RE)].map((match) => match[0].toLowerCase());
}

export function searchMcpCatalog(
  catalog: readonly McpCatalogEntry[],
  query: string,
  server = "",
  limit = 5,
): McpMatch[] {
  const queryRaw = query.trim().toLowerCase();
  const queryText = queryRaw.split(/[_\-\s]+/).join(" ");
  const queryTokens = new Set(tokens(queryText).filter((token) => STOP_WORDS[token] !== true));
  const serverFilter = server.trim().toLowerCase();
  const scored: { score: number; name: string; item: McpCatalogEntry }[] = [];
  for (const item of catalog) {
    if (serverFilter && item.server.toLowerCase() !== serverFilter) continue;
    const name = item.name;
    const normalizedName = name.toLowerCase().split(/[_\-\s]+/).join(" ");
    const summary = item.summary.toLowerCase();
    const keywords = new Set(item.keywords.map((value) => value.toLowerCase()));
    let score = 0;
    if (queryRaw.includes(name.toLowerCase())) score += 100;
    const originalName = name.split("__", 3)[2]?.toLowerCase() ?? "";
    if (originalName && queryRaw.includes(originalName)) score += 40;
    if (queryText && `${normalizedName} ${summary}`.includes(queryText)) score += 20;
    for (const token of queryTokens) {
      if (keywords.has(token)) score += 8;
    }
    for (const token of queryTokens) {
      if (token.length >= 3 && normalizedName.includes(token)) score += 6;
      else if (token.length >= 4 && summary.includes(token)) score += 2;
    }
    if (score >= 12) scored.push({ score, name, item });
  }
  scored.sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const bounded = Math.max(1, Math.min(5, Math.trunc(limit) || 5));
  return scored.slice(0, bounded).map(({ item }) => ({
    name: item.name,
    server: item.server,
    summary: item.summary,
    schema_hash: item.schema_hash,
  }));
}
