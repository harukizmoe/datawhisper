/**
 * `workspace.tree`：工作区目录的一层一层读取，给界面的文件树用。
 *
 * 一次只返回一层（点开目录才取它的下一层），每层最多 `TREE_LIMIT` 项；界面传的是相对工作区根的路径，
 * 不接受绝对路径，也不跟随符号链接，所以读不出工作区之外的东西。只读：面板不提供任何写操作，
 * 改用户文件只由 agent 的 `workspace_*` 工具完成，并受对话的权限模式约束。
 */

import { lstatSync, opendirSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { say } from "../i18n.ts";
import { INVALID_PARAMS, invalidParams, RpcError } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import { WORKSPACE_ID_PATTERN } from "./source-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

export const TREE_LIMIT = 500;
/** 单子目录链最多折叠多少层，防止极深的目录拖慢一次请求。 */
const CHAIN_LIMIT = 8;

/** 已知的大目录或生成物：照常列出但灰显，界面默认不展开。 */
const IGNORED_NAMES: ReadonlySet<string> = new Set([".git", ".venv", "node_modules", "__pycache__", "artifacts", ".zhixi", ".baa_cache"]);
/** 敏感名字：不显示，也不让界面知道它们存在。 */
const HIDDEN_SUFFIXES: ReadonlySet<string> = new Set([".key", ".pem", ".crt", ".pfx", ".keystore"]);
const DATA_SUFFIXES: ReadonlySet<string> = new Set([".csv", ".tsv", ".parquet", ".json", ".jsonl", ".xlsx", ".xls"]);
/** 一次请求里为算徽标最多 stat 多少个文件；超出后目录徽标可能不完整。 */
const PENDING_SCAN_LIMIT = 2000;

/** 导入状态：没导入过、导入后变了、已导入，或不是数据文件。 */
export type ImportState = "new" | "changed" | "imported" | "none";

type RegistryEntry = { readonly size?: number; readonly mtime_ns?: number };

/** 读取 compute 写的 `.zhixi/registry.json`（导入过哪些文件、当时多大）。坏了就当空。 */
function readRegistry(workdir: string): Record<string, RegistryEntry> {
  try {
    const raw = JSON.parse(readFileSync(join(workdir, ".zhixi", "registry.json"), "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, RegistryEntry>) : {};
  } catch {
    return {};
  }
}

function importStateOf(registry: Record<string, RegistryEntry>, rel: string, stats: { size: number; mtimeMs: number }): ImportState {
  const entry = registry[rel];
  if (entry === undefined) return "new";
  // 旧版本记的条目没有大小与时间：只能认为已导入，否则整棵树都会标成「已变化」。
  if (typeof entry.size !== "number" || typeof entry.mtime_ns !== "number") return "imported";
  const mtimeNs = Math.round(stats.mtimeMs * 1e6);
  return entry.size === stats.size && Math.abs(entry.mtime_ns - mtimeNs) < 2_000_000 ? "imported" : "changed";
}

export type TreeEntry = {
  /** 显示名；折叠过单子目录链时是 `a/b/c`。 */
  readonly name: string;
  /** 相对工作区根的路径（折叠过时是最里层目录），用正斜杠。 */
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly size: number;
  readonly mtimeMs: number;
  readonly ignored: boolean;
  /** 仅目录：里面什么都没有。 */
  readonly empty: boolean;
  /** 仅文件：扩展名是能导入成表的数据文件。 */
  readonly data: boolean;
  /** 仅数据文件：导入状态。 */
  readonly importState: ImportState;
  /** 仅目录：这棵子树里没导入或变了的数据文件数。 */
  readonly pending: number;
};

export type TreeListing = {
  readonly path: string;
  readonly entries: TreeEntry[];
  readonly truncated: boolean;
  readonly total: number;
};

function isHidden(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || lower === ".ssh" || HIDDEN_SUFFIXES.has(extname(lower));
}

function badPath(message: string): RpcError {
  return new RpcError(message, INVALID_PARAMS, { kind: "invalid_input", reason: "invalid_path" });
}

/** 把界面传来的相对路径落到工作区内的真实目录；越界、绝对路径、不存在或不是目录都拒绝。 */
function resolveInside(workdir: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw badPath(say(`The path must stay inside the workspace: ${rel}`, `路径必须在工作区内：${rel}`));
  }
  const root = realpathSync.native(workdir);
  let target: string;
  try {
    target = realpathSync.native(join(root, rel));
  } catch {
    throw badPath(say(`Path does not exist: ${rel}`, `路径不存在：${rel}`));
  }
  if (target !== root && !target.startsWith(root + sep)) {
    throw badPath(say(`The path must stay inside the workspace: ${rel}`, `路径必须在工作区内：${rel}`));
  }
  if (!statSync(target).isDirectory()) throw badPath(say(`Path is not a directory: ${rel}`, `路径不是目录：${rel}`));
  return target;
}

function visibleChildren(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).filter((child) => !child.isSymbolicLink() && !isHidden(child.name));
}

function isEmptyDir(dir: string): boolean {
  let handle;
  try {
    handle = opendirSync(dir);
    return handle.readSync() === null;
  } catch {
    return false;
  } finally {
    handle?.closeSync();
  }
}

/** 沿着「只有一个子目录」往下走，返回合并后的显示名与最里层目录的绝对路径。 */
function followChain(dir: string, name: string): { name: string; dir: string } {
  let currentName = name;
  let current = dir;
  for (let depth = 0; depth < CHAIN_LIMIT; depth += 1) {
    if (IGNORED_NAMES.has(currentName.split("/").at(-1) ?? "")) break;
    let children: Dirent[];
    try {
      children = visibleChildren(current);
    } catch {
      break;
    }
    const only = children.length === 1 ? children[0] : undefined;
    if (only === undefined || !only.isDirectory() || IGNORED_NAMES.has(only.name)) break;
    currentName = `${currentName}/${only.name}`;
    current = join(current, only.name);
  }
  return { name: currentName, dir: current };
}

/** 读工作区里一个目录的直接子项：目录在前、文件在后，各自按名称不分大小写排序。 */
export function listDirectory(workdir: string, rel: string): TreeListing {
  const root = realpathSync.native(workdir);
  const target = resolveInside(workdir, rel);
  const registry = readRegistry(root);
  const pendingDirs = countPendingDirs(root, registry);
  const children = visibleChildren(target).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  const entries: TreeEntry[] = [];
  for (const child of children.slice(0, TREE_LIMIT)) {
    const full = join(target, child.name);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      continue; // 列目录与取属性之间被删掉了
    }
    const ignored = IGNORED_NAMES.has(child.name);
    if (child.isDirectory()) {
      const chain = ignored ? { name: child.name, dir: full } : followChain(full, child.name);
      entries.push({
        name: chain.name,
        path: relative(root, chain.dir).split(sep).join("/"),
        kind: "dir",
        size: 0,
        mtimeMs: stats.mtimeMs,
        ignored,
        empty: isEmptyDir(chain.dir),
        data: false,
        importState: "none",
        pending: pendingDirs.get(relative(root, chain.dir).split(sep).join("/")) ?? 0,
      });
    } else if (child.isFile()) {
      entries.push({
        name: child.name,
        path: relative(root, full).split(sep).join("/"),
        kind: "file",
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ignored,
        empty: false,
        data: DATA_SUFFIXES.has(extname(child.name).toLowerCase()),
        importState: DATA_SUFFIXES.has(extname(child.name).toLowerCase())
          ? importStateOf(registry, relative(root, full).split(sep).join("/"), { size: stats.size, mtimeMs: stats.mtimeMs })
          : "none",
        pending: 0,
      });
    }
  }
  return { path: relative(root, target).split(sep).join("/"), entries, truncated: children.length > TREE_LIMIT, total: children.length };
}

