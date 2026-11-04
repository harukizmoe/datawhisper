/**
 * UI 协议的会话路由（docs/refactor/ui-protocol.md），挂载在 /v1/conversations。
 *
 *   GET  /                  列出无主的会话，最新的在前
 *   POST /                  创建会话；请求体 {model?, thinkingLevel?}，默认使用设置中的默认模型
 *   GET  /:id/subscribe      SSE：先发 `snapshot` {seq:0, view}，再发 `ops` {seq, ops}；watch 结束时发 `end`
 *   POST /:id/submit         {requestId, text, whenBusy?} -> {submissionId, status}
 *                            会话没有模型且没有可用模型时返回 409 {error:"no_model"}，
 *                            其模型所属 provider 被删除或禁用时返回 409 {error:"model_unavailable"}
 *   PUT  /:id/model          {model, thinkingLevel} -> {model, thinkingLevel}；从下一次模型请求起生效
 *   POST /:id/abort          中止当前运行并撤回已排队的输入
 *
 * `:id` 是 `root`，或会话的数字 id。
 */
import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Harness,
  ROOT_CONVERSATION_ID,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { EMPTY_TURN_CONTEXT, type TurnContext, TurnDoc } from "../agent/turn.ts";
import { type ModelService, SettingsError } from "../models/service.ts";
import { MAX_VISIBLE_TOOLS, recordDiscoveredToolTurn } from "../tools/exposure.ts";
import { toolsForTurn } from "../tools/select.ts";
import type {
  AgentModelResponse,
  ConversationListResponse,
  ConversationSummary,
  CreateConversationRequest,
  EndEvent,
  OpsEvent,
  SetModelRequest,
  SnapshotEvent,
  SubmitRequest,
  SubmitResponse,
} from "../protocol.ts";

export const DEFAULT_HEARTBEAT_MS = 15_000;
const SCAN_PAGE = 256;

/** 数据源/工作区状态，供每轮的工具暴露与系统提示判定。 */
export type TurnState = {
  hasDataSource: boolean;
  sourceCount: number;
  hasWorkspace: boolean;
  hasUnnamedColumns: boolean;
  teamsEnabled: boolean;
};

const NO_TURN_STATE: TurnState = { hasDataSource: false, sourceCount: 0, hasWorkspace: false, hasUnnamedColumns: false, teamsEnabled: false };

export type ConversationRoutesDeps = {
  harness: Harness;
  modelService: ModelService;
  context: Context;
  heartbeatMs?: number;
  /** 本轮可用的工具，由 P4 提供。 */
  tools?: readonly ToolRegistration[];
  /** 每轮开始时重新取一次数据源/工作区状态。 */
  turnState?: () => TurnState;
};

