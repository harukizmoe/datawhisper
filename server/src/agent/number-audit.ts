/**
 * Numeric provenance audit for final answers (port of agent/number_audit.py).
 *
 * A report may only present data-derived numbers that trace back to tool results of the conversation, to numbers
 * the user wrote, or to numbers the agent put into tool arguments (SQL thresholds). Percentages, magnitude-suffixed
 * values, ranges, years, small integers, tiny decimals and identifier-embedded tokens (PM2.5, v1.3) are skipped.
 *
 * Python used `decimal.Decimal`; here a number is an exact `{int, scale}` pair (value = int / 10^scale), so equality,
 * ROUND_HALF_UP quantization and the 28-digit context limit behave the same. Known divergence: Python's `\d` also
 * matches every Unicode decimal digit and `Decimal()` parses them; here only digits that NFKC maps to ASCII
 * (full-width ０-９) are read, other scripts' digits are ignored.
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
/** Python's default Decimal context precision. */
const DECIMAL_PRECISION = 28;

/** Tools whose success marks a turn as data-derived; only those turns are audited. */
export const NUMBER_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "query_data",
  "run_analysis",
  "create_analysis_table",
  "profile_data",
  "fetch_table",
  "browser_extract_tables",
  "generate_chart",
]);

/** Exact non-negative decimal: value = int / 10^scale, canonical form has no trailing fractional zeros. */
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

/** Returns the parsed number and its count of fractional digits as written (`1500.00` has 2). */
function toDecimal(raw: string): { value: Dec; decimals: number } | undefined {
  const cleaned = raw.replaceAll(",", "").normalize("NFKC");
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(cleaned)) return undefined;
  const [whole = "", frac = ""] = cleaned.split(".");
  return { value: canonical(BigInt(whole + frac), frac.length), decimals: frac.length };
}

function digitCount(n: bigint): number {
  return n === 0n ? 1 : n.toString().length;
}

/** `Decimal.quantize(10^-decimals, ROUND_HALF_UP)`; the value is returned unchanged when Python would raise InvalidOperation. */
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

/** Python `float(Decimal)` is the nearest double; so is `Number(string)`. */
function toFloat(d: Dec): number {
  return Number(d.scale === 0 ? d.int.toString() : `${d.int}e-${d.scale}`);
}

/** Python `round(x, 6)` for the magnitudes seen here (doubles): round-half-even on the exact value. */
function round6(x: number): number {
  return Number(x.toFixed(6));
}

/**
 * Returns the report numbers (first-appearance order, deduplicated, capped at 15) that no evidence supports, and the
 * full count of unsupported numbers.
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
      // Derived integer deltas: x == a + b or x == a - b where BOTH operands are substantial evidence numbers.
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
 * Splits a conversation into tool-result texts and context texts (user messages and the agent's own tool-call
 * arguments). Assistant prose is excluded on purpose: that is the channel fabricated numbers would re-enter through.
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
