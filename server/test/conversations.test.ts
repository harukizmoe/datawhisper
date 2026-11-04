import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import type { ConversationListResponse, SubmitResponse } from "../src/protocol.ts";
import { type Service, startService } from "../src/service.ts";
import { SseClient, type SseEvent } from "./support/sse.ts";
import { STUB_MODEL, stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

const TOKEN = "test-token";
const ctx = BACKGROUND_CONTEXT;

type Running = { service: Service; stub: Stub; base: string; dir: string };
const running: Running[] = [];
const streams: SseClient[] = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  for (const { service, stub, dir } of running.splice(0)) {
    await service.stop();
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(options: { chunkDelayMs?: number; heartbeatMs?: number; provider?: boolean } = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "dw-conv-test-"));
  const stub = startStub({ chunkDelayMs: options.chunkDelayMs ?? 1 });
  const config = loadConfig({ DW_TOKEN: TOKEN, DW_DATA_DIR: dir, DW_PORT: "0" });
  const service = await startService(config, { forceFileCredentials: true, heartbeatMs: options.heartbeatMs });
  if (options.provider !== false) await service.modelService.putProvider(stubProvider(stub.url));
  const r = { service, stub, base: `http://127.0.0.1:${service.port}/v1`, dir };
  running.push(r);
  return r;
}

function call(base: string, method: string, path: string, body?: unknown, token = TOKEN): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

async function subscribe(base: string, id: string): Promise<SseClient> {
  const stream = await SseClient.open(`${base}/conversations/${id}/subscribe`, TOKEN);
  streams.push(stream);
  return stream;
}

type View = ConversationView;
type Snapshot = { seq: number; view: View };
type Ops = { seq: number; ops: Op[] };

// SSE 载荷是服务用这些确切类型（src/protocol.ts）构造的 JSON；测试校验其内容。
const snapshotOf = (event: SseEvent): Snapshot => event.data as Snapshot;
const opsOf = (event: SseEvent): Ops => event.data as Ops;
/** view 的 `pi.live`：Harness 自己的 LiveState 文档。 */
const liveOf = (view: View): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

/** 用 Chord 自己的 apply 折叠 snapshot + ops 事件，并校验序列号。 */
function replicate(events: SseEvent[]): View {
  const [first, ...rest] = events;
  expect(first?.event).toBe("snapshot");
  const snapshot = snapshotOf(first!);
  expect(snapshot.seq).toBe(0);
  let view = snapshot.view;
  let seq = 0;
  for (const { event, data } of rest) {
    if (event !== "ops") continue;
    const ops = opsOf({ event, data });
    expect(ops.seq).toBe(seq + 1);
    seq = ops.seq;
    view = applyImmutable(view, ops.ops);
  }
  return view;
}

/** 在提交答案条目之后运行时已结束（没有 `pi.live.run`）。 */
function answered(events: SseEvent[]): boolean {
  if (events.length < 2) return false;
  const view = replicate(events);
  return liveOf(view).run === undefined && view.entries.some((entry) => entry.kind === "pi.assistant");
}

