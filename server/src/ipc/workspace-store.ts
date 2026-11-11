/**
 * 工作区注册表。
 *
 * 工作区是全局的：同一个目录只登记一次，所有属于它的对话共用一条记录和一个持久化来源。
 * 对话本身只记 `scope`（见 `source-store.ts`），不再各自保存工作区副本。
 *
 * 说明（`instructions`）存在应用数据目录，不写进用户文件夹：不污染用户的项目，
 * 也不会与用户自己放在目录里的 `ZHIXI.md` 冲突（后者由 `agent/instructions.ts` 另行读取）。
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePrivateJson } from "../models/credentials.ts";

export type WorkspaceRecord = {
  workspaceId: string;
  workdir: string;
  name: string;
  /** 应用侧保存的工作区说明，并入属于该工作区的每一轮系统提示。 */
  instructions: string;
  /** 目录同步出的持久化来源 id，整个工作区共用一个；尚未同步时为空。 */
  sourceId: string;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceStore = {
  list(): Promise<WorkspaceRecord[]>;
  get(workspaceId: string): Promise<WorkspaceRecord | undefined>;
  /** 按 `workspaceId` 新增或整条覆盖。 */
  put(record: WorkspaceRecord): Promise<void>;
  remove(workspaceId: string): Promise<void>;
};

/** 由规范化后的目录路径推出稳定 id：同一目录在任何会话里都得到同一个工作区。 */
export function workspaceIdFor(workdir: string): string {
  return `ws_${createHash("sha256").update(workdir).digest("hex").slice(0, 16)}`;
}

/** 目录是否存在且确实是目录（工作区的目录可能被用户删了或挪走）。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 容忍损坏或缺字段的文件：解析不了的条目直接丢弃，不让一条坏记录挡住整个应用。 */
function parseRecords(raw: unknown): WorkspaceRecord[] {
  if (typeof raw !== "object" || raw === null || !("workspaces" in raw) || !Array.isArray(raw.workspaces)) return [];
  const records: WorkspaceRecord[] = [];
  for (const item of raw.workspaces as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const entry: Record<string, unknown> = Object.fromEntries(Object.entries(item));
    const workspaceId = text(entry.workspaceId);
    const workdir = text(entry.workdir);
    if (workspaceId === "" || workdir === "") continue;
    records.push({
      workspaceId,
      workdir,
      name: text(entry.name),
      instructions: text(entry.instructions),
      sourceId: text(entry.sourceId),
      lastSyncedAt: text(entry.lastSyncedAt),
      createdAt: text(entry.createdAt),
      updatedAt: text(entry.updatedAt),
    });
  }
  return records;
}

/** `<dataDir>/workspaces.json`，原子写；写入排成一个串行队列，避免并发覆盖。 */
export function createWorkspaceStore(options: { readonly dataDir: string }): WorkspaceStore {
  const path = join(options.dataDir, "workspaces.json");
  let queue: Promise<unknown> = Promise.resolve();

  const read = (): WorkspaceRecord[] => {
    try {
      return parseRecords(JSON.parse(readFileSync(path, "utf8")) as unknown);
    } catch {
      return [];
    }
  };
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    async list() {
      return read();
    },
    async get(workspaceId) {
      return read().find((record) => record.workspaceId === workspaceId);
    },
    put(record) {
      return serialized(async () => {
        const next = read().filter((item) => item.workspaceId !== record.workspaceId);
        next.push(record);
        await writePrivateJson(path, { version: 1, workspaces: next });
      });
    },
    remove(workspaceId) {
      return serialized(async () => {
        const next = read().filter((item) => item.workspaceId !== workspaceId);
        await writePrivateJson(path, { version: 1, workspaces: next });
      });
    },
  };
}

/** 内存实现：单元测试与没有数据目录的嵌入场景。 */
export function createMemoryWorkspaceStore(initial: Iterable<WorkspaceRecord> = []): WorkspaceStore {
  const records = new Map<string, WorkspaceRecord>();
  for (const record of initial) records.set(record.workspaceId, structuredClone(record));
  return {
    async list() {
      return [...records.values()].map((record) => structuredClone(record));
    },
    async get(workspaceId) {
      const record = records.get(workspaceId);
      return record === undefined ? undefined : structuredClone(record);
    },
    async put(record) {
      records.set(record.workspaceId, structuredClone(record));
    },
    async remove(workspaceId) {
      records.delete(workspaceId);
    },
  };
}
