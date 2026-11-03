/**
 * Agent service entry point, started by the desktop app.
 *
 * Ready line: once listening, one JSON line on stdout
 *   {"type":"ready","port":<n>,"pid":<n>}            (plus "token" only when DW_TOKEN was not supplied)
 * Lifetime: SIGTERM/SIGINT, or EOF on stdin when stdin is a pipe (the parent died), close the
 * service gracefully. A storage failure closes the Harness; the process then exits with code 1 so the
 * supervisor restarts it, and `resume()` continues interrupted work.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createApp } from "./app.ts";
import { ComputeClient } from "./compute/client.ts";
import { loadConfig } from "./config.ts";

const context = BACKGROUND_CONTEXT;
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const models = createModels();
const registry = createRegistry();
const harness = await Harness.open(
  await openNodeSqliteStorage(join(config.dataDir, "datawhisper.sqlite")),
  {
    models: () => models,
    registry,
    identity: { attribution: null },
    onReport: (report) => console.error(`[harness] ${report.kind}`, report),
  },
  context,
);
harness.resume();

const compute = new ComputeClient({
  python: config.python,
  cwd: config.computeCwd,
  onStderr: (line) => console.error(`[compute] ${line}`),
});

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0,
  fetch: createApp({ token: config.token, harness, compute, context }).fetch,
});

console.log(
  JSON.stringify({ type: "ready", port: server.port, pid: process.pid, ...(config.tokenGenerated ? { token: config.token } : {}) }),
);

let harnessClosed = false;
let stopping: Promise<void> | undefined;
function shutdown(exitCode: number): Promise<void> {
  stopping ??= (async () => {
    await server.stop(true);
    await compute.close();
    if (!harnessClosed) await harness.close(context);
    process.exit(exitCode);
  })();
  return stopping;
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
if (!process.stdin.isTTY) {
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.resume();
}
void harness.closed.then((end) => {
  harnessClosed = true;
  if (end.kind === "failed") {
    console.error("[harness] closed after a storage failure:", end.error);
    void shutdown(1);
  }
});
