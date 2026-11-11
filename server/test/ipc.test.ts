import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.ts";
import type { ConversationEvent } from "../src/conversations/service.ts";
import { INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR, type RpcRecord } from "../src/ipc/errors.ts";
import { JsonLinesDecoder, JsonlWriter } from "../src/ipc/framing.ts";
import type { Service } from "../src/service.ts";
import { startService } from "../src/service.ts";
import { connectToService, type ServicePipe } from "./support/pipe.ts";
import { memoryServer } from "./support/rpc.ts";
import { stubProvider } from "./support/stub-models.ts";
import { startStub, type Stub } from "./support/stub-openai.ts";

describe("JSONL 分帧", () => {
  test("粘包：一个 chunk 里的多条记录逐条切出", () => {
    const decoder = new JsonLinesDecoder();
    const records = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const chunk = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    expect(decoder.push(chunk)).toEqual(records.map((record) => JSON.stringify(record)));
    expect(decoder.pendingLength).toBe(0);
  });

  test("半包：记录跨 chunk，多字节字符被拼回来", () => {
    const decoder = new JsonLinesDecoder();
    const record = JSON.stringify({ method: "echo", params: { text: "数据流" } });
    const bytes = new TextEncoder().encode(`${record}\n`);
    const lines: string[] = [];
    // 一个字节一个 chunk：UTF-8 的多字节字符与记录边界都被拆开。
    for (const byte of bytes) lines.push(...decoder.push(new Uint8Array([byte])));
    expect(lines).toEqual([record]);
  });

  test("U+2028/U+2029 出现在字符串里时不切开记录", () => {
    const decoder = new JsonLinesDecoder();
    const record = JSON.stringify({ method: "echo", params: { text: "行分隔符\u2028与\u2029" } });
    expect(record).toContain("\u2028");
    expect(decoder.push(`${record}\n${JSON.stringify({ second: true })}\n`)).toEqual([record, JSON.stringify({ second: true })]);
  });

  test("写入串行排队，前一条写完才写下一条", async () => {
    const written: string[] = [];
    const gate = Promise.withResolvers<void>();
    let blocked = true;
    const writer = new JsonlWriter(async (line) => {
      if (blocked) {
        blocked = false;
        await gate.promise;
      }
      written.push(line);
    });
    const first = writer.send({ n: 1 });
    const second = writer.send({ n: 2 });
    // 第一条被挡住时，第二条不会抢在前面写出去。
    expect(written).toEqual([]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(written).toEqual(['{"n":1}', '{"n":2}']);
  });
});

describe("请求分发", () => {
  test("非法 JSON 得到 -32700，后续记录照常处理", async () => {
    const memory = memoryServer({ ping: () => "pong" });
    await memory.line("not json");
    expect(memory.records).toHaveLength(1);
    expect(memory.records[0]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR } });
    expect(await memory.call("ping")).toEqual({ result: "pong" });
  });

  test("未知方法是 -32601，参数不是对象是 -32602", async () => {
    const memory = memoryServer({ ping: () => "pong" });
    expect((await memory.call("nope")).error?.code).toBe(METHOD_NOT_FOUND);
    await memory.line(JSON.stringify({ jsonrpc: "2.0", id: "array", method: "ping", params: ["not", "an", "object"] }));
    expect(memory.records.at(-1)?.error).toMatchObject({ code: INVALID_PARAMS, data: { kind: "invalid_input" } });
    expect((await memory.call("ping")).result).toBe("pong");

    await memory.line(JSON.stringify({ jsonrpc: "2.0", method: "nope" }));
    expect(memory.records).toHaveLength(3); // 通知不应答
  });

  test("并发请求乱序返回，按 id 配对", async () => {
    const gate = Promise.withResolvers<void>();
    const memory = memoryServer({
      slow: async () => {
        await gate.promise;
        return "slow";
      },
      fast: () => "fast",
    });
    const slow = memory.server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "slow" }));
    const fast = memory.server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: "fast", method: "fast" }));
    await fast;
    expect(memory.records.map((record: RpcRecord) => record.id)).toEqual(["fast"]);
    gate.resolve();
    await slow;
    expect(memory.records.map((record: RpcRecord) => record.id)).toEqual(["fast", "slow"]);
    expect(memory.records[0]!.result).toBe("fast");
    expect(memory.records[1]!.result).toBe("slow");
  });
});

