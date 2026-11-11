import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import type { ConversationEvent } from "../src/conversations/service.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError } from "../src/ipc/errors.ts";
import type { ConversationListResponse, SnapshotEvent, SubmitResponse } from "../src/protocol.ts";
import { type Service, startService } from "../src/service.ts";
import { type ServicePipe, connectToService } from "./support/pipe.ts";
import { STUB_MODEL, stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

const ctx = BACKGROUND_CONTEXT;

type Running = { service: Service; stub: Stub; pipe: ServicePipe; dir: string };
const running: Running[] = [];

afterEach(async () => {
  for (const { service, stub, pipe, dir } of running.splice(0)) {
    await service.stop();
    stub.stop();
    pipe.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(options: { chunkDelayMs?: number; provider?: boolean } = {}): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "dw-conv-test-"));
  const stub = startStub({ chunkDelayMs: options.chunkDelayMs ?? 1 });
  const service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
  if (options.provider !== false) await service.modelService.putProvider(stubProvider(stub.url));
  const pipe = connectToService(service);
  const r = { service, stub, pipe, dir };
  running.push(r);
  return r;
}

/** 某个订阅收到的 `conversation.event` 通知，按到达顺序。 */
function eventsOf(pipe: ServicePipe, subscriptionId: number): ConversationEvent[] {
  return pipe.client.notifications
    .filter((notification) => notification.method === "conversation.event")
    .map((notification) => notification.params as ConversationEvent)
    .filter((event) => event.subscriptionId === subscriptionId);
}

async function until(pipe: ServicePipe, subscriptionId: number, predicate: (events: ConversationEvent[]) => boolean): Promise<void> {
  await pipe.client.until(() => predicate(eventsOf(pipe, subscriptionId)));
}

async function subscribe(pipe: ServicePipe, id: string): Promise<number> {
  const { subscriptionId } = await pipe.client.request<{ subscriptionId: number }>("conversation.subscribe", { id });
  return subscriptionId;
}

/** 断言调用以 RPC 错误结束，并返回它。 */
async function rpcError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected an RPC error");
}

type View = ConversationView;

/** 第一个事件必须是 `snapshot`。 */
function firstSnapshot(events: ConversationEvent[]): SnapshotEvent {
  const first = events[0];
  if (first === undefined || first.event !== "snapshot") throw new Error("第一个事件必须是 snapshot");
  return first;
}

/** 用 Chord 自己的 apply 折叠 snapshot + ops 事件，并校验序列号。 */
function replicate(events: ConversationEvent[]): View {
  const snapshot = firstSnapshot(events);
  expect(snapshot.seq).toBe(0);
  let view = snapshot.view;
  const rest = events.slice(1);
  let seq = 0;
  for (const event of rest) {
    if (event.event !== "ops") continue;
    expect(event.seq).toBe(seq + 1);
    seq = event.seq;
    view = applyImmutable(view, event.ops as Op[]);
  }
  return view;
}

/** view 的 `pi.live`：Harness 自己的 LiveState 文档。 */
const liveOf = (view: View): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

/** 在提交答案条目之后运行时已结束（没有 `pi.live.run`）。 */
function answered(events: ConversationEvent[]): boolean {
  if (events.length < 2) return false;
  const view = replicate(events);
  return liveOf(view).run === undefined && view.entries.some((entry) => entry.kind === "pi.assistant");
}

