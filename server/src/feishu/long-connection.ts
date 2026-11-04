/**
 * 飞书机器人长连接：维持与飞书的 WSS 连接，收到事件后交给回调。
 *
 * 移植自 `infrastructure/feishu_long_connection.py`，但不再受官方 SDK 的进程级事件循环限制：
 * 旧实现在凭据变化时只能把状态标成 `restart_required`（同进程无法安全替换 SDK 客户端）；
 * 这里的连接是我们自己的对象，`replace()` 可以关掉旧连接再用新凭据连一次，因此不再需要重启应用。
 *
 * 状态机（`status` 的取值）：
 * - `idle`：从未启动。
 * - `starting`：首次握手。
 * - `connected`：已连上，正在心跳。
 * - `reconnecting`：连接结束，按 ClientConfig 的退避参数重试。
 * - `error`：凭据/权限被拒，或重连次数用尽；`error` 是短代码（不含响应体与凭据）。
 * - `paused`：没有可用的长连接（未启用、Webhook 入站或凭据未配置）。
 *
 * 心跳与重连参数来自握手响应（`ClientConfig`）：`PingInterval`/`ReconnectInterval`/`ReconnectNonce`
 * 的单位是秒（与官方 SDK 的 `asyncio.sleep` 一致），允许小数以便测试压缩时间。
 */

import {
  decodeFrame,
  encodeFrame,
  type Frame,
  FRAME_CONTROL,
  FRAME_DATA,
  HEADER_BIZ_RT,
  HEADER_MESSAGE_ID,
  HEADER_SEQ,
  HEADER_SUM,
  HEADER_TYPE,
  headerValue,
  MESSAGE_TYPE,
} from "./frame.ts";
import {
  DEFAULT_CLIENT_CONFIG,
  FeishuEndpointError,
  type FeishuClientConfig,
  type FeishuCredentials,
  type FeishuSocket,
  type FeishuTransport,
} from "./transport.ts";

export type FeishuConnectionStatus = "idle" | "starting" | "connected" | "reconnecting" | "error" | "paused";

export type FeishuConnectionState = { status: FeishuConnectionStatus; error: string };

