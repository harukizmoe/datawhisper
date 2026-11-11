/**
 * `select_chart`：图表注册表检索。
 *
 * 移植自 `LLM/chart_selector.py` 的 `_score_chart` / `select_charts` /
 * `format_selection_result`。评分规则（关键词加分、列形状信号、全文匹配、
 * 列名与 required_roles 的亲和度）和输出文案逐字保留，方便模型行为对齐。
 */

import type { JsonValue } from "@earendil-works/chord";
import { pyRepr } from "../../agent/py-compat.ts";
import { say } from "../../i18n.ts";
import { errorResult, makeAppTool, okResult, type AppTool, type AppToolDeps } from "./types.ts";
import { BOOST_TABLE, CHARTS, COLUMN_PATTERN_TABLE, type ChartEntry } from "./chart-registry.ts";

const MINIMUM_VALID_SCORE = 1;

export type ChartCandidate = {
  chart_id: string;
  name: string;
  category: string;
  required_roles: string[];
  optional_roles: string[];
  data_format: string;
  constraints: string;
  desc: string;
  _score: number;
};

function flattenRoles(entry: ChartEntry): string[] {
  const roles: string[] = [];
  for (const role of entry.required_roles) {
    if (typeof role === "string") roles.push(role);
    else roles.push(...role);
  }
  return roles;
}

export function scoreChart(entry: ChartEntry, intentLower: string, columns: readonly string[]): number {
  let score = 0;
  for (const rule of BOOST_TABLE) {
    if (!rule.charts.includes(entry.chart_id)) continue;
    if (rule.words.some((word) => intentLower.includes(word))) score += rule.boost;
  }
  const columnsJoined = columns.join(" ");
  for (const rule of COLUMN_PATTERN_TABLE) {
    if (rule.chart !== entry.chart_id) continue;
    const hits = rule.substrings.filter((substring) => columnsJoined.includes(substring)).length;
    if (hits >= rule.threshold) score += rule.boost;
  }
  const haystack = [entry.name, entry.desc, entry.data_format, entry.constraints].join(" ").toLowerCase();
  for (const token of intentLower.split(/\s+/)) {
    if (token.length >= 2 && haystack.includes(token)) score += 4;
  }
  for (const role of flattenRoles(entry)) {
    const roleLower = role.toLowerCase();
    for (const column of columns) {
      if (roleLower.includes(column) || column.includes(roleLower)) score += 3;
    }
  }
  return score;
}

export function selectCharts(
  userIntent: string,
  availableColumns: readonly string[] = [],
  topN = 3,
): ChartCandidate[] {
  const intentLower = userIntent.toLowerCase();
  const columns = availableColumns.map((column) => column.toLowerCase());
  const scored = CHARTS.map((entry) => ({ entry, score: scoreChart(entry, intentLower, columns) }))
    .filter((item) => item.score >= MINIMUM_VALID_SCORE);
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, topN).map(({ entry, score }) => ({
    chart_id: entry.chart_id,
    name: entry.name,
    category: entry.category,
    required_roles: entry.required_roles.map((role) => (typeof role === "string" ? role : role.join(" OR "))),
    optional_roles: [...entry.optional_roles],
    data_format: entry.data_format,
    constraints: entry.constraints,
    desc: entry.desc,
    _score: score,
  }));
}

export function formatSelectionResult(candidates: readonly ChartCandidate[]): string {
  if (candidates.length === 0) {
    return (
      "No matching charts found in the registry. " +
      "Use `ask_user` to confirm the visualization goal " +
      "before selecting a chart."
    );
  }
  const lines: string[] = [
    say(
      "The following candidate charts were matched from the chart registry for the user's request (sorted by relevance).",
      "根据用户需求，从图表注册表中匹配到以下候选图表（按相关度排序）。",
    ),
    say(
      "Pick the most suitable one and **build `field_mapping` strictly with the keys listed in `required_roles`**.",
      "请选择最合适的一个，并**严格使用 `required_roles` 中列出的 key 构造 `field_mapping`**。",
    ),
    "",
  ];
  candidates.forEach((candidate, index) => {
    const scoreHint = (candidate._score ?? 0) > 0 ? `  *(score=${candidate._score})*` : "";
    lines.push(say(
      `### Option ${index + 1}: ${candidate.name}  (\`${candidate.chart_id}\`)${scoreHint}`,
      `### 选项 ${index + 1}：${candidate.name}  (\`${candidate.chart_id}\`)${scoreHint}`,
    ));
    lines.push(`- **${say("Category", "分类")}**${say(": ", "：")}${candidate.category}`);
    lines.push(`- **${say("Purpose", "用途")}**${say(": ", "：")}${candidate.desc}`);
    lines.push(`- **required_roles → field_mapping keys**${say(": ", "：")}\`${pyRepr(candidate.required_roles)}\``);
    if (candidate.optional_roles.length > 0) {
      lines.push(`- **optional_roles**${say(": ", "：")}\`${pyRepr(candidate.optional_roles)}\``);
    }
    lines.push(`- **${say("Data format", "数据格式")}**${say(": ", "：")}${candidate.data_format}`);
    if (candidate.constraints) {
      lines.push(`- **${say("Constraints", "约束")}**${say(": ", "：")}${candidate.constraints}`);
    }
    lines.push("");
  });
  lines.push(
    "---",
    say("**Next steps**:", "**下一步操作**："),
    say("1. Pick a `chart_id`", "1. 选定 `chart_id`"),
    say(
      "2. Use `query_data` to confirm the SQL result column names match `required_roles` one to one",
      "2. 用 `query_data` 确认 SQL 结果列名与 `required_roles` 一一对应",
    ),
    say(
      "3. Call `generate_chart`; the keys of `field_mapping` must come strictly from the `required_roles` above",
      "3. 调用 `generate_chart`，`field_mapping` 的 key 必须完全来自上面的 `required_roles`",
    ),
  );
  return lines.join("\n");
}

export function createChartTool(_deps: AppToolDeps): AppTool[] {
  return [
    makeAppTool<{ user_intent: string; available_columns?: string[] }>({
      name: "select_chart",
      description:
        "Look up the chart registry to find the best-matching chart type for the user's request. " +
        "ALWAYS call this BEFORE generate_chart whenever the user asks for a visualization " +
        "and you are not 100% certain which chart_id and field_mapping keys to use. " +
        "Returns the top matching charts with their exact required_roles, data_format, " +
        "and constraints — use this information to construct the correct field_mapping for generate_chart. " +
        "Do NOT skip this step and guess the chart type directly.",
      parameters: {
        type: "object",
        properties: {
          user_intent: {
            type: "string",
            description:
              "A concise description of what the user wants to visualize. " +
              "Include chart type hints if the user mentioned one, the business question, " +
              "and any dimension/metric keywords. " +
              "Examples: '各月销售额趋势', '产品类别占比饼图', '两个时间点的排名变化', " +
              "'地区销售热力图', 'KPI达成率对比'.",
          },
          available_columns: {
            type: "array",
            items: { type: "string" },
            description:
              "Column names available in the data (from get_schema or query_data). " +
              "Helps the selector match required_roles to actual columns. " +
              "Leave empty if schema is unknown.",
          },
        },
        required: ["user_intent"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const candidates = selectCharts(args.user_intent ?? "", args.available_columns ?? [], 3);
          const text = formatSelectionResult(candidates);
          return okResult("select_chart", text, {
            tool: "select_chart",
            candidates: candidates as unknown as JsonValue,
            count: candidates.length,
          });
        } catch (error) {
          return errorResult("select_chart", error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
}
