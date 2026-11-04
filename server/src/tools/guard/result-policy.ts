/**
 * 工具结果的阈值与预览（移植自 `agent/tools/results.py`）。
 *
 * 旧实现给每个工具一份策略：超过 `persist_threshold` 的结果落盘成 `tr_<id>` 制品，模型只看到
 * 前 `preview_lines` 行、总长不超过 `preview_chars` 的预览。这里逐字保留阈值、预览文案与错误分类，
 * 因为模型提示词里的习惯（“看到 `…[full result persisted; …]` 就去读制品”）是按这些字符串训练的。
 */

/** 旧 `TOOL_RESULT_CHAR_BUDGET`：默认落盘阈值。 */
export const TOOL_RESULT_CHAR_BUDGET = 2_000;
/** 旧 `TOOL_RESULT_PREVIEW_CHARS`：默认预览上限（字符数，不是字节）。 */
export const TOOL_RESULT_PREVIEW_CHARS = 2_000;
/** 旧 `TOOL_RESULT_PREVIEW_LINES`：默认预览行数。 */
export const TOOL_RESULT_PREVIEW_LINES = 40;
/** 旧 `TOOL_RESULT_READ_MAX_CHARS`：`read_tool_result` 单次最多返回的字符数。 */
export const TOOL_RESULT_READ_MAX_CHARS = 4_000;
/** 旧 `make_tool_result` 里错误文本的截断长度。 */
export const TOOL_RESULT_ERROR_MAX_CHARS = 1_500;

export type ToolResultPolicy = {
  /** 超过该字符数就落盘；恰好等于阈值不落盘（旧实现是 `len(text) <= threshold` 才原样返回）。 */
  readonly persistThreshold: number;
  readonly previewChars: number;
  readonly previewLines: number;
};

export const DEFAULT_RESULT_POLICY: ToolResultPolicy = {
  persistThreshold: 2_000,
  previewChars: 2_000,
  previewLines: 40,
};

/** 旧 `_TOOL_RESULT_POLICIES` 逐项照抄；未列出的工具用默认策略。 */
const TOOL_RESULT_POLICIES: Readonly<Record<string, ToolResultPolicy>> = {
  get_schema: { persistThreshold: 2_000, previewChars: 2_000, previewLines: 60 },
  get_table_detail: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 60 },
  query_data: { persistThreshold: 2_000, previewChars: 2_000, previewLines: 20 },
  run_analysis: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 40 },
  profile_data: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 40 },
  clean_data: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 40 },
  workspace_glob: { persistThreshold: 2_000, previewChars: 2_000, previewLines: 40 },
  workspace_grep: { persistThreshold: 2_000, previewChars: 2_000, previewLines: 40 },
  workspace_read_file: { persistThreshold: 2_000, previewChars: 2_000, previewLines: 60 },
  read_tool_result: { persistThreshold: 5_000, previewChars: 4_600, previewLines: 120 },
  export_excel: { persistThreshold: 800, previewChars: 800, previewLines: 20 },
  export_report: { persistThreshold: 800, previewChars: 800, previewLines: 20 },
  generate_ppt: { persistThreshold: 800, previewChars: 800, previewLines: 20 },
  generate_dashboard: { persistThreshold: 800, previewChars: 800, previewLines: 20 },
  fetch_table: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 60 },
  browser_extract_tables: { persistThreshold: 3_000, previewChars: 3_000, previewLines: 60 },
};

export function toolResultPolicy(tool: string): ToolResultPolicy {
  return TOOL_RESULT_POLICIES[tool] ?? DEFAULT_RESULT_POLICY;
}

/** Python `datetime.now().isoformat(timespec="seconds")`：本地时间、无毫秒、无时区。 */
export function isoSeconds(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * Python `json.dumps(value, ensure_ascii=False, default=str)` 的等价渲染。
 *
 * 工具结果已经是字符串时就原样返回；对象按紧凑 JSON 渲染。`default=str` 对不可序列化值取字符串，
 * JSON.stringify 会直接丢掉这些键，因此用 replacer 补成 `String(value)`。
 */
export function jsonTextDocument(value: unknown, indent = 0): string {
  if (typeof value === "string") return value;
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item !== null && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
        return item;
      }
      return item;
    },
    indent > 0 ? indent : undefined,
  );
}

