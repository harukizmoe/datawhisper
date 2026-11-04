/**
 * The agent service with the in-process stub model (stub-openai.ts) as its only provider, so every conversation uses it. Same process
 * contract as src/main.ts (env, ready line, SIGTERM / stdin EOF), so the desktop app's live tests can supervise it:
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
// Overwritten on every start, so a data dir from an earlier run points at this run's stub port.
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