describe("conversation methods", () => {
  test("unknown conversation ids are not_found", async () => {
    const { pipe } = await start();
    for (const id of ["999", "abc", "0", "-1", "1.5"]) {
      for (const [method, params] of [
        ["conversation.subscribe", { id }],
        ["conversation.submit", { id, requestId: "r", text: "x" }],
        ["conversation.abort", { id }],
        ["conversation.setModel", { id, model: STUB_MODEL, thinkingLevel: null }],
      ] as const) {
        const error = await rpcError(pipe.client.request(method, params));
        expect(error.code).toBe(APP_ERROR);
        expect(error.data?.kind).toBe("not_found");
      }
    }
  });

  test("submit validates its body", async () => {
    const { pipe } = await start();
    for (const params of [{ id: "root", text: "x" }, { id: "root", requestId: "", text: "x" }, { id: "root", requestId: "r" }, { id: "root", requestId: "r", text: "x", whenBusy: "reject" }]) {
      const error = await rpcError(pipe.client.request("conversation.submit", params));
      expect(error.code).toBe(INVALID_PARAMS);
      expect(error.data?.kind).toBe("invalid_input");
    }
  });

  test("subscribe sends a snapshot, then sequenced ops; a resubscribe's snapshot equals the replica", async () => {
    const { pipe, stub } = await start({ chunkDelayMs: 40 });
    const subscriptionId = await subscribe(pipe, "root");
    await until(pipe, subscriptionId, (events) => events.length >= 1);
    const events = eventsOf(pipe, subscriptionId);
    expect(events[0]!.event).toBe("snapshot");
    const initial = replicate(events);
    expect(initial.entries).toEqual([]);
    expect(Object.keys(initial.docs).sort()).toEqual(["pi.agent", "pi.inbox", "pi.live", "pi.provider", "pi.usage"]);

    const submitted = await pipe.client.request<SubmitResponse>("conversation.submit", { id: "root", requestId: "req-1", text: "Summarize the data" });
    expect(typeof submitted.submissionId).toBe("number");
    expect(["queued", "placed", "done"]).toContain(submitted.status);

    await until(pipe, subscriptionId, answered);
    // 回复在流式过程中已可见：某个中间副本在 pi.live.generation 中持有部分内容。
    const partials = eventsOf(pipe, subscriptionId)
      .map((_, index) => liveOf(replicate(eventsOf(pipe, subscriptionId).slice(0, index + 1))).generation?.message)
      .filter((message) => message !== undefined);
    expect(partials.length).toBeGreaterThan(0);
    const replica = replicate(eventsOf(pipe, subscriptionId));
    // 每轮提交都会写入本轮上下文并重设工具集，因此正文之前会有一条 `pi.system`（提示词/工具变更的位置标记）。
    // 这里只断言它对模型不可见的种类安排：用户消息在前、助手回复在后，中间只允许 system 标记。
    const kinds = replica.entries.map((entry) => entry.kind).filter((kind) => kind !== "pi.system");
    expect(kinds).toEqual(["pi.user", "pi.assistant"]);
    expect(replica.entries.some((entry) => entry.kind === "pi.system")).toBe(true);
    expect(stub.log).toHaveLength(1);

    const fresh = await subscribe(pipe, "1"); // 按数字 id 订阅根会话
    await until(pipe, fresh, (freshEvents) => freshEvents.length >= 1);
    expect(firstSnapshot(eventsOf(pipe, fresh)).view).toEqual(replica);
  });

  test("the same requestId returns the same submission and runs once", async () => {
    const { pipe, service, stub } = await start();
    const body = { id: "root", requestId: "dup", text: "hello" };
    const first = await pipe.client.request<SubmitResponse>("conversation.submit", body);
    const second = await pipe.client.request<SubmitResponse>("conversation.submit", body);
    expect(second.submissionId).toBe(first.submissionId);
    const other = await pipe.client.request<SubmitResponse>("conversation.submit", { id: "root", requestId: "other", text: "again" });
    expect(other.submissionId).not.toBe(first.submissionId);
    await (await service.harness.root(ctx)).waitForIdle(ctx);
    expect(stub.log.filter((record) => record.lastUser === "hello")).toHaveLength(1);
  });

  test("a conversation without a model gets the default at submit; with no provider configured, submit is no_model", async () => {
    const bare = await start({ provider: false });
    const refused = await rpcError(bare.pipe.client.request("conversation.submit", { id: "root", requestId: "r", text: "hi" }));
    expect(refused.code).toBe(APP_ERROR);
    expect(refused.data?.kind).toBe("no_model");
    expect(bare.stub.log).toHaveLength(0);

    // 稍后再添加 provider：同一个会话（创建时未指定模型）现在改用默认 provider 运行。
    await bare.service.modelService.putProvider(stubProvider(bare.stub.url));
    await bare.pipe.client.request("conversation.submit", { id: "root", requestId: "r2", text: "hi" });
    const root = await bare.service.harness.root(ctx);
    await root.waitForIdle(ctx);
    expect(bare.stub.log.map((record) => record.model)).toEqual([STUB_MODEL.modelId]);
    expect((await root.agent(ctx)).model).toEqual(STUB_MODEL);
  });

  test("switching model and thinking level mid-conversation applies to the next request", async () => {
    const { pipe, service, stub } = await start();
    const { id } = await pipe.client.request<{ id: number }>("conversation.create");
    const conversation = (await service.harness.conversation(id as never, ctx))!;

    await pipe.client.request("conversation.submit", { id, requestId: "a", text: "first" });
    await conversation.waitForIdle(ctx);

    // 未知模型和模型不支持的等级会被拒绝，且不改变任何状态。
    const unknown = await rpcError(pipe.client.request("conversation.setModel", { id, model: { ...STUB_MODEL, modelId: "nope" }, thinkingLevel: null }));
    expect(unknown.code).toBe(INVALID_PARAMS);
    expect(unknown.data?.kind).toBe("unknown_model");
    const unsupported = await rpcError(pipe.client.request("conversation.setModel", { id, model: STUB_MODEL, thinkingLevel: "high" }));
    expect(unsupported.code).toBe(INVALID_PARAMS);
    expect(unsupported.data?.kind).toBe("unsupported_thinking_level");

    const switched = await pipe.client.request("conversation.setModel", { id, model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "high" });
    expect(switched).toEqual({ model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "high" });

    await pipe.client.request("conversation.submit", { id, requestId: "b", text: "second" });
    await conversation.waitForIdle(ctx);
    expect(stub.log.map((record) => [record.model, record.lastUser])).toEqual([
      [STUB_MODEL.modelId, "first"],
      ["stub-reasoner", "second"],
    ]);
    expect(stub.log[1]!.body.reasoning_effort).toBe("high");
    expect(stub.log[0]!.body.reasoning_effort).toBeUndefined();
  });

  test("a new conversation can start on a chosen model; a removed provider makes submit model_unavailable", async () => {
    const { pipe, service, stub } = await start();
    const unknown = await rpcError(pipe.client.request("conversation.create", { model: { ...STUB_MODEL, modelId: "missing" } }));
    expect(unknown.code).toBe(INVALID_PARAMS);
    expect(unknown.data?.kind).toBe("unknown_model");
    const { id } = await pipe.client.request<{ id: number }>("conversation.create", { model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "low" });
    const conversation = (await service.harness.conversation(id as never, ctx))!;
    expect(await conversation.agent(ctx)).toMatchObject({ model: { ...STUB_MODEL, modelId: "stub-reasoner" }, thinkingLevel: "low" });

    await service.modelService.deleteProvider(STUB_MODEL.provider);
    const refused = await rpcError(pipe.client.request("conversation.submit", { id, requestId: "x", text: "hi" }));
    expect(refused.code).toBe(APP_ERROR);
    expect(refused.data?.kind).toBe("model_unavailable");
    expect(stub.log).toHaveLength(0);
  });

  test("abort ends the running reply and settles its input unanswered", async () => {
    const { pipe, service } = await start({ chunkDelayMs: 200 });
    const subscriptionId = await subscribe(pipe, "root");
    const submitted = await pipe.client.request<SubmitResponse>("conversation.submit", { id: "root", requestId: "slow", text: "take your time" });
    // 等到回复开始流式输出，然后中止它。
    await until(pipe, subscriptionId, (events) => liveOf(replicate(events)).generation?.message !== undefined);
    expect(await pipe.client.request("conversation.abort", { id: "root" })).toEqual({ ok: true });
    await until(pipe, subscriptionId, (events) => liveOf(replicate(events)).runFailure?.reason === "aborted");
    const view = replicate(eventsOf(pipe, subscriptionId));
    expect(liveOf(view).run).toBeUndefined();
    // SubmissionId 是 pi-durable 擦除后的整数 brand；服务把它当作普通数字返回。
    const submissionId = submitted.submissionId as Parameters<typeof service.harness.submission>[0];
    const submission = await service.harness.submission(submissionId, ctx);
    expect((await submission!.status(ctx)).status).toBe("unanswered");
  });

  test("a subscription ends when the service stops", async () => {
    const { pipe, service } = await start();
    const subscriptionId = await subscribe(pipe, "root");
    await until(pipe, subscriptionId, (events) => events.length >= 1);
    const reply = pipe.client.request("conversation.abort", { id: "root" });
    await reply;
    await service.stop();
    await until(pipe, subscriptionId, (events) => events.some((event) => event.event === "end"));
    const events = eventsOf(pipe, subscriptionId);
    const last = events.at(-1);
    if (last === undefined || last.event !== "end") throw new Error("最后一条事件必须是 end");
    expect(["stopped", "ended"]).toContain(last.kind);
    // 快照之后只有这一条 end：没有内容变化时不会凭空产生 ops。
    expect(events.filter((event) => event.event === "ops")).toEqual([]);
  });

  test("list and create conversations", async () => {
    const { pipe, service } = await start();
    await pipe.client.request("conversation.submit", { id: "root", requestId: "list", text: "hi" });
    await (await service.harness.root(ctx)).waitForIdle(ctx);
    const { id } = await pipe.client.request<{ id: number }>("conversation.create");
    expect(id).toBeGreaterThan(1);

    const list = await pipe.client.request<ConversationListResponse>("conversation.list");
    expect(list.conversations.map((conversation) => conversation.id)).toEqual([id, 1]);
    const [fresh, root] = list.conversations;
    expect(fresh).toEqual({ id, root: false, lastEntryId: null, updatedAt: null });
    expect(root!.root).toBe(true);
    expect(root!.lastEntryId).toBeGreaterThan(0);
    expect(root!.updatedAt).toBeGreaterThan(Date.now() - 60_000);

    const subscriptionId = await subscribe(pipe, String(id));
    await until(pipe, subscriptionId, (events) => events.length >= 1);
    expect(Number(firstSnapshot(eventsOf(pipe, subscriptionId)).view.conversation.id)).toBe(id);
  });
});