export type FeishuConnectionDeps = {
  readonly transport: FeishuTransport;
  /** 当前要连接的凭据；返回 undefined 表示没有可用凭据（状态转 `paused`）。 */
  credentials(): Promise<FeishuCredentials | undefined>;
  /** 收到一条事件（payload 原文，UTF-8 JSON 字符串）。 */
  onEvent(payload: string): void;
  onState?(state: FeishuConnectionState): void;
  /** 可注入的计时器与随机数，便于测试压缩退避时间。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly log?: (message: string, error?: unknown) => void;
};

/** 帧缓存 5 秒（官方 SDK 的 `ExpiringCache(..., 5)` 同值）。 */
const COMBINE_TTL_MS = 5_000;

export class FeishuLongConnection {
  private state: FeishuConnectionState = { status: "idle", error: "" };
  private socket: FeishuSocket | undefined;
  private config: FeishuClientConfig = DEFAULT_CLIENT_CONFIG;
  /** 握手 URL 里的 `service_id`，心跳帧与回执帧都要带上。 */
  private serviceId = 0;
  private running: Promise<void> | undefined;
  private stopped = false;
  private pingHandle: unknown;
  /** 分片合包：`message_id` → 按 seq 排列的片段。 */
  private readonly chunks = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>();
  /** 正在关闭的 socket 的结束回调，`stop()` 用它解除等待。 */
  private notifyClosed: (() => void) | undefined;
  private wakeSleep: (() => void) | undefined;

  constructor(private readonly deps: FeishuConnectionDeps) {}

  status(): FeishuConnectionState {
    return { ...this.state };
  }

  /** 启动连接；已在运行时直接返回（换凭据走 `replace()`）。返回是否接受了这次启动。 */
  async start(): Promise<boolean> {
    if (this.running !== undefined) return true;
    const credentials = await this.resolveCredentials();
    if (credentials === undefined) {
      this.setState({ status: "paused", error: "" });
      return false;
    }
    this.stopped = false;
    this.running = this.loop(credentials).finally(() => {
      this.running = undefined;
    });
    return true;
  }

  /** 关掉当前连接并等待循环退出；之后可以再 `start()`。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeSleep?.();
    this.stopPing();
    const socket = this.socket;
    this.socket = undefined;
    this.notifyClosed?.();
    socket?.close();
    const running = this.running;
    if (running !== undefined) await running;
    if (this.state.status !== "paused") this.setState({ status: "idle", error: "" });
  }

  /** 凭据变化后重启：先停旧连接，再用新凭据连一次。 */
  async replace(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  private async resolveCredentials(): Promise<FeishuCredentials | undefined> {
    try {
      return await this.deps.credentials();
    } catch (error) {
      this.deps.log?.("[feishu] 读取凭据失败", error);
      return undefined;
    }
  }

  private setState(state: FeishuConnectionState): void {
    this.state = { ...state };
    try {
      this.deps.onState?.({ ...state });
    } catch (error) {
      this.deps.log?.("[feishu] 连接状态订阅者抛错", error);
    }
  }

  private async loop(credentials: FeishuCredentials): Promise<void> {
    this.setState({ status: "starting", error: "" });
    let attempt = 0;
    while (!this.stopped) {
      let endpoint: { url: string; config: FeishuClientConfig };
      try {
        endpoint = await this.deps.transport.endpoint(credentials);
      } catch (error) {
        if (error instanceof FeishuEndpointError && error.fatal) {
          this.setState({ status: "error", error: error.code });
          return;
        }
        const code = error instanceof FeishuEndpointError ? error.code : "handshake_failed";
        this.deps.log?.("[feishu] 端点发现失败", error);
        this.setState({ status: attempt === 0 ? "error" : "reconnecting", error: code });
        if (!(await this.waitBeforeRetry(attempt++))) return;
        continue;
      }
      this.config = endpoint.config;
      this.serviceId = serviceIdOf(endpoint.url);
      const result = await this.runSocket(endpoint.url);
      if (this.stopped) return;
      // 连上过的连接断线后再重连：次数从头计算（与官方 SDK 每次断线都重新走 `_reconnect` 一致）。
      // 握手就没成功的不清零，否则 `ReconnectCount` 永远用不完。
      if (result.opened) attempt = 0;
      this.setState({ status: "reconnecting", error: result.reason });
      if (!(await this.waitBeforeRetry(attempt++))) return;
    }
  }

  /** 连接一次并等到它结束；返回结束原因短代码与这次是否真的连上过。 */
  private runSocket(url: string): Promise<{ reason: string; opened: boolean }> {
    const { promise, resolve } = Promise.withResolvers<{ reason: string; opened: boolean }>();
    let settled = false;
    let opened = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      this.notifyClosed = undefined;
      resolve({ reason, opened });
    };
    // `stop()` 通过它解除等待，否则关闭 socket 的回调可能永远不来。
    this.notifyClosed = () => finish("stopped");
    let socketRef: FeishuSocket | undefined;
    socketRef = this.deps.transport.connect(url, {
      open: () => {
        opened = true;
        if (this.stopped) {
          socketRef?.close();
          return;
        }
        this.socket = socketRef;
        this.setState({ status: "connected", error: "" });
        this.startPing();
      },
      message: (data) => this.handleFrame(data),
      close: (reason) => {
        if (this.socket === socketRef) this.socket = undefined;
        finish(reason);
      },
    });
    if (this.stopped) socketRef.close();
    return promise;
  }

  /** 返回 false 表示应当停止（凭据问题已由 `endpoint` 处理，这里只处理次数与停止）。 */
  private async waitBeforeRetry(attempt: number): Promise<boolean> {
    const config = this.config;
    if (config.reconnectCount >= 0 && attempt >= config.reconnectCount) {
      this.setState({ status: "error", error: "unreachable" });
      return false;
    }
    // 首次重连加随机抖动，避免多实例同时打满飞书；之后按固定间隔。
    const seconds = attempt === 0 ? (this.deps.random ?? Math.random)() * config.reconnectNonce : config.reconnectInterval;
    await this.sleep(seconds * 1_000);
    return !this.stopped;
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep !== undefined) return this.deps.sleep(ms);
    const { promise, resolve } = Promise.withResolvers<void>();
    const handle = setTimeout(() => {
      this.wakeSleep = undefined;
      resolve();
    }, ms);
    this.wakeSleep = () => {
      clearTimeout(handle);
      this.wakeSleep = undefined;
      resolve();
    };
    return promise;
  }

  private startPing(): void {
    this.stopPing();
    const interval = this.config.pingInterval * 1_000;
    const schedule = this.deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const fire = () => {
      if (this.socket === undefined) return;
      try {
        this.socket.send(encodeFrame(pingFrame(this.serviceId)));
      } catch (error) {
        this.deps.log?.("[feishu] 心跳发送失败", error);
      }
      this.pingHandle = schedule(fire, interval);
    };
    this.pingHandle = schedule(fire, interval);
  }

  private stopPing(): void {
    if (this.pingHandle === undefined) return;
    const handle = this.pingHandle;
    this.pingHandle = undefined;
    if (this.deps.clearTimeout !== undefined) this.deps.clearTimeout(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private handleFrame(data: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch (error) {
      this.deps.log?.("[feishu] 丢弃无法解码的帧", error);
      return;
    }
    if (frame.method === FRAME_CONTROL) {
      this.handleControlFrame(frame);
      return;
    }
    if (frame.method !== FRAME_DATA) return;
    const type = headerValue(frame, HEADER_TYPE);
    if (type !== MESSAGE_TYPE.event) return;

    const messageId = headerValue(frame, HEADER_MESSAGE_ID) ?? "";
    const sum = Number(headerValue(frame, HEADER_SUM) ?? "1");
    const seq = Number(headerValue(frame, HEADER_SEQ) ?? "0");
    let payload = frame.payload;
    if (sum > 1) {
      payload = this.combine(messageId, sum, seq, frame.payload);
      if (payload === undefined) return;
    }
    const started = Date.now();
    try {
      if (payload !== undefined) this.deps.onEvent(new TextDecoder().decode(payload));
    } catch (error) {
      this.deps.log?.("[feishu] 事件处理失败", error);
    }
    // 回执：与官方 SDK 一样把事件帧原样发回，payload 换成 {"code":200}，并带上处理耗时。
    const ack = {
      ...frame,
      headers: [...frame.headers, { key: HEADER_BIZ_RT, value: String(Date.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify({ code: 200 })),
    };
    try {
      this.socket?.send(encodeFrame(ack));
    } catch (error) {
      this.deps.log?.("[feishu] 事件回执发送失败", error);
    }
  }

  private handleControlFrame(frame: Frame): void {
    const type = headerValue(frame, HEADER_TYPE);
    if (type !== MESSAGE_TYPE.pong || frame.payload === undefined) return;
    // 服务端可以在会话中下发新的心跳/重连参数。
    try {
      const raw = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
      this.config = { ...this.config, ...readConfigPatch(raw) };
      this.startPing();
    } catch (error) {
      this.deps.log?.("[feishu] 忽略无法解析的 pong 配置", error);
    }
  }

  private combine(messageId: string, sum: number, seq: number, payload: Uint8Array | undefined): Uint8Array | undefined {
    const now = Date.now();
    for (const [key, value] of this.chunks) {
      if (now - value.at > COMBINE_TTL_MS) this.chunks.delete(key);
    }
    let entry = this.chunks.get(messageId);
    if (entry === undefined) {
      entry = { parts: new Array<Uint8Array | undefined>(sum), at: now };
      this.chunks.set(messageId, entry);
    }
    if (seq < 0 || seq >= sum) return undefined;
    entry.parts[seq] = payload;
    entry.at = now;
    let total = 0;
    for (const part of entry.parts) {
      if (part === undefined) return undefined;
      total += part.length;
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const part of entry.parts) {
      combined.set(part!, offset);
      offset += part!.length;
    }
    this.chunks.delete(messageId);
    return combined;
  }
}

/** 握手 URL 的查询参数 `service_id`（官方 SDK 用 `urlparse(...).query[SERVICE_ID]`）。 */
function serviceIdOf(url: string): number {
  try {
    const value = Number(new URL(url).searchParams.get("service_id") ?? "");
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 心跳帧：CONTROL + `type: ping`，service 用握手 URL 里的 `service_id`。 */
export function pingFrame(serviceId: number): Frame {
  return {
    seqId: 0n,
    logId: 0n,
    service: serviceId,
    method: FRAME_CONTROL,
    headers: [{ key: HEADER_TYPE, value: MESSAGE_TYPE.ping }],
    payloadEncoding: "",
    payloadType: "",
    payload: undefined,
    logIdNew: "",
  };
}

function readConfigPatch(raw: Record<string, unknown>): Partial<FeishuClientConfig> {
  const patch: { -readonly [K in keyof FeishuClientConfig]?: number } = {};
  if (typeof raw.PingInterval === "number") patch.pingInterval = raw.PingInterval;
  if (typeof raw.ReconnectInterval === "number") patch.reconnectInterval = raw.ReconnectInterval;
  if (typeof raw.ReconnectNonce === "number") patch.reconnectNonce = raw.ReconnectNonce;
  if (typeof raw.ReconnectCount === "number") patch.reconnectCount = raw.ReconnectCount;
  return patch;
}
