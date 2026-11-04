/**
 * 飞书机器人：配置、长连接、入站回合、写工具与 IPC 方法。
 *
 * 全部本地化：HTTP/WS 用自写的假飞书服务（`Bun.serve`，同时提供开放平台 REST 与长连接端点），
 * 模型用进程内 stub（`test/support/stub-openai.ts`）。不访问外网，不读用户目录里的真实配置。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import {
  decodeFrame,
  encodeFrame,
  FRAME_CONTROL,
  FRAME_DATA,
  HEADER_MESSAGE_ID,
  HEADER_SEQ,
  HEADER_SUM,
  HEADER_TYPE,
  headerValue,
  type Frame,
} from "../src/feishu/frame.ts";
import { FeishuLongConnection } from "../src/feishu/long-connection.ts";
import { FeishuEndpointError, type FeishuTransport } from "../src/feishu/transport.ts";
import { FeishuWriteLedger, ledgerKey } from "../src/feishu/ledger.ts";
import { FeishuBitableError, parseBitableReference } from "../src/feishu/bitable.ts";
import { splitMarkdown } from "../src/feishu/client.ts";
import { createFeishuTools } from "../src/feishu/tools.ts";
import type { AppTool } from "../src/tools/app/types.ts";
import { feishuService, type FeishuService, type FeishuStatus } from "../src/feishu/service.ts";
import { INVALID_PARAMS, RpcError } from "../src/ipc/errors.ts";
import { type Service, startService } from "../src/service.ts";
import { connectToService, type ServicePipe } from "./support/pipe.ts";
import { stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

const ANSWER = "群聊回答：42";
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Recorded = { method: string; path: string; search: string; body: unknown };

/** 假飞书：开放平台 REST + 长连接端点 + 可推送事件的 WS。 */
type FakeFeishu = {
  readonly apiBase: string;
  readonly domain: string;
  readonly requests: Recorded[];
  readonly socketCount: number;
  pushEvent(envelope: unknown): void;
  closeSockets(): void;
  stop(): void;
};

