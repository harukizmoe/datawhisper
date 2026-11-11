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

export function connectToService(service: Service, options: { dataDir?: string; autoStartFeishu?: boolean } = {}): ServicePipe {
  const toService = new PassThrough();
  const toClient = new PassThrough();
  // 测试默认不启动飞书长连接：数据目录里若残留已启用配置，不该在跑测试时连真实网络。
  attachIpc(service, { input: toService, output: toClient }, { autoStartFeishu: false, ...options });
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
