/**
 * 会话业务的传输无关实现（docs/refactor/ui-protocol.md 的语义，docs/refactor/ui-transport.md 的方法）。
 *
 * 这里没有任何 HTTP/SSE 概念：调用方给一个 `EventSink`，订阅把 `snapshot`、`ops`、`end` 交给它；
 * RPC 层再把它们包成 `conversation.event` 通知。暴露的入口既给 IPC 方法表用，也给测试直接调用
 * （`service.conversations.submitTurn(…)`）。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type ConversationView,
  type ConversationWatch,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { EMPTY_TURN_CONTEXT, type TurnContext, TurnDoc } from "../agent/turn.ts";
import { appError, invalidParams } from "../ipc/errors.ts";
import { type ModelService, parseThinkingLevel } from "../models/service.ts";
import type {
  AgentModelResponse,
  ConversationListResponse,
  ConversationSummary,
  EndEvent,
  OpsEvent,
  SetModelRequest,
  SnapshotEvent,
  SubmitRequest,
  SubmitResponse,
} from "../protocol.ts";
import { MAX_VISIBLE_TOOLS, recordDiscoveredToolTurn } from "../tools/exposure.ts";
import { toolsForTurn } from "../tools/select.ts";

const SCAN_PAGE = 256;

/** 数据源/工作区状态，供每轮的工具暴露与系统提示判定。 */
export type TurnState = {
  hasDataSource: boolean;
  sourceCount: number;
  hasWorkspace: boolean;
  hasUnnamedColumns: boolean;
  teamsEnabled: boolean;
};

export const NO_TURN_STATE: TurnState = {
  hasDataSource: false,
  sourceCount: 0,
  hasWorkspace: false,
  hasUnnamedColumns: false,
  teamsEnabled: false,
};

export type ConversationsDeps = {
  harness: Harness;
  modelService: ModelService;
  context: Context;
  /** 本轮可用的工具，由 P4 提供。 */
  tools?: readonly ToolRegistration[];
  /** 每轮开始时重新取一次数据源/工作区状态。 */
  turnState?: () => TurnState;
};

/** 一条订阅通知：与旧 SSE 的 `snapshot`/`ops`/`end` 一一对应，加上订阅号。 */
export type ConversationEvent = { subscriptionId: number } & (SnapshotEvent & { event: "snapshot" } | OpsEvent & { event: "ops" } | EndEvent & { event: "end" });

/** 订阅把事件交给它的方式；返回 promise 时，发下一条之前会等它完成（背压）。 */
export type EventSink = (event: ConversationEvent) => void | Promise<void>;

export type Conversations = {
  list(): Promise<ConversationListResponse>;
  create(body: unknown): Promise<{ id: number }>;
  setModel(id: string | number, body: unknown): Promise<AgentModelResponse>;
  /** 提交一轮：模型兜底 → 写本轮上下文 → 收敛工具集 → submit。 */
  submitTurn(id: string | number, body: unknown): Promise<SubmitResponse>;
  abort(id: string | number): Promise<{ ok: true }>;
  subscribe(id: string | number, sink: EventSink): Promise<{ subscriptionId: number }>;
  unsubscribe(subscriptionId: number): Promise<{ ok: true }>;
  /** 给所有订阅发 `end` 并停掉 watch；服务停止前调用。 */
  close(): Promise<void>;
};

type Subscription = {
  watch: ConversationWatch;
  sink: EventSink;
  /** 显式退订：不再发 `end`（对端已经不要了）。 */
  suppressEnd: boolean;
  /** `end`（或抑制）处理完毕；`stop()` 之后等它，保证退出前写完。 */
  ended: Promise<void>;
};

/** `root`（首次使用时创建），或已有会话的数字 id。 */
async function lookup(deps: ConversationsDeps, param: string | number): Promise<Conversation | undefined> {
  const text = String(param);
  if (text === "root") return deps.harness.root(deps.context);
  if (!/^[1-9][0-9]{0,15}$/.test(text)) return undefined;
  // ConversationId 是正整数的擦除 branded 类型（pi-durable 未导出 idFromNumber）；上面已校验格式。
  return deps.harness.conversation(Number(text) as ConversationId, deps.context);
}