function startFakeFeishu(options: { chats?: { chat_id: string; name: string }[] } = {}): FakeFeishu {
  const requests: Recorded[] = [];
  const sockets = new Map<number, { send(data: Uint8Array): void; close(): void }>();
  let socketSeq = 0;
  let socketCount = 0;
  let port = 0;

  const server = Bun.serve<{ id: number }>({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(request, { data: { id: (socketSeq += 1) } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      return handleRest(request, url);
    },
    websocket: {
      open(ws) {
        socketCount += 1;
        sockets.set(ws.data.id, ws);
      },
      message() {
        // 客户端发来的 ping/ACK 不需要断言内容；连接与回执的成功由状态变化证明。
      },
      close(ws) {
        sockets.delete(ws.data.id);
      },
    },
  });
  port = server.port ?? 0;
  const apiBase = `http://127.0.0.1:${port}/open-apis`;
  const domain = `http://127.0.0.1:${port}`;

  async function handleRest(request: Request, url: URL): Promise<Response> {
    if (url.pathname === "/callback/ws/endpoint") {
      return Response.json({
        code: 0,
        msg: "ok",
        data: {
          URL: `ws://127.0.0.1:${port}/ws?device_id=dev-1&service_id=7`,
          ClientConfig: { ReconnectCount: -1, ReconnectInterval: 0.02, ReconnectNonce: 0, PingInterval: 0.05 },
        },
      });
    }
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined);
    requests.push({ method: request.method, path: url.pathname, search: url.search, body });

    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      return Response.json({ code: 0, tenant_access_token: "t-test", expire: 7200 });
    }
    if (url.pathname === "/open-apis/im/v1/chats") {
      return Response.json({
        code: 0,
        data: { items: options.chats ?? [{ chat_id: "oc_1", name: "分析群" }], has_more: false },
      });
    }
    if (url.pathname === "/open-apis/im/v1/messages") {
      return Response.json({ code: 0, data: { message_id: "om_1" } });
    }
    if (url.pathname === "/open-apis/drive/explorer/v2/root_folder/meta") {
      return Response.json({ code: 0, data: { token: "fld_root" } });
    }
    if (url.pathname === "/open-apis/bitable/v1/apps" && request.method === "POST") {
      return Response.json({ code: 0, data: { app: { app_token: "bas_1", url: "https://feishu.cn/base/bas_1" } } });
    }
    if (/^\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables$/.test(url.pathname)) {
      if (request.method === "GET") {
        return Response.json({ code: 0, data: { items: [{ table_id: "tbl_1", name: "数据" }], has_more: false } });
      }
      return Response.json({ code: 0, data: { table_id: "tbl_1" } });
    }
    if (/\/records\/batch_create$/.test(url.pathname)) {
      const records = recordList(body);
      return Response.json({
        code: 0,
        data: { records: records.map((_, index) => ({ record_id: `rec_${index + 1}` })) },
      });
    }
    if (/\/records\/[^/]+$/.test(url.pathname) && request.method === "PUT") {
      return Response.json({ code: 0, data: { record: { record_id: "rec_1" } } });
    }
    return Response.json({ code: 99991663, msg: "not found" }, { status: 404 });
  }

  return {
    apiBase,
    domain,
    requests,
    get socketCount() {
      return socketCount;
    },
    pushEvent(envelope) {
      const payload = new TextEncoder().encode(JSON.stringify(envelope));
      const frame: Frame = {
        seqId: 1n,
        logId: 1n,
        service: 7,
        method: FRAME_DATA,
        headers: [
          { key: HEADER_TYPE, value: "event" },
          { key: HEADER_MESSAGE_ID, value: `msg_${socketCount}` },
          { key: HEADER_SUM, value: "1" },
          { key: HEADER_SEQ, value: "0" },
        ],
        payloadEncoding: "",
        payloadType: "",
        payload,
        logIdNew: "",
      };
      const bytes = encodeFrame(frame);
      for (const socket of sockets.values()) socket.send(bytes);
    },
    closeSockets() {
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
    },
    stop() {
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
      server.stop(true);
    },
  };
}

function recordList(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null || !("records" in body)) return [];
  const records = body.records;
  return Array.isArray(records) ? records : [];
}

/** 一条发出消息的 `msg_type` 与 `content`；形状不对时返回 undefined。 */
function messageBody(record: Recorded): { type: string; content: string } | undefined {
  const body = record.body;
  if (typeof body !== "object" || body === null) return undefined;
  if (!("msg_type" in body) || typeof body.msg_type !== "string") return undefined;
  if (!("content" in body) || typeof body.content !== "string") return undefined;
  return { type: body.msg_type, content: body.content };
}

/** 账本里存的结果文本；形状不对时返回 undefined。 */
function storedText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("text" in value)) return undefined;
  return typeof value.text === "string" ? value.text : undefined;
}

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
  const first = result.output?.[0];
  return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
}

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await Bun.sleep(10);
  }
}

async function untilAsync(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await Bun.sleep(10);
  }
}

/** 群 @机器人 文本消息的事件信封。 */
function groupMessage(options: { eventId: string; chatId: string; text: string }): unknown {
  return {
    schema: "2.0",
    header: { event_id: options.eventId, event_type: "im.message.receive_v1", token: "v" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_1" } },
      message: {
        chat_id: options.chatId,
        chat_type: "group",
        message_type: "text",
        mentions: [{ key: "@_user_1", name: "机器人" }],
        content: JSON.stringify({ text: `@_user_1 ${options.text}` }),
      },
    },
  };
}

/** 一次写工具调用的 durable 身份。 */
function callApi(taskId: number, callId: string): ToolExecutionApi {
  return { taskId, callId } as unknown as ToolExecutionApi;
}

