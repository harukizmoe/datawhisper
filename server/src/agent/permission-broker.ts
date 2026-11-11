/**
 * 待用户审批的工具调用：挂起调用方、把请求交给界面、收到回复后放行或拒绝。
 *
 * 只存在于内存里：进程重启后，被挂起的工具调用由调度器重放，再次走到闸门时会重新询问；
 * 所以这里不持久化，也不需要超时——用户不回复就一直等，中止这一轮会让等待结束。
 */

import { randomUUID } from "node:crypto";
import { awaitWithContext, type Context } from "@earendil-works/chord/context";

/** `allow_chat`：这次放行，并且本对话里同一个工具以后不再问（只对 edit 类提供）。 */
export type PermissionReply = "allow" | "allow_chat" | "deny";

export type PermissionRequest = {
  readonly requestId: string;
  readonly conversationId: number;
  readonly tool: string;
  /** 一句话说明要做什么，例如「Write file report.md」。 */
  readonly summary: string;
  /** 命令原文、写入内容的开头等，界面可折叠显示；没有就是空串。 */
  readonly detail: string;
  /** 能否提供「本对话都允许」。 */
  readonly allowChat: boolean;
  readonly createdAt: string;
};

export type PermissionEvent =
  | { readonly type: "requested"; readonly request: PermissionRequest }
  | { readonly type: "resolved"; readonly request: PermissionRequest; readonly reply: PermissionReply | "cancelled" };

export type PermissionBroker = {
  /** 挂起直到用户回复；`context` 被取消（中止本轮）时抛出取消错误。 */
  request(input: Omit<PermissionRequest, "requestId" | "createdAt">, context: Context): Promise<PermissionReply>;
  /** 返回是否有这个待审批请求；重复回复或回复已取消的请求返回 false。 */
  respond(requestId: string, reply: PermissionReply): boolean;
  pending(conversationId?: number): PermissionRequest[];
  onEvent(listener: (event: PermissionEvent) => void): () => void;
};

export function createPermissionBroker(): PermissionBroker {
  const waiting = new Map<string, { request: PermissionRequest; resolve: (reply: PermissionReply) => void }>();
  const listeners = new Set<(event: PermissionEvent) => void>();
  const emit = (event: PermissionEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return {
    async request(input, context) {
      const request: PermissionRequest = { ...input, requestId: randomUUID(), createdAt: new Date().toISOString() };
      const slot = Promise.withResolvers<PermissionReply>();
      waiting.set(request.requestId, { request, resolve: slot.resolve });
      emit({ type: "requested", request });
      try {
        const reply = await awaitWithContext(slot.promise, context);
        emit({ type: "resolved", request, reply });
        return reply;
      } catch (error) {
        if (waiting.delete(request.requestId)) emit({ type: "resolved", request, reply: "cancelled" });
        throw error;
      }
    },
    respond(requestId, reply) {
      const entry = waiting.get(requestId);
      if (entry === undefined) return false;
      waiting.delete(requestId);
      entry.resolve(reply);
      return true;
    },
    pending(conversationId) {
      return [...waiting.values()]
        .map((entry) => entry.request)
        .filter((request) => conversationId === undefined || request.conversationId === conversationId);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
