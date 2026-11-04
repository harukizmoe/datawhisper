/** 测试与命令行共用的内存双工管道：把服务接到两个 PassThrough 上，再用管道客户端驱动它。 */
import { PassThrough } from "node:stream";
import { attachIpc } from "../../src/ipc/attach.ts";
import { IpcClient } from "../../src/ipc/client.ts";
import { streamLineSink } from "../../src/ipc/framing.ts";
import type { Service } from "../../src/service.ts";

export type ServicePipe = {
  client: IpcClient;
  /** 结束客户端写端；服务端据此看到 EOF。 */
  close(): void;
};

export function connectToService(service: Service): ServicePipe {
  const toService = new PassThrough();
  const toClient = new PassThrough();
  attachIpc(service, { input: toService, output: toClient });
  const client = new IpcClient({
    input: toClient,
    write: streamLineSink(toService),
    endOutput: () => {
      toService.end();
    },
  });
  return {
    client,
    close() {
      // 只结束客户端写端：服务端的 watch 之后仍可能写 `end`，销毁流会把它们变成写错误。
      client.close();
    },
  };
}
