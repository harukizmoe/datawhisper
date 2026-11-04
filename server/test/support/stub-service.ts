/**
 * 以进程内 stub 模型（stub-openai.ts）为唯一 provider 的 agent 服务，因此每个会话都会用它。进程契约与
 * src/main.ts 相同（env、ready 行、stdin EOF / SIGTERM、stdout 只走 JSON-RPC），以便桌面应用的 live 测试与
 * 命令行都可以监管它：
 *
 *   DW_DATA_DIR=/tmp/x STUB_CHUNK_MS=15 bun run server/test/support/stub-service.ts
 */
import { loadConfig } from "../../src/config.ts";
import { attachIpc } from "../../src/ipc/attach.ts";
import { startService } from "../../src/service.ts";
import { stubProvider } from "./stub-models.ts";
import { startStub } from "./stub-openai.ts";

const stub = startStub({ chunkDelayMs: Number(process.env.STUB_CHUNK_MS ?? 15) });
const config = loadConfig();
const service = await startService(config, { forceFileCredentials: true });
// 每次启动都会覆盖，因此早先运行留下的数据目录会指向本次运行的 stub 端口。
await service.modelService.putProvider(stubProvider(stub.url));

let exiting = false;
async function shutdown(): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await service.stop();
  } finally {
    stub.stop();
    process.exit(0);
  }
}

process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
attachIpc(service, { input: process.stdin, output: process.stdout }, { onInputEnd: () => void shutdown() });
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
