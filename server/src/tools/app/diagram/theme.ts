/**
 * 概念图主题与质检：移植自 `agent/tools/business/diagram_theme.py`。
 *
 * 模型只写 draw.io 默认调色板的六个槽位（blue/green/yellow/red/purple/grey），
 * 落盘前确定性映射到会话配色（mckinsey/bcg/bain/ey）。QC 只给建议级 warnings，
 * 绝不把可渲染的图变成 error。
 */

const SERIES: Readonly<Record<string, readonly string[]>> = {
  mckinsey: ["#003B71", "#005CAB", "#0083CA", "#00A3E0", "#7FBA00", "#FFC000", "#F7630C", "#E2231A", "#A4373A", "#6B2C91"],
  bcg: ["#006C5B", "#009879", "#00B398", "#004A3F", "#8CC63F", "#F2A900", "#2C7FB8", "#3F454A"],
  bain: ["#E41E26", "#FF5C5C", "#A6192E", "#6E0E1B", "#E87722", "#0F8B8C", "#3F454A"],
  ey: ["#FFD100", "#2E2E38", "#75787B", "#9C6F00", "#00629B", "#E87722"],
};
const MUTED = "#7a8399";
const FILL_SLOTS: Readonly<Record<string, number>> = {
  "#dae8fc": 0,
  "#d5e8d4": 1,
  "#fff2cc": 2,
  "#f8cecc": 3,
  "#e1d5e7": 4,
};
const STROKE_SLOTS: Readonly<Record<string, number>> = {
  "#6c8ebf": 0,
  "#82b366": 1,
  "#d6b656": 2,
  "#b85450": 3,
  "#9673a6": 4,
};
const GREY_FILL = "#f5f5f5";
const GREY_STROKE = "#666666";
const TINT_FACTOR = 0.25;
const VERTEX_BUDGET = 60;
const EDGE_BUDGET = 80;
const FONT_MIN = 8;
const FONT_MAX = 24;

function tint(hexColor: string): string {
  const hex = hexColor.replace(/^#/, "");
  const channels = [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  return `#${channels
    .map((channel) => Math.round(channel * TINT_FACTOR + 255 * (1 - TINT_FACTOR)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function restyle(style: string, series: readonly string[]): string {
  return style
    .split(";")
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals < 0) return part;
      const key = part.slice(0, equals);
      let value = part.slice(equals + 1);
      const lowered = value.trim().toLowerCase();
      if (key === "fillColor") {
        const slot = FILL_SLOTS[lowered];
        if (slot !== undefined) value = tint(series[slot] ?? "#ffffff");
        else if (lowered === GREY_FILL) value = "#f7f8fa";
      } else if (key === "strokeColor" || key === "fontColor") {
        const slot = STROKE_SLOTS[lowered];
        if (slot !== undefined) value = series[slot] ?? MUTED;
        else if (lowered === GREY_STROKE) value = MUTED;
      }
      return `${key}=${value}`;
    })
    .join(";");
}

/** 槽位色 → 会话配色；任何内部异常都回退原 XML。 */
export function applyDiagramTheme(xml: string, scheme = "mckinsey"): { xml: string; warnings: string[] } {
  if (!xml || !xml.includes("<mxCell")) return { xml, warnings: [] };
  const series = SERIES[scheme] ?? SERIES.mckinsey ?? [];
  if (series.length === 0) return { xml, warnings: [] };
  let themed = 0;
  const output = xml.replace(/(<mxCell\b[^>]*\bstyle=")([^"]*)(")/g, (_match, head: string, style: string, tail: string) => {
    if (!/(?:fillColor|strokeColor|fontColor)=/.test(style)) return `${head}${style}${tail}`;
    const next = restyle(style, series);
    if (next !== style) themed += 1;
    return `${head}${next}${tail}`;
  });
  return themed === 0 ? { xml, warnings: [] } : { xml: output, warnings: [] };
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(tag)?.[1] ?? "";
}

/** 建议级 QC：节点/连线预算、悬空/孤立、字号越界。 */
export function qcDiagram(xml: string): string[] {
  const warnings: string[] = [];
  if (!xml || !xml.includes("<mxCell")) return warnings;
  const vertices: string[] = [];
  const edges: string[] = [];
  for (const match of xml.matchAll(/<mxCell\b[^>]*>/g)) {
    const tag = match[0];
    if (attr(tag, "vertex") === "1") vertices.push(tag);
    else if (attr(tag, "edge") === "1") edges.push(tag);
  }
  if (vertices.length > VERTEX_BUDGET) {
    warnings.push(
      `节点数 ${vertices.length} 超过概念图预算 ${VERTEX_BUDGET}，建议聚合次要节点或拆分为多张图`,
    );
  }
  if (edges.length > EDGE_BUDGET) {
    warnings.push(`连线数 ${edges.length} 超过预算 ${EDGE_BUDGET}，建议精简关系或拆分`);
  }
  const floating = edges.filter((edge) => !attr(edge, "source") || !attr(edge, "target")).length;
  if (floating > 0) {
    warnings.push(`存在 ${floating} 条悬空连线（缺 source/target），请在 edit_diagram 中补全`);
  }
  if (edges.length > 0) {
    const endpoints = new Set<string>();
    for (const edge of edges) {
      endpoints.add(attr(edge, "source"));
      endpoints.add(attr(edge, "target"));
    }
    const isolated = vertices.filter((vertex) => {
      const style = attr(vertex, "style");
      return (
        attr(vertex, "parent") === "1" &&
        !endpoints.has(attr(vertex, "id")) &&
        attr(vertex, "value").trim() !== "" &&
        !style.includes("swimlane") &&
        !style.includes("container")
      );
    });
    if (isolated.length > 0) {
      warnings.push(`存在 ${isolated.length} 个孤立节点（无任何连线），若它们不属于本图讯息请删除，否则请连线表达关系`);
    }
  }
  let badFonts = 0;
  for (const cell of [...vertices, ...edges]) {
    for (const part of attr(cell, "style").split(";")) {
      const equals = part.indexOf("=");
      if (equals < 0 || part.slice(0, equals) !== "fontSize") continue;
      const value = Number.parseFloat(part.slice(equals + 1));
      if (Number.isFinite(value) && (value < FONT_MIN || value > FONT_MAX)) badFonts += 1;
    }
  }
  if (badFonts > 0) {
    warnings.push(`存在 ${badFonts} 处字号越界（建议 ${FONT_MIN}-${FONT_MAX}，标题可到 20），请统一字号层级`);
  }
  return warnings;
}
