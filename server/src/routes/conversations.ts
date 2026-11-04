/**
 * Conversation routes of the UI protocol (docs/refactor/ui-protocol.md), mounted at /v1/conversations.
 *
 *   GET  /                   list ownerless conversations, newest first
 *   POST /                   create a conversation; body {model?, thinkingLevel?}, default: the settings' default model
 *   GET  /:id/subscribe      SSE: `snapshot` {seq:0, view}, then `ops` {seq, ops}; `end` when the watch ends
 *   POST /:id/submit         {requestId, text, whenBusy?} -> {submissionId, status}
 *                            409 {error:"no_model"} when the conversation has no model and none is available,
 *                            409 {error:"model_unavailable"} when its model's provider was removed or disabled
 *   PUT  /:id/model          {model, thinkingLevel} -> {model, thinkingLevel}; applies from the next model request
 *   POST /:id/abort          abort the current run and withdraw queued inputs
 *
 * `:id` is `root` or a conversation's numeric id.
 */
import type { Context } from "@earendil-works/chord/context";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type ModelService, SettingsError } from "../models/service.ts";
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

export type ConversationRoutesDeps = {
  harness: Harness;
  modelService: ModelService;
  context: Context;
  heartbeatMs?: number;
};

export function conversationRoutes({ harness, modelService, context, heartbeatMs = DEFAULT_HEARTBEAT_MS }: ConversationRoutesDeps): Hono {
  const routes = new Hono();

  routes.onError((error, c) => {
    if (error instanceof SettingsError) return c.json({ error: error.message }, 400);
    throw error;
  });

  /** `root` (created on first use), or an existing conversation's numeric id. */
  async function lookup(param: string): Promise<Conversation | undefined> {
    if (param === "root") return harness.root(context);
    if (!/^[1-9][0-9]{0,15}$/.test(param)) return undefined;
    // ConversationId is an erased brand over a positive integer (pi-durable does not export idFromNumber); checked above.
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
      // A comment line every heartbeatMs: a dead peer fails the write, which aborts the stream and stops the watch.
      const heartbeat = setInterval(() => void sse.write(": ping\n\n").catch(() => void watch.stop()), heartbeatMs);
      watch.start(async (call) => {
        // A `failed` call keeps the last value; the next value call starts with ["r", value], so nothing is lost.
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
