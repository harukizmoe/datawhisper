/**
 * Long-term memory, read side: the on-disk layout, record parsing/validation and the prompt section.
 *
 * Port of `agent/memory.py::{render_memory_section, read_memory}` and the read half of
 * `data/memory_store.py` (the file format, `_validate_payload`, `_parse`, `list_records`, `_render_index`).
 * The extraction / consolidation LLM jobs and the write side (create/update/archive, audit log,
 * trash) are NOT here (planned for P3.3).
 *
 * Layout (single user, no user ids):
 *   user scope       `<userDir>/memories/<name>.md`                (types `user`, `feedback`)
 *   workspace scope  `<workspaceRoot>/.zhixi/memory/memories/<name>.md` (types `project`, `reference`)
 * Each file is `---\n<YAML frontmatter>---\n<body>`.
 *
 * Difference from Python: `list_records` there also rewrote `<scope>/MEMORY.md` on every call (a
 * write on the read path that created `.zhixi/memory` inside the user's workspace; nothing reads
 * that file). Reads here are side-effect free; the write side should refresh MEMORY.md with
 * {@link renderMemoryIndex}.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  PY_SPACE,
  isMapping,
  isWithin,
  pyLen,
  pyStr,
  pyStrip,
  pySuffix,
  pyTruthy,
  readTextUtf8,
  resolveNonStrict,
} from "./py-compat.ts";

export const MAX_TITLE_CHARS = 180;
export const MAX_BODY_CHARS = 2_000;
export const MAX_RECORDS = 200;
export const MAX_INDEX_CHARS = 25_000;
/** Workspace memory root relative to a workspace root. */
export const WORKSPACE_MEMORY_SUBDIR = join(".zhixi", "memory");

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "user" | "workspace";

const SCOPE_BY_TYPE: Readonly<Record<MemoryType, MemoryScope>> = {
  user: "user",
  feedback: "user",
  project: "workspace",
  reference: "workspace",
};
const INDEX_LABELS: Readonly<Record<MemoryType, string>> = {
  user: "用户偏好",
  feedback: "纠正反馈",
  project: "工作区知识",
  reference: "参考资料",
};
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const S = `[${PY_SPACE}]`;
const NOT_S = `[^${PY_SPACE}]`;
const SECRET_RE = new RegExp(
  `(?:api[_ -]?key|secret|password|passwd|token|authorization|bearer)${S}*[:=]${S}*${NOT_S}+|` +
    `(?:mysql|postgres(?:ql)?|mongodb(?:\\+srv)?|redis)://${NOT_S}+|` +
    "-----BEGIN [A-Z ]+PRIVATE KEY-----",
  "i",
);

export type MemoryRecord = Readonly<{
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  title: string;
  body: string;
  why: string;
  howToApply: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  sourceSession: string;
}>;

/** Where the two memory scopes live. Both are passed in; nothing is derived from `~` or the environment. */
export type MemoryDirs = {
  /** User-scope root (holds `memories/`). */
  userDir: string;
  /** Mounted workspace root; absent = no workspace-scope memory. */
  workspaceRoot?: string;
};

export class MemoryValidationError extends Error {}

/** Canonical, validated field set of a record (what `_validate_payload` returns). */
export type ValidatedMemoryPayload = Readonly<{
  name: string;
  type: MemoryType;
  scope: MemoryScope;
  title: string;
  body: string;
  why: string;
  howToApply: string;
}>;

function validateText(value: unknown, label: string, limit: number, required = true, automatic = false): string {
  const text = pyTruthy(value) ? pyStrip(pyStr(value)) : "";
  if (required && !text) throw new MemoryValidationError(`${label}不能为空`);
  if (pyLen(text) > limit) throw new MemoryValidationError(`${label}不能超过 ${limit} 个字符`);
  if (automatic && SECRET_RE.test(text)) throw new MemoryValidationError("自动记忆不能包含疑似凭据或连接信息");
  return text;
}

