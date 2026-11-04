/**
 * MCP 客户端：按传输建立连接、列工具、调用工具、超时与重连。
 *
 * 行为基准是 `agent/mcp_manager.py`：
 * - 传输只有 `stdio` 与 `sse`（旧实现没有 streamable-http）；未知传输报 `未知 transport: …`。
 * - 状态机 `disconnected / connecting / connected / error`，重连最多 3 次、1s 起指数退避。
 * - 失败文案由 `formatMcpError` 统一（`[MCP ERROR] server=… tool=…`）。
 *
 * 与旧实现的两处有意差异：
 * 1. **并发**：旧 `StdioTransport.send_request` 用一把锁把整个服务器串行化，一个慢工具会堵住所有调用。
 *    这里按 JSON-RPC id 分发响应，同一服务器的多个 `tools/call` 可以同时在飞；只有 initialize 是一次性的。
 * 2. **空闲关闭**：旧实现没有空闲语义，进程会一直挂着。这里在最后一次调用结束后计时，空闲超时就关闭传输
 *    （下次 `ensureConnected` 再按需拉起），与「连接按需建立」配套。
 *
 * 另外，JSON-RPC 的 `error` 响应不再触发重连重试（旧实现把所有 RuntimeError 当传输故障，会重复执行有副作用的工具）。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { basename, extname } from "node:path";
import { type McpServerConfig, STDIO_ALLOWED_COMMANDS } from "./config.ts";
import { formatMcpError, validateMcpArgs } from "./tools.ts";

export type McpClientStatus = "disconnected" | "connecting" | "connected" | "error";

/** `tools/list` 里的单条工具定义；形状对齐 MCP 规范，字段先宽松读入再在 tools.ts 里规范化。 */
export type McpToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type McpCallOutcome = {
  /** 给模型的文本；失败时是旧实现的 `[MCP ERROR]` 整段文案。 */
  readonly text: string;
  readonly failed: boolean;
};

export type McpClientOptions = {
  /** 单次 JSON-RPC 请求超时（旧 stdio `send_request(timeout=30)`）。 */
  readonly requestTimeoutMs?: number;
  /** 单次工具调用超时（旧 `_submit(conn.call_tool(...), timeout=60)`）。 */
  readonly callTimeoutMs?: number;
  /** 建连 + initialize + tools/list 的总超时（旧 `connect_server` 的 180s）。 */
  readonly connectTimeoutMs?: number;
  /** 空闲多久关闭传输；`0` 表示不关（旧实现行为）。默认 5 分钟。 */
  readonly idleTimeoutMs?: number;
  /** 旧 `_MAX_RECONNECT_ATTEMPTS`。 */
  readonly reconnectAttempts?: number;
  /** 旧 `_RECONNECT_BASE_WAIT`；测试可设为 1ms。 */
  readonly reconnectBaseDelayMs?: number;
  /**
   * stdio 命令白名单。默认是旧实现的 `STDIO_ALLOWED_COMMANDS`；测试注入 Bun 运行时作为可执行文件，
   * 生产路径不传，行为与旧实现一致。
   */
  readonly allowedStdioCommands?: ReadonlySet<string>;
  readonly onLog?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
};

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  callTimeoutMs: 60_000,
  connectTimeoutMs: 180_000,
  idleTimeoutMs: 5 * 60_000,
  reconnectAttempts: 3,
  reconnectBaseDelayMs: 1_000,
} as const;

/** initialize 的参数沿用旧实现（服务端可能按 clientInfo 记录来源）。 */
const CLIENT_INFO = { name: "business-analytics-agent", version: "1.0" } as const;
const PROTOCOL_VERSION = "2024-11-05";

/** JSON-RPC `error` 响应：是工具级失败，不是传输故障。 */
export class McpRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRpcError";
  }
}

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type JsonRpcId = number;

