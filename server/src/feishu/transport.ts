/**
 * 飞书长连接的默认传输层：端点发现用 `fetch`，连接用 Bun/浏览器原生的 `WebSocket`。
 *
 * 旧实现用 `lark_oapi.ws.Client`，它是「POST 端点发现 + WSS + protobuf 帧」的封装；这里只替换传输，
 * 协议（端点路径、请求体、ClientConfig 字段、帧格式）与官方 SDK 一致（见 `frame.ts` 与
 * `long-connection.ts`），不新增依赖。
 *
 * 端点发现失败时用 `fatal` 区分「凭据/权限问题（重试也没用）」与「网络问题（可退避重试）」：
 * 官方 SDK 在 514/403 时抛 ClientException 并停止重连，其余抛 ServerException 继续重连。
 */

export type FeishuCredentials = { appId: string; appSecret: string };

/** 端点发现返回的重连/心跳参数（`data.ClientConfig`）。 */
export type FeishuClientConfig = {
  reconnectCount: number;
  reconnectInterval: number;
  reconnectNonce: number;
  pingInterval: number;
};

export const DEFAULT_CLIENT_CONFIG: FeishuClientConfig = {
  // 与官方 SDK 的本地默认值一致；握手成功后由服务端下发覆盖。
  reconnectCount: -1,
  reconnectInterval: 120,
  reconnectNonce: 30,
  pingInterval: 120,
};

export type FeishuSocketHandlers = {
  open(): void;
  message(data: Uint8Array): void;
  /** 连接结束（对端关闭、网络错误或本地 close 都会走到这里）。 */
  close(reason: string): void;
};

export type FeishuSocket = {
  send(data: Uint8Array): void;
  close(): void;
};

export type FeishuTransport = {
  /** `POST /callback/ws/endpoint`。 */
  endpoint(credentials: FeishuCredentials): Promise<{ url: string; config: FeishuClientConfig }>;
  connect(url: string, handlers: FeishuSocketHandlers): FeishuSocket;
};

/** 端点发现的可分类错误：`fatal` 为真时调用方不再重试。 */
export class FeishuEndpointError extends Error {
  constructor(
    message: string,
    readonly fatal: boolean,
    /** 稳定的短代码，写进连接状态（不携带响应体，避免泄露）。 */
    readonly code: string,
  ) {
    super(message);
    this.name = "FeishuEndpointError";
  }
}

const ENDPOINT_PATH = "/callback/ws/endpoint";
/** 与官方 SDK 相同的握手错误码。 */
const AUTH_FAILED = 514;
const FORBIDDEN = 403;

export type TransportOptions = {
  readonly fetch: typeof fetch;
  /** 开放平台根地址（默认 `https://open.feishu.cn`）。 */
  readonly domain: string;
  /** 握手请求的 User-Agent；不含凭据。 */
  readonly userAgent?: string;
  readonly timeoutMs?: number;
};

export function createTransport(options: TransportOptions): FeishuTransport {
  const userAgent = options.userAgent ?? "datawhisper-desktop/1.0";
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async endpoint(credentials) {
      let response: Response;
      try {
        response = await options.fetch(`${options.domain}${ENDPOINT_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", locale: "zh", "User-Agent": userAgent },
          body: JSON.stringify({ AppID: credentials.appId, AppSecret: credentials.appSecret }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new FeishuEndpointError("无法连接飞书开放平台，请检查网络", false, "network");
      }
      if (!response.ok) {
        // 非 200 也可能带 `{"msg": …}`；只取 msg 作为错误码前缀，绝不回显响应体原文之外的字段。
        throw new FeishuEndpointError(`飞书长连接握手返回 HTTP ${response.status}`, false, `http_${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new FeishuEndpointError("飞书长连接握手返回了无效响应", false, "invalid_response");
      }
      const envelope = asObject(body);
      const code = typeof envelope?.code === "number" ? envelope.code : 0;
      if (code !== 0) {
        const fatal = code === AUTH_FAILED || code === FORBIDDEN;
        throw new FeishuEndpointError(
          `飞书长连接握手被拒绝（错误码 ${code}）`,
          fatal,
          fatal ? "auth_failed" : `code_${code}`,
        );
      }
      const data = asObject(envelope?.data);
      const url = typeof data?.URL === "string" ? data.URL : typeof data?.url === "string" ? data.url : "";
      if (url === "") throw new FeishuEndpointError("飞书长连接握手没有返回地址", false, "invalid_response");
      const config = asObject(data?.ClientConfig) ?? asObject(data?.clientConfig) ?? {};
      return { url, config: readClientConfig(config) };
    },

    connect(url, handlers) {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let closed = false;
      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        handlers.close(reason);
      };
      socket.addEventListener("open", () => handlers.open());
      socket.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) handlers.message(new Uint8Array(data));
        else if (data instanceof Uint8Array) handlers.message(data);
      });
      socket.addEventListener("close", (event: CloseEvent) => finish(`closed_${event.code}`));
      socket.addEventListener("error", () => finish("socket_error"));
      return {
        send(data) {
          // 编码出来的帧总是由普通 ArrayBuffer 承载；类型上 `Uint8Array` 可能带 SharedArrayBuffer。
          if (!closed) socket.send(data as Uint8Array<ArrayBuffer>);
        },
        close() {
          finish("closed_local");
          try {
            socket.close();
          } catch {
            // 已经关闭：无需处理。
          }
        },
      };
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** `ClientConfig` 的四个数字；缺项或非数字时沿用默认值。 */
export function readClientConfig(raw: Record<string, unknown>): FeishuClientConfig {
  const number = (key: string, fallback: number): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  return {
    reconnectCount: number("ReconnectCount", DEFAULT_CLIENT_CONFIG.reconnectCount),
    reconnectInterval: number("ReconnectInterval", DEFAULT_CLIENT_CONFIG.reconnectInterval),
    reconnectNonce: number("ReconnectNonce", DEFAULT_CLIENT_CONFIG.reconnectNonce),
    pingInterval: number("PingInterval", DEFAULT_CLIENT_CONFIG.pingInterval),
  };
}