describe("订阅通知", () => {
  const running: { service: Service; stub: Stub; pipe: ServicePipe; dir: string }[] = [];

  afterEach(async () => {
    for (const { service, stub, pipe, dir } of running.splice(0)) {
      await service.stop();
      stub.stop();
      pipe.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function start(): Promise<{ service: Service; pipe: ServicePipe }> {
    const dir = mkdtempSync(join(tmpdir(), "dw-ipc-test-"));
    const stub = startStub({ chunkDelayMs: 1 });
    const service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
    await service.modelService.putProvider(stubProvider(stub.url));
    const pipe = connectToService(service);
    running.push({ service, stub, pipe, dir });
    return { service, pipe };
  }

  function eventsOf(pipe: ServicePipe, subscriptionId: number): ConversationEvent[] {
    return pipe.client.notifications
      .filter((notification) => notification.method === "conversation.event")
      .map((notification) => notification.params as ConversationEvent)
      .filter((event) => event.subscriptionId === subscriptionId);
  }

  const maxSeq = (events: ConversationEvent[]): number =>
    events.reduce((max, event) => (event.event === "ops" ? Math.max(max, event.seq) : max), 0);

  test("订阅先给 snapshot，再给递增的 ops；退订后不再推送", async () => {
    const { service, pipe } = await start();
    const { subscriptionId } = await pipe.client.request<{ subscriptionId: number }>("conversation.subscribe", { id: "root" });

    await pipe.client.until(() => eventsOf(pipe, subscriptionId).length >= 1);
    const first = eventsOf(pipe, subscriptionId)[0];
    if (first === undefined || first.event !== "snapshot") throw new Error("第一条事件必须是 snapshot");
    expect(first.seq).toBe(0);

    await pipe.client.request("conversation.submit", { id: "root", requestId: "ipc-1", text: "hello" });
    await pipe.client.until(() => maxSeq(eventsOf(pipe, subscriptionId)) >= 2);
    const seqs = eventsOf(pipe, subscriptionId).flatMap((event) => (event.event === "ops" ? [event.seq] : []));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));

    expect(await pipe.client.request("conversation.unsubscribe", { subscriptionId })).toEqual({ ok: true });
    const seen = maxSeq(eventsOf(pipe, subscriptionId));
    // 退订之后同一订阅不会再有事件（包括 end）。
    await (await service.harness.root(BACKGROUND_CONTEXT)).waitForIdle(BACKGROUND_CONTEXT);
    await pipe.client.request("conversation.submit", { id: "root", requestId: "ipc-2", text: "again" });
    await (await service.harness.root(BACKGROUND_CONTEXT)).waitForIdle(BACKGROUND_CONTEXT);
    expect(maxSeq(eventsOf(pipe, subscriptionId))).toBe(seen);
    expect(eventsOf(pipe, subscriptionId).some((event) => event.event === "end")).toBe(false);
  }, 30_000);

  test("服务停止时先给每个订阅发 end", async () => {
    const { service, pipe } = await start();
    const { subscriptionId } = await pipe.client.request<{ subscriptionId: number }>("conversation.subscribe", { id: "root" });
    await pipe.client.until(() => eventsOf(pipe, subscriptionId).length >= 1);

    await service.stop();
    await pipe.client.until(() => eventsOf(pipe, subscriptionId).some((event) => event.event === "end"));
    const end = eventsOf(pipe, subscriptionId).at(-1);
    if (end === undefined || end.event !== "end") throw new Error("最后一条事件必须是 end");
    expect(["stopped", "ended"]).toContain(end.kind);
  }, 30_000);
});
