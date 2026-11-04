/**
 * Safe layered project-instruction loading: USER (`<userRoot>/ZHIXI.md`), WORKSPACE
 * (`<workspaceRoot>/ZHIXI.md`) and LOCAL (`<workspaceRoot>/ZHIXI.local.md`) instruction files with
 * `@include <file>` expansion (root containment, depth limit, cycle detection), a size bound and an
 * mtime-keyed result cache.
 *
 * Port of `agent/instructions.py`. Single user: no user/workspace ids; `userRoot` is the app data
 * dir and `workspaceRoot` an optional mounted workspace directory, both passed in.
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

// Key: `${userRoot}\0${workspaceRoot}`. Value: the mtimes of the candidate files when rendered
// (0 = file did not exist) and the rendered section. @include targets are NOT individually tracked;
// editing the parent file changes its mtime and invalidates the entry naturally.
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
    // Joined without lexical normalisation: `..` must be applied after symlink resolution.
    const candidate = resolveNonStrict(isAbsolute(raw) ? raw : `${dirname(resolved)}${sep}${raw}`);
    if (!isWithin(candidate, root)) lines.push("<!-- @include blocked: path outside root -->");
    else if (!exists(candidate)) lines.push(`<!-- @include missing: ${raw} -->`);
    else lines.push(expand(candidate, root, visited, depth + 1));
  }
  visited.delete(resolved);
  return lines.join("\n");
}

/**
 * Bounded, trusted instructions block, or `""` when no instruction file has content. Results are
 * cached by file mtimes: creating, modifying or deleting a file invalidates automatically.
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
