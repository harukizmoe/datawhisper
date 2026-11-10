/**
 * 管道客户端：桌面界面、命令行和测试都用它。协议见 docs/refactor/ui-transport.md。
 *
 * 一方向是请求/响应（`id` 关联，可乱序），另一方向是通知（`conversation.event`）。读取只按 LF 切分，
 * 与服务端共用 framing.ts，因此两端的记录边界规则不会漂移。
 */
import { say } from "../i18n.ts";
import { JsonLinesDecoder, JsonlWriter, type LineSink } from "./framing.ts";
import { INTERNAL_ERROR, RpcError, type RpcRecord } from "./errors.ts";

export type ReadyRecord = { type: "ready"; pid: number; [key: string]: unknown };
export type IpcNotification = { method: string; params: Record<string, unknown> };

export type IpcClientOptions = {
  /** 服务端的 stdout。 */
  input: NodeJS.ReadableStream;
  /** 往服务端的 stdin 写一行；返回 promise 表示背压。 */
  write: LineSink;
  /** 主动关闭时结束写端（父进程退出即服务退出）。 */
  endOutput?: () => void | Promise<void>;
  log?: (message: string, error?: unknown) => void;
};

type Pending = { resolve: (result: unknown) => void; reject: (error: unknown) => void };

export class IpcClient {
  /** 到目前为止收到的全部通知，按到达顺序（测试用它做断言）。 */
  readonly notifications: IpcNotification[] = [];
  /** 就绪记录；服务端还没发时一直挂着。 */
  readonly ready: Promise<ReadyRecord>;

  readonly #writer: JsonlWriter;
  readonly #decoder = new JsonLinesDecoder();
  readonly #pending = new Map<number | string, Pending>();
  readonly #queue: IpcNotification[] = [];
  readonly #readyWaiters: ((record: ReadyRecord) => void)[] = [];
  readonly #waiterPromises: (() => void)[] = [];
  readonly #notificationResolvers: { resolve: (notification: IpcNotification) => void; reject: (error: unknown) => void }[] = [];
  readonly #closeWaiters: (() => void)[] = [];
  readonly #log: (message: string, error?: unknown) => void;
  readonly #input: NodeJS.ReadableStream;
  readonly #endOutput: (() => void | Promise<void>) | undefined;
  readonly #handlers = new Set<(notification: IpcNotification) => void>();
  #nextId = 1;
  #closed = false;
  #endRequested = false;

  constructor({ input, write, endOutput, log }: IpcClientOptions) {
    this.#input = input;
    this.#endOutput = endOutput;
    this.#log = log ?? (() => undefined);
    const { promise, resolve } = Promise.withResolvers<ReadyRecord>();
    this.ready = promise;
    this.#readyWaiters.push(resolve);
    this.#writer = new JsonlWriter(write);

    input.on("data", (chunk: Uint8Array | string) => this.#receive(chunk));
    input.on("end", () => this.#closeInput());
    input.on("error", (error: Error) => {
      this.#log("管道读取失败", error);
      this.#closeInput();
    });
    if (typeof input.resume === "function") input.resume();
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** 发出请求并等它的响应；服务端按 `id` 关联，因此可以和别的请求并发。 */
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) throw new Error(say(`The pipe is closed; cannot send ${method}`, `管道已关闭，无法发送 ${method}`));
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    const record: RpcRecord = { jsonrpc: "2.0", id, method, params };
    try {
      await this.#writer.send(record);
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return (await promise) as T;
  }

  /** 等服务端的下一次通知（消费式）。 */
  nextNotification(): Promise<IpcNotification> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.reject(new Error(say("The pipe is closed; no more notifications will arrive", "管道已关闭，不会再有通知")));
    const { promise, resolve, reject } = Promise.withResolvers<IpcNotification>();
    this.#notificationResolvers.push({ resolve, reject });
    return promise;
  }

  /** 让 `handler` 收到之后到达的每条通知；返回注销函数。 */
  onNotification(handler: (notification: IpcNotification) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /** 等已收到的通知满足 `predicate`。不轮询、不用计时器：每次通知到达后重新判定。 */
  async until(predicate: (notifications: IpcNotification[]) => boolean): Promise<void> {
    while (!predicate(this.notifications)) {
      if (this.#closed) throw new Error(say(`The pipe is closed; ${this.notifications.length} notification(s) received`, `管道已关闭；已收到 ${this.notifications.length} 条通知`));
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#waiterPromises.push(resolve);
      await promise;
    }
  }

  /** 等管道关闭（对方退出或自己 close）。 */
  whenClosed(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#closeWaiters.push(resolve);
    return promise;
  }

  /** 关闭写端；服务端读到 EOF 后有序退出。读端仍可继续接收退出前的通知。 */
  close(): void {
    if (this.#endRequested) return;
    this.#endRequested = true;
    void this.#writer
      .flush()
      .then(() => this.#endOutput?.())
      .catch(() => undefined);
  }

  #receive(chunk: Uint8Array | string): void {
    for (const line of this.#decoder.push(chunk)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.#log(`忽略了无法解析的记录：${line.slice(0, 200)}`, error);
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (record.jsonrpc !== "2.0") {
        // 就绪记录没有 jsonrpc 字段，是进程约定的一部分。
        if (record.type === "ready") {
          const ready = parsed as ReadyRecord;
          for (const resolve of this.#readyWaiters.splice(0)) resolve(ready);
        }
        continue;
      }
      if (typeof record.method === "string") {
        this.#notification({ method: record.method, params: (record.params ?? {}) as Record<string, unknown> });
        continue;
      }
      this.#respond(record);
    }
  }

  #respond(record: Record<string, unknown>): void {
    const id = record.id;
    if (typeof id !== "number" && typeof id !== "string") {
      this.#log("忽略了没有 id 的响应记录");
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#log(`忽略了未知 id 的响应：${id}`);
      return;
    }
    this.#pending.delete(id);
    const error = record.error;
    if (typeof error === "object" && error !== null) {
      const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(
        new RpcError(
          typeof message === "string" ? message : "rpc error",
          typeof code === "number" ? code : INTERNAL_ERROR,
          data as RpcError["data"],
        ),
      );
      return;
    }
    pending.resolve(record.result);
  }

  #notification(notification: IpcNotification): void {
    this.notifications.push(notification);
    for (const handler of this.#handlers) {
      try {
        handler(notification);
      } catch (error) {
        this.#log("通知处理器抛出异常", error);
      }
    }
    const waiter = this.#notificationResolvers.shift();
    if (waiter !== undefined) waiter.resolve(notification);
    else this.#queue.push(notification);
    for (const wake of this.#waiterPromises.splice(0)) wake();
  }

  #closeInput(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error(say("The pipe is closed", "管道已关闭")));
    this.#pending.clear();
    for (const wake of this.#waiterPromises.splice(0)) wake();
    for (const resolve of this.#closeWaiters.splice(0)) resolve();
    for (const waiter of this.#notificationResolvers.splice(0)) waiter.reject(new Error(say("The pipe is closed", "管道已关闭")));
    this.#input.removeAllListeners("data");
    this.#input.removeAllListeners("end");
    this.#input.removeAllListeners("error");
  }
}
