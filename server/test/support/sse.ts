/** 测试用的极简 SSE 客户端：解析 `event:`/`data:` 帧并统计注释行（心跳）。 */
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

  /** 当 `predicate` 对目前已收到的事件（及注释）成立时 resolve。 */
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
      // 由 close() 中止
    } finally {
      this.done = true;
      this.#wake();
    }
  }
}
