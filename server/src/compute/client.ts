/**
 * Client for the Python compute worker (`python -m compute`, protocol in compute/rpc.py).
 *
 * One worker process, started on first use. Requests run concurrently in the worker; a
 * request that depends on another must await it first (openSource does this for sources).
 *
 * Crash policy: when the worker exits unexpectedly, every in-flight request rejects with
 * ComputeCrashed and is not retried here (whether a tool may rerun is pi-durable's
 * `replay` decision). The next call restarts the worker and reopens every recorded source
 * from its descriptor before sending anything else. In-memory tables created at runtime do
 * not survive; the RestartReport names them per source. More than `maxRestarts` crashes
 * within `restartWindowMs` stops restarting: calls then reject with ComputeUnavailable.
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

/** The worker died while the request was in flight; the request may have partially run. */
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
  /** Python interpreter, e.g. `.venv/bin/python`, or a frozen compute executable. */
  python: string;
  /** Arguments after the interpreter. Default `["-m", "compute"]`. */
  args?: string[];
  /** Working directory: the repo root, where `compute/` and `Function/` import from. */
  cwd: string;
  env?: Record<string, string>;
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Grace period for `close()` before the worker is killed. */
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

  /** Process id of the running worker, if any. */
  get pid(): number | undefined {
    return this.worker?.proc.pid;
  }

  /** Settles when the current worker exits; test seam for crash scenarios. */
  get exited(): Promise<number | null> | undefined {
    return this.worker?.exited;
  }

  async call<T = JsonValue>(method: string, params: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    options.signal?.throwIfAborted();
    if (this.closed) throw new ComputeUnavailable("compute client is closed", "");
    // With a live worker the request is written synchronously, so calls keep their issue
    // order relative to each other and to a later close().
    const worker = this.worker ?? (await this.ready());
    return (await this.send(worker, method, params, options)) as T;
  }

  /** Opens (or reopens) a source and remembers its descriptor for restarts. */
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

  /** Records a source's current tables, so a restart can report which in-memory ones were lost. */
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
    // Sequential: each open must finish before the next call that may use it.
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
