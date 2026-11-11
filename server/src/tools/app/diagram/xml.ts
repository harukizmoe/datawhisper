/**
 * draw.io XML 校验、自动修复与按 cell id 编辑。
 *
 * 逐条移植自 `agent/tools/business/xml_utils.py`。Python 用 ElementTree，
 * TS 侧没有内置 XML DOM，因此校验使用“标签配对 + 属性检查”的保守实现，
 * 编辑操作用原始片段替换（保留 LLM 的属性顺序），语义与旧实现一致：
 * - 只处理 `<root>` 的直接子 `<mxCell>`；
 * - delete 递归删除子节点，并连带删除 source/target 指向被删节点的连线；
 * - id=0/1 是 draw.io 根哨兵，禁止删除。
 */


const STRUCTURAL_ATTRS = ["edge", "parent", "source", "target", "vertex", "connectable"] as const;
const VALID_ENTITIES: Readonly<Record<string, true>> = { lt: true, gt: true, amp: true, quot: true, apos: true };
const ROOT_CELLS = '<mxCell id="0"/>\n<mxCell id="1" parent="0"/>';

export type XmlOperation = {
  operation: string;
  cell_id: string;
  new_xml?: string;
};

export type OperationError = { type: string; cellId: string; message: string };

export type OperationResult = { result: string; errors: OperationError[] };

function checkDuplicateStructuralAttrs(xml: string): string | undefined {
  for (const tagMatch of xml.matchAll(/<[^>]+>/g)) {
    const tag = tagMatch[0];
    const attrs = new Map<string, number>();
    for (const attrMatch of tag.matchAll(/\s([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=/g)) {
      const name = attrMatch[1] as string;
      attrs.set(name, (attrs.get(name) ?? 0) + 1);
    }
    const duplicates = [...attrs.entries()]
      .filter(([name, count]) => count > 1 && (STRUCTURAL_ATTRS as readonly string[]).includes(name))
      .map(([name]) => name);
    if (duplicates.length > 0) return `Duplicate structural attribute(s): ${duplicates.join(", ")}`;
  }
  return undefined;
}

function checkDuplicateIds(xml: string): string | undefined {
  const ids = new Map<string, number>();
  for (const match of xml.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    const id = match[1] as string;
    ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  const duplicates = [...ids.entries()].filter(([id, count]) => count > 1 && id !== "0" && id !== "1");
  if (duplicates.length > 0) {
    const names = duplicates.slice(0, 5).map(([id, count]) => `'${id}' (${count}x)`);
    return `Found duplicate cell ID(s): ${names.join(", ")}`;
  }
  return undefined;
}

function checkUnescapedLtInAttrs(xml: string): string | undefined {
  for (const match of xml.matchAll(/=\s*"([^"]*)"/g)) {
    const value = match[1] ?? "";
    if (value.includes("<") && !value.includes("&lt;")) return "Unescaped < character in attribute values";
  }
  return undefined;
}

function checkEntityReferences(xml: string): string | undefined {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, "");
  if (/&(?!(?:lt|gt|amp|quot|apos|#))[a-zA-Z]/.test(cleaned)) return "Found unescaped & character(s)";
  for (const match of cleaned.matchAll(/&([a-zA-Z][a-zA-Z0-9]*);/g)) {
    if (VALID_ENTITIES[match[1] as string] !== true) return `Invalid entity reference: &${match[1]};`;
  }
  return undefined;
}

function checkEmptyIds(xml: string): string | undefined {
  if (/<mxCell[^>]*\sid\s*=\s*["']\s*["'][^>]*>/.test(xml)) {
    return "Found mxCell element(s) with empty id attribute";
  }
  return undefined;
}

/** 保守的 XML 配对检查：只覆盖 LLM 常见的标签错误。 */
export function checkXmlSyntax(xml: string): string | undefined {
  const stack: string[] = [];
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    if (open < 0) break;
    if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open + 4);
      if (end < 0) return "XML syntax error: unclosed comment";
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open + 9);
      if (end < 0) return "XML syntax error: unclosed CDATA section";
      index = end + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open + 2);
      if (end < 0) return "XML syntax error: unclosed processing instruction";
      index = end + 2;
      continue;
    }
    // 引号内的 `>` 是合法属性值，不能当作标签结束。
    let close = -1;
    let quote = "";
    for (let cursor = open + 1; cursor < xml.length; cursor += 1) {
      const char = xml[cursor] as string;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        close = cursor;
        break;
      }
    }
    if (close < 0) return "XML syntax error: unclosed tag";
    const tag = xml.slice(open + 1, close);
    index = close + 1;
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      const expected = stack.pop();
      if (expected !== name) return `XML syntax error: mismatched tag </${name}>`;
      continue;
    }
    if (tag.endsWith("/")) continue;
    const name = /^[A-Za-z_:][^\s/>]*/.exec(tag)?.[0];
    if (name === undefined) return "XML syntax error: invalid tag";
    stack.push(name);
  }
  if (stack.length > 0) return `XML syntax error: unclosed tag <${stack[stack.length - 1]}>`;
  return undefined;
}

