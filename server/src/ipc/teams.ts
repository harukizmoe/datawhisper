/**
 * 团队视图的 IPC 方法：读取团队状态/子会话列表，取消正在跑的成员委托。
 *
 * 团队文档存在会话级 `TEAM_STORE_DOC` 里，所以每个方法都带 `conversationId`；
 * 与编排方法一样，参数错误 → -32602，找不到团队/会话 → -32000。
 * 由整合者在 `createMethods` 里 `...teamMethods(deps)` 接线；未接线时客户端收到 -32601。
 */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { createConversationDocs } from "../tools/app/docs.ts";
import { WorkspaceTeamError, WorkspaceTeamStore } from "../tools/app/teams.ts";
import type { TeamDelegationService } from "../teams/delegate.ts";
import { appError, invalidParams } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";

export type TeamMethodDeps = {
  readonly harness: Harness;
  readonly context: Context;
  /** 委托执行器；省略时取消方法返回 `canceled: 0`。 */
  readonly delegation?: TeamDelegationService;
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

function optionalString(params: MethodParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value;
}

/** `WorkspaceTeamError` 的文案沿用旧实现；只有“找不到”按协议错误返回，其余是参数问题。 */
function translate<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof WorkspaceTeamError) {
      if (
        error.message.startsWith("team not found:") ||
        error.message.startsWith("member not found:") ||
        error.message.startsWith("dynamic plan not found:")
      ) {
        throw appError("not_found", error.message);
      }
      throw invalidParams(error.message);
    }
    throw error;
  });
}

export function teamMethods(deps: TeamMethodDeps): Record<string, RpcMethod> {
  const { harness, context, delegation } = deps;

  async function store(params: MethodParams): Promise<WorkspaceTeamStore> {
    const id = conversationId(params);
    const conversation = await harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
    const docs = createConversationDocs({ harness, conversation, context });
    return new WorkspaceTeamStore(docs.teams);
  }

  return {
    "teams.list": (params) => translate(async () => ({ teams: await (await store(params)).list() })),
    /**
     * 任务板（`task_create` 等工具维护的会话文档）。它不在订阅推送的视图里（视图只含 pi 自带文档），
     * 界面在任务工具完成后据此重新读取。
     */
    "tasks.list": async (params) => {
      const id = conversationId(params);
      const conversation = await harness.conversation(id as ConversationId, context);
      if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
      const board = await createConversationDocs({ harness, conversation, context }).tasks.read();
      return { tasks: board.tasks };
    },

    "teams.status": (params) =>
      translate(async () => {
        const name = requiredString(params, "name");
        return await (await store(params)).status(name);
      }),

    "teams.cancelDelegate": async (params) => {
      const teamName = requiredString(params, "teamName");
      const memberName = optionalString(params, "memberName");
      if (delegation === undefined) return { canceled: 0 };
      return { canceled: await delegation.cancel(teamName, memberName) };
    },

    /** 正在运行的委托（子会话 id 与成员），供界面显示“停止”按钮。 */
    "teams.activeDelegations": () => ({ delegations: delegation?.active() ?? [] }),
  };
}
