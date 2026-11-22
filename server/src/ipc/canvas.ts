/**
 * 画布的 IPC 方法：读取会话里的完整画布文档。
 *
 * 自定义 durable 文档不在订阅视图里（视图只含 pi 自带文档），所以界面在画布工具完成后、
 * 以及切换会话时用 `canvas.list` 重新读取。
 */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { createConversationDocs } from "../tools/app/docs.ts";
import { appError, invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";

export type CanvasMethodDeps = {
  readonly harness: Harness;
  readonly context: Context;
};

function conversationId(params: MethodParams): number {
  const value = params.conversationId;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams("'conversationId' must be a positive integer");
  }
  return value;
}

export function canvasMethods(deps: CanvasMethodDeps): Record<string, RpcMethod> {
  return {
    "canvas.list": async (params) => {
      const id = conversationId(params);
      const conversation = await deps.harness.conversation(id as ConversationId, deps.context);
      if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
      const doc = await createConversationDocs({ harness: deps.harness, conversation, context: deps.context }).canvas.read();
      return { canvases: doc.canvases };
    },
  };
}
