/**
 * JSONL 分帧：一行一个 JSON 对象，**只按 LF（U+000A）切分**。
 *
 * 不能用 `readline` 一类的行读取器：它们还会在 U+2028/U+2029 上断行，而这两个码点可以合法地出现在 JSON 字符串里，
 * 一旦被当成换行就会把一条记录劈成两半。解析（判断记录是否合法）只发生在切分之后，因此一条坏记录不会影响后续记录，
 * 也不会把两行粘在一起。
 */

/** 累计 decode 的读取器：跨 chunk 的多字节 UTF-8 字符在这里拼回来。 */
export class JsonLinesDecoder {
  readonly #decoder = new TextDecoder("utf-8");
  #pending = "";

  /** 喂入一个 chunk，返回其中已经完整的行（不含换行符，空行被丢弃）。 */
  push(chunk: Uint8Array | string): string[] {
    this.#pending += typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    for (;;) {
      const index = this.#pending.indexOf("\n");
      if (index < 0) break;
      const line = this.#pending.slice(0, index);
      this.#pending = this.#pending.slice(index + 1);
      // 行尾的 `\r` 留给 JSON.parse 当空白，不做特殊处理。
      if (line.trim() !== "") lines.push(line);
    }
    return lines;
  }

  /** 尚未收到换行的残留字节数（调试与测试用）。 */
  get pendingLength(): number {
    return this.#pending.length;
  }
}

/** 一行写出去的形状；Node 的 `Writable.write` 回调在数据真正落盘/被对端读走后才被调用。 */
export type LineSink = (line: string) => void | Promise<void>;

/**
 * 串行化写入：所有记录排队，一次只发一条，`send()` 在对应行写完后才 resolve。
 *
 * 这样既保证同一时刻只有一行在写（不会交错），也把背压传回调用方——对端不读时 `send()` 就一直等着，
 * 而不是把内存堆满。
 */
export class JsonlWriter {
  #chain: Promise<void> = Promise.resolve();

  constructor(readonly sink: LineSink) {}

  send(record: unknown): Promise<void> {
    // 序列化也放进队列：调用方拿到的永远是 promise，不会因为不可序列化的结果同步抛出。
    const write = this.#chain.then(() => this.sink(JSON.stringify(record)));
    // 失败不要卡死后续记录：错误照常抛给本次调用方，队列回到已复原的状态。
    this.#chain = write.catch(() => undefined);
    return write;
  }

  /** 等排队中的记录全部写完。 */
  flush(): Promise<void> {
    return this.#chain;
  }
}

/** 把一个可写流包成 `LineSink`：等 write 回调，从而获得背压。 */
export function streamLineSink(stream: { write(chunk: string, callback: (error?: Error | null) => void): unknown }): LineSink {
  return (line) => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
    return promise;
  };
}
