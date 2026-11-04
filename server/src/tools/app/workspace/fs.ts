/**
 * 工作区文件系统端口与 Node 实现。
 *
 * 移植自 `agent/tools/workspace/files.py` + `data/system_workspace.py` +
 * `data/workspace.py::resolve_tool_path`。策略原样保留：
 *
 * - 逻辑根 `uploads` / `outputs` / `mcp`，其中只有 `outputs` 可写；
 * - 挂载的用户工作区只在 `permission === "read_write"` 时可写；
 * - 所有路径先 resolve，再校验仍在根内；符号链接不跟随；
 * - 敏感片段（`.env`/`.ssh`/`.git`/`__pycache__`）与密钥后缀直接拒绝；
 * - 读后写（read-before-write）用 mtimeNs 做乐观并发检查。
 *
 * 所有根目录都由调用方传入，模块不读 `~` 或环境变量。
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { readXlsxRows } from "./spreadsheet.ts";
import { readZipEntry, findZipEntry } from "./zip.ts";
import { AppToolError } from "../types.ts";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_READ_BYTES = MAX_FILE_BYTES;
export const MAX_SPREADSHEET_READ_BYTES = 256 * 1024 * 1024;
export const MAX_READ_LINES = 400;
export const MAX_READ_CHARS = 12_000;
export const MAX_WRITE_BYTES = MAX_FILE_BYTES;
export const MAX_DOCX_XML_BYTES = 64 * 1024 * 1024;
export const MAX_SEARCH_FILES = 200;
export const MAX_SEARCH_FILE_CHARS = 200_000;
export const MAX_COMMAND_OUTPUT = 20_000;
export const MAX_INDEXED_FILES = 10_000;
export const MAX_LIST_LIMIT = 100;
export const MAX_LIST_CHARS = 12_000;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_BASH_TIMEOUT = 120;

const TEXT_SUFFIXES: Readonly<Record<string, true>> = {
  ".txt": true,
  ".md": true,
  ".csv": true,
  ".tsv": true,
  ".json": true,
  ".jsonl": true,
  ".yaml": true,
  ".yml": true,
  ".sql": true,
  ".py": true,
  ".js": true,
  ".css": true,
  ".html": true,
  ".xml": true,
  ".toml": true,
  ".ini": true,
};
const DOCUMENT_SUFFIXES: Readonly<Record<string, true>> = { ".doc": true, ".docx": true, ".txt": true, ".md": true };
const SPREADSHEET_SUFFIXES: Readonly<Record<string, true>> = {
  ".xlsx": true,
  ".xls": true,
  ".xlsm": true,
  ".xlsb": true,
  ".ods": true,
};
const SKIP_DIRS: Readonly<Record<string, true>> = {
  ".git": true,
  ".zhixi": true,
  ".baa_cache": true,
  node_modules: true,
  __pycache__: true,
  ".venv": true,
};
const SYSTEM_SKIP_DIRS: Readonly<Record<string, true>> = {
  ...SKIP_DIRS,
  ".idea": true,
  ".ruff_cache": true,
  ".pytest_cache": true,
  ".workspace": true,
};
const BLOCKED_FRAGMENTS: Readonly<Record<string, true>> = {
  ".env": true,
  ".ssh": true,
  ".git": true,
  __pycache__: true,
};
const BLOCKED_SUFFIXES: Readonly<Record<string, true>> = {
  ".key": true,
  ".pem": true,
  ".crt": true,
  ".pfx": true,
  ".keystore": true,
};
const DATA_SUFFIXES: Readonly<Record<string, true>> = {
  ".csv": true,
  ".tsv": true,
  ".parquet": true,
  ".json": true,
  ".jsonl": true,
  ".xlsx": true,
  ".xls": true,
  ".txt": true,
};

export type GlobMatch = {
  path: string;
  size: number;
  modified_ns: number;
  suffix?: string;
};

export type GlobResult = {
  matches: GlobMatch[];
  count: number;
  total: number;
  cursor: number;
  next_cursor: number | null;
  truncated: boolean;
};

export type GrepMatch = { path: string; line: number; text: string };

export type GrepResult = {
  matches: GrepMatch[];
  count: number;
  searched_files: number;
  truncated: boolean;
};

export type ReadResult = {
  path: string;
  content_type?: string;
  sheet_name?: string;
  sheets?: string[];
  offset: number;
  total_lines: number | null;
  content: string;
  next_offset: number | null;
  truncated: boolean;
  character_limit_reached: boolean;
};

export type WriteResult = { path: string; bytes: number };
export type EditResult = { path: string; replacements: number };
export type DeleteResult = { path: string; deleted: true; bytes: number };
export type MoveResult = { source_path: string; path: string; moved: true; overwritten: boolean };

export type CommandResult = {
  operation: string;
  sha256?: string;
  valid?: boolean;
  path?: string;
  exit_code?: number;
  output?: string;
  truncated?: boolean;
};

/** `workspace_status` 的结构；字段与旧实现一致。 */
export type WorkspaceStatus = {
  system_workspace: { roots: JsonValue[] };
  user_workspace: JsonValue;
  usage: string;
};

