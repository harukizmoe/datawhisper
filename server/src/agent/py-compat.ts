/**
 * Small Python-semantics helpers shared by the skills / commands / instructions / memory ports.
 *
 * The Python originals lean on behaviours JS does not share: `str` length and slicing count code
 * points, `str.strip()` / `\s` use the Unicode `isspace` set (not the JS whitespace set — JS also
 * trims U+FEFF, Python also trims U+001C-001F and U+0085), `Path.read_text` translates newlines,
 * `Path.resolve(strict=False)` resolves symlinks of the existing prefix, `round()` is exact, and
 * error messages embed `repr()` of values.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, normalize, parse, relative, sep } from "node:path";

/** Character-class body (no brackets) of Python's `\s` / `str.isspace()` for `str` patterns. */
export const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export function isPySpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Python `Path.suffix`: the final `.ext` (a leading or trailing dot is not a suffix). */
export function pySuffix(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

/** `str.strip()` */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isPySpace(text.charCodeAt(start))) start++;
  while (end > start && isPySpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/** `len(str)`: number of code points. */
export function pyLen(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** `text[:count]` counted in code points. */
export function pyHead(text: string, count: number): string {
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < count) {
    const code = text.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    seen++;
  }
  return text.slice(0, i);
}

/** Python string ordering (by code point, not UTF-16 unit). */
export function pyCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i >= a.length) return j >= b.length ? 0 : -1;
  return 1;
}

const LINE_BREAK = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/** `str.splitlines()` */
export function pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!LINE_BREAK.has(code)) continue;
    lines.push(text.slice(start, i));
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** `round(x, digits)`: exact decimal rounding, ties to even (JS `toFixed` rounds exact ties up). */
export function pyRound(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const fixed = value.toFixed(digits);
  const wide = value.toFixed(Math.min(100, digits + 60));
  const point = wide.indexOf(".");
  const tail = wide.slice(point + 1 + digits);
  if (!/^50*$/.test(tail)) return Number(fixed);
  const down = wide.slice(0, point + 1 + digits).replace(/\.$/, "");
  const lastDigit = Number(down.replace(".", "").slice(-1));
  return Number(lastDigit % 2 === 0 ? down : fixed);
}

const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

function reprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (char !== " " && NOT_PRINTABLE.test(char)) {
      const hex = code.toString(16).padStart(code <= 0xff ? 2 : code <= 0xffff ? 4 : 8, "0");
      out += `\\${code <= 0xff ? "x" : code <= 0xffff ? "u" : "U"}${hex}`;
    } else out += char;
  }
  return out + quote;
}

function reprNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Number.isInteger(value)) return BigInt(value).toString();
  const [mantissa, exponent] = value.toExponential().split("e") as [string, string];
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  const exp10 = Number(exponent);
  let body: string;
  if (exp10 < -4 || exp10 >= 16) {
    const sign = exp10 < 0 ? "-" : "+";
    body = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ""}e${sign}${String(Math.abs(exp10)).padStart(2, "0")}`;
  } else if (exp10 >= 0) body = `${digits.slice(0, exp10 + 1)}.${digits.slice(exp10 + 1)}`;
  else body = `0.${"0".repeat(-exp10 - 1)}${digits}`;
  return negative ? `-${body}` : body;
}

/** `repr(value)` for values produced by a YAML/JSON parse. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return reprNumber(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${reprString(key)}: ${pyRepr(item)}`).join(", ")}}`;
  }
  return String(value);
}

/** `str(value)` for values produced by a YAML/JSON parse. */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/** Python truthiness for parsed YAML/JSON values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `meta.get(key, fallback)`: only a *missing* key falls back (an explicit YAML null stays null). */
export function mapGet(meta: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(meta, key) ? meta[key] : fallback;
}

const ERRNO_TEXT: Record<string, [number, string]> = {
  ENOENT: [2, "No such file or directory"],
  EACCES: [13, "Permission denied"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  ELOOP: [40, "Too many levels of symbolic links"],
};

/** Text of a Python `OSError` for a failed filesystem call. */
export function osErrorText(error: unknown, path: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  const known = ERRNO_TEXT[code];
  return known ? `[Errno ${known[0]}] ${known[1]}: '${path}'` : String(error);
}

export class PyDecodeError extends Error {}

/**
 * `Path.read_text(encoding="utf-8")`: strict UTF-8 (BOM kept) and universal-newline translation.
 * Filesystem errors propagate; invalid UTF-8 raises {@link PyDecodeError} (a `UnicodeDecodeError`).
 */
export function readTextUtf8(path: string): string {
  const bytes = readFileSync(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PyDecodeError(`'utf-8' codec can't decode bytes in ${path}`);
  }
  return text.replace(/\r\n?/g, "\n");
}

/**
 * `Path.resolve(strict=False)`: port of CPython 3.11 `posixpath._joinrealpath`. Symlinks of the existing
 * prefix are resolved, `..` is applied after symlink resolution, and the non-existent tail is kept.
 */
export function resolveNonStrict(input: string): string {
  const absolute = isAbsolute(input) ? input : `${process.cwd()}${sep}${input}`;
  const seen = new Map<string, string | null>();

  const joinReal = (start: string, rest: string): [string, boolean] => {
    let path = start;
    const root = parse(rest).root;
    if (root) {
      path = root;
      rest = rest.slice(root.length);
    }
    const names = rest.split(sep === "\\" ? /[\\/]/ : "/");
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      if (name === "" || name === ".") continue;
      if (name === "..") {
        if (path === "") path = "..";
        else {
          const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf(sep)) + 1;
          let head = path.slice(0, cut);
          if (head && head !== sep.repeat(head.length)) head = head.replace(/[\\/]+$/, "");
          path = path.slice(cut) === ".." ? `${head}${sep}..${sep}..` : head;
        }
        continue;
      }
      const next = path === "" ? name : path.endsWith(sep) ? `${path}${name}` : `${path}${sep}${name}`;
      let isLink = false;
      try {
        isLink = lstatSync(next).isSymbolicLink();
      } catch {
        isLink = false;
      }
      if (!isLink) {
        path = next;
        continue;
      }
      const cached = seen.get(next);
      if (cached !== undefined) {
        if (cached !== null) {
          path = cached;
          continue;
        }
        return [[next, ...names.slice(index + 1)].join(sep), false];
      }
      seen.set(next, null);
      const [resolved, ok] = joinReal(path, readlinkSync(next));
      path = resolved;
      if (!ok) return [[path, ...names.slice(index + 1)].join(sep), false];
      seen.set(next, path);
    }
    return [path, true];
  };

  return normalize(joinReal("", absolute)[0]);
}

/** `resolved.relative_to(root)` succeeds (both sides resolved with `strict=False`). */
export function isWithin(path: string, root: string): boolean {
  const rel = relative(resolveNonStrict(root), resolveNonStrict(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