describe("飞书长连接的帧编解码", () => {
  test("round-trips a data frame with headers and payload", () => {
    const payload = new TextEncoder().encode(JSON.stringify({ hello: "世界" }));
    const frame: Frame = {
      seqId: 42n,
      logId: 7n,
      service: 3,
      method: FRAME_DATA,
      headers: [
        { key: "type", value: "event" },
        { key: "message_id", value: "m1" },
      ],
      payloadEncoding: "",
      payloadType: "",
      payload,
      logIdNew: "",
    };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.seqId).toBe(42n);
    expect(decoded.logId).toBe(7n);
    expect(decoded.service).toBe(3);
    expect(decoded.method).toBe(FRAME_DATA);
    expect(decoded.headers).toEqual(frame.headers);
    expect(new TextDecoder().decode(decoded.payload)).toBe(JSON.stringify({ hello: "世界" }));
    expect(headerValue(decoded, "message_id")).toBe("m1");
  });

  test("a control frame without payload survives the round trip", () => {
    const decoded = decodeFrame(
      encodeFrame({
        seqId: 0n,
        logId: 0n,
        service: 7,
        method: FRAME_CONTROL,
        headers: [{ key: "type", value: "ping" }],
        payloadEncoding: "",
        payloadType: "",
        payload: undefined,
        logIdNew: "",
      }),
    );
    expect(decoded.method).toBe(FRAME_CONTROL);
    expect(decoded.payload).toBeUndefined();
    expect(decoded.service).toBe(7);
  });
});

describe("飞书长连接状态机", () => {
  test("a fatal handshake failure stops retrying and reports a short code", async () => {
    const transport: FeishuTransport = {
      endpoint: async () => {
        throw new FeishuEndpointError("denied", true, "auth_failed");
      },
      connect: () => ({ send: () => {}, close: () => {} }),
    };
    const connection = new FeishuLongConnection({
      transport,
      credentials: async () => ({ appId: "cli_x", appSecret: "s" }),
      onEvent: () => {},
      sleep: async () => {},
    });
    await connection.start();
    await until(() => connection.status().status === "error");
    expect(connection.status()).toEqual({ status: "error", error: "auth_failed" });
    await connection.stop();
  });

  test("reconnect attempts honour ReconnectCount and the backoff parameters", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const connection = new FeishuLongConnection({
      transport: {
        endpoint: async () => {
          attempts += 1;
          return {
            url: "ws://unused/ws?service_id=1",
            config: { reconnectCount: 2, reconnectInterval: 7, reconnectNonce: 4, pingInterval: 1 },
          };
        },
        connect: (_url, handlers) => {
          // 每次连上立刻断开，模拟对端拒绝。
          queueMicrotask(() => handlers.close("closed_1000"));
          return { send: () => {}, close: () => {} };
        },
      },
      credentials: async () => ({ appId: "cli_x", appSecret: "s" }),
      onEvent: () => {},
      sleep: async (ms) => {
        delays.push(ms);
      },
      random: () => 0.5,
    });
    await connection.start();
    await until(() => connection.status().error === "unreachable");
    // 首次 + 两次重连；用尽后进入 error。
    expect(attempts).toBe(3);
    expect(connection.status()).toEqual({ status: "error", error: "unreachable" });
    // 第一次重连是「抖动」（0.5 × ReconnectNonce 秒），之后按固定间隔。
    expect(delays).toEqual([2_000, 7_000]);
    await connection.stop();
  });
});