/**
 * 走一遍工作区，统计每个目录下「没导入或已变化」的数据文件数（给目录行的小圆点）。
 * 只比大小与修改时间，不重读文件；扫到 PENDING_SCAN_LIMIT 个文件就停。
 */
function countPendingDirs(root: string, registry: Record<string, RegistryEntry>): Map<string, number> {
  const counts = new Map<string, number>();
  let seen = 0;
  const walk = (dir: string): void => {
    let children: Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (seen >= PENDING_SCAN_LIMIT || child.isSymbolicLink() || isHidden(child.name)) continue;
      const full = join(dir, child.name);
      if (child.isDirectory()) {
        if (IGNORED_NAMES.has(child.name)) continue;
        walk(full);
        continue;
      }
      if (!child.isFile() || !DATA_SUFFIXES.has(extname(child.name).toLowerCase())) continue;
      seen += 1;
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }
      if (importStateOf(registry, relative(root, full).split(sep).join("/"), { size: stats.size, mtimeMs: stats.mtimeMs }) === "imported") continue;
      // 从文件所在目录一路数到根：每一级祖先目录都 +1。
      let rel = relative(root, dir).split(sep).join("/");
      while (rel !== "") {
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
        rel = dirnameOf(rel);
      }
      counts.set("", (counts.get("") ?? 0) + 1);
    }
  };
  walk(root);
  return counts;
}