async function requireConversation(deps: ConversationsDeps, param: string | number): Promise<Conversation> {
  const conversation = await lookup(deps, param);
  if (conversation === undefined) throw appError("not_found", `conversation not found: ${param}`);
  return conversation;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalidParams("params must be an object");
  return body as Record<string, unknown>;
}

function modelRef(value: unknown): { provider: string; modelId: string } {
  if (typeof value !== "object" || value === null) throw invalidParams("model must be {provider, modelId}");
  const { provider, modelId } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof modelId !== "string") throw invalidParams("model must be {provider, modelId}");
  return { provider, modelId };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParams(`'${name}' must be a string`);
  return value;
}

/**
 * 提交一轮。顺序有讲究：先写本轮上下文（section 渲染时要读），再 `configure({ modelTools })`（下一次模型请求前
 * 生效），最后才 submit。`configure` 是整体替换语义，所以每轮都必须重算，不能增量合并。
 */
export async function submitTurn(deps: ConversationsDeps, id: string | number, body: unknown): Promise<SubmitResponse> {
  const params = asObject(body);
  const { requestId, text } = params;
  if (typeof requestId !== "string" || requestId === "" || typeof text !== "string") throw invalidParams("requestId and text are required");
  const command = optionalString(params.command, "command");
  const whenBusy = params.whenBusy;
  if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") throw invalidParams("whenBusy must be steer or followUp");

  const { harness, modelService, context } = deps;
  const conversation = await requireConversation(deps, id);
  const agent = await conversation.agent(context);
  if (agent.model === undefined) {
    const fallback = await modelService.defaultAgent();
    if (fallback === undefined) throw appError("no_model", "no model is available; configure one in model settings");
    await conversation.configure(fallback, context);
  } else if (modelService.models.getModel(agent.model.provider, agent.model.modelId) === undefined) {
    throw appError("model_unavailable", `model ${agent.model.provider}/${agent.model.modelId} is not available`);
  }

  const previous = (await harness.snapshot(TurnDoc, conversation.id, context)) ?? EMPTY_TURN_CONTEXT;
  const current = (deps.turnState ?? (() => NO_TURN_STATE))();
  // 命令/技能轮不参与关键词发现（旧实现传空消息，记一次空发现并推进 TTL）。
  const discoveryMessage = command === undefined ? text : "";
  const discovery = recordDiscoveredToolTurn(
    { discovered: previous.discoveredTools, turns: previous.discoveryTurns },
    discoveryMessage,
  );
  const next: TurnContext = {
    ...previous,
    message: text,
    command: command ?? null,
    activation: command === undefined ? { kind: "none", name: "" } : { kind: "command", name: command },
    ...current,
    discoveryTurns: discovery.state.turns.map((turn) => [...turn]),
    discoveredTools: [...discovery.state.discovered],
    turn: previous.turn + 1,
  };
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(TurnDoc, conversation.id);
    Object.assign(doc, next);
  }, context);

  const selected = toolsForTurn(deps.tools ?? [], {
    userMessage: text,
    command,
    hasDataSource: current.hasDataSource,
    hasWorkspace: current.hasWorkspace,
    teamsEnabled: current.teamsEnabled,
    discoveredTools: next.discoveredTools,
    maxTools: MAX_VISIBLE_TOOLS,
  });
  await conversation.configure({ modelTools: selected }, context);

  const submission = await conversation.submit(
    { type: "input", content: text, requestId, whenBusy: whenBusy ?? "followUp" },
    context,
  );
  const record = await submission.status(context);
  return { submissionId: submission.id, status: record.status };
}

