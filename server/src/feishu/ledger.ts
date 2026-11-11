/**
 * 飞书写操作的幂等账本（跨重启持久）。
 *
 * 为什么需要：工具调用是外部副作用，一次调用可能被重投（pi-durable 的记录重放、模型重试同一次调用、
 * 或进程在「请求已发出、结果未提交」之间崩溃）。旧实现没有这层保护，重复投递就会产生重复记录。
 *
 * 键由调用身份（pi-durable 的 `taskId` / `callId`）与负载指纹组成，因此：
 * - 同一个 durable 调用被重投：命中已完成条目，直接返回上次的结果，不再写飞书；
 * - 同一次调用崩溃在写入之间：条目停在 `started`，重复投递得到「结果未知」的错误，而不是再写一遍；
 * - 另一次调用（新 callId）带相同负载：不共享条目，模型确实要求再写一次时才写。
 *
 * 存储：`<数据目录>/feishu-writes.json`，0600 + 原子重命名；写操作排队执行，重启后仍在。
 * 条目数上限 500，超出时按时间淘汰最旧的。账本只存工具结果的文本与字段，不存凭据。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writePrivateJson } from "../models/credentials.ts";

export type LedgerEntry = {
  readonly operation: string;
  readonly status: "started" | "done";
  /** ISO 时间；用于淘汰。 */
  readonly at: string;
  /** 完成时的值；`started` 条目没有。 */
  readonly value?: unknown;
};

export type ClaimResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "done"; readonly entry: LedgerEntry }
  /** 有同键的旧条目停在 `started`：上次写入的结果未知。 */
  | { readonly kind: "unfinished"; readonly entry: LedgerEntry };

type StoredFile = { version: 1; entries: Record<string, LedgerEntry> };

const MAX_ENTRIES = 500;

export class FeishuWriteLedger {
  private entries: Record<string, LedgerEntry>;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    entries: Record<string, LedgerEntry>,
  ) {
    this.entries = entries;
  }

  static async open(filePath: string): Promise<FeishuWriteLedger> {
    let stored: StoredFile = { version: 1, entries: {} };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StoredFile>;
      if (parsed.entries !== undefined && typeof parsed.entries === "object" && parsed.entries !== null) {
        stored = { version: 1, entries: parsed.entries };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FeishuWriteLedger(filePath, stored.entries);
  }

  /** 占位：返回 `claimed` 表示可以写入；`done` 表示复用结果；`unfinished` 表示上次写入结果未知。 */
  claim(key: string, operation: string): Promise<ClaimResult> {
    return this.serialize(async () => {
      const existing = this.entries[key];
      if (existing === undefined) {
        const started: LedgerEntry = { operation, status: "started", at: new Date().toISOString() };
        await this.write({ ...this.entries, [key]: started });
        return { kind: "claimed" };
      }
      if (existing.status === "done") return { kind: "done", entry: existing };
      return { kind: "unfinished", entry: existing };
    });
  }

  /** 写入成功：把结果落盘，重复投递直接复用。 */
  complete(key: string, operation: string, value: unknown): Promise<void> {
    return this.serialize(async () => {
      const entries: Record<string, LedgerEntry> = {
        ...this.entries,
        [key]: { operation, status: "done", at: new Date().toISOString(), value },
      };
      await this.write(prune(entries));
    });
  }

  /** 明确失败（例如参数校验或网络错误）：删掉占位，允许下一次调用重新尝试。 */
  release(key: string): Promise<void> {
    return this.serialize(async () => {
      if (!Object.hasOwn(this.entries, key)) return;
      const entries = { ...this.entries };
      delete entries[key];
      await this.write(entries);
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async write(entries: Record<string, LedgerEntry>): Promise<void> {
    await writePrivateJson(this.filePath, { version: 1, entries } satisfies StoredFile);
    this.entries = entries;
  }
}

/**
 * 由调用身份与负载算出稳定键。
 *
 * 负载指纹让「同一次调用」与「同一份写入内容」绑定：若调用身份相同但参数变了（理论上不会发生），
 * 键也随之变化，不会把旧结果当成新调用的结果返回。
 */
export function ledgerKey(operation: string, identity: { taskId?: string; callId?: string }, payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex").slice(0, 32);
  return `${operation}:${identity.taskId ?? ""}:${identity.callId ?? ""}:${digest}`;
}

function prune(entries: Record<string, LedgerEntry>): Record<string, LedgerEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= MAX_ENTRIES) return entries;
  const keep = keys
    .sort((left, right) => (entries[right]?.at ?? "").localeCompare(entries[left]?.at ?? ""))
    .slice(0, MAX_ENTRIES);
  const pruned: Record<string, LedgerEntry> = {};
  for (const key of keep) {
    const entry = entries[key];
    if (entry !== undefined) pruned[key] = entry;
  }
  return pruned;
}