/** 文件与命令工具依赖的唯一工作区面。 */
export interface WorkspaceFs {
  status(): Promise<WorkspaceStatus>;
  glob(pattern: string, path?: string, maxResults?: number, cursor?: number): Promise<GlobResult>;
  grep(pattern: string, path?: string, include?: string, maxResults?: number): Promise<GrepResult>;
  readFile(filePath: string, offset?: number, limit?: number, sheetName?: string): Promise<ReadResult>;
  writeFile(filePath: string, content: string): Promise<WriteResult>;
  editFile(filePath: string, oldString: string, newString: string): Promise<EditResult>;
  deleteFile(filePath: string, confirm: boolean): Promise<DeleteResult>;
  moveFile(sourcePath: string, destinationPath: string, confirmOverwrite: boolean): Promise<MoveResult>;
  command(operation: string, path?: string, pattern?: string, timeout?: number): Promise<CommandResult>;
  /** 受限 bash 的 token 解析与执行入口；`execute` 内部只调用上面的固定操作。 */
  bash(command: string, timeout: number, confirm: boolean): Promise<{ command: string; exit_code: number; output: JsonValue }>;
}

export type WorkspaceFsOptions = {
  /** 挂载的用户工作区根目录；省略表示本会话没有用户工作区。 */
  readonly userRoot?: string;
  readonly userPermission?: "read_only" | "read_write";
  /** 系统根（uploads/outputs/mcp）所在的 data 目录。 */
  readonly dataRoot: string;
  /** 资源目录（mcp 根 = `<resourceRoot>/MCP`）。 */
  readonly resourceRoot?: string;
  /** 内部元数据目录，读文件工具不可访问。 */
  readonly metaDir?: string;
  /** 缓存目录；git/compileall 的临时输出写在这里。 */
  readonly cacheDir?: string;
  /** 额外禁止访问的绝对目录（系统目录、home 敏感目录等）。 */
  readonly blockedDirs?: readonly string[];
};

type Located = {
  readonly path: string;
  readonly rootName: string;
  readonly rootPath: string;
  readonly user: boolean;
};

type RootPolicy = {
  readonly name: string;
  readonly path: string;
  readonly writable: boolean;
};

function skipSuffix(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function isSkipDir(name: string, system: boolean): boolean {
  const lowered = name.toLowerCase();
  if (system && name.startsWith(".")) return true;
  return system ? SYSTEM_SKIP_DIRS[lowered] === true : SKIP_DIRS[lowered] === true;
}

/** Python `fnmatch.fnmatch` 的最小等价实现（`*` `?` `[seq]`）。 */
export function fnmatch(name: string, pattern: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "*") source += "[\\s\\S]*";
    else if (char === "?") source += "[\\s\\S]";
    else if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end < 0) source += "\\[";
      else {
        const body = pattern.slice(index + 1, end).replace(/^!/, "^");
        source += `[${body}]`;
        index = end;
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(name);
}

/** Python `str.splitlines()` 的常用子集：末尾换行不产生空行。 */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "" && /(?:\r\n|\r|\n)$/.test(text)) lines.pop();
  return lines;
}

