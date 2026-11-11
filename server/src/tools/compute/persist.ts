/**
 * 图表落盘。
 *
 * compute worker 的 `CallChartStore` 只在**单次调用内**保留图表 HTML（注释写明“由调用方负责持久化”），
 * 所以工具外壳必须把返回里的 `charts[].html` 写成 `<chartDir>/<chart_id>.html`，否则界面只有一句
 * “Chart generated”却没有任何可展示的文件。
 *
 * 写入用临时文件 + rename，避免界面读到半截 HTML；details 里把 `html` 换成 `path`，不让几十 KB 的
 * 页面挤在 IPC 消息里。
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

const CHART_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 记录字段名来自 compute：`id`（旧实现里也叫 `chart_id`）、`html`、`title`、`chart_type`、`spec`。 */
type ChartRecord = { id?: unknown; chart_id?: unknown; html?: unknown; path?: unknown; [key: string]: unknown };

/** 落盘一张图表；返回写好的路径，id 不合法或没有 HTML 时返回 undefined。 */
export function writeChart(chartDir: string, chart: ChartRecord): string | undefined {
  const id = typeof chart.id === "string" ? chart.id : typeof chart.chart_id === "string" ? chart.chart_id : "";
  const html = typeof chart.html === "string" ? chart.html : "";
  if (!CHART_ID.test(id) || html.trim() === "") return undefined;
  if (!existsSync(chartDir)) mkdirSync(chartDir, { recursive: true });
  const path = join(chartDir, `${id}.html`);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, html, { encoding: "utf8", mode: 0o644 });
  renameSync(temp, path);
  return path;
}

type ToolResult = { details?: unknown; isError?: true; [key: string]: unknown };

/** 把结果里带 `html` 的 chart 记录写成文件，并把 details 里的 `html` 换成 `path`。 */
export function persistChartResult(result: ToolResult, chartDir: string): ToolResult {
  const details = result.details;
  if (typeof details !== "object" || details === null) return result;
  const charts = (details as { charts?: unknown }).charts;
  if (!Array.isArray(charts) || charts.length === 0) return result;
  let changed = false;
  const next = charts.map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const chart = item as ChartRecord;
    if (typeof chart.html !== "string") return item;
    const path = writeChart(chartDir, chart);
    if (path === undefined) return item;
    changed = true;
    const { html: _html, ...rest } = chart;
    return { ...rest, path };
  });
  if (!changed) return result;
  return { ...result, details: { ...(details as object), charts: next } };
}

/**
 * 包一层：成功结果里的图表落盘。只处理 `charts`，工具输出的文本与其它 details 原样透传。
 */
export function withChartPersistence(tools: readonly ToolRegistration[], chartDir: string): ToolRegistration[] {
  return tools.map((tool) =>
    defineTool<object>({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: tool.replay,
      async execute(args, api, context) {
        const run = tool.execute as unknown as (args: unknown, api: unknown, context: Context) => Promise<ToolResult>;
        const result = await run(args, api, context);
        return persistChartResult(result, chartDir) as never;
      },
    }),
  );
}
