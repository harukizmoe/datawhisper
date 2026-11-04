/**
 * 最终答案中数字的来源审计（移植自 agent/number_audit.py）。
 *
 * 报告只能呈现可追溯到本会话工具结果、用户写下的数字、或 agent 写入工具参数的数字（SQL 阈值）的
 * 数据类数字。百分比、带量级后缀的值、范围、年份、小整数、极小的小数以及嵌在标识符中的记号
 * （PM2.5、v1.3）会被跳过。
 *
 * Python 使用 `decimal.Decimal`；这里用精确的 `{int, scale}` 对（值 = int / 10^scale），因此相等性、
 * ROUND_HALF_UP 量化和 28 位上下文限制的行为一致。已知差异：Python 的 `\d` 也匹配所有 Unicode
 * 十进制数字，`Decimal()` 也能解析它们；这里只读取 NFKC 映射到 ASCII 的数字（全角 ０-９），
 * 其他文种的数字会被忽略。
 */
import type { Message } from "@earendil-works/pi-ai";

const RANGE_RE = /\d[\d.,]*\s*[-–—~～]\s*\d[\d.,]*/gu;
const NUM_RE = /(?<![A-Za-z0-9_.\u00b7])\p{Nd}{1,3}(?:,\p{Nd}{3})+(?:\.\p{Nd}+)?|(?<![A-Za-z0-9_.\u00b7])\p{Nd}+(?:\.\p{Nd}+)?/gu;
const YEAR_RE = /^(19|20)\d{2}\n?$/;
const SKIP_SUFFIX_CHARS = ["%", "％", "‰", "万", "亿", "倍"];

const MIN_INT = 100n;
const MIN_DECIMAL: Dec = { int: 3n, scale: 0 };
const MAX_LISTED = 15;
const MAX_TEXT_CHARS = 60_000;
/** Python 默认的 Decimal 上下文精度。 */
const DECIMAL_PRECISION = 28;

/** 成功即把该轮标记为数据来源的工具；只有这些轮次会被审计。 */
export const NUMBER_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "query_data",
  "run_analysis",
  "create_analysis_table",
  "profile_data",
  "fetch_table",
  "browser_extract_tables",
  "generate_chart",
]);

/** 精确的非负十进制数：值 = int / 10^scale，规范形式不带末尾的小数零。 */
type Dec = { int: bigint; scale: number };

function canonical(int: bigint, scale: number): Dec {
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale -= 1;
  }
  return { int, scale };
}