export function createConversations(deps: ConversationsDeps): Conversations {
  const { harness, modelService, context } = deps;
  const subscriptions = new Map<number, Subscription>();
  let nextSubscriptionId = 1;

  return {
    async list() {
      const conversations = await harness.commit(async (tx) => {
        const records: ConversationRecord[] = [];
        let cursor;
        do {
          const page = await tx.scanConversations({ order: "descending" }, SCAN_PAGE, cursor);
          records.push(...page.items.filter((record) => record.owner === undefined));
          cursor = page.next;
        } while (cursor !== undefined);
        const out: ConversationSummary[] = [];
        for (const record of records) {
          const lastEntryId = await tx.latestEntryId(record.id);
          const last = lastEntryId === undefined ? undefined : await tx.entry(lastEntryId);
          const message = last?.model?.at(-1);
          out.push({
            id: record.id,
            root: record.id === ROOT_CONVERSATION_ID,
            ...(record.parent ? { parent: { conversationId: record.parent.conversationId, at: record.parent.at } } : {}),
            lastEntryId: lastEntryId ?? null,
            updatedAt: message && "timestamp" in message ? message.timestamp : null,
          });
        }
        return out;
      }, context);
      return { conversations };
    },

    async create(body) {
      const params = body === undefined ? {} : asObject(body);
      const thinkingLevel = parseThinkingLevel(params.thinkingLevel);
      let agent;
      if (params.model !== undefined) {
        const model = modelRef(params.model);
        modelService.resolve(model, thinkingLevel);
        agent = { model, thinkingLevel };
      } else {
        agent = await modelService.defaultAgent();
      }
      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
      return { id: conversation.id };
    },

    async setModel(id, body) {
      const params = asObject(body);
      const model = modelRef(params.model);
      const thinkingLevel = parseThinkingLevel(params.thinkingLevel);
      const conversation = await requireConversation(deps, id);
      modelService.resolve(model, thinkingLevel);
      await conversation.configure({ model, thinkingLevel }, context);
      const agent = await conversation.agent(context);
      return { model: agent.model ?? null, thinkingLevel: agent.thinkingLevel };
    },

    submitTurn: (id, body) => submitTurn(deps, id, body),

    async abort(id) {
      const conversation = await requireConversation(deps, id);
      await conversation.abort(context);
      return { ok: true as const };
    },

    async subscribe(id, sink) {
      const conversation = await requireConversation(deps, id);
      const subscriptionId = nextSubscriptionId++;
      const watch = await conversation.watch(context);
      let seq = 0;
      const record: Subscription = {
        watch,
        sink,
        suppressEnd: false,
        ended: Promise.resolve(),
      };
      record.ended = (async () => {
        // `failed` 调用会保留最后一个值；下一次 value 调用以 ["r", value] 开始，因此不会丢失内容。
        const end = await watch.closed;
        if (!record.suppressEnd) await sink({ subscriptionId, event: "end", kind: end.kind });
      })()
        .catch((error: unknown) => console.error("[conversation] 发送订阅结束通知失败", error))
        .finally(() => subscriptions.delete(subscriptionId));
      subscriptions.set(subscriptionId, record);
      try {
        await sink({ subscriptionId, event: "snapshot", seq: 0, view: watch.value });
      } catch (error) {
        subscriptions.delete(subscriptionId);
        record.suppressEnd = true;
        await watch.stop();
        throw error;
      }
      watch.start(async (call) => {
        if (call.kind !== "value" || call.ops.length === 0) return;
        seq += 1;
        await sink({ subscriptionId, event: "ops", seq, ops: call.ops as readonly Op[] });
      });
      return { subscriptionId };
    },

    async unsubscribe(subscriptionId) {
      const record = subscriptions.get(subscriptionId);
      if (record === undefined) throw appError("not_found", `unknown subscription: ${subscriptionId}`);
      record.suppressEnd = true;
      subscriptions.delete(subscriptionId);
      await record.watch.stop();
      await record.ended;
      return { ok: true as const };
    },

    async close() {
      const records = [...subscriptions.values()];
      await Promise.all(
        records.map(async (record) => {
          await record.watch.stop();
          await record.ended;
        }),
      );
    },
  };
}
