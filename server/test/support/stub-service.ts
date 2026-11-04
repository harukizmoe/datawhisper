/**
 * 以进程内 stub 模型（stub-openai.ts）为唯一 provider 的 agent 服务，因此每个会话都会用它。进程契约与
 * src/main.ts 相同（env、ready 行、SIGTERM / stdin EOF），以便桌面应用的 live 测试可以监管它：
 *
 *   DW_TOKEN=t DW_DATA_DIR=/tmp/x STUB_CHUNK_MS=15 bun run server/test/support/stub-service.ts
 */
import { loadConfig } from "../../src/config.ts";
import { startService } from "../../src/service.ts";
import { stubProvider } from "./stub-models.ts";
import { startStub } from "./stub-openai.ts";

const stub = startStub({ chunkDelayMs: Number(process.env.STUB_CHUNK_MS ?? 15) });
const config = loadConfig();
const service = await startService(config, { forceFileCredentials: true });
// 每次启动都会覆盖，因此早先运行留下的数据目录会指向本次运行的 stub 端口。
await service.modelService.putProvider(stubProvider(stub.url));

console.log(
  JSON.stringify({ type: "ready", port: service.port, pid: process.pid, ...(config.tokenGenerated ? { token: config.token } : {}) }),
);

let exiting = false;
async function shutdown(): Promise<void> {
  if (exiting) return;
  exiting = true;
  await service.stop();
  stub.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
if (!process.stdin.isTTY) {
  process.stdin.on("end", () => void shutdown());
  process.stdin.resume();
}
