/**
 * XLSX 只读预览。
 *
 * 旧实现把这一步交给 pandas；TS 服务不能为此引入重依赖，因此这里直接读
 * OOXML 包：workbook.xml 取工作表顺序，sharedStrings.xml 取共享字符串，
 * worksheet XML 取行/单元格。日期格式化、合并单元格、公式求值不在本模块范围
 * （公式显示缓存值，日期显示序列号），这些差异在 P4.1 报告里注明。
 */

import { readZipEntry, listZipEntries, type ZipEntry } from "./zip.ts";

const MAX_SHARED_STRINGS_BYTES = 128 * 1024 * 1024;
const MAX_SHEET_BYTES = 128 * 1024 * 1024;

export type SheetRows = {
  readonly sheets: string[];
  readonly sheetName: string;
  /** 第 N 行（0 基）→ 单元格文本；缺失单元格为空串。 */
  readonly rows: string[][];
};

function xmlUnescape(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&#13;", "\r")
    .replaceAll("&amp;", "&");
}

function attribute(xml: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(xml);
  return match?.[1] ?? "";
}

function textRuns(xml: string): string {
  let result = "";
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) result += xmlUnescape(match[1] ?? "");
  return result;
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0]?.toUpperCase() ?? "";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function normalizeTarget(target: string): string {
  const clean = target.replaceAll("\\", "/");
  if (clean.startsWith("/")) return clean.slice(1);
  return clean.startsWith("xl/") ? clean : `xl/${clean.replace(/^\.\//, "")}`;
}

function entryByName(entries: readonly ZipEntry[], name: string): ZipEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

function sheetEntries(buffer: Buffer): { names: string[]; targets: string[] } {
  const entries = listZipEntries(buffer);
  const workbook = entryByName(entries, "xl/workbook.xml");
  if (workbook === undefined) throw new Error("workbook.xml is missing");
  const xml = readZipEntry(buffer, workbook, MAX_SHEET_BYTES).toString("utf8");
  const relsEntry = entryByName(entries, "xl/_rels/workbook.xml.rels");
  const rels = relsEntry === undefined
    ? new Map<string, string>()
    : new Map(
      [...readZipEntry(buffer, relsEntry, MAX_SHEET_BYTES).toString("utf8").matchAll(
        /<Relationship\b[^>]*>/g,
      )].map((match) => [attribute(match[0], "Id"), normalizeTarget(attribute(match[0], "Target"))]),
    );
  const names: string[] = [];
  const targets: string[] = [];
  for (const match of xml.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = match[0];
    names.push(attribute(tag, "name"));
    const relId = attribute(tag, "r:id");
    const target = rels.get(relId);
    if (target !== undefined) targets.push(target);
  }
  return { names, targets };
}

function sharedStrings(buffer: Buffer): string[] {
  const entries = listZipEntries(buffer);
  const entry = entryByName(entries, "xl/sharedStrings.xml");
  if (entry === undefined) return [];
  const xml = readZipEntry(buffer, entry, MAX_SHARED_STRINGS_BYTES).toString("utf8");
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1] ?? ""));
}

function readSheet(buffer: Buffer, target: string, strings: readonly string[]): string[][] {
  const entries = listZipEntries(buffer);
  const entry = entryByName(entries, target);
  if (entry === undefined) throw new Error(`worksheet ${target} is missing`);
  const xml = readZipEntry(buffer, entry, MAX_SHEET_BYTES).toString("utf8");
  const rows: string[][] = [];
  let width = 0;
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const index = columnIndex(attribute(attrs, "r"));
      const type = attribute(attrs, "t");
      let value = "";
      if (type === "s") {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = strings[Number.parseInt(raw, 10)] ?? "";
      } else if (type === "inlineStr") {
        value = textRuns(body);
      } else if (type === "b") {
        value = (/<v\b[^>]*>1<\/v>/.test(body) ? "TRUE" : "FALSE");
      } else {
        value = xmlUnescape(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }
      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    width = Math.max(width, cells.length);
    rows.push(cells);
  }
  return rows.map((cells) => {
    while (cells.length < width) cells.push("");
    return cells;
  });
}

/** 读取指定工作表（默认第一张）的全部行；调用方负责 offset/limit 与渲染预算。 */
export function readXlsxRows(buffer: Buffer, sheetName = ""): SheetRows {
  const { names, targets } = sheetEntries(buffer);
  if (names.length === 0) throw new Error("spreadsheet contains no worksheets");
  const wanted = sheetName.trim() || (names[0] as string);
  const index = names.indexOf(wanted);
  if (index < 0) {
    throw new Error(`worksheet not found: ${wanted}; available: ${names.slice(0, 20).join(", ")}`);
  }
  const target = targets[index];
  if (target === undefined) throw new Error(`worksheet ${wanted} has no workbook relationship`);
  return { sheets: names, sheetName: wanted, rows: readSheet(buffer, target, sharedStrings(buffer)) };
}
