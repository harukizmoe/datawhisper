/**
 * JSON-RPC 2.0 的请求分发（JSONL 分帧见 framing.ts），纪律与 compute/rpc.py 一致：
 * 只应答带 `id` 的请求，通知不应答；方法并发执行、响应可能乱序，客户端按 `id` 关联。
 */
import { INVALID_PARAMS, INVALID_REQUEST, INTERNAL_ERROR, METHOD_NOT_FOUND, PARSE_ERROR, RpcError } from "./errors.ts";
import type { RpcRecord } from "./errors.ts";

export type MethodParams = Record<string, unknown>;
export type RpcMethod = (params: MethodParams) => unknown;
export type RpcId = string | number | null;

/** 把非 `RpcError` 的异常翻译成协议错误；返回 undefined 表示按内部错误处理。 */
export type MapError = (error: unknown) => { code: number; message: string; data?: unknown } | undefined;

export type RpcServerOptions = {
  methods: Record<string, RpcMethod>;
  send: (record: RpcRecord) => Promise<void>;
  /** 方法抛出的业务异常（如 SettingsError）在这里翻译成错误码与 `data.kind`。 */
  mapError?: MapError;
  /** 诊断输出，默认 stderr。 */
  log?: (message: string, error?: unknown) => void;
};

export class RpcServer {
  readonly #methods: Record<string, RpcMethod>;
  readonly #send: (record: RpcRecord) => Promise<void>;
  readonly #mapError: MapError | undefined;
  readonly #log: (message: string, error?: unknown) => void;

  constructor({ methods, send, mapError, log }: RpcServerOptions) {
    this.#methods = methods;
    this.#send = send;
    this.#mapError = mapError;
    this.#log =
      log ??
      ((message, error) => {
        if (error === undefined) console.error(`[ipc] ${message}`);
        else console.error(`[ipc] ${message}`, error);
      });
  }

  /** 主动推送一条通知（服务端 → 客户端）。 */
  notify(method: string, params: unknown): Promise<void> {
    return this.#send({ jsonrpc: "2.0", method, params });
  }

  /** 处理一行原始记录。坏记录只影响它自己：错误以响应返回，读取循环继续。 */
  async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.#log("无法解析的记录", error);
      await this.#sendError(null, PARSE_ERROR, "parse error");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      await this.#sendError(null, INVALID_REQUEST, "invalid request: expected a JSON object");
      return;
    }

    const record = parsed as Record<string, unknown>;
    const hasId = Object.hasOwn(record, "id");
    const rawId = record.id;
    const id: RpcId | undefined = typeof rawId === "string" || typeof rawId === "number" ? rawId : rawId === null ? null : undefined;
    if (hasId && id === undefined) {
      await this.#sendError(null, INVALID_REQUEST, "invalid request: id must be a string, number, or null");
      return;
    }
    if (!hasId && (Object.hasOwn(record, "result") || Object.hasOwn(record, "error"))) {
      // 客户端发来的响应没有意义；忽略而不是回一个错误，避免两个方向互相报错。
      this.#log("忽略了客户端发来的响应记录");
      return;
    }
    if (record.jsonrpc !== undefined && record.jsonrpc !== "2.0") {
      if (id !== undefined) await this.#sendError(id, INVALID_REQUEST, "invalid request: jsonrpc must be \"2.0\"");
      return;
    }

    const method = record.method;
    if (typeof method !== "string") {
      if (id === undefined) {
        this.#log("忽略了没有 method 的通知记录");
        return;
      }
      await this.#sendError(id, INVALID_REQUEST, "invalid request: method must be a string");
      return;
    }

    const rawParams = record.params;
    if (rawParams !== undefined && rawParams !== null && (typeof rawParams !== "object" || Array.isArray(rawParams))) {
      if (id !== undefined) await this.#sendError(id, INVALID_PARAMS, "invalid params: expected an object", { kind: "invalid_input" });
      return;
    }

    const handler = this.#methods[method];
    if (handler === undefined) {
      if (id === undefined) {
        this.#log(`忽略了未知通知：${method}`);
        return;
      }
      await this.#sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
      return;
    }

    let result: unknown;
    try {
      result = await handler((rawParams ?? {}) as MethodParams);
    } catch (error) {
      const mapped = this.#mapError?.(error);
      if (mapped === undefined) this.#log(`方法 ${method} 失败`, error);
      if (id === undefined) return;
      if (mapped !== undefined) await this.#sendError(id, mapped.code, mapped.message, mapped.data);
      else await this.#sendError(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
      return;
    }
    if (id === undefined) return;
    await this.#sendResult(id, result);
  }

  async #sendResult(id: RpcId, result: unknown): Promise<void> {
    try {
      // 先自己序列化一次：不可序列化的结果（BigInt、循环引用）要以错误响应告诉调用方，
      // 而不是让写出行时抛异常、调用方永远等不到响应。
      JSON.stringify(result);
    } catch (error) {
      await this.#sendError(id, INTERNAL_ERROR, `result not serializable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.#send({ jsonrpc: "2.0", id, result });
  }

  async #sendError(id: RpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
  }
}