describe("conversation routes", () => {
  test("require the bearer token", async () => {
    const { base } = await start();
    for (const [method, path] of [
      ["GET", "/conversations"],
      ["POST", "/conversations"],
      ["GET", "/conversations/root/subscribe"],
      ["POST", "/conversations/root/submit"],
      ["POST", "/conversations/root/abort"],
      ["PUT", "/conversations/root/model"],
    ] as const) {
      expect((await fetch(`${base}${path}`, { method })).status).toBe(401);
      expect((await call(base, method, path, {}, "wrong")).status).toBe(401);
    }
  });

  test("unknown conversation ids are 404", async () => {
    const { base } = await start();
    for (const id of ["999", "abc", "0", "-1", "1.5"]) {
      expect((await call(base, "GET", `/conversations/${id}/subscribe`)).status).toBe(404);
      expect((await call(base, "POST", `/conversations/${id}/submit`, { requestId: "r", text: "x" })).status).toBe(404);
      expect((await call(base, "POST", `/conversations/${id}/abort`)).status).toBe(404);
      expect((await call(base, "PUT", `/conversations/${id}/model`, { model: STUB_MODEL, thinkingLevel: null })).status).toBe(404);
    }
  });

  test("submit validates its body", async () => {
    const { base } = await start();
    expect((await call(base, "POST", "/conversations/root/submit", { text: "x" })).status).toBe(400);
    expect((await call(base, "POST", "/conversations/root/submit", { requestId: "", text: "x" })).status).toBe(400);
    expect((await call(base, "POST", "/conversations/root/submit", { requestId: "r" })).status).toBe(400);
    expect((await call(base, "POST", "/conversations/root/submit", { requestId: "r", text: "x", whenBusy: "reject" })).status).toBe(400);
    const res = await fetch(`${base}/conversations/root/submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("subscribe sends a snapshot, then sequenced ops; a resubscribe's snapshot equals the replica", async () => {
    const { base, stub } = await start({ chunkDelayMs: 40 });
    const stream = await subscribe(base, "root");
    await stream.until((events) => events.length >= 1);
    expect(stream.events[0]!.event).toBe("snapshot");
    const initial = replicate(stream.events);
    expect(initial.entries).toEqual([]);
    expect(Object.keys(initial.docs).sort()).toEqual(["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"]);

    const submitted = await call(base, "POST", "/conversations/root/submit", { requestId: "req-1", text: "Summarize the data" });
    expect(submitted.status).toBe(200);
    const { submissionId, status } = (await submitted.json()) as SubmitResponse;
    expect(typeof submissionId).toBe("number");
    expect(["queued", "placed", "done"]).toContain(status);

    await stream.until(answered);
    // 回复在流式过程中已可见：某个中间副本在 pi.live.generation 中持有部分内容。
    const partials = stream.events
      .map((_, i) => liveOf(replicate(stream.events.slice(0, i + 1))).generation?.message)
      .filter((message) => message !== undefined);
    expect(partials.length).toBeGreaterThan(0);
    const replica = replicate(stream.events);
    // 每轮提交都会写入本轮上下文并重设工具集，因此正文之前会有一条 `pi.system`（提示词/工具变更的位置标记）。
    // 这里只断言它对模型不可见的种类安排：用户消息在前、助手回复在后，中间只允许 system 标记。
    const kinds = replica.entries.map((e) => e.kind).filter((kind) => kind !== "pi.system");
    expect(kinds).toEqual(["pi.user", "pi.assistant"]);
    expect(replica.entries.some((e) => e.kind === "pi.system")).toBe(true);
    expect(stub.log).toHaveLength(1);

    const fresh = await subscribe(base, "1"); // 按数字 id 订阅根会话
    await fresh.until((events) => events.length >= 1);
    expect(snapshotOf(fresh.events[0]!).view).toEqual(replica);
  });

  test("the same requestId returns the same submission and runs once", async () => {
    const { base, service, stub } = await start();
    const body = { requestId: "dup", text: "hello" };
    const first = (await (await call(base, "POST", "/conversations/root/submit", body)).json()) as SubmitResponse;
    const second = (await (await call(base, "POST", "/conversations/root/submit", body)).json()) as SubmitResponse;
    expect(second.submissionId).toBe(first.submissionId);
    const other = (await (await call(base, "POST", "/conversations/root/submit", { requestId: "other", text: "again" })).json()) as SubmitResponse;
    expect(other.submissionId).not.toBe(first.submissionId);
    await (await service.harness.root(ctx)).waitForIdle(ctx);
    expect(stub.log.filter((r) => r.lastUser === "hello")).toHaveLength(1);
  });

  test("a conversation without a model gets the default at submit; with no provider configured, submit is 409 no_model", async () => {
    const bare = await start({ provider: false });
    const refused = await call(bare.base, "POST", "/conversations/root/submit", { requestId: "r", text: "hi" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no_model" });
    expect(bare.stub.log).toHaveLength(0);

    // 稍后再添加 provider：同一个会话（创建时未指定模型）现在改用默认 provider 运行。
    await bare.service.modelService.putProvider(stubProvider(bare.stub.url));
    expect((await call(bare.base, "POST", "/conversations/root/submit", { requestId: "r2", text: "hi" })).status).toBe(200);
    const root = await bare.service.harness.root(ctx);
    await root.waitForIdle(ctx);
    expect(bare.stub.log.map((r) => r.model)).toEqual([STUB_MODEL.modelId]);
    expect((await root.agent(ctx)).model).toEqual(STUB_MODEL);
  });

  test("switching model and thinking level mid-conversation applies to the next request", async () => {
    const { base, service, stub } = await start();
    const created = await call(base, "POST", "/conversations");
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    const conversation = (await service.harness.conversation(id as never, ctx))!;

    await call(base, "POST", `/conversations/${id}/submit`, { requestId: "a", text: "first" });
    await conversation.waitForIdle(ctx);

    // 未知模型和模型不支持的等级会被拒绝，且不改变任何状态。
    expect((await call(base, "PUT", `/conversations/${id}/model`, { model: { ...STUB_MODEL, modelId: "nope" }, thinkingLevel: null })).status).toBe(400);
    expect((await call(base, "PUT", `/conversations/${id}/model`, { model: STUB_MODEL, thinkingLevel: "high" })).status).toBe(400);
    for (const [method, path] of [
      ["POST", "/conversations"],
      ["PUT", `/conversations/${id}/model`],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` }, body: "not json" });
      expect(res.status).toBe(400);
    }

    const switched = await call(base, "PUT", `/conversations/${id}/model`, { model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "high" });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({ model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "high" });

    await call(base, "POST", `/conversations/${id}/submit`, { requestId: "b", text: "second" });
    await conversation.waitForIdle(ctx);
    expect(stub.log.map((r) => [r.model, r.lastUser])).toEqual([
      [STUB_MODEL.modelId, "first"],
      ["stub-reasoner", "second"],
    ]);
    expect(stub.log[1]!.body.reasoning_effort).toBe("high");
    expect(stub.log[0]!.body.reasoning_effort).toBeUndefined();
  });

  test("a new conversation can start on a chosen model; a removed provider makes submit 409 model_unavailable", async () => {
    const { base, service, stub } = await start();
    expect((await call(base, "POST", "/conversations", { model: { ...STUB_MODEL, modelId: "missing" } })).status).toBe(400);
    const { id } = (await (await call(base, "POST", "/conversations", { model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "low" })).json()) as { id: number };
    const conversation = (await service.harness.conversation(id as never, ctx))!;
    expect(await conversation.agent(ctx)).toMatchObject({ model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "low" });

    await service.modelService.deleteProvider(STUB_MODEL.provider);
    const refused = await call(base, "POST", `/conversations/${id}/submit`, { requestId: "x", text: "hi" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "model_unavailable" });
    expect(stub.log).toHaveLength(0);
  });

  test("abort ends the running reply and settles its input unanswered", async () => {
    const { base, service } = await start({ chunkDelayMs: 200 });
    const stream = await subscribe(base, "root");
    const res = (await (await call(base, "POST", "/conversations/root/submit", { requestId: "slow", text: "take your time" })).json()) as SubmitResponse;
    // 等到回复开始流式输出，然后中止它。
    await stream.until((events) => liveOf(replicate(events)).generation?.message !== undefined);
    const aborted = await call(base, "POST", "/conversations/root/abort");
    expect(aborted.status).toBe(200);
    expect(await aborted.json()).toEqual({ ok: true });
    await stream.until((events) => liveOf(replicate(events)).runFailure?.reason === "aborted");
    const view = replicate(stream.events);
    expect(liveOf(view).run).toBeUndefined();
    // SubmissionId 是 pi-durable 擦除后的整数 brand；路由把它当作普通数字返回。
    const submissionId = res.submissionId as Parameters<typeof service.harness.submission>[0];
    const submission = await service.harness.submission(submissionId, ctx);
    expect((await submission!.status(ctx)).status).toBe("unanswered");
  });

  test("a subscription sends heartbeat comments and ends when the service stops", async () => {
    const r = await start({ heartbeatMs: 30 });
    const stream = await subscribe(r.base, "root");
    await stream.until((events) => events.length >= 1);
    await stream.until((_events, client) => client.comments >= 2);
    expect(stream.events.filter((e) => e.event !== "snapshot")).toEqual([]); // 注释行不算事件
    await r.service.stop();
    await stream.finished;
    expect(stream.done).toBe(true);
  });

  test("list and create conversations", async () => {
    const { base, service } = await start();
    await call(base, "POST", "/conversations/root/submit", { requestId: "list", text: "hi" });
    await (await service.harness.root(ctx)).waitForIdle(ctx);
    const created = await call(base, "POST", "/conversations");
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    expect(id).toBeGreaterThan(1);

    const list = (await (await call(base, "GET", "/conversations")).json()) as ConversationListResponse;
    expect(list.conversations.map((c) => c.id)).toEqual([id, 1]);
    const [fresh, root] = list.conversations;
    expect(fresh).toEqual({ id, root: false, lastEntryId: null, updatedAt: null });
    expect(root!.root).toBe(true);
    expect(root!.lastEntryId).toBeGreaterThan(0);
    expect(root!.updatedAt).toBeGreaterThan(Date.now() - 60_000);

    const stream = await subscribe(base, String(id));
    await stream.until((events) => events.length >= 1);
    expect(Number(snapshotOf(stream.events[0]!).view.conversation.id)).toBe(id);
  });
});