interface McpTransport {
  connect(): Promise<void>;
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
  onClose(handler: (error: Error) => void): () => void;
}

function log(options: McpClientOptions, level: "debug" | "info" | "warn" | "error", message: string): void {
  options.onLog?.(level, message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 旧 `_build_stdio_argv`：Windows 的 .cmd/.bat shim 必须经 cmd.exe 启动。 */
function stdioArgv(command: string, args: readonly string[]): string[] {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return [process.env.ComSpec ?? "cmd.exe", "/c", command, ...args];
  }
  return [command, ...args];
}

/** JSON-RPC 的 `error` 字段转文本：优先 `message`，否则原样序列化。 */
function rpcErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

class StdioTransport implements McpTransport {
  private proc: ChildProcess | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 0;
  private buffer = "";
  private stderrTail = "";
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private closed = false;
  private spawnFailure: Error | undefined;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpClientOptions,
  ) {}

  async connect(): Promise<void> {
    const allowed = this.options.allowedStdioCommands ?? STDIO_ALLOWED_COMMANDS;
    const stem = extname(this.config.command) === ""
      ? basename(this.config.command)
      : basename(this.config.command, extname(this.config.command));
    if (!allowed.has(stem)) throw new Error(`命令 '${this.config.command}' 不在白名单中`);
    const argv = stdioArgv(this.config.command, this.config.args);
    const proc = spawn(argv[0]!, argv.slice(1), {
      // 旧实现：os.environ 打底、配置覆盖。
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.consume(chunk));
    // 子进程已退出时写 stdin 会抛 EPIPE；不挂监听会让未处理的 'error' 事件直接结束整个服务。
    proc.stdin?.on("error", () => this.failAll(new Error("MCP stdio process closed stdout")));
    proc.stderr?.on("data", (chunk: string) => {
      // 只留最后 2KB 作为报错上下文：MCP 服务器的 stderr 可能很吵。
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2048);
    });
    proc.on("error", (error: Error) => {
      this.spawnFailure = new Error(
        `无法启动命令 '${this.config.command}': ${error.message}. `
        + "请确认已安装对应运行时（如 Node.js / Python），或在配置中填写可执行文件的完整路径。",
      );
      this.failAll(this.spawnFailure);
    });
    const started = Promise.withResolvers<void>();
    proc.once("spawn", () => started.resolve());
    proc.once("error", () => started.resolve());
    proc.on("close", () => this.failAll(new Error("MCP stdio process closed stdout")));
    await started.promise;
    if (this.spawnFailure !== undefined) throw this.spawnFailure;
    if (this.closed) throw new Error("MCP stdio process closed stdout");
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs);
    await this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const stdin = this.proc?.stdin;
    if (stdin === null || stdin === undefined || this.closed) {
      return Promise.reject(new Error("MCP stdio process closed stdout"));
    }
    const id = ++this.nextId;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`MCP 请求超时（${timeoutMs}ms）: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { resolve, reject, timer });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    const stdin = this.proc?.stdin;
    if (stdin === null || stdin === undefined || this.closed) throw new Error("MCP stdio process closed stdout");
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP stdio process closed stdout"));
    const proc = this.proc;
    this.proc = undefined;
    if (proc === undefined) return;
    // 进程已经退出了：`close` 事件不会再发，直接收尾，避免每次失败都等满 5 秒。
    if (proc.exitCode !== null || proc.signalCode !== null) {
      proc.stdin?.end();
      return;
    }
    const ended = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      ended.resolve();
    }, 5_000);
    timer.unref?.();
    proc.once("close", () => {
      clearTimeout(timer);
      ended.resolve();
    });
    proc.stdin?.end();
    await ended.promise;
  }

  /** 按行解析 stdout；通知（无 id）直接丢弃，与旧实现一致。 */
  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        log(this.options, "warn", `[mcp:${this.config.server_id}] stdout 不是 JSON，已忽略: ${text.slice(0, 200)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: unknown): void {
    if (typeof message !== "object" || message === null || !("id" in message)) return;
    const pending = this.pending.get(Number(message.id));
    if (pending === undefined) return;
    this.pending.delete(Number(message.id));
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(new McpRpcError(rpcErrorMessage(message.error)));
      return;
    }
    pending.resolve("result" in message ? message.result : undefined);
  }

  private failAll(error: Error): void {
    const reason = this.stderrTail.trim() === "" ? error : new Error(`${error.message}\n${this.stderrTail.trim()}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(reason);
  }
}

/**
 * 旧 `SSETransport`：GET 流里等 `endpoint` 事件，之后所有请求 POST 到该地址。
 * 流在后台继续排空（服务端可能推送通知，旧实现同样不处理）。
 */
class SseTransport implements McpTransport {
  private endpoint = "";
  private nextId = 0;
  private controller: AbortController | undefined;
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private closed = false;

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: McpClientOptions,
  ) {}

  async connect(): Promise<void> {
    this.controller = new AbortController();
    let response: Response;
    try {
      response = await fetch(this.config.url, {
        headers: { accept: "text/event-stream", ...this.config.headers },
        signal: this.controller.signal,
      });
    } catch (error) {
      throw new Error(`SSE 连接失败: ${errorText(error)}`);
    }
    if (!response.ok) throw new Error(`SSE 连接失败: HTTP ${response.status}`);
    this.endpoint = new URL(await this.readEndpoint(response), this.config.url).toString();
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs);
    await this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed || this.endpoint === "") return Promise.reject(new Error("SSE 连接失败: endpoint 未就绪"));
    const id = ++this.nextId;
    return this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs).then((data) => {
      if (typeof data === "object" && data !== null && "error" in data) {
        throw new McpRpcError(rpcErrorMessage(data.error));
      }
      return typeof data === "object" && data !== null && "result" in data ? data.result : undefined;
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed || this.endpoint === "") throw new Error("SSE 连接失败: endpoint 未就绪");
    await this.post({ jsonrpc: "2.0", method, params }, this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs);
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    this.controller = undefined;
    for (const handler of this.closeHandlers) handler(new Error("MCP SSE 连接已关闭"));
  }

  private async post(body: unknown, timeoutMs: number): Promise<unknown> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.config.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return response.json();
  }

  /** 读事件流直到 `endpoint`；找到后让剩余事件在后台排空。 */
  private async readEndpoint(response: Response): Promise<string> {
    if (response.body === null) throw new Error("SSE 连接失败: 响应没有 body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const endpointOf = (payload: string): string | undefined => {
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (typeof parsed === "object" && parsed !== null && "endpoint" in parsed && typeof parsed.endpoint === "string") {
          return parsed.endpoint;
        }
      } catch {
        // 有些服务器直接发纯 URL 字符串。
        if (payload.startsWith("http") || payload.startsWith("/")) return payload;
      }
      return undefined;
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const endpoint = endpointOf(line.slice(5).trim());
          if (endpoint !== undefined) {
            void drain(reader);
            return endpoint;
          }
        }
      }
    } catch (error) {
      throw new Error(`SSE 连接失败: ${errorText(error)}`);
    }
    throw new Error("SSE 连接失败: 未收到 endpoint 事件");
  }
}

/** 后台排空 SSE 流；推送通知旧实现也不处理。 */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // 继续读，避免服务端因背压断开。
    }
  } catch {
    // 流被取消或网络断开：连接状态由下一次请求的错误体现。
  }
}

/** 解析 `tools/list` 的结果；名字重复时保留第一条（旧实现的排序/选择按名字去重）。 */
function parseTools(result: unknown): McpToolDef[] {
  if (typeof result !== "object" || result === null || !("tools" in result)) return [];
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];
  const seen = new Set<string>();
  const parsed: McpToolDef[] = [];
  for (const item of tools) {
    if (typeof item !== "object" || item === null) continue;
    const name = "name" in item && typeof item.name === "string" ? item.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const description = "description" in item && typeof item.description === "string" ? item.description : "";
    const schema = "inputSchema" in item && typeof item.inputSchema === "object" && item.inputSchema !== null && !Array.isArray(item.inputSchema)
      ? item.inputSchema
      : {};
    parsed.push({ name, description, inputSchema: schema as Readonly<Record<string, unknown>> });
  }
  return parsed;
}

/** `tools/call` 结果整形：旧实现只取 text 块，多个用换行拼接。 */
function renderCallResult(result: unknown): { text: string; failed: boolean } {
  if (typeof result !== "object" || result === null) return { text: String(result), failed: false };
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const texts = content.flatMap((item) =>
    typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
      ? [item.text]
      : []);
  const isError = "isError" in result && result.isError === true;
  if (isError) return { text: texts.join(" ") || "工具返回错误", failed: true };
  if (texts.length > 0) return { text: texts.join("\n"), failed: false };
  return { text: JSON.stringify(result), failed: false };
}

/** 单台 MCP 服务器的连接与调用。并发调用共用一个传输，但不互相排队。 */
export class McpServerClient {
  status: McpClientStatus = "disconnected";
  lastError = "";
  private transport: McpTransport | undefined;
  private connecting: Promise<boolean> | undefined;
  private reconnecting: Promise<boolean> | undefined;
  private toolsCache: McpToolDef[] = [];
  private reconnectCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private activeCalls = 0;
  private closing = false;

  constructor(
    readonly config: McpServerConfig,
    private readonly options: McpClientOptions = {},
  ) {}

  get serverId(): string {
    return this.config.server_id;
  }

  /** 已列出的工具（连接断开后保留上次快照，供注册与参数校验使用）。 */
  get tools(): readonly McpToolDef[] {
    return this.toolsCache;
  }

  /** 显式连接：重置重连计数（旧 `connect_server` 的行为）。 */
  async connectNow(): Promise<boolean> {
    this.reconnectCount = 0;
    return this.connect();
  }

  async connect(): Promise<boolean> {
    if (this.status === "connected" && this.transport !== undefined) return true;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = this.doConnect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** 需要时重连（调用路径），最多 `reconnectAttempts` 次。 */
  async ensureConnected(): Promise<boolean> {
    if (this.status === "connected" && this.transport !== undefined) return true;
    return this.reconnect();
  }

  async callTool(rawName: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const fail = (reason: string): McpCallOutcome => ({ text: formatMcpError(this.serverId, rawName, reason), failed: true });
    if (!(await this.ensureConnected())) return fail(`服务器未连接且重连失败: ${this.lastError}`);

    const tool = this.toolsCache.find((item) => item.name === rawName);
    const validation = validateMcpArgs(tool?.inputSchema ?? {}, args);
    if (!validation.ok) return fail(`参数校验失败: ${validation.error}`);

    this.activeCalls += 1;
    try {
      try {
        const result = await this.transport!.request("tools/call", { name: rawName, arguments: args }, this.options.callTimeoutMs ?? DEFAULTS.callTimeoutMs);
        const rendered = renderCallResult(result);
        return rendered.failed ? { text: formatMcpError(this.serverId, rawName, rendered.text), failed: true } : rendered;
      } catch (error) {
        // JSON-RPC error 是服务器对这次调用的回答，重试只会重复副作用。
        if (error instanceof McpRpcError) return fail(error.message);
        this.dropTransport(error);
        if (!(await this.reconnect())) return fail(`调用时连接断开且重连失败: ${this.lastError}`);
        try {
          const retried = await this.transport!.request("tools/call", { name: rawName, arguments: args }, this.options.callTimeoutMs ?? DEFAULTS.callTimeoutMs);
          const rendered = renderCallResult(retried);
          return rendered.failed ? { text: formatMcpError(this.serverId, rawName, rendered.text), failed: true } : rendered;
        } catch (retryError) {
          return fail(`重连后重试仍失败: ${errorText(retryError)}`);
        }
      }
    } finally {
      this.activeCalls -= 1;
      if (this.activeCalls === 0) this.scheduleIdle();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearIdle();
    const transport = this.transport;
    this.transport = undefined;
    this.status = "disconnected";
    await transport?.close().catch(() => undefined);
  }

  private async doConnect(): Promise<boolean> {
    if (this.closing) return false;
    this.status = "connecting";
    this.lastError = "";
    const transport = this.buildTransport();
    try {
      await withTimeout(transport.connect(), this.options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs, `连接 ${this.serverId} 超时`);
      const result = await transport.request("tools/list", {}, this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs);
      this.toolsCache = parseTools(result);
      this.transport = transport;
      transport.onClose((error) => {
        if (this.transport === transport) this.dropTransport(error);
      });
      this.status = "connected";
      this.reconnectCount = 0;
      this.scheduleIdle();
      log(this.options, "info", `[mcp] ${this.serverId} connected, ${this.toolsCache.length} tools`);
      return true;
    } catch (error) {
      this.status = "error";
      this.lastError = errorText(error);
      await transport.close().catch(() => undefined);
      log(this.options, "error", `[mcp] ${this.serverId} connect failed: ${this.lastError}`);
      return false;
    }
  }

  private buildTransport(): McpTransport {
    if (this.config.transport === "stdio") return new StdioTransport(this.config, this.options);
    if (this.config.transport === "sse") return new SseTransport(this.config, this.options);
    // 类型上不可达，保留旧实现的文案，方便以后加传输时忘了改这里。
    throw new Error(`未知 transport: ${String(this.config.transport)}`);
  }

  private reconnect(): Promise<boolean> {
    // 并发的工具调用同时发现断线时，只发起一次重连。
    this.reconnecting ??= this.doReconnect().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  private async doReconnect(): Promise<boolean> {
    const limit = this.options.reconnectAttempts ?? DEFAULTS.reconnectAttempts;
    if (this.reconnectCount >= limit) {
      log(this.options, "warn", `[mcp] ${this.serverId} max reconnect attempts (${limit}) reached, giving up`);
      return false;
    }
    const wait = (this.options.reconnectBaseDelayMs ?? DEFAULTS.reconnectBaseDelayMs) * 2 ** this.reconnectCount;
    this.reconnectCount += 1;
    if (wait > 0) {
      const slept = Promise.withResolvers<void>();
      setTimeout(slept.resolve, wait);
      await slept.promise;
    }
    const stale = this.transport;
    this.transport = undefined;
    this.status = "disconnected";
    await stale?.close().catch(() => undefined);
    return this.connect();
  }

  /** 传输坏了：先拆掉旧传输，等下一次调用重连。 */
  private dropTransport(error: unknown): void {
    this.lastError = errorText(error);
    this.status = "error";
    const stale = this.transport;
    this.transport = undefined;
    void stale?.close().catch(() => undefined);
  }

  private scheduleIdle(): void {
    this.clearIdle();
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
    if (idleTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.activeCalls > 0 || this.status !== "connected") return;
      const transport = this.transport;
      this.transport = undefined;
      this.status = "disconnected";
      this.toolsCache = [];
      log(this.options, "info", `[mcp] ${this.serverId} closed after ${idleTimeoutMs}ms idle`);
      void transport?.close().catch(() => undefined);
    }, idleTimeoutMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timed = Promise.withResolvers<T>();
  const timer = setTimeout(() => timed.reject(new Error(message)), timeoutMs);
  timer.unref?.();
  promise.then(
    (value) => {
      clearTimeout(timer);
      timed.resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      timed.reject(error);
    },
  );
  return timed.promise;
}
