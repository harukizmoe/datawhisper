/**
 * 飞书入站消息 → 本机会话的一轮对话。
 *
 * 移植自 `api/feishu_bot.py` 的 `dispatch_inbound_event` / `_run_feishu_turn` / `_event_prompt`：
 *
 * - 只接受「群聊里 @机器人 的文本消息」；普通群聊、私聊和其它消息类型一律忽略。
 * - 群必须由界面显式绑定到某个会话（`FeishuLinkStore`）；未绑定的群保持沉默，不会自动新建会话。
 * - 触发方式复用 `conversations.submitTurn`（本轮上下文、工具集收敛、模型兜底都在那里），
 *   不自建 agent 循环。`requestId` 用飞书 `event_id`：飞书重投同一事件时 pi-durable 会把输入
 *   当成同一次提交处理，不会重复执行一轮。
 * - 一轮结束后把助手回复以卡片 Markdown 发回该群（旧实现 `send_markdown("**🤖 智析 Agent**\n…")`），
 *   与本机 Web 侧的可见性一致。
 * - 事件级去重落在持久账本里：`started` 表示上次投递中途崩溃（重投时接着等待并回填回复），
 *   `done` 表示已处理完（直接忽略）。
 */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, SubmissionId } from "@earendil-works/pi-durable";
import type { FeishuClient } from "./client.ts";
import type { FeishuLinkStore } from "./links.ts";
import type { FeishuWriteLedger } from "./ledger.ts";

/** 与 `conversations.submitTurn` 的返回同形（这里只依赖用得到的字段，避免把业务服务类型带进来）。 */
export type SubmitTurn = (id: string | number, body: unknown) => Promise<{ submissionId: number }>;

export type FeishuInboundDeps = {
  readonly conversations: { submitTurn: SubmitTurn };
  readonly harness: Pick<Harness, "submission" | "conversation">;
  readonly context: Context;
  readonly client: Pick<FeishuClient, "sendMarkdown">;
  readonly links: FeishuLinkStore;
  readonly ledger: FeishuWriteLedger;
  readonly log: (message: string, error?: unknown) => void;
};

/** 正在处理的事件 id（防同进程内同事件并发投递；跨重启由账本负责）。 */
const inFlight = new Set<string>();

/**
 * 旧 `_event_prompt`：从事件信封里取出 (chat_id, 文本)。
 *
 * 要求 `sender.sender_type == "user"`、`message.chat_type == "group"`、有提及、`message_type == "text"`；
 * 文本里 `@_user_N` 占位符被去掉。
 */
export function inboundPrompt(event: unknown): { chatId: string; text: string } | undefined {
  const envelope = asObject(event);
  if (envelope === undefined) return undefined;
  const sender = asObject(envelope.sender);
  const message = asObject(envelope.message);
  if (sender?.sender_type !== "user" || message?.chat_type !== "group") return undefined;
  const mentions = message.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return undefined;
  if (message.message_type !== "text") return undefined;
  let content: unknown;
  try {
    content = JSON.parse(typeof message.content === "string" ? message.content : "{}");
  } catch {
    return undefined;
  }
  const raw = asObject(content);
  const text = typeof raw?.text === "string" ? raw.text.replace(/@_user_\d+\s*/g, "").trim() : "";
  const chatId = typeof message.chat_id === "string" ? message.chat_id.trim() : "";
  return chatId !== "" && text !== "" ? { chatId, text } : undefined;
}

/**
 * 处理一条已通过长连接校验的事件。返回是否接受了这次投递。
 *
 * 调用方在后台运行它（不阻塞帧回执），异常一律吞掉并记日志：飞书侧的失败不能反过来影响本机对话。
 */
export async function dispatchInboundEvent(
  deps: FeishuInboundDeps,
  event: unknown,
  eventId: string,
): Promise<boolean> {
  const parsed = inboundPrompt(event);
  if (parsed === undefined) return false;
  const link = deps.links.get(parsed.chatId);
  if (link === undefined) return false;

  // 没有 event_id 的事件无法安全去重（同一个群里可以发同样的两句话），给一个一次性键。
  const key = eventId !== "" ? `inbound:${eventId}` : `inbound:${crypto.randomUUID()}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const claim = await deps.ledger.claim(key, "feishu.inbound");
    if (claim.kind === "done") return false;

    const requestId = eventId !== "" ? `feishu:${eventId}` : `feishu:${crypto.randomUUID()}`;
    const submitted = await deps.conversations.submitTurn(link.conversationId, {
      requestId,
      text: parsed.text,
      // 群聊是一个共享上下文：正在回答时把新消息排到下一轮，而不是打断当前回答。
      whenBusy: "followUp",
    });
    const submission = await deps.harness.submission(submitted.submissionId as SubmissionId, deps.context);
    if (submission !== undefined) await submission.wait(deps.context);
    const answer = await latestAssistantText(deps, link.conversationId);
    if (answer !== "") {
      await deps.client.sendMarkdown(`**🤖 智析 Agent**\n${answer}`, {
        receiveId: parsed.chatId,
        receiveIdType: "chat_id",
      });
    }
    await deps.ledger.complete(key, "feishu.inbound", { requestId, replied: answer !== "" });
    return true;
  } catch (error) {
    // 失败（没有模型、网络问题）释放占位，飞书重投时可以再试；同一 requestId 不会重复跑一轮。
    await deps.ledger.release(key).catch(() => undefined);
    deps.log("[feishu] 入站回合失败", error);
    return false;
  } finally {
    inFlight.delete(key);
  }
}

/** 从会话最新的几条 entry 里取最后一条助手回复的文本（工具调用/思考块不计入）。 */
async function latestAssistantText(deps: FeishuInboundDeps, conversationId: number): Promise<string> {
  const conversation = await deps.harness.conversation(conversationId as ConversationId, deps.context);
  if (conversation === undefined) return "";
  const page = await conversation.entries({ order: "descending" }, 8, undefined, deps.context);
  for (const entry of page.items) {
    const messages = entry.model ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      if (text !== "") return text;
    }
  }
  return "";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

