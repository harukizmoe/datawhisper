/**
 * 提案类工具：在真正生成文件之前，把结构化计划交回界面/调用方。
 *
 * `propose_*` 只产出 markdown 与结构化参数，不写文件；`set_ppt_color_scheme`
 * 更新会话配色偏好（宿主通过 `deps.colorScheme` 读取）。文案与 Python
 * `agent/tools/business/export.py` 一致。
 */

import type { JsonValue } from "@earendil-works/chord";
import { errorResult, makeAppTool, okResult, type AppTool, type AppToolDeps } from "../types.ts";

/** 与 `Function/Charts_generation/charts/color_schemes.py` 相同的四套方案。 */
export const COLOR_SCHEMES: Readonly<Record<string, { name: string; description: string }>> = {
  mckinsey: { name: "McKinsey Blue", description: "麦肯锡蓝色配色" },
  bcg: { name: "BCG Green", description: "波士顿咨询绿色配色" },
  bain: { name: "Bain Red", description: "贝恩红色配色" },
  ey: { name: "EY Yellow", description: "安永黄色配色" },
};

const PPT_LAYOUT_LABELS: Readonly<Record<string, readonly [string, string]>> = {
  cover: ["封面", "Cover"],
  toc: ["目录", "Table of Contents"],
  section_divider: ["章节分割", "Section Divider"],
  closing: ["结束页", "Closing"],
  big_number: ["大数字", "Big Number"],
  two_stat: ["双数字对比", "Two-Stat Compare"],
  metric_cards: ["指标卡片", "Metric Cards"],
  data_table: ["数据表格", "Data Table"],
  table_insight: ["洞察表格", "Insight Table"],
  executive_summary: ["执行摘要", "Executive Summary"],
  two_column_text: ["双栏文本", "Two-Column Text"],
  action_items: ["行动项", "Action Items"],
  donut: ["环形图", "Donut Chart"],
  grouped_bar: ["分组柱状图", "Grouped Bar"],
  stacked_bar: ["堆叠柱状图", "Stacked Bar"],
  timeline: ["时间轴", "Timeline"],
};

type ReportSection = { heading: string; content: string };

/** `normalize_report_outline_args`：把 title/body 别名统一成 heading/content。 */
export function normalizeReportSections(raw: JsonValue | undefined): ReportSection[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { heading: "", content: "" };
    }
    const section = item as Record<string, JsonValue>;
    const heading = typeof section.heading === "string" && section.heading.trim()
      ? section.heading
      : typeof section.title === "string" ? section.title : "";
    const content = typeof section.content === "string" && section.content.trim()
      ? section.content
      : typeof section.body === "string" ? section.body : "";
    return { heading, content };
  });
}

/** `validate_tool_args(propose_report_outline, …)` 的原话。 */
export function validateReportOutline(name: string, title: string, sections: readonly ReportSection[]): string | undefined {
  if (!title.trim()) return `'${name}' requires a non-empty 'title'.`;
  if (sections.length === 0) return `'${name}' requires a non-empty 'sections' list.`;
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] as ReportSection;
    if (!section.heading.trim()) return `'${name}': section ${index + 1} requires a non-empty 'heading'.`;
    if (!section.content.trim()) return `'${name}': section ${index + 1} requires non-empty string 'content'.`;
  }
  return undefined;
}