/** 相对目录路径的父路径（`a/b` → `a`，`a` → 空串表示根）。 */
function dirnameOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

export type PendingFile = {
  readonly path: string;
  readonly state: "new" | "changed";
  readonly size: number;
  readonly mtimeMs: number;
};

/** 列出整个工作区里还没导入或已变化的数据文件，给「Changes」页签用；扫描上限与树相同。 */
export function listPendingFiles(workdir: string): { files: PendingFile[]; truncated: boolean } {
  const root = realpathSync.native(workdir);
  const registry = readRegistry(root);
  const files: PendingFile[] = [];
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let children: Dirent[];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (child.isSymbolicLink() || isHidden(child.name)) continue;
      const full = join(dir, child.name);
      if (child.isDirectory()) {
        if (!IGNORED_NAMES.has(child.name)) walk(full);
        continue;
      }
      if (!child.isFile() || !DATA_SUFFIXES.has(extname(child.name).toLowerCase())) continue;
      if (files.length >= PENDING_SCAN_LIMIT) {
        truncated = true;
        return;
      }
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full).split(sep).join("/");
      const state = importStateOf(registry, rel, { size: stats.size, mtimeMs: stats.mtimeMs });
      if (state !== "new" && state !== "changed") continue;
      files.push({ path: rel, state, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };
  walk(root);
  files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
  return { files, truncated };
}

export function workspaceTreeMethods(deps: { readonly workspaces: WorkspaceStore }): Record<string, RpcMethod> {
  const requireRecord = async (params: MethodParams) => {
    const workspaceId = params.workspaceId;
    if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
      throw invalidParams("'workspaceId' must look like ws_<16 hex>");
    }
    const record = await deps.workspaces.get(workspaceId);
    if (record === undefined) {
      throw new RpcError(say("That workspace is not registered.", "没有这个工作区。"), INVALID_PARAMS, {
        kind: "invalid_input",
        reason: "workspace_not_found",
      });
    }
    return record;
  };

  return {
    /** 还没导入或已变化的数据文件：数据面板「Changes」页签的列表。 */
    "workspace.pending": async (params: MethodParams) => {
      const record = await requireRecord(params);
      try {
        return { workspaceId: record.workspaceId, ...listPendingFiles(record.workdir) };
      } catch {
        throw new RpcError(say("The workspace folder is not available.", "工作区目录不可用。"), INVALID_PARAMS, {
          kind: "invalid_input",
          reason: "workspace_unavailable",
        });
      }
    },
    "workspace.tree": async (params: MethodParams) => {
      const path = params.path === undefined ? "" : params.path;
      if (typeof path !== "string") throw invalidParams("'path' must be a string");
      const record = await requireRecord(params);
      try {
        return { workspaceId: record.workspaceId, ...listDirectory(record.workdir, path) };
      } catch (error) {
        if (error instanceof RpcError) throw error;
        // 工作区目录本身没了（被移走或卸载）：与 workspace_unavailable 一致，让界面提示重新选择。
        throw new RpcError(say("The workspace folder is not available.", "工作区目录不可用。"), INVALID_PARAMS, {
          kind: "invalid_input",
          reason: "workspace_unavailable",
        });
      }
    },
  };
}
