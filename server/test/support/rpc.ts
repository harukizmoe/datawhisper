/** 不经管道的分发器测试支架：把记录写进内存，直接读回响应。 */
import type { RpcRecord } from "../../src/ipc/errors.ts";
import { type MapError, type RpcMethod, RpcServer } from "../../src/ipc/rpc.ts";

export type RpcReply<T = unknown> = { result?: T; error?: { code: number; message: string; data?: { kind?: string } } };

export type MemoryServer = {
  server: RpcServer;
  records: RpcRecord[];
  /** 发一条请求并返回它的响应记录。 */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<RpcReply<T>>;
  /** 直接喂原始文本（分帧、坏记录测试用）。 */
  line(text: string): Promise<void>;
};

export function memoryServer(methods: Record<string, RpcMethod>, mapError?: MapError): MemoryServer {
  const records: RpcRecord[] = [];
  const server = new RpcServer({
    methods,
    send: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    mapError,
    log: () => undefined,
  });
  let nextId = 1;
  return {
    server,
    records,
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<RpcReply<T>> {
      const id = nextId++;
      await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const reply = records.findLast((record) => record.id === id);
      if (reply === undefined) throw new Error(`no response for ${method}`);
      return { ...(reply.error ? { error: reply.error as RpcReply<T>["error"] } : { result: reply.result as T }) };
    },
    line(text: string) {
      return server.handleLine(text);
    },
  };
}
