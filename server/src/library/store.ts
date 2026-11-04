/**
 * 会话库的本地元数据与墓碑。
 *
 * 为什么单独一个 SQLite 文件：pi-durable 的 `datawhisper.sqlite` 归它自己迁移与维护，
 * 从外部改表结构或删行会和它的版本管理打架。这里的库视图是**我们自己的**数据
 * （用户改过的标题、置顶、归档、已删除标记），放在 `<dataDir>/library.sqlite`，
 * 只通过 bun:sqlite 访问，与 pi-durable 的会话/entry 表没有外键关系。
 *
 * 删除：pi-durable 1.5 的 `Storage` 接口没有删除会话或 entry 的方法（只有 conversation /
 * entry / task / submission / document 的读与 commit），因此无法在存储层真删。会话删除
 * 写成显式墓碑：`session_deleted` 保留 id 与删除时间，`session.list` 和 `session.search`
 * 过滤掉这些 id。墓碑是幂等的：重复删除只更新/保留一行，不报错。
 */
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { ensureDir, isoNow } from "./files.ts";

export type SessionMeta = {
  conversationId: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SessionTombstone = {
  conversationId: string;
  deletedAt: string;
  title: string;
};

type MetaRow = {
  conversation_id: string;
  title: string;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
};

type DeletedRow = {
  conversation_id: string;
  deleted_at: string;
  title: string;
};

function toMeta(row: MetaRow): SessionMeta {
  return {
    conversationId: row.conversation_id,
    title: row.title,
    pinned: row.pinned !== 0,
    archived: row.archived !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class LibraryStore {
  readonly #db: Database;

  constructor(path: string) {
    ensureDir(dirname(path));
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        conversation_id TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        pinned          INTEGER NOT NULL DEFAULT 0,
        archived        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_deleted (
        conversation_id TEXT PRIMARY KEY,
        deleted_at      TEXT NOT NULL,
        title           TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  meta(conversationId: string): SessionMeta | undefined {
    const row = this.#db
      .query<MetaRow, [string]>("SELECT * FROM session_meta WHERE conversation_id = ?")
      .get(conversationId);
    return row === null ? undefined : toMeta(row);
  }

  allMeta(): Map<string, SessionMeta> {
    const rows = this.#db.query<MetaRow, []>("SELECT * FROM session_meta").all();
    return new Map(rows.map((row) => [row.conversation_id, toMeta(row)]));
  }

  /** 局部更新；没有这一行时用 `now` 作为创建时间。 */
  putMeta(conversationId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): SessionMeta {
    const now = isoNow();
    const previous = this.meta(conversationId);
    const next: SessionMeta = {
      conversationId,
      title: patch.title ?? previous?.title ?? "",
      pinned: patch.pinned ?? previous?.pinned ?? false,
      archived: patch.archived ?? previous?.archived ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.#db
      .query(
        `INSERT INTO session_meta (conversation_id, title, pinned, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           title = excluded.title,
           pinned = excluded.pinned,
           archived = excluded.archived,
           updated_at = excluded.updated_at`,
      )
      .run(next.conversationId, next.title, next.pinned ? 1 : 0, next.archived ? 1 : 0, next.createdAt, next.updatedAt);
    return next;
  }

  deleteMeta(conversationId: string): void {
    this.#db.query("DELETE FROM session_meta WHERE conversation_id = ?").run(conversationId);
  }

  isDeleted(conversationId: string): boolean {
    return (
      this.#db
        .query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM session_deleted WHERE conversation_id = ?")
        .get(conversationId) !== null
    );
  }

  deleted(conversationId: string): SessionTombstone | undefined {
    const row = this.#db
      .query<DeletedRow, [string]>("SELECT * FROM session_deleted WHERE conversation_id = ?")
      .get(conversationId);
    return row === null ? undefined : { conversationId: row.conversation_id, deletedAt: row.deleted_at, title: row.title };
  }

  deletedIds(): Set<string> {
    const rows = this.#db
      .query<{ conversation_id: string }, []>("SELECT conversation_id FROM session_deleted")
      .all();
    return new Set(rows.map((row) => row.conversation_id));
  }

  /** 写墓碑并丢掉元数据；已有墓碑时保留第一次的删除时间。返回是否是第一次删除。 */
  tombstone(conversationId: string, title: string): boolean {
    const inserted = this.#db
      .query(
        `INSERT OR IGNORE INTO session_deleted (conversation_id, deleted_at, title) VALUES (?, ?, ?)`,
      )
      .run(conversationId, isoNow(), title);
    this.deleteMeta(conversationId);
    return inserted.changes > 0;
  }
}
