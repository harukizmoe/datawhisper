/**
 * 用户侧的会话库视图：标题、置顶、归档、删除、导出与检索。
 *
 * pi-durable 自己持久化会话与 entry；这里只补它没有的「用户元数据」。删除没有存储层 API，
 * 用 `LibraryStore` 的显式墓碑过滤（见 store.ts 顶部说明）。
 */
import { say } from "../i18n.ts";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import type { Conversations } from "../conversations/service.ts";
import { appError, invalidParams } from "../ipc/errors.ts";
import { isoNow, safeFileStem } from "./files.ts";
import type { LibraryStore, SessionMeta } from "./store.ts";

const PAGE_SIZE = 500;
const TITLE_LIMIT = 60;
const MAX_TITLE_CHARS = 200;

export type SessionListParams = {
  includeArchived?: boolean;
  includeModel?: boolean;
};

export type SessionView = {
  id: number;
  root: boolean;
  parent?: { conversationId: number; at: number };
  lastEntryId: number | null;
  updatedAt: number | null;
  title: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string | null;
  model: { provider: string; modelId: string } | null;
};

export type SessionSearchHit = {
  id: number;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: number | null;
  matchedIn: "title" | "body";
  snippet: string;
};

/** 一条 entry 里的可见文本：用户/助手的正文，忽略思考、工具结果与系统提示。 */
export function visibleText(entry: EntryRecord): string {
  const parts: string[] = [];
  for (const message of entry.model ?? []) {
    if (message.role === "user" || message.role === "assistant") {
      const text = messageText(message.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as { type?: unknown; text?: unknown; thinking?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push(say("[image]", "[图片]"));
    // 思考内容不进导出/检索：它可能是被安全策略脱敏后的空壳，也不是用户看到的正文。
  }
  return parts.join("\n");
}

/** 助手 entry 里的工具调用，折叠成 `name {json}` 一行。 */
export function toolCallsOf(entry: EntryRecord): { name: string; argumentsJson: string }[] {
  const calls: { name: string; argumentsJson: string }[] = [];
  for (const message of entry.model ?? []) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      let args: string;
      try {
        args = JSON.stringify(block.arguments ?? {});
      } catch {
        args = "{}";
      }
      calls.push({ name: block.name, argumentsJson: truncate(args, 200) });
    }
  }
  return calls;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function entryTimestamp(entry: EntryRecord | undefined): number | null {
  if (entry === undefined) return null;
  for (const message of [...(entry.model ?? [])].reverse()) {
    if (typeof message.timestamp === "number") return message.timestamp;
  }
  return null;
}

function formatTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return say("unknown", "未知");
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function snippetAround(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return undefined;
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + query.length + 80);
  return `${start > 0 ? "…" : ""}${collapse(text.slice(start, end))}${end < text.length ? "…" : ""}`;
}

export type SessionLibraryDeps = {
  harness: Harness;
  context: Context;
  conversations: Conversations;
  store: LibraryStore;
};

export class SessionLibrary {
  readonly #deps: SessionLibraryDeps;

  constructor(deps: SessionLibraryDeps) {
    this.#deps = deps;
  }

  async list(params: SessionListParams = {}): Promise<{ conversations: SessionView[] }> {
    const includeArchived = params.includeArchived !== false;
    const includeModel = params.includeModel !== false;
    const { conversations } = await this.#deps.conversations.list();
    const deleted = this.#deps.store.deletedIds();
    const metas = this.#deps.store.allMeta();
    const out: SessionView[] = [];
    for (const record of conversations) {
      const key = String(record.id);
      if (deleted.has(key)) continue;
      const meta = metas.get(key);
      if (meta?.archived === true && !includeArchived) continue;
      const conversationId = record.id as ConversationId;
      const title = (meta?.title ?? "").trim() || (await this.#derivedTitle(conversationId, record.root));
      let model: SessionView["model"] = null;
      if (includeModel) {
        const conversation = await this.#deps.harness.conversation(conversationId, this.#deps.context);
        if (conversation !== undefined) {
          try {
            const agent = await conversation.agent(this.#deps.context);
            model = agent.model ?? null;
          } catch {
            // 模型被删/扩展装不上不应该让整个会话列表失败；模型字段留空即可。
            model = null;
          }
        }
      }
      out.push({
        ...record,
        title: title || (record.root ? say("Default conversation", "默认会话") : say("Untitled conversation", "未命名会话")),
        pinned: meta?.pinned ?? false,
        archived: meta?.archived ?? false,
        createdAt: meta?.createdAt ?? null,
        model,
      });
    }
    return { conversations: out };
  }

  async rename(id: string | number, title: string): Promise<{ id: number; title: string; pinned: boolean; archived: boolean }> {
    const trimmed = title.trim();
    if (trimmed === "") throw invalidParams("'title' must be a non-empty string");
    if (trimmed.length > MAX_TITLE_CHARS) throw invalidParams(`'title' must be at most ${MAX_TITLE_CHARS} characters`);
    const conversation = await this.#require(id);
    const meta = this.#deps.store.putMeta(String(conversation.id), { title: trimmed });
    return { id: conversation.id, title: meta.title, pinned: meta.pinned, archived: meta.archived };
  }

  async setPinned(id: string | number, pinned?: boolean): Promise<{ id: number; title: string; pinned: boolean; archived: boolean }> {
    const conversation = await this.#require(id);
    const key = String(conversation.id);
    return this.#writeFlag(conversation.id, { pinned: pinned ?? !(this.#deps.store.meta(key)?.pinned ?? false) });
  }

  async setArchived(id: string | number, archived?: boolean): Promise<{ id: number; title: string; pinned: boolean; archived: boolean }> {
    const conversation = await this.#require(id);
    const key = String(conversation.id);
    return this.#writeFlag(conversation.id, { archived: archived ?? !(this.#deps.store.meta(key)?.archived ?? false) });
  }

  /**
   * 幂等删除：第一次写墓碑并清掉元数据，重复调用返回 `deleted: false, alreadyDeleted: true`。
   * 根会话是 Harness 的引导会话，删掉它没有意义，按参数不合法拒绝。
   */
  async remove(id: string | number): Promise<{ id: string; title: string; deleted: boolean; alreadyDeleted: boolean }> {
    const text = String(id);
    if (text === "root" || text === "1") throw invalidParams("the root conversation cannot be deleted");
    const conversation = await this.#lookup(id);
    const key = conversation === undefined ? text : String(conversation.id);
    if (this.#deps.store.isDeleted(key)) {
      const tombstone = this.#deps.store.deleted(key);
      return { id: key, title: tombstone?.title ?? "", deleted: false, alreadyDeleted: true };
    }
    if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
    const title =
      (this.#deps.store.meta(key)?.title ?? "").trim() || (await this.#derivedTitle(conversation.id, conversation.id === 1));
    const first = this.#deps.store.tombstone(key, title);
    return { id: key, title, deleted: first, alreadyDeleted: !first };
  }

  async exportSession(id: string | number, format: "md" | "json"): Promise<{ format: string; filename: string; content: string }> {
    if (format !== "md" && format !== "json") throw invalidParams("'format' must be md or json");
    const conversation = await this.#require(id);
    const key = String(conversation.id);
    const entries = await this.#entries(conversation);
    const meta = this.#deps.store.meta(key);
    const title = (meta?.title ?? "").trim() || (await this.#derivedTitle(conversation.id, conversation.id === 1)) || say("Untitled conversation", "未命名会话");
    let model: { provider: string; modelId: string } | null = null;
    try {
      const agent = await conversation.agent(this.#deps.context);
      model = agent.model ?? null;
    } catch {
      model = null;
    }
    const updatedAt = entryTimestamp(entries.at(-1));
    const filename = `${safeFileStem(title, `session-${key}`)}.${format === "md" ? "md" : "json"}`;
    if (format === "json") {
      return {
        format,
        filename,
        content: JSON.stringify(
          {
            version: 1,
            id: conversation.id,
            title,
            root: conversation.id === 1,
            model,
            createdAt: meta?.createdAt ?? null,
            updatedAt,
            exportedAt: isoNow(),
            entries: entries.map((entry) => ({
              kind: entry.kind,
              timestamp: entryTimestamp(entry),
              text: visibleText(entry),
              toolCalls: toolCallsOf(entry),
            })),
          },
          null,
          2,
        ),
      };
    }
    return { format, filename, content: renderMarkdown(key, title, meta, model, updatedAt, entries) };
  }

  /**
   * 标题 + 正文检索。pi-durable 1.5 没有文本检索方法（只有 entries/context 的读取），
   * 因此正文按 `conversation.entries()` 逐页扫描可见的用户/助手文本；标题命中的会话不再读正文。
   * 命中按会话去重，每个会话只返回第一处匹配的片段。
   */
  async search(params: {
    query: string;
    limit?: number;
    includeArchived?: boolean;
  }): Promise<{ query: string; hits: SessionSearchHit[] }> {
    const query = params.query.trim();
    if (query === "") throw invalidParams("'query' must be a non-empty string");
    const limit = Math.max(1, Math.min(params.limit ?? 20, 100));
    const includeArchived = params.includeArchived === true;
    const { conversations } = await this.#deps.conversations.list();
    const deleted = this.#deps.store.deletedIds();
    const metas = this.#deps.store.allMeta();
    const hits: SessionSearchHit[] = [];
    for (const record of conversations) {
      if (hits.length >= limit) break;
      const key = String(record.id);
      if (deleted.has(key)) continue;
      const meta = metas.get(key);
      if (meta?.archived === true && !includeArchived) continue;
      const conversationId = record.id as ConversationId;
      const title =
        (meta?.title ?? "").trim() ||
        (await this.#derivedTitle(conversationId, record.root)) ||
        (record.root ? say("Default conversation", "默认会话") : say("Untitled conversation", "未命名会话"));
      const titleHit = snippetAround(title, query);
      if (titleHit !== undefined) {
        hits.push({ id: record.id, title, pinned: meta?.pinned ?? false, archived: meta?.archived ?? false, updatedAt: record.updatedAt, matchedIn: "title", snippet: titleHit });
        continue;
      }
      const conversation = await this.#deps.harness.conversation(conversationId, this.#deps.context);
      if (conversation === undefined) continue;
      const bodyHit = await this.#bodySnippet(conversation, query);
      if (bodyHit !== undefined) {
        hits.push({ id: record.id, title, pinned: meta?.pinned ?? false, archived: meta?.archived ?? false, updatedAt: record.updatedAt, matchedIn: "body", snippet: bodyHit });
      }
    }
    return { query, hits };
  }

  async #writeFlag(
    id: number,
    patch: { pinned?: boolean; archived?: boolean },
  ): Promise<{ id: number; title: string; pinned: boolean; archived: boolean }> {
    const meta = this.#deps.store.putMeta(String(id), patch);
    return { id, title: meta.title, pinned: meta.pinned, archived: meta.archived };
  }

  async #lookup(id: string | number): Promise<Conversation | undefined> {
    if (String(id) === "root") return this.#deps.harness.root(this.#deps.context);
    const text = String(id);
    if (!/^[1-9][0-9]{0,15}$/.test(text)) return undefined;
    return this.#deps.harness.conversation(Number(text) as ConversationId, this.#deps.context);
  }

  async #require(id: string | number): Promise<Conversation> {
    const conversation = await this.#lookup(id);
    if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
    if (this.#deps.store.isDeleted(String(conversation.id))) {
      throw appError("not_found", `conversation not found: ${id}`);
    }
    return conversation;
  }

  async #entries(conversation: Conversation): Promise<EntryRecord[]> {
    const items: EntryRecord[] = [];
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, PAGE_SIZE, cursor, this.#deps.context);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return items;
  }

  /** 没有显式标题时用第一条用户消息；最多翻 50 条 entry，避免为列表把整段历史读完。 */
  async #derivedTitle(id: ConversationId, root: boolean): Promise<string> {
    const conversation = await this.#deps.harness.conversation(id, this.#deps.context);
    if (conversation === undefined) return root ? say("Default conversation", "默认会话") : "";
    const page = await conversation.entries({ order: "ascending" }, 50, undefined, this.#deps.context);
    for (const entry of page.items) {
      if (entry.kind !== "pi.user") continue;
      const text = collapse(visibleText(entry));
      if (text !== "") return truncate(text, TITLE_LIMIT);
    }
    return root ? say("Default conversation", "默认会话") : "";
  }

  async #bodySnippet(conversation: Conversation, query: string): Promise<string | undefined> {
    let cursor: Parameters<Conversation["entries"]>[2];
    do {
      const page = await conversation.entries({ order: "ascending" }, PAGE_SIZE, cursor, this.#deps.context);
      for (const entry of page.items) {
        if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
        const text = visibleText(entry);
        if (text === "") continue;
        const snippet = snippetAround(text, query);
        if (snippet !== undefined) return snippet;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }
}

function renderMarkdown(
  key: string,
  title: string,
  meta: SessionMeta | undefined,
  model: { provider: string; modelId: string } | null,
  updatedAt: number | null,
  entries: readonly EntryRecord[],
): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    say(`- Conversation ID: ${key}`, `- 会话 ID: ${key}`),
    say(`- Created: ${meta?.createdAt ?? "unknown"}`, `- 创建时间: ${meta?.createdAt ?? "未知"}`),
    say(`- Updated: ${formatTime(updatedAt)}`, `- 更新时间: ${formatTime(updatedAt)}`),
    say(
      `- Model: ${model === null ? "not set" : `${model.provider}/${model.modelId}`}`,
      `- 模型: ${model === null ? "未设置" : `${model.provider}/${model.modelId}`}`,
    ),
    say(`- Exported: ${isoNow()}`, `- 导出时间: ${isoNow()}`),
    "",
    "---",
    "",
  ];
  let assistantStarted = false;
  for (const entry of entries) {
    if (entry.kind === "pi.user") {
      const text = visibleText(entry);
      if (text === "") continue;
      lines.push(say("## User", "## 用户"), "", text, "");
      assistantStarted = false;
      continue;
    }
    if (entry.kind === "pi.assistant") {
      const text = visibleText(entry);
      const calls = toolCallsOf(entry);
      if (text !== "" || calls.length > 0) {
        if (!assistantStarted) {
          lines.push(say("## Assistant", "## 助手"), "");
          assistantStarted = true;
        }
        if (text !== "") lines.push(text, "");
        for (const call of calls) lines.push(say(`- Tool call: \`${call.name}\` ${call.argumentsJson}`, `- 工具调用: \`${call.name}\` ${call.argumentsJson}`));
        if (calls.length > 0) lines.push("");
      }
      continue;
    }
    if (entry.kind === "pi.compaction") {
      lines.push(say("> Context compacted", "> 上下文已压缩"), "");
      assistantStarted = false;
      continue;
    }
    if (entry.kind === "pi.reset") {
      lines.push(say("> Conversation context reset", "> 会话上下文已重置"), "");
      assistantStarted = false;
    }
  }
  if (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}
