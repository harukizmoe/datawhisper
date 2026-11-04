/**
 * 安全的分层项目指令加载：USER（`<userRoot>/ZHIXI.md`）、WORKSPACE
 * （`<workspaceRoot>/ZHIXI.md`）与 LOCAL（`<workspaceRoot>/ZHIXI.local.md`）指令文件，支持
 * `@include <file>` 展开（限制在根目录内、深度上限、环检测）、大小上限，以及按 mtime 缓存结果。
 *
 * 移植自 `agent/instructions.py`。单用户：没有 user/workspace id；`userRoot` 是应用数据目录，
 * `workspaceRoot` 是可选的挂载工作区目录，两者都由调用方传入。
 */
import { statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { PY_SPACE, isWithin, pyHead, pyLen, pySplitlines, pyStrip, readTextUtf8, resolveNonStrict } from "./py-compat.ts";

export const MAX_INSTRUCTION_CHARS = 25_000;
export const MAX_INCLUDE_DEPTH = 5;
export const USER_INSTRUCTION_FILE = "ZHIXI.md";
export const WORKSPACE_INSTRUCTION_FILE = "ZHIXI.md";
export const LOCAL_INSTRUCTION_FILE = "ZHIXI.local.md";

const INCLUDE_RE = new RegExp(`^[${PY_SPACE}]*@include[${PY_SPACE}]+<([^>]+)>[${PY_SPACE}]*$`);

// Key: `${userRoot}\0${workspaceRoot}`。Value: 渲染时候选文件的 mtime（0 = 文件不存在）
// 以及渲染出的段落。@include 的目标文件不做单独跟踪；修改父文件会改变其 mtime，
// 从而自然地使该缓存条目失效。
const cache = new Map<string, { mtimes: number[]; result: string }>();

export function clearInstructionCache(): void {
  cache.clear();
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function expand(path: string, root: string, visited: Set<string>, depth: number): string {
  const resolved = resolveNonStrict(path);
  if (!isWithin(resolved, root)) return "<!-- @include blocked: path outside root -->";
  if (depth > MAX_INCLUDE_DEPTH) return "<!-- @include blocked: maximum depth reached -->";
  if (visited.has(resolved)) return "<!-- @include blocked: cycle detected -->";
  if (!isFile(resolved)) return `<!-- @include missing: ${basename(path)} -->`;
  let text: string;
  try {
    text = readTextUtf8(resolved);
  } catch {
    return `<!-- @include unreadable: ${basename(path)} -->`;
  }

  visited.add(resolved);
  const lines: string[] = [];
  for (const line of pySplitlines(text)) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    const raw = pyStrip(match[1]!);
    // 拼接时不做词法归一化：`..` 必须在符号链接解析之后才生效。
    const candidate = resolveNonStrict(isAbsolute(raw) ? raw : `${dirname(resolved)}${sep}${raw}`);
    if (!isWithin(candidate, root)) lines.push("<!-- @include blocked: path outside root -->");
    else if (!exists(candidate)) lines.push(`<!-- @include missing: ${raw} -->`);
    else lines.push(expand(candidate, root, visited, depth + 1));
  }
  visited.delete(resolved);
  return lines.join("\n");
}

/**
 * 有界的可信指令块；没有任何指令文件含内容时返回 `""`。结果按文件 mtime 缓存：
 * 新建、修改或删除文件都会自动使其失效。
 */
export function renderInstructionSection(dirs: { userRoot: string; workspaceRoot?: string }): string {
  const userRoot = resolveNonStrict(dirs.userRoot);
  const candidates: { label: string; path: string; root: string }[] = [
    { label: "USER", path: join(userRoot, USER_INSTRUCTION_FILE), root: userRoot },
  ];
  const workspaceRoot = dirs.workspaceRoot ? resolveNonStrict(dirs.workspaceRoot) : undefined;
  if (workspaceRoot) {
    candidates.push(
      { label: "WORKSPACE", path: join(workspaceRoot, WORKSPACE_INSTRUCTION_FILE), root: workspaceRoot },
      { label: "LOCAL", path: join(workspaceRoot, LOCAL_INSTRUCTION_FILE), root: workspaceRoot },
    );
  }

  const mtimes = candidates.map((candidate) => mtimeOf(candidate.path));
  const key = `${userRoot}\0${workspaceRoot ?? ""}`;
  const cached = cache.get(key);
  if (cached && cached.mtimes.length === mtimes.length && cached.mtimes.every((value, i) => value === mtimes[i])) {
    return cached.result;
  }

  const sections: string[] = [];
  for (const { label, path, root } of candidates) {
    if (!isFile(path)) continue;
    const content = pyStrip(expand(path, root, new Set(), 0));
    if (content) sections.push(`[${label} INSTRUCTIONS]\n${content}`);
  }
  let result = "";
  if (sections.length > 0) {
    let content = sections.join("\n\n---\n\n");
    if (pyLen(content) > MAX_INSTRUCTION_CHARS) {
      content = `${pyHead(content, MAX_INSTRUCTION_CHARS)}\n<!-- instructions truncated -->`;
    }
    result = `\n\n[PROJECT INSTRUCTIONS]\n${content}\n[END PROJECT INSTRUCTIONS]`;
  }
  cache.set(key, { mtimes, result });
  return result;
}
