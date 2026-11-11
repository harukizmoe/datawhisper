/**
 * 长期记忆的写入侧（旧 `data/memory_store.py` 的 create / update / archive）。
 *
 * 读取侧仍在 `agent/memory.ts`：文件格式、frontmatter 校验与 `MEMORY.md` 索引渲染都复用它的
 * 实现，避免出现第二套解析规则。删除沿用旧语义——移进 `<dataRoot>/outputs/.trash/memories/<id>/`
 * 并写 manifest，而不是永久删除；重复删除返回 `removed: false`，不报错。
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryValidationError,
  WORKSPACE_MEMORY_SUBDIR,
  getMemoryRecord,
  listMemoryRecords,
  parseMemoryFile,
  renderMemoryIndex,
  type MemoryDirs,
  type MemoryRecord,
  type MemoryScope,
  type ValidatedMemoryPayload,
  validateMemoryPayload,
} from "../agent/memory.ts";
import { resolveNonStrict } from "../agent/py-compat.ts";
import { appError, invalidParams } from "../ipc/errors.ts";
import { ensureDir, isoNow, writeAtomic } from "./files.ts";

export type MemoryWriteParams = {
  name?: string;
  type?: string;
  title?: string;
  body?: string;
  why?: string;
  howToApply?: string;
  sourceSession?: string;
};

export type MemoryLibraryDeps = {
  dirs: MemoryDirs;
  /** 记忆回收站目录，默认与旧 Python 一样是 `<dataRoot>/outputs/.trash/memories`。 */
  trashDir: string;
};

function publicRecord(record: MemoryRecord) {
  return {
    name: record.name,
    type: record.type,
    scope: record.scope,
    title: record.title,
    body: record.body,
    why: record.why,
    howToApply: record.howToApply,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastSeenAt: record.lastSeenAt,
    sourceSession: record.sourceSession,
  };
}

function validationError(error: unknown): never {
  if (error instanceof MemoryValidationError) throw invalidParams(error.message);
  throw error;
}

export class MemoryLibrary {
  readonly #deps: MemoryLibraryDeps;

  constructor(deps: MemoryLibraryDeps) {
    this.#deps = deps;
  }

  list() {
    return { records: listMemoryRecords(this.#deps.dirs).map(publicRecord) };
  }

  add(params: MemoryWriteParams) {
    let validated: ValidatedMemoryPayload;
    try {
      validated = validateMemoryPayload({
        name: params.name,
        type: params.type,
        title: params.title,
        body: params.body,
        why: params.why ?? "",
        how_to_apply: params.howToApply ?? "",
      });
    } catch (error) {
      validationError(error);
    }
    const root = this.#rootFor(validated.scope);
    const target = join(root, "memories", `${validated.name}.md`);
    if (existsSync(target)) throw invalidParams("同名记忆已存在");
    const timestamp = isoNow();
    const record: MemoryRecord = {
      ...validated,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp.slice(0, 10),
      sourceSession: (params.sourceSession ?? "").slice(0, 200),
    };
    this.#writeRecord(root, record);
    this.#rebuildIndex(root, record.scope);
    return publicRecord(record);
  }

  update(name: string, params: MemoryWriteParams) {
    const current = getMemoryRecord(name, this.#deps.dirs);
    if (current === undefined) throw appError("not_found", `记忆不存在或不属于当前作用域: ${name}`);
    let merged;
    try {
      merged = validateMemoryPayload(
        {
          ...(params.type === undefined ? {} : { type: params.type }),
          ...(params.title === undefined ? {} : { title: params.title }),
          ...(params.body === undefined ? {} : { body: params.body }),
          ...(params.why === undefined ? {} : { why: params.why }),
          ...(params.howToApply === undefined ? {} : { how_to_apply: params.howToApply }),
        },
        {
          existing: {
            name: current.name,
            type: current.type,
            title: current.title,
            body: current.body,
            why: current.why,
            how_to_apply: current.howToApply,
          },
        },
      );
    } catch (error) {
      validationError(error);
    }
    if (merged.scope !== current.scope) throw invalidParams("不能跨作用域修改记忆类型");
    const root = this.#rootFor(current.scope);
    const record: MemoryRecord = {
      ...current,
      ...merged,
      updatedAt: isoNow(),
    };
    this.#writeRecord(root, record);
    this.#rebuildIndex(root, record.scope);
    return publicRecord(record);
  }

  remove(name: string) {
    const current = getMemoryRecord(name, this.#deps.dirs);
    if (current === undefined) return { removed: false };
    const root = this.#rootFor(current.scope);
    const source = join(root, "memories", `${current.name}.md`);
    if (!existsSync(source)) return { removed: false };
    const trashId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}_${crypto.randomUUID().replaceAll("-", "")}`;
    const group = join(this.#deps.trashDir, trashId);
    const size = statSync(source).size;
    ensureDir(group);
    renameSync(source, join(group, `${current.name}.md`));
    writeAtomic(
      join(group, "manifest.json"),
      `${JSON.stringify(
        {
          kind: "memory_record",
          deleted_at: isoNow(),
          name: current.name,
          scope: current.scope,
          type: current.type,
          title: current.title,
          source_root: root,
          filename: `${current.name}.md`,
          size_bytes: size,
        },
        null,
        2,
      )}\n`,
    );
    this.#rebuildIndex(root, current.scope);
    return { removed: true, trashId };
  }

  #rootFor(scope: MemoryScope): string {
    if (scope === "user") return resolveNonStrict(this.#deps.dirs.userDir);
    const workspaceRoot = this.#deps.dirs.workspaceRoot;
    if (workspaceRoot === undefined || workspaceRoot === "") {
      throw invalidParams("当前未挂载工作区，无法保存工作区记忆");
    }
    return resolveNonStrict(join(workspaceRoot, WORKSPACE_MEMORY_SUBDIR));
  }

  #writeRecord(root: string, record: MemoryRecord): void {
    const metadata: Record<string, unknown> = {
      name: record.name,
      type: record.type,
      title: record.title,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      last_seen_at: record.lastSeenAt,
      source_session: record.sourceSession,
    };
    if (record.why) metadata.why = record.why;
    if (record.howToApply) metadata.how_to_apply = record.howToApply;
    const frontmatter = Bun.YAML.stringify(metadata).trim();
    writeAtomic(join(root, "memories", `${record.name}.md`), `---\n${frontmatter}\n---\n${record.body.trim()}\n`);
  }

  /** 与旧 `_rebuild_index` 一致：按 `updated_at` 从新到旧，重写该作用域的 `MEMORY.md`。 */
  #rebuildIndex(root: string, scope: MemoryScope): void {
    const folder = join(root, "memories");
    let names: string[];
    try {
      names = readdirSync(folder).filter((entry) => entry.endsWith(".md")).sort();
    } catch {
      names = [];
    }
    const records = names
      .map((entry) => parseMemoryFile(join(folder, entry), root, scope))
      .filter((record): record is MemoryRecord => record !== null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    writeAtomic(join(root, "MEMORY.md"), renderMemoryIndex(records));
  }
}
