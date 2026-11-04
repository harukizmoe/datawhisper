/**
 * Agent service entry point, started by the desktop app.
 *
 * Ready line: once listening, one JSON line on stdout
 *   {"type":"ready","port":<n>,"pid":<n>}            (plus "token" only when DW_TOKEN was not supplied)
 * Lifetime: SIGTERM/SIGINT, or EOF on stdin when stdin is a pipe (the parent died), close the
 * service gracefully. A storage failure closes the Harness; the process then exits with code 1 so the
 * supervisor restarts it, and `resume()` continues interrupted work.
 */
import { loadConfig } from "./config.ts";
import { startService } from "./service.ts";

const config = loadConfig();
const service = await startService(config);

console.log(
  JSON.stringify({ type: "ready", port: service.port, pid: process.pid, ...(config.tokenGenerated ? { token: config.token } : {}) }),
);

let exiting = false;
async function shutdown(exitCode: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  await service.stop();
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
if (!process.stdin.isTTY) {
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.resume();
}
void service.closed.then((end) => {
  if (end.kind === "failed") {
    console.error("[harness] closed after a storage failure:", end.error);
    void shutdown(1);
  }
});