function fail(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createProposalTools(deps: AppToolDeps): AppTool[] {
  const colorScheme = deps.colorScheme ?? { value: "mckinsey" };
  const label = (layout: string): string => {
    const pair = PPT_LAYOUT_LABELS[layout];
    if (pair === undefined) return layout;
    return deps.uiLang === "en" ? pair[1] : pair[0];
  };
  return [
    makeAppTool<{ tables: string[]; filename?: string; summary?: string }>({
      name: "propose_excel_export",
      description:
        "Show the user a preview of which tables will be exported BEFORE generating the Excel file.\n" +
        "ONLY call this when the /export slash command is active. NEVER call proactively.\n" +
        "The frontend renders a confirmation card with Confirm / Edit / Cancel buttons.",
      parameters: {
        type: "object",
        properties: {
          tables: {
            type: "array",
            items: { type: "string" },
            description: "Table names to export. Use [\"*\"] to export all available tables.",
          },
          filename: { type: "string", description: "Base filename without extension (optional)." },
          summary: { type: "string", description: "One-sentence description of what will be exported." },
        },
        required: ["tables"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const tables = args.tables ?? [];
          const all = tables.length === 1 && (tables[0] === "*" || tables[0] === "all");
          const exportLabel = all
            ? "全部可用表格（原始数据 + 分析结果）"
            : tables.length > 0 ? tables.join("、") : "（未指定）";
          let markdown =
            `**导出目标：** ${exportLabel}\n\n` +
            `**文件名：** ${args.filename || "（自动生成）"}.xlsx\n\n`;
          if (args.summary) markdown += `**说明：** ${args.summary}\n`;
          const result = { tables, filename: args.filename ?? "", summary: args.summary ?? "", markdown };
          return okResult("propose_excel_export", "导出计划已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。", {
            tool: "propose_excel_export",
            event: "excel_outline",
            ...(result as unknown as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("propose_excel_export", error);
        }
      },
    }),
    makeAppTool<{ title: string; sections: JsonValue }>({
      name: "propose_report_outline",
      description:
        "Show the user a report outline for review BEFORE generating the Word file.\n" +
        "ONLY call this when the /report slash command is active. NEVER call proactively.\n" +
        "The frontend renders a confirmation card with Confirm / Edit / Cancel buttons.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Report title." },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: { heading: { type: "string" }, content: { type: "string" } },
              required: ["heading", "content"],
            },
            description: "Ordered list of report sections.",
          },
        },
        required: ["title", "sections"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const sections = normalizeReportSections(args.sections);
          const problem = validateReportOutline("propose_report_outline", args.title ?? "", sections);
          if (problem !== undefined) throw new Error(problem);
          const rows = ["| # | 章节标题 |\n|---|---------|"];
          sections.forEach((section, index) => {
            rows.push(`| ${index + 1} | ${section.heading || `Section ${index + 1}`} |`);
          });
          const markdown = `**${args.title}**（共 ${sections.length} 个章节）\n\n` + rows.join("\n");
          return okResult("propose_report_outline", "报告大纲已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。", {
            tool: "propose_report_outline",
            event: "report_outline",
            title: args.title,
            sections: sections as unknown as JsonValue,
            markdown,
          });
        } catch (error) {
          return fail("propose_report_outline", error);
        }
      },
    }),
    makeAppTool<{ title: string; slides: JsonValue }>({
      name: "propose_ppt_outline",
      description:
        "Show the user a slide-by-slide PPT outline for review BEFORE generating the file.\n" +
        "ONLY call this when the /ppt slash command is active. NEVER call proactively.\n" +
        "The frontend will render an editable card with Confirm / Edit / Cancel buttons.\n" +
        "Use exactly the same parameters as generate_ppt.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Overall deck title." },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: { layout: { type: "string" }, params: { type: "object" } },
              required: ["layout", "params"],
            },
            description: "Ordered list of slides, each {layout, params}.",
          },
        },
        required: ["title", "slides"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const slides = Array.isArray(args.slides) ? args.slides : [];
          if (slides.length === 0) {
            return errorResult(
              "propose_ppt_outline",
              "ERROR: slides array is empty. You MUST provide a " +
                "slides array with 8-15 slide objects. Re-read the " +
                "query results above and call propose_ppt_outline " +
                "again with a complete slides list.",
            );
          }
          const rows = ["| # | 布局 | 内容摘要 |\n|---|------|---------|"];
          slides.forEach((slide, index) => {
            const record = (slide ?? {}) as Record<string, JsonValue>;
            const layout = typeof record.layout === "string" ? record.layout : "";
            const params = (record.params ?? {}) as Record<string, JsonValue>;
            const title = typeof params.title === "string" ? params.title : "";
            const extra = [params.subtitle, params.message, params.section_label, params.headline]
              .find((value): value is string => typeof value === "string" && value !== "") ?? "";
            const summary = extra ? `${title} · ${extra}` : title;
            rows.push(`| ${index + 1} | ${label(layout)} | ${summary} |`);
          });
          const markdown = `**${args.title}**（共 ${slides.length} 张）\n\n` + rows.join("\n");
          return okResult("propose_ppt_outline", "大纲已展示给用户，等待其通过按钮确认或修改。", {
            tool: "propose_ppt_outline",
            event: "ppt_outline",
            title: args.title,
            slides: slides as unknown as JsonValue,
            markdown,
          });
        } catch (error) {
          return fail("propose_ppt_outline", error);
        }
      },
    }),
    makeAppTool<{ scheme: string }>({
      name: "set_ppt_color_scheme",
      description:
        "Set the color scheme for ALL visuals in this session — both Plotly charts " +
        "and PPT slides. Default is 'mckinsey'. " +
        "Available schemes: mckinsey, bcg, bain, ey. " +
        "Call this IMMEDIATELY whenever the user mentions a color preference, firm style, " +
        "or brand (e.g. 'BCG green', 'Bain style', 'EY yellow', '麦肯锡蓝'). " +
        "If the user never specifies, do NOT call this tool — mckinsey is already active.",
      parameters: {
        type: "object",
        properties: {
          scheme: {
            type: "string",
            enum: ["mckinsey", "bcg", "bain", "ey"],
            description: "Color scheme name.",
          },
        },
        required: ["scheme"],
      },
      replay: "safe",
      async execute(args) {
        const requested = (args.scheme ?? "").toLowerCase().trim();
        const info = COLOR_SCHEMES[requested];
        if (info === undefined) {
          return errorResult(
            "set_ppt_color_scheme",
            `未知配色方案 '${requested}'。可用方案：${Object.keys(COLOR_SCHEMES).join(", ")}`,
          );
        }
        colorScheme.value = requested;
        return okResult(
          "set_ppt_color_scheme",
          `✅ 配色已切换为「${info.name}」（${info.description}），后续图表和 PPT 均使用此配色。`,
          { tool: "set_ppt_color_scheme", event: "ppt_scheme", scheme: requested },
        );
      },
    }),
    makeAppTool<{ name: string; widgets: JsonValue }>({
      name: "propose_dashboard_outline",
      description:
        "Show the user a dashboard outline for review BEFORE generating the dashboard.\n" +
        "ONLY call this when the /dashboard slash command is active. NEVER call proactively.\n" +
        "The frontend renders a confirmation card with Confirm / Edit / Cancel buttons.\n" +
        "Do NOT call generate_dashboard in the same turn.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Dashboard name." },
          widgets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                chart_type: {
                  type: "string",
                  enum: [
                    "Bar_Chart", "Line_Chart", "Pie_Chart",
                    "Scatter_Plot", "Area_Chart", "Grouped_Bar_Chart",
                    "Heatmap", "Stacked_Bar_Chart",
                  ],
                },
                sql: { type: "string", description: "Valid SQL against real tables." },
                field_mapping: {
                  type: "object",
                  description: "Maps chart axes/roles to SQL result column names. Values must be real column names from the SQL query output, never placeholder strings like 'category'. Example: {\"x\":\"month\",\"y\":\"revenue\"} or {\"x\":\"city\",\"y\":[\"sales\",\"profit\"]}.",
                },
                options: { type: "object" },
                grid: { type: "object", description: "{x, y, w, h} grid position (w/h in grid units)." },
              },
              required: ["title", "chart_type", "sql", "field_mapping"],
            },
            description: "List of widget specs (2–6 widgets recommended).",
          },
        },
        required: ["name", "widgets"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const widgets = Array.isArray(args.widgets) ? args.widgets : [];
          if (widgets.length === 0) {
            return errorResult(
              "propose_dashboard_outline",
              "ERROR: widgets array is empty. You MUST provide a " +
                "widgets array with at least 1 widget object. Re-read " +
                "the data schema and call propose_dashboard_outline " +
                "again with a complete widgets list.",
            );
          }
          const rows = ["| # | 标题 | 图表类型 | 核心字段 |", "|---|------|---------|---------|"];
          widgets.forEach((widget, index) => {
            const record = (widget ?? {}) as Record<string, JsonValue>;
            const title = typeof record.title === "string" ? record.title : `图表 ${index + 1}`;
            const chartType = typeof record.chart_type === "string" ? record.chart_type : "Bar_Chart";
            const mapping = record.field_mapping;
            const fields = mapping !== null && typeof mapping === "object" && !Array.isArray(mapping)
              ? Object.entries(mapping as Record<string, JsonValue>)
                .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("|") : String(value)}`)
                .join(", ")
              : "—";
            rows.push(`| ${index + 1} | ${title} | ${chartType} | ${fields || "—"} |`);
          });
          const markdown = `**${args.name}**（共 ${widgets.length} 个组件）\n\n` + rows.join("\n");
          return okResult(
            "propose_dashboard_outline",
            "看板大纲已展示给用户，等待其通过按钮确认或修改。请不要输出任何文字。",
            {
              tool: "propose_dashboard_outline",
              event: "dashboard_outline",
              name: args.name,
              widgets: widgets as unknown as JsonValue,
              markdown,
            },
          );
        } catch (error) {
          return fail("propose_dashboard_outline", error);
        }
      },
    }),
  ];
}
