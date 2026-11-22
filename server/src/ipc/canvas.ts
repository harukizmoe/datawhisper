/**
 * 画布的 IPC 方法：列出、读取与应用操作。
 *
 * 自定义 durable 文档不在订阅视图里（视图只含 pi 自带文档），所以界面在画布工具完成后、
 * 以及切换会话时用 `canvas.list` 重新读取。改动用 `canvas.apply` 原子提交，版本过期返回
 * `canvas_conflict`，由界面回滚到服务端快照。
 */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { createConversationDocs } from "../tools/app/docs.ts";
import { CanvasOpError, applyCanvasOps } from "../tools/app/canvas/ops.ts";
import { APP_ERROR, RpcError, appError, invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";

export type CanvasMethodDeps = {
  readonly harness: Harness;
  readonly context: Context;
  readonly now?: () => Date;
};

function conversationId(params: MethodParams): number {
  const value = params.conversationId;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams("'conversationId' must be a positive integer");
  }
  return value;
}

function requiredString(params: MethodParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value;
}

function conflict(revision: number): RpcError {
  return new RpcError("canvas revision conflict", APP_ERROR, { kind: "canvas_conflict", revision });
}

export function canvasMethods(deps: CanvasMethodDeps): Record<string, RpcMethod> {
  const now = deps.now ?? (() => new Date());
  async function host(params: MethodParams) {
    const id = conversationId(params);
    const conversation = await deps.harness.conversation(id as ConversationId, deps.context);
    if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
    return createConversationDocs({ harness: deps.harness, conversation, context: deps.context }).canvas;
  }

  return {
    "canvas.list": async (params) => {
      const doc = await (await host(params)).read();
      return { canvases: doc.canvases };
    },

    "canvas.get": async (params) => {
      const canvasId = requiredString(params, "canvasId");
      const doc = await (await host(params)).read();
      const canvas = doc.canvases.find((item) => item.id === canvasId);
      if (canvas === undefined) throw appError("not_found", `canvas not found: ${canvasId}`);
      return { canvas };
    },

    "canvas.apply": async (params) => {
      const canvasId = requiredString(params, "canvasId");
      const baseRevision = params.baseRevision;
      if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 1) {
        throw invalidParams("'baseRevision' must be a positive integer");
      }
      if (!Array.isArray(params.ops)) throw invalidParams("'ops' must be an array");
      const ops = params.ops;
      const docs = await host(params);
      return await docs.update((doc) => {
        const index = doc.canvases.findIndex((item) => item.id === canvasId);
        if (index < 0) throw appError("not_found", `canvas not found: ${canvasId}`);
        const current = doc.canvases[index]!;
        if (current.revision !== baseRevision) throw conflict(current.revision);
        try {
          const result = applyCanvasOps(current, ops, now());
          doc.canvases[index] = result.canvas;
          return {
            canvas: result.canvas,
            createdNodeIds: result.createdNodeIds,
            createdEdgeIds: result.createdEdgeIds,
            changedNodeIds: result.changedNodeIds,
            changedEdgeIds: result.changedEdgeIds,
            deletedNodeIds: result.deletedNodeIds,
            deletedEdgeIds: result.deletedEdgeIds,
          };
        } catch (error) {
          if (error instanceof CanvasOpError) throw invalidParams(error.message);
          throw error;
        }
      });
    },
  };
}