export function validateMxcellStructure(xml: string): string | undefined {
  const syntax = checkXmlSyntax(xml);
  if (syntax !== undefined) {
    return `${syntax}. Likely unescaped special characters in attribute values.`;
  }
  if (/^\s*<!\[CDATA\[/.test(xml)) return "XML is wrapped in CDATA section";
  return (
    checkDuplicateStructuralAttrs(xml) ??
    checkUnescapedLtInAttrs(xml) ??
    checkDuplicateIds(xml) ??
    checkEntityReferences(xml) ??
    checkEmptyIds(xml)
  );
}

export function autoFixXml(xml: string): { fixed: string; fixes: string[] } {
  let fixed = xml;
  const fixes: string[] = [];
  if (/=\\"/.test(fixed)) {
    fixed = fixed.replaceAll('\\"', '"').replaceAll("\\n", "\n");
    fixes.push("Fixed JSON-escaped XML");
  }
  if (/^\s*<!\[CDATA\[/.test(fixed)) {
    fixed = fixed.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "");
    fixes.push("Removed CDATA wrapper");
  }
  const xmlStart = /<(\?xml|mxGraphModel|mxfile)/i.exec(fixed);
  if (xmlStart !== null && xmlStart.index > 0) {
    fixed = fixed.slice(xmlStart.index);
    fixes.push("Removed text before XML root");
  }
  const ampPattern = /&(?!(?:lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/g;
  if (ampPattern.test(fixed)) {
    fixed = fixed.replace(ampPattern, "&amp;");
    fixes.push("Escaped unescaped & characters");
  }
  for (const [pattern, replacement] of [
    ["&ampquot;", "&quot;"],
    ["&amplt;", "&lt;"],
    ["&ampgt;", "&gt;"],
    ["&ampapos;", "&apos;"],
    ["&ampamp;", "&amp;"],
  ] as const) {
    if (fixed.includes(pattern)) {
      fixed = fixed.replaceAll(pattern, replacement);
      fixes.push(`Fixed double-escaped entity ${pattern}`);
    }
  }
  if (/<\/?Cell[\s>]/i.test(fixed)) {
    fixed = fixed.replace(/<Cell(\s)/gi, "<mxCell$1").replace(/<\/Cell>/gi, "</mxCell>");
    fixes.push("Fixed <Cell> tags to <mxCell>");
  }
  for (const [wrong, right] of [
    ["</mxElement>", "</mxCell>"],
    ["</mxcell>", "</mxCell>"],
    ["</mxgeometry>", "</mxGeometry>"],
    ["</mxpoint>", "</mxPoint>"],
  ] as const) {
    if (fixed.includes(wrong)) {
      fixed = fixed.replaceAll(wrong, right);
      fixes.push(`Fixed closing tag typo ${wrong} → ${right}`);
    }
  }
  const hasUnescaped = [...fixed.matchAll(/=\s*"([^"]*)"/g)].some(
    (match) => (match[1] ?? "").includes("<") && !(match[1] ?? "").includes("&lt;"),
  );
  if (hasUnescaped) {
    fixed = fixed.replace(/=\s*"([^"]*)"/g, (_match, value: string) => {
      return `="${value.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"`;
    });
    fixes.push("Escaped <> characters in attribute values");
  }
  let counter = 0;
  const idFixed = fixed.replace(/<mxCell([^>]*)\sid\s*=\s*["']\s*["']([^>]*)>/g, (_match, before: string, after: string) => {
    counter += 1;
    return `<mxCell${before} id="cell_${counter}"${after}>`;
  });
  if (idFixed !== fixed) {
    fixed = idFixed;
    if (counter > 0) fixes.push(`Generated ${counter} missing ID(s)`);
  }
  const lastTag = [...fixed.matchAll(/<\/[a-zA-Z][a-zA-Z0-9]*>|\/>/g)].at(-1)?.index;
  if (lastTag !== undefined) {
    const lastTagEnd = [...fixed.matchAll(/<\/[a-zA-Z][a-zA-Z0-9]*>|\/>/g)].at(-1);
    const end = lastTagEnd === undefined ? lastTag : lastTag + lastTagEnd[0].length;
    if (end < fixed.length) {
      const trailing = fixed.slice(end).trim();
      if (trailing && !/^(\s*<\/[^>]+>)*\s*$/.test(trailing)) {
        fixed = fixed.slice(0, end);
        fixes.push("Removed trailing garbage after last XML tag");
      }
    }
  }
  return { fixed, fixes };
}

export type FixResult = {
  valid: boolean;
  error?: string;
  fixed?: string;
  fixes: string[];
};

export function validateAndFixXml(xml: string): FixResult {
  const error = validateMxcellStructure(xml);
  if (error === undefined) return { valid: true, fixes: [] };
  const { fixed, fixes } = autoFixXml(xml);
  const second = validateMxcellStructure(fixed);
  if (second === undefined) return { valid: true, fixed, fixes };
  return { valid: false, error: second, fixed: fixes.length > 0 ? fixed : undefined, fixes };
}

export function isMxcellXmlComplete(xml: string | undefined): boolean {
  const trimmed = (xml ?? "").trim();
  if (!trimmed) return false;
  const lastSelfClose = trimmed.lastIndexOf("/>");
  const lastCellClose = trimmed.lastIndexOf("</mxCell>");
  const lastValidEnd = Math.max(lastSelfClose, lastCellClose);
  if (lastValidEnd === -1) return false;
  const endOffset = lastCellClose > lastSelfClose ? 9 : 2;
  const suffix = trimmed.slice(lastValidEnd + endOffset);
  return /^(\s*<\/[^>]+>)*\s*$/.test(suffix);
}

function stripTrailingWrappers(xml: string): string {
  const lastSelf = xml.lastIndexOf("/>");
  const lastClose = xml.lastIndexOf("</mxCell>");
  const lastEnd = Math.max(lastSelf, lastClose);
  if (lastEnd === -1) return xml;
  const offset = lastClose > lastSelf ? 9 : 2;
  const after = xml.slice(lastEnd + offset);
  if (/^(\s*<\/[a-zA-Z][a-zA-Z0-9]*>\s*)*$/.test(after)) return xml;
  return xml.slice(0, lastEnd + offset);
}

export function wrapWithMxfile(xml: string): string {
  if (xml.includes("<mxfile>")) return xml;
  if (xml.includes("<mxGraphModel>")) {
    let content = stripTrailingWrappers(xml);
    content = content.replace(/<mxCell id="0"[^>]*\/?>/g, "").replace(/<mxCell id="1"[^>]*\/?>/g, "");
    return `<mxfile><diagram name="Page-1" id="page-1">${content}</diagram></mxfile>`;
  }
  let content = xml.includes("<root>") ? xml.replace(/<root>/g, "").replace(/<\/root>/g, "") : xml;
  content = stripTrailingWrappers(content);
  content = content.replace(/<mxCell id="0"[^>]*\/?>/g, "").replace(/<mxCell id="1"[^>]*\/?>/g, "");
  return (
    '<mxfile><diagram name="Page-1" id="page-1">' +
    "<mxGraphModel><root>" +
    `${ROOT_CELLS}\n${content}` +
    "</root></mxGraphModel>" +
    "</diagram></mxfile>"
  );
}

type CellFragment = { id: string; parent: string; source: string; target: string; fragment: string };

/** 列出 root 的直接子 mxCell（Python `root_el.findall("mxCell")` 只取直接子节点）。 */
function directCells(content: string): CellFragment[] {
  const cells: CellFragment[] = [];
  const pattern = /<mxCell\b[^>]*?(?:\/>|>[\s\S]*?<\/mxCell>)/g;
  for (const match of content.matchAll(pattern)) {
    const fragment = match[0];
    const attrs = /^<mxCell\b([^>]*?)\/?>/.exec(fragment)?.[1] ?? "";
    const id = /\bid\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "";
    cells.push({
      id,
      parent: /\bparent\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
      source: /\bsource\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
      target: /\btarget\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
      fragment,
    });
  }
  return cells;
}

function firstCellFragment(xml: string): CellFragment | undefined {
  const match = /<mxCell\b[^>]*?(?:\/>|>[\s\S]*?<\/mxCell>)/.exec(xml);
  if (match === null) return undefined;
  return directCells(match[0])[0];
}

function collectDescendants(id: string, cells: Map<string, CellFragment>, collected: Set<string>): void {
  if (collected.has(id)) return;
  collected.add(id);
  for (const [cellId, cell] of cells) {
    if (cell.parent === id && cellId !== "0" && cellId !== "1") collectDescendants(cellId, cells, collected);
  }
}

type ContentItem = { kind: "text"; text: string } | { kind: "cell"; cell: CellFragment };

/** 把 root 内容拆成“非 cell 文本 + 直接子 cell”片段，保持原始顺序。 */
function splitContent(content: string): ContentItem[] {
  const items: ContentItem[] = [];
  let cursor = 0;
  for (const match of content.matchAll(/<mxCell\b[^>]*?(?:\/>|>[\s\S]*?<\/mxCell>)/g)) {
    const start = match.index ?? 0;
    if (start > cursor) items.push({ kind: "text", text: content.slice(cursor, start) });
    const fragment = match[0];
    const attrs = /^<mxCell\b([^>]*?)\/?>/.exec(fragment)?.[1] ?? "";
    items.push({
      kind: "cell",
      cell: {
        id: /\bid\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
        parent: /\bparent\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
        source: /\bsource\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
        target: /\btarget\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
        fragment,
      },
    });
    cursor = start + fragment.length;
  }
  if (cursor < content.length) items.push({ kind: "text", text: content.slice(cursor) });
  return items;
}

export function applyDiagramOperations(xmlContent: string, operations: readonly XmlOperation[]): OperationResult {
  const errors: OperationError[] = [];
  const rootMatch = /<root\b[^>]*>([\s\S]*)<\/root>/.exec(xmlContent);
  if (rootMatch === null) {
    return { result: xmlContent, errors: [{ type: "update", cellId: "", message: "No <root> element found" }] };
  }
  const openTag = rootMatch[0].slice(0, rootMatch[0].indexOf(">") + 1);
  const prefix = xmlContent.slice(0, rootMatch.index) + openTag;
  const suffix = "</root>" + xmlContent.slice((rootMatch.index ?? 0) + rootMatch[0].length);
  const items = splitContent(rootMatch[1] ?? "");
  const cells = new Map<string, CellFragment>();
  for (const item of items) if (item.kind === "cell" && item.cell.id) cells.set(item.cell.id, item.cell);

  for (const operation of operations) {
    const type = operation.operation ?? "";
    const cellId = String(operation.cell_id ?? "");
    const newXml = operation.new_xml;
    if (type === "update") {
      const existing = cells.get(cellId);
      if (existing === undefined) {
        errors.push({ type: "update", cellId, message: `Cell id="${cellId}" not found` });
        continue;
      }
      if (!newXml) {
        errors.push({ type: "update", cellId, message: "new_xml required for update" });
        continue;
      }
      const replacement = firstCellFragment(newXml);
      if (replacement === undefined) {
        errors.push({ type: "update", cellId, message: "new_xml must contain mxCell" });
        continue;
      }
      if (replacement.id !== cellId) {
        errors.push({ type: "update", cellId, message: `ID mismatch: expected "${cellId}" got "${replacement.id}"` });
        continue;
      }
      existing.fragment = replacement.fragment;
      existing.parent = replacement.parent;
      existing.source = replacement.source;
      existing.target = replacement.target;
    } else if (type === "add") {
      if (cells.has(cellId)) {
        errors.push({ type: "add", cellId, message: `Cell id="${cellId}" already exists` });
        continue;
      }
      if (!newXml) {
        errors.push({ type: "add", cellId, message: "new_xml required for add" });
        continue;
      }
      const added = firstCellFragment(newXml);
      if (added === undefined) {
        errors.push({ type: "add", cellId, message: "new_xml must contain mxCell" });
        continue;
      }
      if (added.id !== cellId) {
        errors.push({ type: "add", cellId, message: `ID mismatch: expected "${cellId}" got "${added.id}"` });
        continue;
      }
      items.push({ kind: "cell", cell: added });
      cells.set(cellId, added);
    } else if (type === "delete") {
      if (cellId === "0" || cellId === "1") {
        errors.push({ type: "delete", cellId, message: `Cannot delete root cell "${cellId}"` });
        continue;
      }
      if (!cells.has(cellId)) continue;
      const toDelete = new Set<string>();
      collectDescendants(cellId, cells, toDelete);
      for (const deletedId of [...toDelete]) {
        for (const [otherId, cell] of cells) {
          if ((cell.source === deletedId || cell.target === deletedId) && otherId !== "0" && otherId !== "1") {
            collectDescendants(otherId, cells, toDelete);
          }
        }
      }
      for (const deletedId of toDelete) cells.delete(deletedId);
    }
  }

  const rendered = items
    .filter((item) => item.kind === "text" || cells.has(item.cell.id))
    .map((item) => (item.kind === "text" ? item.text : cells.get(item.cell.id)?.fragment ?? item.cell.fragment))
    .join("");
  return { result: `${prefix}${rendered}${suffix}`, errors };
}