/** `_validate_payload`: the canonical field set of a record (`None`/`undefined` fields fall back to `existing`). */
export function validateMemoryPayload(
  payload: Record<string, unknown>,
  options: { automatic?: boolean; existing?: Record<string, unknown> } = {},
): ValidatedMemoryPayload {
  const { automatic = false, existing } = options;
  const source: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(payload)) if (value !== null && value !== undefined) source[key] = value;
  const type = pyTruthy(source.type) ? pyStrip(pyStr(source.type)) : "";
  if (!Object.hasOwn(SCOPE_BY_TYPE, type)) throw new MemoryValidationError("记忆类型无效");
  const name = pyTruthy(source.name) ? pyStrip(pyStr(source.name)) : "";
  if (!NAME_RE.test(name)) throw new MemoryValidationError("记忆 ID 必须是 kebab-case");
  return {
    name,
    type: type as MemoryType,
    scope: SCOPE_BY_TYPE[type as MemoryType],
    title: validateText(source.title, "标题", MAX_TITLE_CHARS, true, automatic),
    body: validateText(source.body, "正文", MAX_BODY_CHARS, true, automatic),
    why: validateText(source.why, "原因", 500, false, automatic),
    howToApply: validateText(source.how_to_apply, "应用方式", 500, false, automatic),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `_parse`: one record file, or `null` when it is invalid, misplaced or of the wrong scope. */
export function parseMemoryFile(path: string, root: string, scope: MemoryScope): MemoryRecord | null {
  if (!isWithin(path, root) || pySuffix(basename(path)) !== ".md" || !isFile(path)) return null;
  let raw: string;
  try {
    raw = readTextUtf8(path);
  } catch {
    return null;
  }
  if (!raw.startsWith("---\n")) return null;
  const end = raw.indexOf("---\n", 4);
  if (end < 0) return null;
  let metadata: unknown;
  try {
    metadata = Bun.YAML.parse(raw.slice(4, end));
  } catch {
    return null;
  }
  if (!isMapping(metadata)) return null;
  let payload: ValidatedMemoryPayload;
  try {
    payload = validateMemoryPayload({ ...metadata, body: pyStrip(raw.slice(end + 4)) });
  } catch (error) {
    if (error instanceof MemoryValidationError) return null;
    throw error;
  }
  const stem = basename(path).slice(0, basename(path).length - ".md".length);
  if (payload.scope !== scope || stem !== payload.name) return null;
  const text = (value: unknown) => (pyTruthy(value) ? pyStr(value) : "");
  return {
    ...payload,
    createdAt: text(metadata.created_at),
    updatedAt: text(metadata.updated_at),
    lastSeenAt: text(metadata.last_seen_at),
    sourceSession: text(metadata.source_session),
  };
}

/** `_records`: valid records of one scope, newest `updated_at` first (ties: file name ascending). */
function scopeRecords(root: string, scope: MemoryScope): MemoryRecord[] {
  const folder = join(root, "memories");
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const records: MemoryRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const record = parseMemoryFile(join(folder, name), root, scope);
    if (record) records.push(record);
  }
  // Array.prototype.sort is stable, so equal timestamps keep the name order above.
  return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** All visible records: user scope first, then workspace scope. */
export function listMemoryRecords(dirs: MemoryDirs): MemoryRecord[] {
  const records = scopeRecords(resolveNonStrict(dirs.userDir), "user");
  if (dirs.workspaceRoot) {
    records.push(...scopeRecords(resolveNonStrict(join(dirs.workspaceRoot, WORKSPACE_MEMORY_SUBDIR)), "workspace"));
  }
  return records;
}

export function getMemoryRecord(name: string, dirs: MemoryDirs): MemoryRecord | undefined {
  if (!NAME_RE.test(name || "")) return undefined;
  return listMemoryRecords(dirs).find((record) => record.name === name);
}

/** `_render_index`: one `- [label] title (name)` line per record, bounded by count and characters. */
export function renderMemoryIndex(records: readonly Pick<MemoryRecord, "type" | "title" | "name">[]): string {
  const lines = records.map((record) => `- [${INDEX_LABELS[record.type]}] ${record.title} (${record.name})`);
  const kept: string[] = [];
  for (const line of lines.slice(0, MAX_RECORDS)) {
    if (pyLen([...kept, line].join("\n")) > MAX_INDEX_CHARS) break;
    kept.push(line);
  }
  if (kept.length < lines.length) kept.push(`<!-- memory index truncated, ${lines.length - kept.length} more -->`);
  return kept.join("\n") + (kept.length > 0 ? "\n" : "");
}

/** The `[LONG-TERM MEMORY]` prompt section, or `""` when there are no records. */
export function renderMemorySection(dirs: MemoryDirs): string {
  const records = listMemoryRecords(dirs);
  if (records.length === 0) return "";
  return (
    "\n\n[LONG-TERM MEMORY]\n" +
    renderMemoryIndex(records) +
    "Use memory_read(name) only when the full record is needed.\n[END LONG-TERM MEMORY]"
  );
}

/** Text returned to the `memory_read` tool. */
export function readMemory(name: string, dirs: MemoryDirs): string {
  const record = getMemoryRecord(name, dirs);
  if (!record) return "Memory record is unavailable in the current scope.";
  const lines = [`[${record.type}] ${record.title}`, record.body];
  if (record.why) lines.push(`Why: ${record.why}`);
  if (record.howToApply) lines.push(`How to apply: ${record.howToApply}`);
  return lines.join("\n");
}
