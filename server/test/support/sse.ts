/** Minimal SSE client for tests: parses `event:`/`data:` frames and counts comment lines (heartbeats). */
export type SseEvent = { event: string; data: unknown };

export class SseClient {
  readonly events: SseEvent[] = [];
  comments = 0;
  done = false;
  #waiters: (() => void)[] = [];
  #controller = new AbortController();
  readonly finished: Promise<void>;

  constructor(readonly response: Response) {
    this.finished = this.#read();
  }

  static async open(url: string, token: string): Promise<SseClient> {
    const controller = new AbortController();
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const client = new SseClient(response);
    client.#controller = controller;
    return client;
  }

  close(): void {
    this.#controller.abort();
  }

  /** Resolve once `predicate` holds for the events (and comments) received so far. */
  async until(predicate: (events: SseEvent[], client: SseClient) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events, this)) {
      if (this.done) throw new Error(`stream ended; ${this.events.length} events`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out after ${this.events.length} events`);
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, left);
      this.#waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      await promise;
    }
  }

  #wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async #read(): Promise<void> {
    if (!this.response.body) return;
    const reader = this.response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let event = "message";
    let data = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line.startsWith(":")) this.comments += 1;
          else if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
          else if (line === "") {
            if (data !== "") this.events.push({ event, data: JSON.parse(data) });
            event = "message";
            data = "";
          }
          newline = buffer.indexOf("\n");
        }
        this.#wake();
      }
    } catch {
      // aborted by close()
    } finally {
      this.done = true;
      this.#wake();
    }
  }
}