export function conversationRoutes({
  harness,
  modelService,
  context,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  tools = [],
  turnState,
}: ConversationRoutesDeps): Hono {
  const routes = new Hono();

  routes.onError((error, c) => {
    if (error instanceof SettingsError || error instanceof SyntaxError) return c.json({ error: error.message }, 400);
    throw error;
  });

  /**
   * 提交前写本轮上下文，并按它收敛本轮工具集。
   *
   * 顺序有讲究：先写文档（section 渲染时要读），再 `configure({ modelTools })`（下一次模型请求前生效），
   * 最后才 submit。`configure` 是整体替换语义，所以每轮都必须重算，不能增量合并。
   */
  async function prepareTurn(conversation: Conversation, body: SubmitRequest): Promise<void> {
    const previous = (await harness.snapshot(TurnDoc, conversation.id, context)) ?? EMPTY_TURN_CONTEXT;
    const state = turnState ?? (() => NO_TURN_STATE);
    const current = state();
    // 命令/技能轮不参与关键词发现（旧实现传空消息，记一次空发现并推进 TTL）。
    const discoveryMessage = body.command === undefined ? body.text : "";
    const discovery = recordDiscoveredToolTurn(
      { discovered: previous.discoveredTools, turns: previous.discoveryTurns },
      discoveryMessage,
    );
    const next: TurnContext = {
      ...previous,
      message: body.text,
      command: body.command ?? null,
      activation:
        body.command === undefined
          ? { kind: "none", name: "" }
          : { kind: "command", name: body.command },
      ...current,
      discoveryTurns: discovery.state.turns.map((turn) => [...turn]),
      discoveredTools: [...discovery.state.discovered],
      turn: previous.turn + 1,
    };
    await conversation.commit(async (tx) => {
      const doc = await tx.doc(TurnDoc, conversation.id);
      Object.assign(doc, next);
    }, context);

    const selected = toolsForTurn(tools, {
      userMessage: body.text,
      command: body.command,
      hasDataSource: current.hasDataSource,
      hasWorkspace: current.hasWorkspace,
      teamsEnabled: current.teamsEnabled,
      discoveredTools: next.discoveredTools,
      maxTools: MAX_VISIBLE_TOOLS,
    });
    await conversation.configure({ modelTools: selected }, context);
  }

  /** `root`（首次使用时创建），或已有会话的数字 id。 */
  async function lookup(param: string): Promise<Conversation | undefined> {
    if (param === "root") return harness.root(context);
    if (!/^[1-9][0-9]{0,15}$/.test(param)) return undefined;
    // ConversationId 是正整数的擦除 branded 类型（pi-durable 未导出 idFromNumber）；上面已校验格式。
    return harness.conversation(Number(param) as ConversationId, context);
  }

  routes.get("/", async (c) => {
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
    return c.json<ConversationListResponse>({ conversations });
  });

  routes.post("/", async (c) => {
    const raw = await c.req.text();
    const body = (raw === "" ? {} : JSON.parse(raw)) as CreateConversationRequest;
    let agent;
    if (body.model !== undefined) {
      modelService.resolve(body.model, body.thinkingLevel ?? null);
      agent = { model: body.model, thinkingLevel: body.thinkingLevel ?? null };
    } else {
      agent = await modelService.defaultAgent();
    }
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, context);
    return c.json({ id: conversation.id }, 201);
  });

  routes.put("/:id/model", async (c) => {
    const conversation = await lookup(c.req.param("id"));
    if (conversation === undefined) return c.json({ error: "not_found" }, 404);
    const { model, thinkingLevel } = await c.req.json<SetModelRequest>();
    if (typeof model?.provider !== "string" || typeof model.modelId !== "string") throw new SettingsError("model must be {provider, modelId}");
    modelService.resolve(model, thinkingLevel ?? null);
    await conversation.configure({ model: { provider: model.provider, modelId: model.modelId }, thinkingLevel: thinkingLevel ?? null }, context);
    const agent = await conversation.agent(context);
    return c.json<AgentModelResponse>({ model: agent.model ?? null, thinkingLevel: agent.thinkingLevel });
  });

  routes.post("/:id/submit", async (c) => {
    const conversation = await lookup(c.req.param("id"));
    if (conversation === undefined) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json<Partial<SubmitRequest>>().catch(() => undefined);
    if (body === undefined || typeof body.requestId !== "string" || body.requestId === "" || typeof body.text !== "string")
      return c.json({ error: "requestId and text are required" }, 400);
    if (body.whenBusy !== undefined && body.whenBusy !== "steer" && body.whenBusy !== "followUp")
      return c.json({ error: "whenBusy must be steer or followUp" }, 400);
    const agent = await conversation.agent(context);
    if (agent.model === undefined) {
      const fallback = await modelService.defaultAgent();
      if (fallback === undefined) return c.json({ error: "no_model" }, 409);
      await conversation.configure(fallback, context);
    } else if (modelService.models.getModel(agent.model.provider, agent.model.modelId) === undefined) {
      return c.json({ error: "model_unavailable" }, 409);
    }
    await prepareTurn(conversation, body as SubmitRequest);
    const submission = await conversation.submit(
      { type: "input", content: body.text, requestId: body.requestId, whenBusy: body.whenBusy ?? "followUp" },
      context,
    );
    const record = await submission.status(context);
    return c.json<SubmitResponse>({ submissionId: submission.id, status: record.status });
  });

  routes.post("/:id/abort", async (c) => {
    const conversation = await lookup(c.req.param("id"));
    if (conversation === undefined) return c.json({ error: "not_found" }, 404);
    await conversation.abort(context);
    return c.json({ ok: true });
  });

  routes.get("/:id/subscribe", async (c) => {
    const conversation = await lookup(c.req.param("id"));
    if (conversation === undefined) return c.json({ error: "not_found" }, 404);
    return streamSSE(c, async (sse) => {
      const watch = await conversation.watch(context);
      sse.onAbort(() => void watch.stop());
      if (sse.aborted) await watch.stop();
      let seq = 0;
      const snapshot: SnapshotEvent = { seq: 0, view: watch.value };
      await sse.writeSSE({ event: "snapshot", id: "0", data: JSON.stringify(snapshot) });
      // 每 heartbeatMs 写一行注释：对端已死时写入会失败，从而中止流并停止 watch。
      const heartbeat = setInterval(() => void sse.write(": ping\n\n").catch(() => void watch.stop()), heartbeatMs);
      watch.start(async (call) => {
        // `failed` 调用会保留最后一个值；下一次 value 调用以 ["r", value] 开始，因此不会丢失内容。
        if (call.kind !== "value" || call.ops.length === 0) return;
        seq += 1;
        const ops: OpsEvent = { seq, ops: call.ops };
        await sse.writeSSE({ event: "ops", id: String(seq), data: JSON.stringify(ops) });
      });
      const end = await watch.closed;
      clearInterval(heartbeat);
      const event: EndEvent = { kind: end.kind };
      if (!sse.aborted) await sse.writeSSE({ event: "end", data: JSON.stringify(event) });
    });
  });

  return routes;
}