const decKey = (d: Dec): string => `${d.int}e${d.scale}`;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function compare(a: Dec, b: Dec): number {
  const scale = Math.max(a.scale, b.scale);
  const x = a.int * pow10(scale - a.scale);
  const y = b.int * pow10(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 返回解析出的数字及其按原样书写的小数位数（`1500.00` 为 2 位）。 */
function toDecimal(raw: string): { value: Dec; decimals: number } | undefined {
  const cleaned = raw.replaceAll(",", "").normalize("NFKC");
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) return undefined;
  const [whole = "", frac = ""] = cleaned.split(".");
  return { value: canonical(BigInt(whole + frac), frac.length), decimals: frac.length };
}

function digitCount(n: bigint): number {
  return n === 0n ? 1 : n.toString().length;
}

/** `Decimal.quantize(10^-decimals, ROUND_HALF_UP)`；当 Python 会抛 InvalidOperation 时原样返回该值。 */
function quantize(value: Dec, decimals: number): Dec {
  let int: bigint;
  if (value.scale <= decimals) {
    int = value.int * pow10(decimals - value.scale);
  } else {
    const divisor = pow10(value.scale - decimals);
    int = value.int / divisor;
    if ((value.int % divisor) * 2n >= divisor) int += 1n;
  }
  if (digitCount(int) > DECIMAL_PRECISION) return value;
  return canonical(int, decimals);
}

function* numberTokens(text: string): Generator<{ raw: string; tail: string }> {
  for (const match of text.matchAll(NUM_RE)) {
    const end = match.index + match[0].length;
    yield { raw: match[0], tail: text.slice(end, end + 3).trimStart() };
  }
}

type ReportNumber = { key: string; value: Dec; decimals: number };

function extractReportNumbers(reportText: string): ReportNumber[] {
  const masked = reportText.replace(RANGE_RE, " ");
  const seen = new Map<string, ReportNumber>();
  for (const { raw, tail } of numberTokens(masked)) {
    const first = tail.slice(0, 1);
    if (first !== "" && SKIP_SUFFIX_CHARS.includes(first)) continue;
    const parsed = toDecimal(raw);
    if (parsed === undefined) continue;
    const { value, decimals } = parsed;
    if (decimals === 0) {
      if (value.int < MIN_INT) continue;
      if (YEAR_RE.test(raw.replaceAll(",", "").normalize("NFKC"))) continue;
    } else if (compare(value, MIN_DECIMAL) < 0) {
      continue;
    }
    const key = raw.replaceAll(",", "");
    if (!seen.has(key)) seen.set(key, { key, value, decimals });
  }
  return [...seen.values()];
}

function parseCorpusValues(texts: readonly string[]): Map<string, Dec> {
  const values = new Map<string, Dec>();
  for (const text of texts) {
    if (text === "") continue;
    for (const { raw } of numberTokens(text.slice(0, MAX_TEXT_CHARS))) {
      const parsed = toDecimal(raw);
      if (parsed !== undefined) values.set(decKey(parsed.value), parsed.value);
    }
  }
  return values;
}

/** Python 的 `float(Decimal)` 取最近的双精度值；`Number(string)` 亦然。 */
function toFloat(d: Dec): number {
  return Number(d.scale === 0 ? d.int.toString() : `${d.int}e-${d.scale}`);
}

/** 对这里出现的量级（双精度）模拟 Python 的 `round(x, 6)`：按精确值四舍六入五取偶。 */
function round6(x: number): number {
  return Number(x.toFixed(6));
}

/**
 * 返回报告中没有任何证据支持的数字（按首次出现顺序、去重、最多 15 个），以及不受支持数字的总数。
 */
export function auditReportNumbers(
  reportText: string,
  evidenceTexts: readonly string[],
  contextTexts: readonly string[] = [],
): { unsupported: string[]; total: number } {
  const texts = [...evidenceTexts, ...contextTexts];
  const blob = texts
    .filter((t) => t !== "")
    .map((t) => t.slice(0, MAX_TEXT_CHARS).replaceAll(",", ""))
    .join(" ");
  const values = parseCorpusValues(texts);
  const floatValues = new Set<number>();
  for (const v of values.values()) if (v.int !== 0n) floatValues.add(toFloat(v));

  const unsupported: string[] = [];
  for (const { key, value, decimals } of extractReportNumbers(reportText)) {
    if (blob.includes(key)) continue;
    if (values.has(decKey(value))) continue;
    const target = decKey(value);
    let matched = false;
    for (const evidence of values.values()) {
      if (decKey(quantize(evidence, decimals)) === target) {
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (decimals === 0) {
      // 推导出的整数差值：x == a + b 或 x == a - b，其中两个操作数都是足够大的证据数字。
      const x = toFloat(value);
      let derived = false;
      for (const a of floatValues) {
        if (a < 100) continue;
        for (const partner of [round6(x - a), round6(a - x)]) {
          if (partner >= 100 && floatValues.has(partner)) {
            derived = true;
            break;
          }
        }
        if (derived) break;
      }
      if (derived) continue;
    }
    unsupported.push(key);
  }
  return { unsupported: unsupported.slice(0, MAX_LISTED), total: unsupported.length };
}

/**
 * 把对话拆成工具结果文本与上下文文本（用户消息和 agent 自身的工具调用参数）。助手散文被特意排除：
 * 那正是编造的数字可能重新流入的通道。
 */
export function collectNumberEvidence(messages: readonly Message[]): { evidence: string[]; context: string[] } {
  const evidence: string[] = [];
  const context: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") {
      evidence.push(textOf(message.content));
    } else if (message.role === "user") {
      context.push(typeof message.content === "string" ? message.content : textOf(message.content));
    } else if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") context.push(JSON.stringify(block.arguments));
    }
  }
  return { evidence, context };
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}