function posix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * 等价于 Python `Path.resolve(strict=False)`：能解析的前缀跟随符号链接，
 * 不存在的尾部按父目录的真实路径拼接。安全校验必须用真实路径，否则一个
 * 指向工作区外的符号链接会绕过 `within()`。
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPath(parent), basename(path));
  }
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function decodeTextBytes(data: Buffer, context: string): string {
  const errors: string[] = [];
  const looksUtf16 = data.length > 1 && (
    (data[0] === 0xff && data[1] === 0xfe) ||
    (data[0] === 0xfe && data[1] === 0xff) ||
    data.subarray(0, Math.min(4096, data.length)).filter((byte) => byte === 0).length /
      Math.min(4096, data.length) > 0.1
  );
  const encodings = looksUtf16 ? ["utf-16", "utf-16le", "utf-16be"] : [];
  encodings.push("utf-8", "gb18030", "windows-1252");
  for (const encoding of encodings) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch (error) {
      errors.push(`${encoding}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new AppToolError(`${context} is not decodable text: ${errors.slice(0, 3).join("; ")}`);
}

function normalizeExtractedText(text: string): string {
  const lines: string[] = [];
  for (const raw of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\0", "").split("\n")) {
    const line = raw
      .split("")
      .map((char) => (char === "\t" || char >= " " ? char : " "))
      .join("")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (line) lines.push(line);
  }
  return lines.join("\n").trim();
}

function readDocxText(path: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    throw new AppToolError(`DOCX cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = findZipEntry(buffer, "word/document.xml");
  if (entry === undefined) throw new AppToolError("DOCX does not contain word/document.xml");
  if (entry.size > MAX_DOCX_XML_BYTES) {
    throw new AppToolError("DOCX expanded document XML exceeds 64 MiB safety limit");
  }
  const xml = readZipEntry(buffer, entry, MAX_DOCX_XML_BYTES).toString("utf8");
  const lines: string[] = [];
  for (const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const body = paragraph[1] ?? "";
    let text = "";
    for (const node of body.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g)) {
      if (node[0].startsWith("<w:t")) {
        text += (node[1] ?? "")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&apos;", "'")
          .replaceAll("&amp;", "&");
      } else if (node[0].startsWith("<w:tab")) text += "\t";
      else text += "\n";
    }
    const trimmed = text.trim();
    if (trimmed) lines.push(...trimmed.split("\n"));
  }
  return lines.join("\n");
}

function readLegacyDocText(path: string): string {
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    throw new AppToolError(`DOC cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fragments: string[] = [];
  const latin = data.toString("latin1");
  for (const match of latin.matchAll(/[\x09\x0a\x0d\x20-\x7e]{4,}/g)) {
    fragments.push(match[0]);
  }
  // 旧实现还会提取 UTF-16LE 的可打印片段（字节间夹 \x00）。
  for (const match of latin.matchAll(/(?:[\x09\x0a\x0d\x20-\x7e]\x00){4,}/g)) {
    fragments.push(Buffer.from(match[0], "latin1").toString("utf16le"));
  }
  const normalized = normalizeExtractedText(fragments.join("\n"));
  if (normalized.length < 8) {
    throw new AppToolError("no readable text was found in legacy DOC binary streams");
  }
  return normalized;
}

/** 一次挂载内的文件版本缓存：`read` 记录 mtimeNs，写入/编辑前校验。 */
class ReadState {
  readonly #entries = new Map<string, bigint>();

  record(path: string): void {
    this.#entries.set(path, statSync(path, { bigint: true }).mtimeNs);
  }

  requireCurrent(path: string): void {
    const prior = this.#entries.get(path);
    if (prior === undefined) {
      throw new AppToolError("existing file must be read before it can be changed");
    }
    let current: bigint;
    try {
      current = statSync(path, { bigint: true }).mtimeNs;
    } catch (error) {
      throw new AppToolError(`cannot stat file: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (current !== prior) {
      throw new AppToolError("file changed after it was read; read it again before editing");
    }
  }

  forget(path: string): void {
    this.#entries.delete(path);
  }

  move(source: string, destination: string): void {
    this.#entries.delete(source);
    this.#entries.set(destination, statSync(destination, { bigint: true }).mtimeNs);
  }
}

export class NodeWorkspaceFs implements WorkspaceFs {
  readonly #userRoot: string | undefined;
  readonly #permission: "read_only" | "read_write";
  readonly #roots: Readonly<Record<string, RootPolicy>>;
  readonly #resourceRoot: string | undefined;
  readonly #metaDir: string | undefined;
  readonly #cacheDir: string | undefined;
  readonly #blockedDirs: readonly string[];
  readonly #state = new ReadState();

  constructor(options: WorkspaceFsOptions) {
    this.#userRoot = options.userRoot === undefined ? undefined : realPath(resolve(options.userRoot));
    this.#permission = options.userPermission ?? "read_only";
    this.#resourceRoot = options.resourceRoot === undefined ? undefined : realPath(resolve(options.resourceRoot));
    const dataRoot = realPath(resolve(options.dataRoot));
    const roots: Record<string, RootPolicy> = {
      uploads: { name: "uploads", path: realPath(join(dataRoot, "uploads")), writable: false },
      outputs: { name: "outputs", path: realPath(join(dataRoot, "outputs")), writable: true },
    };
    if (this.#resourceRoot !== undefined) {
      roots.mcp = { name: "mcp", path: realPath(join(this.#resourceRoot, "MCP")), writable: false };
    }
    this.#roots = roots;
    this.#metaDir = options.metaDir === undefined ? undefined : realPath(resolve(options.metaDir));
    this.#cacheDir = options.cacheDir === undefined ? undefined : realPath(resolve(options.cacheDir));
    this.#blockedDirs = (options.blockedDirs ?? []).map((dir) => realPath(resolve(dir)));
  }

  /** 显式虚拟路径：`workspace://uploads/x` / `uploads/x` / `workspace://user`。 */
  #virtual(value: string): { root: string; relative: string } | undefined {
    if (!value.trim()) return undefined;
    let normalized = value.trim().replaceAll("\\", "/");
    if (normalized.toLowerCase().startsWith("workspace://")) normalized = normalized.slice("workspace://".length);
    normalized = normalized.replace(/^\/+/, "");
    const slash = normalized.indexOf("/");
    const key = (slash < 0 ? normalized : normalized.slice(0, slash)).toLowerCase();
    const rest = slash < 0 ? "." : normalized.slice(slash + 1) || ".";
    if (key === "user") return this.#userRoot === undefined ? undefined : { root: "user", relative: rest };
    if (this.#roots[key] === undefined) return undefined;
    return { root: key, relative: rest };
  }

  #locate(value: string, write = false): Located {
    const virtual = this.#virtual(value);
    if (virtual !== undefined && virtual.root === "user") {
      const root = this.#userRoot as string;
      if (write && this.#permission !== "read_write") throw new AppToolError("workspace is mounted read-only");
      const raw = virtual.relative;
      const candidate = isAbsolute(raw) ? raw : join(root, raw);
      const resolved = realPath(resolve(candidate));
      if (!within(root, resolved)) throw new AppToolError("path must stay inside the mounted workspace");
      this.#checkUserTarget(resolved, root, write);
      return { path: resolved, rootName: "user", rootPath: root, user: true };
    }
    if (virtual !== undefined) {
      const policy = this.#roots[virtual.root];
      if (policy === undefined) throw new AppToolError(`unknown system workspace root: ${virtual.root}`);
      if (write && !policy.writable) throw new AppToolError(`system workspace root '${virtual.root}' is read-only`);
      const raw = virtual.relative;
      if (isAbsolute(raw)) throw new AppToolError("system workspace paths must be virtual, not absolute");
      const resolved = realPath(resolve(policy.path, raw));
      if (!within(policy.path, resolved)) throw new AppToolError("path must stay inside the system workspace root");
      const parts = posix(relative(policy.path, resolved)).split("/").filter(Boolean);
      if (parts.some((part) => part.startsWith(".") || isSkipDir(part, true))) {
        throw new AppToolError("path is hidden by the system workspace policy");
      }
      return { path: resolved, rootName: policy.name, rootPath: policy.path, user: false };
    }
    const root = this.#userRoot;
    if (root === undefined) throw new AppToolError("no workspace is mounted for this session");
    if (!value.trim()) throw new AppToolError("path is required");
    if (write && this.#permission !== "read_write") throw new AppToolError("workspace is mounted read-only");
    let normalized = value.trim().replaceAll("\\", "/");
    const lowered = normalized.toLowerCase();
    if (lowered === "workspace://user" || lowered === "user") normalized = ".";
    else if (lowered.startsWith("workspace://user/")) normalized = normalized.slice("workspace://user/".length);
    else if (lowered.startsWith("user/")) normalized = normalized.slice("user/".length);
    const candidate = isAbsolute(normalized) ? normalized : join(root, normalized);
    const resolved = realPath(resolve(candidate));
    if (!within(root, resolved)) throw new AppToolError("path must stay inside the mounted workspace");
    this.#checkUserTarget(resolved, root, write);
    return { path: resolved, rootName: "user", rootPath: root, user: true };
  }

  #checkUserTarget(resolved: string, root: string, write: boolean): void {
    const parts = resolved.split(sep).map((part) => part.toLowerCase());
    if (parts.some((part) => BLOCKED_FRAGMENTS[part] === true)) {
      throw new AppToolError("path is blocked by workspace security policy");
    }
    if (BLOCKED_SUFFIXES[skipSuffix(resolved)] === true) {
      throw new AppToolError("path is blocked by workspace security policy");
    }
    if (this.#blockedDirs.some((dir) => within(dir, resolved))) {
      throw new AppToolError("path is blocked by workspace security policy");
    }
    for (const internal of [this.#metaDir, this.#cacheDir]) {
      if (internal !== undefined && within(internal, resolved)) {
        throw new AppToolError("internal workspace metadata cannot be accessed");
      }
    }
    if (write && resolved === root) throw new AppToolError("workspace root cannot be overwritten");
  }

  #path(value: string, write = false): string {
    return this.#locate(value, write).path;
  }

  #display(path: string): string {
    const resolvedPath = resolve(path);
    for (const policy of Object.values(this.#roots)) {
      if (within(policy.path, resolvedPath)) {
        const suffix = posix(relative(policy.path, resolvedPath));
        return suffix === "" ? policy.name : `${policy.name}/${suffix}`;
      }
    }
    if (this.#userRoot !== undefined && within(this.#userRoot, resolvedPath)) {
      return `user/${posix(relative(this.#userRoot, resolvedPath))}`;
    }
    throw new AppToolError("path is outside the workspace");
  }

  #documentCandidates(limit = 5): string[] {
    if (this.#userRoot === undefined) return [];
    const root = this.#userRoot;
    const candidates: { score: number; path: string }[] = [];
    let scanned = 0;
    const walk = (directory: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(directory).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(directory, name);
        let isDirectory = false;
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink()) continue;
          isDirectory = stat.isDirectory();
        } catch {
          continue;
        }
        if (isDirectory) {
          if (!isSkipDir(name, false)) walk(full);
          continue;
        }
        scanned += 1;
        if (scanned > MAX_INDEXED_FILES) return;
        if (isSkipDir(name, false)) continue;
        const suffix = skipSuffix(name);
        if (DOCUMENT_SUFFIXES[suffix] !== true) continue;
        const stem = basename(name, suffix);
        let score = stem.includes("说明") ? 10 : 0;
        const lowered = stem.toLowerCase();
        if (["readme", "说明", "doc", "文档"].some((token) => lowered.includes(token))) score += 5;
        try {
          const safe = resolve(full);
          if (!within(root, safe)) continue;
          candidates.push({ score, path: `user/${posix(relative(root, safe))}` });
        } catch {
          continue;
        }
      }
    };
    walk(root);
    return candidates
      .sort((left, right) => right.score - left.score || left.path.toLowerCase().localeCompare(right.path.toLowerCase()))
      .slice(0, limit)
      .map((item) => item.path);
  }

  #missingFileError(requested: string, path: string): AppToolError {
    const label = requested.trim() || "<empty>";
    try {
      if (existsSync(path) && statSync(path).isDirectory()) {
        return new AppToolError(
          `path is a directory, not a file: ${label}; use workspace_glob to list candidate files first`,
        );
      }
    } catch {
      // 继续走文件不存在分支
    }
    const candidates = this.#documentCandidates();
    if (candidates.length > 0) {
      return new AppToolError(
        `file not found: ${label}; do not guess file names. Use workspace_glob to locate the exact path first. ` +
          `Document candidates include: ${candidates.join(", ")}`,
      );
    }
    return new AppToolError(
      `file not found: ${label}; do not guess file names. Use workspace_glob to locate the exact path first`,
    );
  }

  async status(): Promise<WorkspaceStatus> {
    const roots: JsonValue[] = [];
    for (const policy of Object.values(this.#roots)) {
      const scan = this.#scanRoot(policy);
      const recent = [...scan.entries]
        .sort((left, right) => right[1].modified_ns - left[1].modified_ns)
        .slice(0, 5)
        .map(([path, meta]) => ({ path: `${policy.name}/${path}`, size: meta.size }));
      roots.push({
        name: policy.name,
        uri: `workspace://${policy.name}`,
        access: policy.writable ? "read-write" : "read-only",
        file_count: scan.entries.size,
        total_bytes: [...scan.entries.values()].reduce((sum, meta) => sum + meta.size, 0),
        recent,
        truncated: scan.truncated,
      });
    }
    const usage =
      "When a user workspace is mounted, omit path (or use workspace://user) to search it first. " +
      "Use explicit path uploads, outputs, or mcp only when the user refers to those roots; " +
      "then use workspace_grep or workspace_read_file only for relevant files.";
    let user: JsonValue = { mounted: this.#userRoot !== undefined };
    if (this.#userRoot !== undefined) {
      const files = this.#recentDataFiles(5);
      user = {
        mounted: true,
        uri: "workspace://user",
        workdir: this.#userRoot,
        artifacts_dir: join(this.#userRoot, "artifacts"),
        recent_data_files: files,
        recent_files_truncated: files.length >= 5,
        data_source_state: "mounted files are already registered as tables",
      };
    }
    return { system_workspace: { roots }, user_workspace: user, usage };
  }

  #scanRoot(policy: RootPolicy): { entries: Map<string, { size: number; modified_ns: number; suffix: string }>; truncated: boolean } {
    const entries = new Map<string, { size: number; modified_ns: number; suffix: string }>();
    let truncated = false;
    if (!existsSync(policy.path)) return { entries, truncated };
    const walk = (directory: string): void => {
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(directory, name);
        let stat;
        try {
          stat = lstatSync(full, { bigint: true });
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (!isSkipDir(name, true)) walk(full);
          continue;
        }
        if (stat.isSymbolicLink() || isSkipDir(name, true)) continue;
        const suffix = skipSuffix(name);
        entries.set(posix(relative(policy.path, full)), {
          size: Number(stat.size),
          modified_ns: Number(stat.mtimeNs),
          suffix,
        });
        if (entries.size >= MAX_INDEXED_FILES) {
          truncated = true;
          return;
        }
      }
    };
    walk(policy.path);
    return { entries, truncated };
  }

  #recentDataFiles(maxFiles: number): JsonValue[] {
    const root = this.#userRoot as string;
    const results: JsonValue[] = [];
    const walk = (directory: string): boolean => {
      let names: string[];
      try {
        names = readdirSync(directory).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      } catch {
        return false;
      }
      for (const name of names) {
        if (name.startsWith(".") || name.startsWith("~")) continue;
        const full = join(directory, name);
        let stat;
        try {
          stat = lstatSync(full, { bigint: true });
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIP_DIRS[name.toLowerCase()] === true || name.startsWith(".") || name.startsWith("~")) continue;
          if (walk(full)) return true;
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        const suffix = skipSuffix(name);
        if (DATA_SUFFIXES[suffix] !== true) continue;
        results.push({ name: posix(relative(root, full)), size: Number(stat.size), suffix });
        if (results.length >= maxFiles) return true;
      }
      return false;
    };
    walk(root);
    return results;
  }

  #walkFiles(base: string, root: string, system: boolean): { full: string; relativeToBase: string; relativeToRoot: string }[] {
    const out: { full: string; relativeToBase: string; relativeToRoot: string }[] = [];
    const walk = (directory: string): boolean => {
      let names: string[];
      try {
        names = readdirSync(directory).sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      } catch {
        return false;
      }
      for (const name of names) {
        const full = join(directory, name);
        let stat;
        try {
          stat = lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (isSkipDir(name, system)) continue;
          if (walk(full)) return true;
          continue;
        }
        if (!stat.isFile() || isSkipDir(name, system)) continue;
        out.push({
          full,
          relativeToBase: posix(relative(base, full)),
          relativeToRoot: posix(relative(root, full)),
        });
        if (out.length >= MAX_INDEXED_FILES) return true;
      }
      return false;
    };
    walk(base);
    return out;
  }

  async glob(pattern: string, path = "", maxResults = 20, cursor = 0): Promise<GlobResult> {
    let baseValue = path;
    if (!baseValue.trim()) baseValue = this.#userRoot !== undefined ? "." : "uploads";
    const virtual = this.#virtual(baseValue);
    let base: Located;
    if (virtual !== undefined && virtual.root !== "user") {
      const policy = this.#roots[virtual.root] as RootPolicy;
      base = {
        path: resolve(policy.path, virtual.relative),
        rootName: policy.name,
        rootPath: policy.path,
        user: false,
      };
      if (!within(policy.path, base.path)) throw new AppToolError("path must stay inside the system workspace root");
    } else {
      base = this.#locate(baseValue);
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(base.path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new AppToolError("search path is not a directory");
    const limit = Math.max(1, Math.min(Number(maxResults), MAX_LIST_LIMIT));
    const start = Math.max(0, Number(cursor));
    const wanted = (pattern || "**/*").trim() || "**/*";
    const withoutGlobstar = wanted.startsWith("**/") ? wanted.slice(3) : "";
    const matchAll = wanted === "*" || wanted === "**" || wanted === "**/*";
    const rows: GlobMatch[] = [];
    for (const file of this.#walkFiles(base.path, base.rootPath, !base.user)) {
      let matched = matchAll;
      if (!matched) {
        matched = fnmatch(file.relativeToBase, wanted) || fnmatch(file.relativeToRoot, wanted);
      }
      if (!matched && withoutGlobstar) {
        matched = fnmatch(file.relativeToBase, withoutGlobstar) || fnmatch(file.relativeToRoot, withoutGlobstar);
      }
      if (!matched) continue;
      let stat;
      try {
        stat = statSync(file.full, { bigint: true });
      } catch {
        continue;
      }
      const row: GlobMatch = {
        path: base.user ? `user/${file.relativeToRoot}` : `${base.rootName}/${file.relativeToRoot}`,
        size: Number(stat.size),
        modified_ns: Number(stat.mtimeNs),
      };
      if (!base.user) row.suffix = skipSuffix(file.full);
      rows.push(row);
    }
    rows.sort((left, right) => right.modified_ns - left.modified_ns);
    const page: GlobMatch[] = [];
    let renderedChars = 0;
    for (const row of rows.slice(start, start + limit)) {
      const chars = row.path.length + 80;
      if (page.length > 0 && renderedChars + chars > MAX_LIST_CHARS) break;
      page.push(row);
      renderedChars += chars;
    }
    const nextCursor = start + page.length < rows.length ? start + page.length : null;
    return {
      matches: page,
      count: page.length,
      total: rows.length,
      cursor: start,
      next_cursor: nextCursor,
      truncated: nextCursor !== null,
    };
  }

  async grep(pattern: string, path = ".", include = "*", maxResults = 20): Promise<GrepResult> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "u");
    } catch (error) {
      throw new AppToolError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    const virtual = this.#virtual(path);
    let base: Located;
    if (virtual !== undefined && virtual.root !== "user") {
      const policy = this.#roots[virtual.root] as RootPolicy;
      const relativeBase = realPath(resolve(policy.path, virtual.relative));
      if (!within(policy.path, relativeBase)) {
        throw new AppToolError("path must stay inside the system workspace root");
      }
      base = { path: relativeBase, rootName: policy.name, rootPath: policy.path, user: false };
    } else {
      base = this.#locate(path);
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(base.path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new AppToolError("search path is not a directory");
    const limit = Math.max(1, Math.min(Number(maxResults), MAX_SEARCH_LIMIT));
    const results: GrepMatch[] = [];
    let searchedFiles = 0;
    let outputChars = 0;
    for (const file of this.#walkFiles(base.user ? base.path : base.rootPath, base.rootPath, !base.user)) {
      if (results.length >= limit) break;
      const name = basename(file.full);
      if (!fnmatch(name, include || "*")) continue;
      if (TEXT_SUFFIXES[skipSuffix(file.full)] !== true) continue;
      searchedFiles += 1;
      if (searchedFiles > MAX_SEARCH_FILES) break;
      let text: string;
      try {
        const stat = statSync(file.full);
        if (stat.size > MAX_READ_BYTES) continue;
        text = readFileSync(file.full).toString("utf8").slice(0, MAX_SEARCH_FILE_CHARS);
      } catch {
        continue;
      }
      const lines = splitLines(text);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        if (!regex.test(line)) continue;
        const snippet = line.slice(0, 500);
        const displayPath = base.user ? `user/${file.relativeToRoot}` : `${base.rootName}/${file.relativeToRoot}`;
        const rowChars = displayPath.length + snippet.length + 40;
        if (results.length > 0 && outputChars + rowChars > MAX_READ_CHARS) break;
        results.push({ path: displayPath, line: index + 1, text: snippet });
        outputChars += rowChars;
        if (results.length >= limit) break;
      }
    }
    return {
      matches: results,
      count: results.length,
      searched_files: Math.min(searchedFiles, MAX_SEARCH_FILES),
      truncated: results.length >= limit || searchedFiles > MAX_SEARCH_FILES,
    };
  }

  async readFile(filePath: string, offset = 0, limit = 200, sheetName = ""): Promise<ReadResult> {
    const path = this.#path(filePath);
    let stat;
    try {
      stat = statSync(path, { bigint: true });
    } catch {
      throw this.#missingFileError(filePath, path);
    }
    if (!stat.isFile()) throw this.#missingFileError(filePath, path);
    const suffix = skipSuffix(path);
    const sizeLimit = SPREADSHEET_SUFFIXES[suffix] === true ? MAX_SPREADSHEET_READ_BYTES : MAX_READ_BYTES;
    if (Number(stat.size) > sizeLimit) throw new AppToolError(`file exceeds ${sizeLimit} byte read limit`);
    const start = Math.max(0, Number(offset));
    const cap = Math.max(1, Math.min(Number(limit), MAX_READ_LINES));
    if (SPREADSHEET_SUFFIXES[suffix] === true) {
      const result = this.#spreadsheetPreview(path, start, cap, sheetName);
      this.#state.record(path);
      return { path: this.#display(path), ...result };
    }
    let text: string;
    let contentType: string;
    if (suffix === ".docx") {
      text = readDocxText(path);
      contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (suffix === ".doc") {
      text = readLegacyDocText(path);
      contentType = "application/msword";
    } else {
      let data: Buffer;
      try {
        data = readFileSync(path);
      } catch (error) {
        throw new AppToolError(`file cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
      text = decodeTextBytes(data, "file");
      contentType = "text/plain; charset=utf-8";
    }
    const lines = splitLines(text);
    this.#state.record(path);
    const selected: string[] = [];
    let chars = 0;
    let charTruncated = false;
    for (let index = start; index < Math.min(lines.length, start + cap); index += 1) {
      const rendered = `${index + 1}: ${lines[index] ?? ""}`;
      if (selected.length > 0 && chars + rendered.length + 1 > MAX_READ_CHARS) {
        charTruncated = true;
        break;
      }
      const clipped = rendered.slice(0, MAX_READ_CHARS);
      charTruncated = charTruncated || clipped.length < rendered.length;
      selected.push(clipped);
      chars += clipped.length + 1;
    }
    const consumed = selected.length;
    return {
      path: this.#display(path),
      content_type: contentType,
      offset: start,
      total_lines: lines.length,
      content: selected.join("\n"),
      next_offset: start + consumed < lines.length ? start + consumed : null,
      truncated: charTruncated || start + consumed < lines.length,
      character_limit_reached: charTruncated,
    };
  }

  #spreadsheetPreview(path: string, offset: number, limit: number, sheetName: string): Omit<ReadResult, "path"> {
    const suffix = skipSuffix(path);
    if (suffix === ".xls" || suffix === ".xlsb") {
      throw new AppToolError(
        `spreadsheet cannot be opened: ${suffix}: binary spreadsheet preview requires the pandas compute worker`,
      );
    }
    if (suffix === ".ods") {
      throw new AppToolError(
        "spreadsheet cannot be opened: ods: ODS preview requires the pandas compute worker",
      );
    }
    let rows: string[][];
    let sheets: string[];
    let sheet: string;
    try {
      const parsed = readXlsxRows(readFileSync(path), sheetName);
      rows = parsed.rows;
      sheets = parsed.sheets;
      sheet = parsed.sheetName;
    } catch (error) {
      throw new AppToolError(`spreadsheet cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
    const frame = rows.slice(offset, offset + limit);
    const renderedLines: string[] = [];
    let renderedChars = 0;
    let charTruncated = false;
    for (let index = 0; index < frame.length; index += 1) {
      const cells = (frame[index] ?? []).map((value) => value.replaceAll("\r", " ").replaceAll("\n", " ").slice(0, 500));
      const rendered = `${offset + index + 1}: ${cells.join("\t").replace(/\s+$/, "")}`;
      if (renderedLines.length > 0 && renderedChars + rendered.length + 1 > MAX_READ_CHARS) {
        charTruncated = true;
        break;
      }
      renderedLines.push(rendered.slice(0, MAX_READ_CHARS));
      renderedChars += renderedLines[renderedLines.length - 1]!.length + 1;
    }
    const consumed = renderedLines.length;
    const mayHaveMore = frame.length >= limit;
    return {
      content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sheet_name: sheet,
      sheets: sheets.slice(0, 50),
      offset,
      total_lines: null,
      content: renderedLines.join("\n"),
      next_offset: mayHaveMore && consumed > 0 ? offset + consumed : null,
      truncated: charTruncated || mayHaveMore,
      character_limit_reached: charTruncated,
    };
  }

  async writeFile(filePath: string, content: string): Promise<WriteResult> {
    const path = this.#path(filePath, true);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_WRITE_BYTES) throw new AppToolError(`content exceeds ${MAX_WRITE_BYTES} byte write limit`);
    if (existsSync(path)) {
      if (!statSync(path).isFile()) throw new AppToolError("target is not a file");
      this.#state.requireCurrent(path);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    this.#state.record(path);
    return { path: this.#display(path), bytes };
  }

  async editFile(filePath: string, oldString: string, newString: string): Promise<EditResult> {
    const path = this.#path(filePath, true);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new AppToolError("file not found");
    this.#state.requireCurrent(path);
    const text = readFileSync(path, "utf8");
    const count = oldString.length === 0 ? text.length + 1 : text.split(oldString).length - 1;
    if (count !== 1) throw new AppToolError(`old_string must occur exactly once; found ${count}`);
    const updated = text.replace(oldString, newString);
    if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
      throw new AppToolError("edited content exceeds write limit");
    }
    writeFileSync(path, updated, "utf8");
    this.#state.record(path);
    return { path: this.#display(path), replacements: 1 };
  }

  async deleteFile(filePath: string, confirm: boolean): Promise<DeleteResult> {
    if (!confirm) throw new AppToolError("file deletion requires confirm=true");
    const path = this.#path(filePath, true);
    let isFile = false;
    let size = 0;
    try {
      const stat = statSync(path);
      isFile = stat.isFile();
      size = stat.size;
    } catch {
      throw new AppToolError("file not found");
    }
    if (!isFile) throw new AppToolError("only files can be deleted; directory deletion is not supported");
    const displayPath = this.#display(path);
    unlinkSync(path);
    this.#state.forget(path);
    return { path: displayPath, deleted: true, bytes: size };
  }

  async moveFile(sourcePath: string, destinationPath: string, confirmOverwrite: boolean): Promise<MoveResult> {
    const source = this.#path(sourcePath, true);
    const destination = this.#path(destinationPath, true);
    let sourceIsFile = false;
    try {
      sourceIsFile = statSync(source).isFile();
    } catch {
      throw new AppToolError("source file not found");
    }
    if (!sourceIsFile) throw new AppToolError("only files can be moved; directory moves are not supported");
    if (source === destination) throw new AppToolError("source and destination must be different");
    const destinationExisted = existsSync(destination);
    if (destinationExisted) {
      if (!statSync(destination).isFile()) throw new AppToolError("destination is not a file");
      if (!confirmOverwrite) {
        throw new AppToolError("destination exists; overwrite requires confirm_overwrite=true");
      }
    }
    mkdirSync(dirname(destination), { recursive: true });
    const sourceDisplay = this.#display(source);
    try {
      renameSync(source, destination);
    } catch (error) {
      // 跨文件系统移动时 rename 会报 EXDEV；回退成复制后删除（与 shutil.move 一致）。
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      copyFileSync(source, destination);
      unlinkSync(source);
    }
    this.#state.move(source, destination);
    return {
      source_path: sourceDisplay,
      path: this.#display(destination),
      moved: true,
      overwritten: destinationExisted,
    };
  }

  async command(operation: string, path = ".", _pattern = "", timeout = 30): Promise<CommandResult> {
    const target = this.#path(path);
    const clamped = Math.max(1, Math.min(Number(timeout), 120));
    if (operation === "checksum") {
      let isFile = false;
      try {
        isFile = statSync(target).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new AppToolError("checksum target must be a file");
      return {
        operation,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
        path: this.#display(target),
      };
    }
    if (operation === "json_validate") {
      let isFile = false;
      try {
        isFile = statSync(target).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new AppToolError("JSON target must be a file");
      JSON.parse(readFileSync(target, "utf8"));
      return { operation, valid: true, path: this.#display(target) };
    }
    const runtime = this.#userRoot;
    if (runtime === undefined) throw new AppToolError("no workspace is mounted for this session");
    const gitBase = ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "-c", "diff.external=", "-C", runtime];
    const commands: Record<string, string[]> = {
      git_status: [...gitBase, "status", "--short"],
      git_diff: [...gitBase, "diff", "--no-ext-diff", "--", target],
      git_log: [...gitBase, "log", "-n", "20", "--oneline"],
      python_compile: [this.#python(), "-m", "compileall", "-q", target],
    };
    const argv = commands[operation];
    if (argv === undefined) throw new AppToolError("unsupported operation");
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PYTHONPYCACHEPREFIX: join(this.#cacheDir ?? runtime, "pycache"),
    };
    let proc;
    try {
      proc = Bun.spawn(argv, { cwd: runtime, env, stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new AppToolError(`operation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, clamped * 1000);
    let output: string;
    let code: number;
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output = stdout + stderr;
      code = exitCode;
    } catch (error) {
      throw new AppToolError(`operation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      throw new AppToolError(`operation failed: Command '${argv.join(" ")}' timed out after ${clamped} seconds`);
    }
    return {
      operation,
      exit_code: code,
      output: output.slice(0, MAX_COMMAND_OUTPUT),
      truncated: output.length > MAX_COMMAND_OUTPUT,
    };
  }

  #python(): string {
    return Bun.which("python3") ?? Bun.which("python") ?? "python3";
  }

  async bash(command: string, timeout: number, confirm: boolean): Promise<{ command: string; exit_code: number; output: JsonValue }> {
    const tokens = tokenizeCommand(command);
    const seconds = Math.max(1, Math.min(Number(timeout), MAX_BASH_TIMEOUT));
    let executable = basename(tokens[0] as string).toLowerCase();
    if (executable.endsWith(".exe")) executable = executable.slice(0, -4);
    const args = tokens.slice(1);
    const result = (output: JsonValue) => ({ command, exit_code: 0, output });
    if (executable === "pwd" && args.length === 0) {
      const root = this.#userRoot;
      if (root === undefined) throw new AppToolError("no workspace is mounted for this session");
      return result({ path: "workspace://user", name: basename(root) });
    }
    if ((executable === "ls" || executable === "dir") && args.length <= 1) {
      return result((await this.glob("**/*", args[0] ?? "")) as unknown as JsonValue);
    }
    if (executable === "cat" && args.length === 1) {
      return result((await this.readFile(args[0] as string)) as unknown as JsonValue);
    }
    if (executable === "rg" && args.length >= 1 && args.length <= 2) {
      return result((await this.grep(args[0] as string, args[1] ?? ".")) as unknown as JsonValue);
    }
    if ((executable === "sha256sum" || executable === "shasum") && args.length === 1) {
      return result((await this.command("checksum", args[0] as string, "", seconds)) as unknown as JsonValue);
    }
    if ((executable === "json_validate" || executable === "json-validate") && args.length === 1) {
      return result((await this.command("json_validate", args[0] as string, "", seconds)) as unknown as JsonValue);
    }
    if (executable === "json" && args.length === 2 && (args[0] as string).toLowerCase() === "validate") {
      return result((await this.command("json_validate", args[1] as string, "", seconds)) as unknown as JsonValue);
    }
    if (executable === "git" && args.length >= 1) {
      const subcommand = (args[0] as string).toLowerCase();
      if (subcommand === "status" && args.length === 1) {
        return result((await this.command("git_status", ".", "", seconds)) as unknown as JsonValue);
      }
      if (subcommand === "log" && args.length === 1) {
        return result((await this.command("git_log", ".", "", seconds)) as unknown as JsonValue);
      }
      if (subcommand === "diff" && args.length <= 2) {
        return result((await this.command("git_diff", args[1] ?? ".", "", seconds)) as unknown as JsonValue);
      }
      throw new AppToolError("only read-only git status, git log, and git diff [path] are supported");
    }
    if ((executable === "python" || executable === "python3") && (args.length === 2 || args.length === 3) &&
      args[0] === "-m" && args[1] === "compileall") {
      return result((await this.command("python_compile", args[2] ?? ".", "", seconds)) as unknown as JsonValue);
    }
    if ((executable === "rm" || executable === "del") && args.length === 1) {
      return result((await this.deleteFile(args[0] as string, confirm)) as unknown as JsonValue);
    }
    if (["mv", "move", "ren", "rename"].includes(executable) && args.length === 2) {
      return result((await this.moveFile(args[0] as string, args[1] as string, confirm)) as unknown as JsonValue);
    }
    throw new AppToolError(
      "unsupported command; allowed: pwd, ls/dir, cat, rg, sha256sum, " +
        "json_validate/json validate, git status/log/diff, python -m compileall, rm/del, mv/move/ren",
    );
  }
}

const SHELL_OPERATOR_RE = /(?:\r|\n|&&|\|\||[|;<>`]|\$\()/;

/** Python `shlex.split(posix=True)` 的等价词法：仅支持空格、单引号、双引号与反斜杠转义。 */
export function tokenizeCommand(command: string): string[] {
  if (!command.trim()) throw new AppToolError("command is required");
  if (SHELL_OPERATOR_RE.test(command)) {
    throw new AppToolError(
      "shell operators, pipes, redirection, substitutions, and command chaining are not supported",
    );
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote === "'") {
      if (char === "'") quote = "";
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "\\" && index + 1 < command.length) {
        const next = command[index + 1] as string;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          index += 1;
        } else current += char;
      } else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[index + 1];
      index += 1;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== "") throw new AppToolError("invalid command quoting: No closing quotation");
  if (started || current.length > 0) tokens.push(current);
  if (tokens.length === 0) throw new AppToolError("command is required");
  return tokens;
}
