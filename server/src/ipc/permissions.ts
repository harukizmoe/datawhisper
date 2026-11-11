/**
 * 权限模式的 IPC 方法：待审批请求的列表与回复，对话当前的范围与模式。
 *
 * 询问本身发生在 `beforeTool` 里（`agent/permission-gate.ts`）；这里只让界面看见请求并回复。
 * 请求的出现与撤下另由通知 `permission.requested` / `permission.resolved` 推给界面（见 `attach.ts`）。
 */

import { say } from "../i18n.ts";
import { DEFAULT_PERMISSION_MODE, isPermissionMode } from "../agent/permission-mode.ts";
import type { PermissionBroker, PermissionReply } from "../agent/permission-broker.ts";
import { INVALID_PARAMS, invalidParams, RpcError } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import type { SourceDocStore } from "./source-store.ts";

export type PermissionMethodDeps = {
  readonly broker: PermissionBroker;
  readonly state: SourceDocStore;
  /** 会话文档变了（模式或允许名单）：宿主据此刷新本轮暴露的工具状态。 */
  readonly onChanged?: (conversationId: number) => void;
  /** 全部对话 id；省略时 `conversation.scopes` 恒为空。 */
  readonly conversationIds?: () => Promise<readonly number[]>;
};

const REPLIES: readonly PermissionReply[] = ["allow", "allow_chat", "deny"];

function conversationIdParam(params: MethodParams): number {
  const value = params.conversationId;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw invalidParams("'conversationId' must be a positive integer");
  }
  return value;
}

function reasonError(message: string, reason: string): RpcError {
  return new RpcError(message, INVALID_PARAMS, { kind: "invalid_input", reason });
}

export function permissionMethods(deps: PermissionMethodDeps): Record<string, RpcMethod> {
  const { broker, state } = deps;

  const scopeView = async (conversationId: number) => {
    const doc = await state.read(conversationId);
    if (doc.scope?.kind !== "workspace") return { scope: "chat" as const, workspace_id: null, mode: null, allowed_tools: [] as string[] };
    return {
      scope: "workspace" as const,
      workspace_id: doc.scope.workspaceId,
      mode: doc.permissionMode ?? DEFAULT_PERMISSION_MODE,
      allowed_tools: doc.permissionAllow ?? [],
    };
  };

  return {
    "permission.pending": (params) => {
      const conversationId = params.conversationId === undefined ? undefined : conversationIdParam(params);
      return { requests: broker.pending(conversationId) };
    },

    "permission.respond": (params) => {
      const requestId = params.requestId;
      if (typeof requestId !== "string" || requestId === "") throw invalidParams("'requestId' must be a non-empty string");
      const reply = params.decision;
      if (typeof reply !== "string" || !(REPLIES as readonly string[]).includes(reply)) {
        throw invalidParams("'decision' must be allow, allow_chat, or deny");
      }
      if (!broker.respond(requestId, reply as PermissionReply)) {
        throw reasonError(
          say("This request is no longer waiting for an answer.", "这个请求已经不在等待回复了。"),
          "request_not_pending",
        );
      }
      return { ok: true };
    },

    /** 对话属于哪个范围；工作区对话还带当前权限模式与「本对话都允许」的工具。 */
    "conversation.scope": async (params) => scopeView(conversationIdParam(params)),

    /** 全部工作区对话的归属（普通聊天不列出）：侧栏据此按工作区分组。 */
    "conversation.scopes": async () => {
      const scopes: { conversationId: number; workspace_id: string }[] = [];
      for (const conversationId of (await deps.conversationIds?.()) ?? []) {
        const doc = await state.read(conversationId).catch(() => undefined);
        if (doc?.scope?.kind === "workspace") scopes.push({ conversationId, workspace_id: doc.scope.workspaceId });
      }
      return { scopes };
    },

    "conversation.setMode": async (params) => {
      const conversationId = conversationIdParam(params);
      const mode = params.mode;
      if (!isPermissionMode(mode)) throw invalidParams("'mode' must be manual, accept_edits, plan, auto, or bypass");
      await state.update(conversationId, (draft) => {
        if (draft.scope?.kind !== "workspace") {
          throw reasonError(
            say("Permission modes only apply to conversations in a workspace.", "权限模式只适用于属于工作区的对话。"),
            "not_in_workspace",
          );
        }
        draft.permissionMode = mode;
      });
      deps.onChanged?.(conversationId);
      return { ok: true, ...(await scopeView(conversationId)) };
    },
  };
}
