/**
 * Hook condition language (port of `agent/hooks/conditions.py`).
 *
 * `a || b && c` is split on whitespace-delimited `||` first, then `&&`; each clause is `shlex.split`-tokenized into
 * `[field]`, `[field, op, right...]`. Comparisons are case-sensitive for `==`/`!=` and case-insensitive for
 * `contains` / `not_contains` / `startswith` / `endswith`; a boolean field compared with true/false is an identity
 * check before any string conversion. A clause that fails to tokenize, has an unknown operator or an unknown field is
 * false — conditions never raise.
 */
import { PY_SPACE, pyStrip, pyStr } from "../py-compat.ts";
import type { HookContext } from "./models.ts";
import { ShlexError, shlexSplit } from "./shlex.ts";

const OPS: Readonly<Record<string, true>> = {
  "==": true,
  "!=": true,
  contains: true,
  not_contains: true,
  startswith: true,
  endswith: true,
  exists: true,
};

const OR_SPLIT = new RegExp(`[${PY_SPACE}]+\\|\\|[${PY_SPACE}]+`);
const AND_SPLIT = new RegExp(`[${PY_SPACE}]+&&[${PY_SPACE}]+`);

export function evaluateCondition(expression: unknown, ctx: HookContext): boolean {
  const expr = pyStrip(expression === null || expression === undefined ? "" : String(expression));
  if (expr === "") return true;
  return expr.split(OR_SPLIT).some((part) => pyStrip(part) !== "" && evalAnd(part, ctx));
}

function evalAnd(expression: string, ctx: HookContext): boolean {
  return expression
    .split(AND_SPLIT)
    .every((part) => pyStrip(part) === "" || evalClause(pyStrip(part), ctx));
}

function evalClause(clause: string, ctx: HookContext): boolean {
  let tokens: string[];
  try {
    tokens = shlexSplit(clause);
  } catch (error) {
    if (error instanceof ShlexError) return false;
    throw error;
  }
  if (tokens.length === 0) return true;
  if (tokens.length === 1) return truthy(ctx.getField(tokens[0]!));
  const op = tokens[1]!;
  if (OPS[op] !== true) return false;
  const left = ctx.getField(tokens[0]!);
  if (op === "exists") return truthy(left);
  return compare(left, op, tokens.length > 2 ? tokens.slice(2).join(" ") : "");
}

function compare(left: unknown, op: string, right: string): boolean {
  if (typeof left === "boolean" && ["true", "false"].includes(pyStrip(right).toLowerCase())) {
    const expected = pyStrip(right).toLowerCase() === "true";
    if (op === "==") return left === expected;
    if (op === "!=") return left !== expected;
  }
  // `str(dict)` / `str(list)` are Python reprs; `None` becomes the empty string.
  const leftText = left === null || left === undefined ? "" : pyStr(left);
  if (op === "==") return leftText === right;
  if (op === "!=") return leftText !== right;
  const leftLow = leftText.toLowerCase();
  const rightLow = right.toLowerCase();
  if (op === "contains") return leftLow.includes(rightLow);
  if (op === "not_contains") return !leftLow.includes(rightLow);
  if (op === "startswith") return leftLow.startsWith(rightLow);
  if (op === "endswith") return leftLow.endsWith(rightLow);
  return false;
}

const FALSY_TEXT: Readonly<Record<string, true>> = {
  "": true,
  "0": true,
  false: true,
  no: true,
  none: true,
  null: true,
};

function truthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return FALSY_TEXT[pyStrip(pyStr(value)).toLowerCase()] !== true;
}
