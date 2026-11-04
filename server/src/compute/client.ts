/**
 * Python compute worker 的客户端（`python -m compute`，协议见 compute/rpc.py）。
 *
 * 只有一个 worker 进程，首次使用时启动。worker 内请求并发执行；依赖另一请求的请求
 * 必须先 await 它（source 相关操作由 openSource 保证顺序）。
 *
 * 崩溃策略：worker 意外退出时，所有在途请求都以 ComputeCrashed 失败，且不在此处重试
 * （工具能否重跑由 pi-durable 的 `replay` 决定）。下一次调用会重启 worker，并在发出
 * 任何其他请求之前，按 descriptor 重新打开所有已记录的 source。运行时创建的内存表
 * 不会保留；RestartReport 会按 source 列出丢失的表。若在 `restartWindowMs` 内崩溃次数
 * 超过 `maxRestarts`，则不再重启：此后调用以 ComputeUnavailable 失败。
 */

export const RPC_CANCELLED = -32800;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SourceDescriptor = { kind: string } & Record<string, JsonValue>;

export class ComputeError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "ComputeError";
  }
}

export class ComputeCancelled extends ComputeError {
  constructor() {
    super("cancelled", RPC_CANCELLED);
    this.name = "ComputeCancelled";
  }
}

/** 请求执行期间 worker 死亡；该请求可能已部分执行。 */
export class ComputeCrashed extends Error {
  constructor(readonly exitCode: number | null, readonly stderrTail: string) {
    super(`compute worker exited (code ${exitCode}) during the request`);
    this.name = "ComputeCrashed";
  }
}

export class ComputeUnavailable extends Error {
  constructor(message: string, readonly stderrTail: string) {
    super(message);
    this.name = "ComputeUnavailable";
  }
}

export type RestartReport = {
  generation: number;
  reopened: { sourceId: string; lostTables: string[] }[];
  failed: { sourceId: string; error: string }[];
};

export type CallOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number | undefined, message: string) => void;
  onEvent?: (event: JsonValue) => void;
};

export type ComputeOptions = {
  /** Python 解释器，例如 `.venv/bin/python`，或冻结的 compute 可执行文件。 */
  python: string;
  /** 解释器之后的参数。默认 `["-m", "compute"]`。 */
  args?: string[];
  /** 工作目录：仓库根目录，`compute/` 与 `Function/` 从这里导入。 */
  cwd: string;
  env?: Record<string, string>;
  maxRestarts?: number;
  restartWindowMs?: number;
  /** `close()` 中等待 worker 退出的宽限时间，超时则杀掉它。 */
  shutdownTimeoutMs?: number;
  onStderr?: (line: string) => void;
  onRestart?: (report: RestartReport) => void;
};

type Pending = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  options: CallOptions;
};

type Worker = {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  pending: Map<number, Pending>;
  exited: Promise<number | null>;
  stopping: boolean;
};

type OpenSource = { descriptor: SourceDescriptor; tables: string[] };

const STDERR_TAIL_LINES = 40;

export class ComputeClient {
  private readonly options: Required<Omit<ComputeOptions, "env" | "onStderr" | "onRestart">> &
    Pick<ComputeOptions, "env" | "onStderr" | "onRestart">;
  private worker: Worker | undefined;
  private starting: Promise<Worker> | undefined;
  private nextId = 1;
  private generation = 0;
  private crashTimes: number[] = [];
  private stderrTail: string[] = [];
  private closed = false;
  private readonly sources = new Map<string, OpenSource>();

  constructor(options: ComputeOptions) {
    this.options = {
      args: ["-m", "compute"],
      maxRestarts: 3,
      restartWindowMs: 30_000,
      shutdownTimeoutMs: 5_000,
      ...options,
    };
  }

  /** 运行中 worker 的进程号；没有 worker 时为 undefined。 */
  get pid(): number | undefined {
    return this.worker?.proc.pid;
  }

  /** 当前 worker 退出时落定；供崩溃场景测试使用的接缝。 */
  get exited(): Promise<number | null> | undefined {
    return this.worker?.exited;
  }