describe("飞书机器人与入站回合", () => {
  let dir = "";
  let fake: FakeFeishu;
  let stub: Stub;
  let service: Service;
  let feishu: FeishuService;
  let pipe: ServicePipe;
  let conversationId = 0;

  beforeAll(async () => {
    dir = tempDir("dw-feishu-");
    fake = startFakeFeishu();
    stub = startStub({ chunkDelayMs: 1, answerText: ANSWER });
    service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true, tools: [] });
    await service.modelService.putProvider(stubProvider(stub.url));
    feishu = feishuService({
      dataDir: dir,
      domain: fake.domain,
      apiBase: fake.apiBase,
      forceFileCredentials: true,
      env: {},
    });
    feishu.attachRuntime({ conversations: service.conversations, harness: service.harness, context: service.context });
    conversationId = (await service.conversations.create({})).id;
    pipe = connectToService(service, { dataDir: dir });
  });

  afterAll(async () => {
    await feishu?.stop();
    pipe?.close();
    await service?.stop();
    stub?.stop();
    fake?.stop();
  });

  test("status reports an unconfigured bot without any secret", async () => {
    const status = await feishu.status();
    expect(status.configured).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.inboundStatus).toBe("disabled");
    expect(status.appSecretConfigured).toBe(false);
  });

  test("setConfig validates like the old endpoint", async () => {
    await expect(feishu.setConfig(null)).rejects.toThrow("请求体必须是 JSON 对象");
    await expect(feishu.setConfig({ enabled: "yes" })).rejects.toThrow("enabled 必须是布尔值");
    await expect(feishu.setConfig({ enabled: true, app_id: "" })).rejects.toThrow("请填写有效的飞书 App ID");
    await expect(
      feishu.setConfig({ enabled: true, app_id: "cli_app", receive_id_type: "open_id", receive_id: "" }),
    ).rejects.toThrow("未选择目标群时，接收对象类型必须为 chat_id");
    await expect(
      feishu.setConfig({ enabled: true, app_id: "cli_app", receive_id_type: "room", receive_id: "x" }),
    ).rejects.toThrow("接收对象类型仅支持群聊 chat_id 或用户 open_id");
    await expect(feishu.setConfig({ enabled: true, app_id: "cli_app", inbound_transport: "poll" })).rejects.toThrow(
      "入站方式仅支持长连接或 Webhook",
    );
  });

  test("saving config stores the secret outside the config file and never echoes it", async () => {
    const status = await feishu.setConfig({
      enabled: true,
      app_id: "cli_app_id",
      app_secret: "super-secret-value",
      event_verification_token: "verify-token",
      receive_id: "oc_1",
      receive_id_type: "chat_id",
      inbound_transport: "long_connection",
    });
    expect(status.configured).toBe(true);
    expect(status.appSecretConfigured).toBe(true);
    expect(status.eventVerificationTokenConfigured).toBe(true);
    expect(status.appIdMasked).toBe("…app_id");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("verify-token");

    const stored = readFileSync(join(dir, "feishu-bot.json"), "utf8");
    expect(stored).not.toContain("super-secret-value");
    expect(stored).not.toContain("verify-token");
    expect(JSON.parse(stored).app_secret_ref).toBe("feishu:app-secret");
    const credentialsPath = join(dir, "feishu-credentials.json");
    expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(credentialsPath, "utf8")).toContain("super-secret-value");

    // 空串表示「保持当前密钥」：旧实现同样不允许在这个接口里清除密钥。
    const kept = await feishu.setConfig({ enabled: true, app_id: "cli_app_id", app_secret: "", receive_id: "oc_1" });
    expect(kept.appSecretConfigured).toBe(true);
    expect((await feishu.chats()).map((chat) => chat.chat_id)).toEqual(["oc_1"]);
  });

  test("the long connection connects, answers a group mention and reconnects", async () => {
    await feishu.start();
    await until(() => fake.socketCount >= 1);
    await until(() => fake.requests.some((request) => request.path === "/open-apis/auth/v3/tenant_access_token/internal"));

    const link = await feishu.linkConversation(conversationId, { enabled: true, chat_id: "oc_1" });
    expect(link.connected).toBe(true);
    expect(link.chatName).toBe("分析群");
    expect((await feishu.status(conversationId)).link).toEqual({ chatId: "oc_1", chatName: "分析群" });

    const messages = () => fake.requests.filter((request) => request.path === "/open-apis/im/v1/messages");
    const before = messages().length;
    // 未绑定的群：事件被接收但不触发会话。
    fake.pushEvent(groupMessage({ eventId: "ev-other", chatId: "oc_other", text: "未绑定的群" }));
    fake.pushEvent(groupMessage({ eventId: "ev-1", chatId: "oc_1", text: "分析一下" }));

    await until(() => messages().some((request) => messageBody(request)?.content.includes(ANSWER) === true));
    const markdown = messages()
      .map(messageBody)
      .filter((body) => body?.type === "interactive")
      .at(-1);
    expect(markdown).toBeDefined();
    expect(JSON.parse(markdown!.content).elements[0].content).toBe(`**🤖 智析 Agent**\n${ANSWER}`);
    expect(messages().length).toBe(before + 1);

    // 同一 event_id 重投：不再跑一轮，也不再发消息。用一段安静的观察窗口断言「没有发生」，
    // 因为「什么都没发生」没有可等待的事件（这里必须用真实时间）。
    fake.pushEvent(groupMessage({ eventId: "ev-1", chatId: "oc_1", text: "分析一下" }));
    await Bun.sleep(250);
    expect(messages().length).toBe(before + 1);

    // 对端断开后自动重连。
    fake.closeSockets();
    await until(() => fake.socketCount >= 2);
    await untilAsync(async () => (await feishu.status()).inboundStatus === "connected");
  }, 20_000);

  test("IPC methods expose status, config and the test message", async () => {
    const status = await pipe.client.request<FeishuStatus>("feishu.status", {});
    expect(status.configured).toBe(true);
    expect(status.inboundStatus).toBe("connected");
    expect(JSON.stringify(status)).not.toContain("super-secret-value");

    const invalid = await pipe.client
      .request("feishu.setConfig", { enabled: true, app_id: "" })
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(RpcError);
    expect((invalid as RpcError).code).toBe(INVALID_PARAMS);
    expect((invalid as RpcError).message).toBe("请填写有效的飞书 App ID");

    const tested = await pipe.client.request<{ ok: boolean; message: string }>("feishu.test", {});
    expect(tested).toEqual({ ok: true, message: "测试消息已发送到飞书群。" });
    const text = fake.requests
      .filter((request) => request.path === "/open-apis/im/v1/messages")
      .map(messageBody)
      .filter((body) => body?.type === "text")
      .at(-1);
    expect(JSON.parse(text!.content).text).toBe(
      "智析 Agent 已成功连接飞书应用机器人。后续分析结果将可同步至此群。",
    );

    const missing = await pipe.client
      .request("feishu.linkConversation", { conversationId: 424242, enabled: false })
      .catch((error: unknown) => error);
    expect((missing as RpcError).data?.kind).toBe("not_found");

    // 状态变化会作为 `feishu.status` 通知推给界面（与 `conversation.event` 同一套通知机制）。
    await pipe.client.request("feishu.setConfig", { enabled: false, app_id: "cli_app_id" });
    await until(() =>
      pipe.client.notifications.some(
        (notification) =>
          notification.method === "feishu.status" &&
          (notification.params as FeishuStatus).enabled === false &&
          (notification.params as FeishuStatus).inboundStatus === "disabled",
      ),
    );
    expect((await feishu.status()).inboundStatus).toBe("disabled");
  }, 20_000);
});