/** Python `str.splitlines()`：不在末尾换行后再多给一个空行元素。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Python f-string 的 `:,` 千位分隔（只用于整数，避免依赖 ICU 区域数据）。 */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type PreviewOptions = {
  readonly maxChars: number;
  readonly maxLines: number;
  /**
   * 保留预览的哪一头。旧实现只保留开头（head）；`tail` 供输出流水类工具选择，
   * 让它与 pi-durable `outputLimits.retain` 的含义一致。
   */
  readonly retain?: "head" | "tail";
};

/**
 * 旧 `_preview_text` 的等价实现：保留前 `maxLines` 行，再截到 `maxChars` 个字符，末尾追加固定后缀。
 *
 * 后缀文案必须逐字保持：`\n…[full result persisted; N chars / M lines total]`。
 * 末尾没有换行时 Python 的 `splitlines()` 也不额外计数，这里同样按行内容计数。
 */
export function previewText(text: string, options: PreviewOptions): string {
  const maxChars = Math.max(80, Math.trunc(options.maxChars));
  const maxLines = Math.max(1, Math.trunc(options.maxLines));
  const retain = options.retain ?? "head";
  const lines = splitLines(text);
  const kept = retain === "tail" ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  const joined = kept.join("\n");
  const suffix = `\n…[full result persisted; ${grouped(text.length)} chars / ${grouped(lines.length)} lines total]`;
  const bodyCap = Math.max(0, maxChars - suffix.length);
  const body = retain === "tail" ? joined.slice(-bodyCap) : joined.slice(0, bodyCap);
  return bodyCap === 0 ? (body + suffix).slice(-maxChars) : body + suffix;
}

/** 旧 `make_tool_result` 对错误文本的处理：只按字符截断，不落盘。 */
export function truncateErrorText(text: string): string {
  if (text.length <= TOOL_RESULT_ERROR_MAX_CHARS) return text;
  return text.slice(0, TOOL_RESULT_ERROR_MAX_CHARS) + "\n…[error details truncated]";
}

/**
 * 旧 `classify_tool_error`：按结果文本给错误分类；返回空串表示成功。
 *
 * 用于在没有 `isError` 标志时判断结果是否成功（旧实现的 `ok = not error`）。
 */
export function classifyToolError(raw: unknown, tool = ""): string {
  const text = typeof raw === "string" ? raw.trim() : jsonTextDocument(raw).trim();
  const lower = text.toLowerCase();
  if (text === "") return "";
  if (text.startsWith("[ARG ERROR]")) return "argument_error";
  if (lower.includes("sql validation failed")) return "sql_validation_error";
  if (text.startsWith("Chart failed:")) return "chart_generation_error";
  if (text.startsWith("SQL Error:")) {
    if (lower.includes("no such column") || (lower.includes("column") && lower.includes("not found"))) {
      return "field_not_found";
    }
    if (lower.includes("no such table") || (lower.includes("table") && lower.includes("not found"))) {
      return "table_not_found";
    }
    if (lower.includes("syntax") || lower.includes("parser")) return "sql_syntax_error";
    return "sql_execution_error";
  }
  if (lower.includes("no data source") || text.includes("连接已断开")) return "datasource_disconnected";
  // 只是提到“权限”不算失败：技能说明里常有权限章节（旧实现同样只在明确措辞上判定）。
  const permissionMarkers = [
    "permission_error", "permission denied", "access denied", "unauthorized",
    "forbidden", "无权限", "权限不足", "权限被拒绝", "权限拒绝", "权限错误",
  ];
  if (permissionMarkers.some((marker) => lower.includes(marker)) || (text.includes("飞书拒绝") && text.includes("权限"))) {
    return "permission_error";
  }
  if (tool === "get_schema") {
    return text.startsWith("ERROR:") || text.startsWith("工具执行错误") ? "tool_error" : "";
  }
  if (
    lower.startsWith("query returned no rows") ||
    lower.startsWith("empty result") ||
    lower.startsWith("no rows returned")
  ) {
    return "empty_result";
  }
  if (text.startsWith("[MCP ERROR]")) return "mcp_error";
  if (text.startsWith("ERROR:") || text.startsWith("工具执行错误")) return "tool_error";
  return "";
}

/** 模型查看预览后用来取回完整结果的固定行；`artifact://tool-result/tr_…` 沿用旧实现的可恢复引用格式。 */
export function recoverableArtifactLine(artifactId: string): string {
  return `\n[RECOVERABLE_ARTIFACTS] artifact://tool-result/${artifactId} `
    + `— call read_tool_result with artifact_id=${artifactId} to read the full result.`;
}