  async call<T = JsonValue>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (this.closed) throw new ComputeUnavailable("compute client is closed", "");
    // 已有 worker 时请求是同步写入的，因此各次调用之间、以及与之后的 close() 之间
    // 都保持发起顺序。
    const worker = this.worker ?? (await this.ready());
    return (await this.send(worker, method, params, options)) as T;
  }

  /** 打开（或重新打开）一个 source，并记住其 descriptor 以供重启后恢复。 */
  async openSource(sourceId: string, descriptor: SourceDescriptor, options: CallOptions = {}) {
    const result = await this.call<{ source_id: string; name: string; tables: string[] }>(
      "source.open",
      { source_id: sourceId, descriptor },
      options,
    );
    this.sources.set(sourceId, { descriptor, tables: result.tables });
    return result;
  }

  async closeSource(sourceId: string): Promise<void> {
    this.sources.delete(sourceId);
    if (this.worker === undefined) return;
    await this.call("source.close", { source_id: sourceId });
  }

  /** 记录 source 当前的 tables，使重启后能报告哪些内存表已丢失。 */
  async refreshTables(sourceId: string): Promise<string[]> {
    const { tables } = await this.call<{ tables: string[] }>("source.tables", { source_id: sourceId });
    const entry = this.sources.get(sourceId);
    if (entry !== undefined) entry.tables = tables;
    return tables;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker ?? (await this.starting?.catch(() => undefined));
    if (worker === undefined) return;
    worker.stopping = true;
    const timer = setTimeout(() => worker.proc.kill("SIGKILL"), this.options.shutdownTimeoutMs);
    try {
      await this.send(worker, "shutdown", {}, {}).catch(() => undefined);
      worker.proc.stdin.end();
      await worker.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private async ready(): Promise<Worker> {
    if (this.closed) throw new ComputeUnavailable("compute client is closed", "");
    if (this.worker !== undefined) return this.worker;
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<Worker> {
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.options.restartWindowMs);
    if (this.crashTimes.length > this.options.maxRestarts) {
      throw new ComputeUnavailable(
        `compute worker crashed ${this.crashTimes.length} times within ${this.options.restartWindowMs} ms; not restarting`,
        this.tail(),
      );
    }
    const worker = this.spawn();
    try {
      await this.send(worker, "ping", {}, {});
    } catch (error) {
      worker.proc.kill("SIGKILL");
      throw error instanceof ComputeCrashed
        ? new ComputeUnavailable(`compute worker failed to start: ${error.message}`, error.stderrTail)
        : error;
    }
    const restarted = this.generation > 0;
    this.generation += 1;
    if (restarted) {
      const report = await this.reopenSources(worker);
      this.options.onRestart?.(report);
    }
    this.worker = worker;
    return worker;
  }

  private async reopenSources(worker: Worker): Promise<RestartReport> {
    const report: RestartReport = { generation: this.generation, reopened: [], failed: [] };
    // 串行执行：每次 open 都必须在下一次可能用到它的调用之前完成。
    for (const [sourceId, entry] of this.sources) {
      try {
        const result = (await this.send(worker, "source.open", { source_id: sourceId, descriptor: entry.descriptor }, {})) as {
          tables: string[];
        };
        const now = new Set(result.tables);
        report.reopened.push({ sourceId, lostTables: entry.tables.filter((t) => !now.has(t)) });
        entry.tables = result.tables;
      } catch (error) {
        report.failed.push({ sourceId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return report;
  }

  private spawn(): Worker {
    const proc = Bun.spawn([this.options.python, ...this.options.args], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const worker: Worker = { proc, pending: new Map(), exited: proc.exited, stopping: false };
    void this.readLines(proc.stdout, (line) => this.onMessage(worker, line));
    void this.readLines(proc.stderr, (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      this.options.onStderr?.(line);
    });
    void proc.exited.then((code) => this.onExit(worker, code));
    return worker;
  }

  private onExit(worker: Worker, code: number | null): void {
    if (this.worker === worker) this.worker = undefined;
    if (!worker.stopping) this.crashTimes.push(Date.now());
    const tail = this.tail();
    for (const pending of worker.pending.values()) pending.reject(new ComputeCrashed(code, tail));
    worker.pending.clear();
  }

  private send(worker: Worker, method: string, params: Record<string, unknown>, options: CallOptions): Promise<JsonValue> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<JsonValue>();
    const { signal } = options;
    const onAbort = () => {
      if (worker.pending.has(id)) this.write(worker, { jsonrpc: "2.0", method: "$/cancel", params: { id } });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.pending.set(id, { resolve, reject, options });
    try {
      this.write(worker, { jsonrpc: "2.0", id, method, params });
    } catch {
      worker.pending.delete(id);
      reject(new ComputeCrashed(worker.proc.exitCode, this.tail()));
    }
    return promise.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  private write(worker: Worker, message: Record<string, unknown>): void {
    worker.proc.stdin.write(JSON.stringify(message) + "\n");
    worker.proc.stdin.flush();
  }

  private onMessage(worker: Worker, line: string): void {
    let message: {
      id?: number | null;
      method?: string;
      params?: { id?: number; progress?: number; message?: string; event?: JsonValue };
      result?: JsonValue;
      error?: { code: number; message: string; data?: JsonValue };
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.options.onStderr?.(`[compute protocol] unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (message.method !== undefined) {
      const target = message.params?.id === undefined ? undefined : worker.pending.get(message.params.id);
      if (message.method === "progress") target?.options.onProgress?.(message.params?.progress, message.params?.message ?? "");
      else if (message.method === "event") target?.options.onEvent?.(message.params?.event ?? null);
      return;
    }
    if (typeof message.id !== "number") {
      this.options.onStderr?.(`[compute protocol] error without request id: ${message.error?.message ?? line.slice(0, 200)}`);
      return;
    }
    const pending = worker.pending.get(message.id);
    if (pending === undefined) return;
    worker.pending.delete(message.id);
    if (message.error === undefined) pending.resolve(message.result ?? null);
    else if (message.error.code === RPC_CANCELLED) pending.reject(new ComputeCancelled());
    else pending.reject(new ComputeError(message.error.message, message.error.code, message.error.data));
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line !== "") onLine(line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") onLine(buffer);
  }

  private tail(): string {
    return this.stderrTail.join("\n");
  }
}
