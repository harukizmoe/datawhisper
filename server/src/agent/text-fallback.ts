/**
 * 文本形式的工具调用（移植自 agent/agent.py 的 `_parse_text_fallback_tool_calls`）。
 *
 * 有些模型会在消息文本中写出伪 XML 工具调用，而不是原生工具调用 —— 例如 MiniMax-M3
 * 写出的 `<display_diagram><parameter name="xml">…</parameter></display_diagram>`。当 stop-reason
 * 回复里带有下文所列工具的这类块时，该块会被还原成真正的调用，从而实际执行。
 * 只识别这些名字，因此正文中无关的 XML 不会被误读为调用；不含任何 `<parameter>` 条目的
 * 块会被忽略（一个无参数的调用不可能是模型的本意）。
 */

const TEXT_FALLBACK_TOOL_NAMES: ReadonlySet<string> = new Set(["display_diagram", "edit_diagram", "append_diagram"]);

const PARAM_TAG_RE = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
const TOOL_BLOCK_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export type TextToolCall = { name: string; args: Record<string, string> };

export function parseTextFallbackToolCalls(content: string): TextToolCall[] {
  if (content === "" || !content.includes("<")) return [];
  const calls: TextToolCall[] = [];
  // Python 用 `finditer` 配合 `(?P=name)` 按顺序找不重叠的匹配；在新 RegExp 上调用 `matchAll` 亦然，
  // 但模式内部的交替结构意味着分组编号必须与 Python 一致：name 是第 1 组，body 是第 2 组。
  const blocks = new RegExp(TOOL_BLOCK_RE.source, TOOL_BLOCK_RE.flags);
  for (const match of content.matchAll(blocks)) {
    const name = match[1]!;
    if (!TEXT_FALLBACK_TOOL_NAMES.has(name)) continue;
    const args: Record<string, string> = {};
    const body = match[2]!;
    for (const param of body.matchAll(new RegExp(PARAM_TAG_RE.source, PARAM_TAG_RE.flags))) args[param[1]!] = param[2]!;
    if (Object.keys(args).length === 0) continue;
    calls.push({ name, args });
  }
  return calls;
}