describe("飞书多维表格工具", () => {
  let dir = "";
  let fake: FakeFeishu;
  let feishu: FeishuService;
  let tools: Map<string, AppTool>;

  function buildTools(): Map<string, AppTool> {
    const created = createFeishuTools({ connections: () => feishu.connections() });
    return new Map(created.map((tool) => [tool.name, tool]));
  }

  beforeAll(async () => {
    dir = tempDir("dw-feishu-writes-");
    fake = startFakeFeishu();
    feishu = feishuService({ dataDir: dir, domain: fake.domain, apiBase: fake.apiBase, forceFileCredentials: true, env: {} });
    await feishu.setConfig({
      enabled: false,
      app_id: "cli_app_id",
      app_secret: "secret",
      receive_id: "oc_1",
      receive_id_type: "chat_id",
    });
    tools = buildTools();
  });

  afterAll(async () => {
    await feishu?.stop();
    fake?.stop();
  });

  function batchCreates(): Recorded[] {
    return fake.requests.filter((request) => /\/records\/batch_create$/.test(request.path));
  }

  function toolNamed(name: string) {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`missing tool ${name}`);
    return tool;
  }

  async function run(name: string, args: object, api?: ToolExecutionApi) {
    return toolNamed(name).execute(args, api ?? ({} as ToolExecutionApi), BACKGROUND_CONTEXT);
  }

  test("list_feishu_bitable_tables returns the tables with clickable URLs", async () => {
    const result = await run("list_feishu_bitable_tables", { bitable: "https://feishu.cn/base/bas_1" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.app_token).toBe("bas_1");
    expect(parsed.tables).toEqual([
      { table_id: "tbl_1", name: "数据", url: "https://feishu.cn/base/bas_1?table=tbl_1" },
    ]);
  });

  test("the same durable call delivered twice writes once", async () => {
    const before = batchCreates().length;
    const args = { bitable: "bas_1", table_id: "tbl_1", records: [{ 名称: "A", 值: 1 }] };
    const api = callApi(11, "call-append");
    const first = await run("append_feishu_bitable_records", args, api);
    const second = await run("append_feishu_bitable_records", args, api);
    expect(batchCreates().length).toBe(before + 1);
    expect(textOf(second)).toBe(textOf(first));
    expect(JSON.parse(textOf(first))).toMatchObject({
      ok: true,
      message: "分析结果已追加写入飞书多维表格。请把 url 作为可点击链接交付给用户。",
      app_token: "bas_1",
      table_id: "tbl_1",
      url: "https://feishu.cn/base/bas_1?table=tbl_1",
      record_count: 1,
      record_ids: ["rec_1"],
    });
    expect(second.details?.deduplicated).toBe(true);
  });

  test("a different call writes again", async () => {
    const before = batchCreates().length;
    const args = { bitable: "bas_1", table_id: "tbl_1", records: [{ 名称: "A", 值: 1 }] };
    await run("append_feishu_bitable_records", args, callApi(12, "call-append"));
    expect(batchCreates().length).toBe(before + 1);
  });

  test("the ledger survives reopening (a restart keeps deduplicating)", async () => {
    const ledgerFile = join(dir, "feishu-writes.json");
    const key = ledgerKey("append_feishu_bitable_records", { taskId: "7", callId: "c" }, { a: 1 });
    const ledger = await FeishuWriteLedger.open(ledgerFile);
    expect((await ledger.claim(key, "op")).kind).toBe("claimed");
    await ledger.complete(key, "op", { text: "上一轮的结果", details: { tool: "op" } });
    const reopened = await FeishuWriteLedger.open(ledgerFile);
    const claim = await reopened.claim(key, "op");
    expect(claim.kind).toBe("done");
    expect(claim.kind === "done" ? storedText(claim.entry.value) : undefined).toBe("上一轮的结果");
  });

  test("a write interrupted before its result reports an unknown outcome instead of writing twice", async () => {
    const args = { name: "报告", table_name: "明细", fields: ["名称"] };
    // 必须用服务自己那个账本实例：两个实例各自持有快照，会互相覆盖同一个文件。
    const ledger = (await feishu.connections()).ledger;
    // 模拟「进程在写入之间崩溃」：只有占位，没有结果。
    await ledger.claim(ledgerKey("create_feishu_bitable", { taskId: "21", callId: "crashed" }, args), "create_feishu_bitable");
    const before = batchCreates().length;
    const result = await run("create_feishu_bitable", args, callApi(21, "crashed"));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("结果未知");
    expect(batchCreates().length).toBe(before);
  });

  test("create/update keep the old result shape and messages", async () => {
    const created = await run(
      "create_feishu_bitable",
      { name: "季度报告", table_name: "明细", fields: ["名称", "数值"], records: [{ 名称: "A", 数值: 1 }] },
      callApi(31, "call-create"),
    );
    const parsed = JSON.parse(textOf(created));
    expect(parsed).toMatchObject({
      ok: true,
      message: "飞书多维表格已创建。请把 url 作为可点击链接交付给用户。",
      app_token: "bas_1",
      table_id: "tbl_1",
      name: "季度报告",
      table_name: "明细",
      record_count: 1,
      url: "https://feishu.cn/base/bas_1?table=tbl_1",
    });
    const appCreate = fake.requests.find(
      (request) => request.path === "/open-apis/bitable/v1/apps" && request.method === "POST",
    );
    expect(appCreate?.body).toEqual({ name: "季度报告", folder_token: "fld_root" });

    const updated = await run(
      "update_feishu_bitable_record",
      { bitable: "bas_1", table_id: "tbl_1", record_id: "rec_1", fields: { 数值: 2, 名称: "B" } },
      callApi(32, "call-update"),
    );
    expect(JSON.parse(textOf(updated))).toMatchObject({
      ok: true,
      message: "飞书多维表格记录已更新。请把 url 作为可点击链接交付给用户。",
      record_id: "rec_1",
      updated_fields: ["名称", "数值"],
    });
  });

  test("errors keep the old wording", async () => {
    const failure = async (name: string, args: object) => {
      const result = await run(name, args, callApi(41, `call-${name}`));
      expect(result.isError).toBe(true);
      return textOf(result);
    };
    expect(await failure("create_feishu_bitable", { name: "报告", table_name: "明细", fields: [] })).toBe(
      "至少需要一个字段",
    );
    expect(await failure("create_feishu_bitable", { name: "报告", table_name: "明细", fields: ["A", "A"] })).toBe(
      "字段名重复：A",
    );
    expect(
      await failure("append_feishu_bitable_records", {
        bitable: "https://example.com/base/x",
        table_id: "t",
        records: [],
      }),
    ).toBe("只支持飞书多维表格链接");
    expect(await failure("append_feishu_bitable_records", { bitable: "bas_1", table_id: "", records: [] })).toBe(
      "请提供 table_id",
    );
    expect(await failure("append_feishu_bitable_records", { bitable: "bas_1", table_id: "t", records: [] })).toBe(
      "至少需要一条记录",
    );
    expect(
      await failure("update_feishu_bitable_record", { bitable: "bas_1", table_id: "tbl_1", record_id: "", fields: {} }),
    ).toBe("请提供record_id");
    expect(
      await failure("update_feishu_bitable_record", { bitable: "bas_1", table_id: "tbl_1", record_id: "r", fields: {} }),
    ).toBe("fields 必须是非空字段对象");
  });
});

describe("飞书消息发送与链接解析的边界", () => {
  test("splitMarkdown keeps chunks under the card limit and prefers line boundaries", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `第 ${index} 行的内容，长度固定。`).join("\n");
    const chunks = splitMarkdown(lines);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3600);
    expect(chunks.join("\n")).toContain("第 399 行");
  });

  test("parseBitableReference accepts Feishu URLs and rejects other hosts", () => {
    expect(parseBitableReference("https://xxx.feishu.cn/base/bas_9?table=tbl_2")).toEqual({
      appToken: "bas_9",
      tableId: "tbl_2",
    });
    expect(parseBitableReference("bas_9", "tbl_3")).toEqual({ appToken: "bas_9", tableId: "tbl_3" });
    expect(() => parseBitableReference("https://feishu.cn.example.com/base/x")).toThrow(FeishuBitableError);
    expect(() => parseBitableReference("https://feishu.cn/docx/abc")).toThrow("无法从链接中识别多维表格 app_token");
  });
});
