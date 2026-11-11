/**
 * 飞书群 ↔ 本机会话的绑定（持久化）。
 *
 * 旧实现把绑定存在 `ChatSession` 上（`feishu_bot_enabled` + `feishu_chat_id`），语义是：
 * 一个群只有在 Web 端显式绑定后才接收机器人消息；未绑定的群保持沉默，绝不因为群里有人 @机器人
 * 就自动新建会话。这里把同一份语义落到 `<数据目录>/feishu-links.json`：
 *
 *   { "version": 1, "links": { "<chat_id>": { conversationId, name, updatedAt } } }
 *
 * 一个会话只能绑定一个群，一个群也只能指向一个会话（后绑定的覆盖前者，与旧实现「同一 chat_id
 * 只保留一个活跃会话」一致）。
 */

import { readFile } from "node:fs/promises";
import { writePrivateJson } from "../models/credentials.ts";

export type FeishuLink = {
  readonly conversationId: number;
  readonly name: string;
  readonly updatedAt: string;
};

type StoredFile = { version: 1; links: Record<string, FeishuLink> };

export class FeishuLinkStore {
  private links: Record<string, FeishuLink>;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    links: Record<string, FeishuLink>,
  ) {
    this.links = links;
  }

  static async open(filePath: string): Promise<FeishuLinkStore> {
    let links: Record<string, FeishuLink> = {};
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StoredFile>;
      if (parsed.links !== undefined && typeof parsed.links === "object" && parsed.links !== null) {
        for (const [chatId, link] of Object.entries(parsed.links)) {
          const candidate = link as Partial<FeishuLink> | undefined;
          if (typeof candidate?.conversationId !== "number") continue;
          links[chatId] = {
            conversationId: candidate.conversationId,
            name: typeof candidate.name === "string" ? candidate.name : "",
            updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
          };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FeishuLinkStore(filePath, links);
  }

  /** 群对应的会话；未绑定时返回 undefined。 */
  get(chatId: string): FeishuLink | undefined {
    return this.links[chatId];
  }

  /** 会话绑定的群（用于把群消息回显到界面、以及解绑）。 */
  findByConversation(conversationId: number): { chatId: string; link: FeishuLink } | undefined {
    for (const [chatId, link] of Object.entries(this.links)) {
      if (link.conversationId === conversationId) return { chatId, link };
    }
    return undefined;
  }

  /** 绑定一个群；同一会话已有的绑定会被替换。 */
  async link(chatId: string, link: FeishuLink): Promise<void> {
    return this.mutate((links) => {
      for (const [existingChat, existing] of Object.entries(links)) {
        if (existing.conversationId === link.conversationId) delete links[existingChat];
      }
      links[chatId] = link;
    });
  }

  /** 解绑一个会话（旧实现把 enabled/chat_id/name 一起清空）。 */
  async unlinkConversation(conversationId: number): Promise<void> {
    return this.mutate((links) => {
      for (const [chatId, link] of Object.entries(links)) {
        if (link.conversationId === conversationId) delete links[chatId];
      }
    });
  }

  private mutate(fn: (links: Record<string, FeishuLink>) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const links = { ...this.links };
      fn(links);
      await writePrivateJson(this.filePath, { version: 1, links } satisfies StoredFile);
      this.links = links;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
