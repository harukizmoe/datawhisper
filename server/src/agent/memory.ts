/**
 * 长期记忆的读取侧：磁盘布局、记录解析/校验以及提示词段落。
 *
 * 移植自 `agent/memory.py::{render_memory_section, read_memory}` 以及
 * `data/memory_store.py` 的读取部分（文件格式、`_validate_payload`、`_parse`、`list_records`、`_render_index`）。
 * 抽取 / 合并的 LLM 任务与写入侧（创建/更新/归档、审计日志、回收站）不在本文件（计划于 P3.3）。
 *
 * 布局（单用户，无 user id）：
 *   user 作用域       `<userDir>/memories/<name>.md`                （类型 `user`、`feedback`）
 *   workspace 作用域  `<workspaceRoot>/.zhixi/memory/memories/<name>.md`（类型 `project`、`reference`）
 * 每个文件形如 `---\n<YAML frontmatter>---\n<body>`。
 *
 * 与 Python 的差异：那里的 `list_records` 每次调用还会重写 `<scope>/MEMORY.md`（读取路径上的写入，
 * 会在用户工作区内创建 `.zhixi/memory`；而没有任何地方读取该文件）。这里的读取无副作用；
 * 写入侧应使用 {@link renderMemoryIndex} 刷新 MEMORY.md。
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { say } from "../i18n.ts";
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
/** 相对于 workspace 根目录的工作区记忆根目录。 */
export const WORKSPACE_MEMORY_SUBDIR = join(".zhixi", "memory");

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "user" | "workspace";

const SCOPE_BY_TYPE: Readonly<Record<MemoryType, MemoryScope>> = {
  user: "user",
  feedback: "user",
  project: "workspace",
  reference: "workspace",
};
function indexLabel(type: MemoryType): string {
  switch (type) {
    case "user": return say("User preferences", "用户偏好");
    case "feedback": return say("Corrections", "纠正反馈");
    case "project": return say("Workspace knowledge", "工作区知识");
    case "reference": return say("References", "参考资料");
  }
}
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

/** 两个记忆作用域所在的位置。两者都由外部传入；不从 `~` 或环境变量推导。 */
export type MemoryDirs = {
  /** 用户作用域的根目录（其中包含 `memories/`）。 */
  userDir: string;
  /** 挂载的工作区根目录；缺省 = 没有工作区作用域记忆。 */
  workspaceRoot?: string;
};

export class MemoryValidationError extends Error {}

/** 记录的规范、已校验字段集合（即 `_validate_payload` 的返回值）。 */
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
  if (required && !text) throw new MemoryValidationError(say(`${label} must not be empty`, `${label}不能为空`));
  if (pyLen(text) > limit) {
    throw new MemoryValidationError(say(`${label} must not exceed ${limit} characters`, `${label}不能超过 ${limit} 个字符`));
  }
  if (automatic && SECRET_RE.test(text)) {
    throw new MemoryValidationError(
      say("Automatic memories must not contain suspected credentials or connection details", "自动记忆不能包含疑似凭据或连接信息"),
    );
  }
  return text;
}

/** `_validate_payload`：记录的规范字段集合（`None`/`undefined` 字段回退到 `existing`）。 */
export function validateMemoryPayload(
  payload: Record<string, unknown>,
  options: { automatic?: boolean; existing?: Record<string, unknown> } = {},
): ValidatedMemoryPayload {
  const { automatic = false, existing } = options;
  const source: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(payload)) if (value !== null && value !== undefined) source[key] = value;
  const type = pyTruthy(source.type) ? pyStrip(pyStr(source.type)) : "";
  if (!Object.hasOwn(SCOPE_BY_TYPE, type)) throw new MemoryValidationError(say("Invalid memory type", "记忆类型无效"));
  const name = pyTruthy(source.name) ? pyStrip(pyStr(source.name)) : "";
  if (!NAME_RE.test(name)) throw new MemoryValidationError(say("Memory ID must be kebab-case", "记忆 ID 必须是 kebab-case"));
  return {
    name,
    type: type as MemoryType,
    scope: SCOPE_BY_TYPE[type as MemoryType],
    title: validateText(source.title, say("Title", "标题"), MAX_TITLE_CHARS, true, automatic),
    body: validateText(source.body, say("Body", "正文"), MAX_BODY_CHARS, true, automatic),
    why: validateText(source.why, say("Reason", "原因"), 500, false, automatic),
    howToApply: validateText(source.how_to_apply, say("How to apply", "应用方式"), 500, false, automatic),
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `_parse`：解析单个记录文件；无效、位置不对或作用域不符时返回 `null`。 */
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

/** `_records`：某个作用域内的有效记录，按 `updated_at` 从新到旧（相同时按文件名升序）。 */
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
  // Array.prototype.sort 是稳定排序，因此时间戳相同的记录保持上面的文件名顺序。
  return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** 所有可见记录：先 user 作用域，再 workspace 作用域。 */
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

/** `_render_index`：每条记录一行 `- [label] title (name)`，受数量和字符数限制。 */
export function renderMemoryIndex(records: readonly Pick<MemoryRecord, "type" | "title" | "name">[]): string {
  const lines = records.map((record) => `- [${indexLabel(record.type)}] ${record.title} (${record.name})`);
  const kept: string[] = [];
  for (const line of lines.slice(0, MAX_RECORDS)) {
    if (pyLen([...kept, line].join("\n")) > MAX_INDEX_CHARS) break;
    kept.push(line);
  }
  if (kept.length < lines.length) kept.push(`<!-- memory index truncated, ${lines.length - kept.length} more -->`);
  return kept.join("\n") + (kept.length > 0 ? "\n" : "");
}

/** `[LONG-TERM MEMORY]` 提示词段落；没有记录时返回 `""`。 */
export function renderMemorySection(dirs: MemoryDirs): string {
  const records = listMemoryRecords(dirs);
  if (records.length === 0) return "";
  return (
    "\n\n[LONG-TERM MEMORY]\n" +
    renderMemoryIndex(records) +
    "Use memory_read(name) only when the full record is needed.\n[END LONG-TERM MEMORY]"
  );
}

/** 返回给 `memory_read` 工具的文本。 */
export function readMemory(name: string, dirs: MemoryDirs): string {
  const record = getMemoryRecord(name, dirs);
  if (!record) return "Memory record is unavailable in the current scope.";
  const lines = [`[${record.type}] ${record.title}`, record.body];
  if (record.why) lines.push(`Why: ${record.why}`);
  if (record.howToApply) lines.push(`How to apply: ${record.howToApply}`);
  return lines.join("\n");
}
