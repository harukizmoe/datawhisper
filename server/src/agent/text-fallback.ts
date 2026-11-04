/**
 * Text-form tool calls (port of `_parse_text_fallback_tool_calls` in agent/agent.py).
 *
 * Some models answer with pseudo-XML tool calls in the message text instead of native tool calls — e.g. MiniMax-M3
 * writing `<display_diagram><parameter name="xml">…</parameter></display_diagram>`. When a stop-reason reply carries
 * such a block for one of the tools listed below, the block is turned back into a real call so it actually runs.
 * Only those names are recognised, so unrelated XML in prose is never misread as a call, and a block without any
 * `<parameter>` entries is ignored (an argument-less call the model could not have meant).
 */

const TEXT_FALLBACK_TOOL_NAMES: ReadonlySet<string> = new Set(["display_diagram", "edit_diagram", "append_diagram"]);

const PARAM_TAG_RE = /<parameter\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/parameter>/gi;
const TOOL_BLOCK_RE = /<([a-zA-Z_][a-zA-Z0-9_]*)\b[^>]*>([\s\S]*?)<\/\1>/gi;

export type TextToolCall = { name: string; args: Record<string, string> };

export function parseTextFallbackToolCalls(content: string): TextToolCall[] {
  if (content === "" || !content.includes("<")) return [];
  const calls: TextToolCall[] = [];
  // Python's `finditer` with `(?P=name)` finds non-overlapping matches in order; `matchAll` on a fresh RegExp does too,
  // but the alternation inside the pattern means the group numbering must follow Python's: name is group 1, body 2.
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
