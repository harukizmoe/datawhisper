import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createRegistry, Harness, type RegistryReader, type SessionEnd } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createApp } from "./app.ts";
import { ComputeClient } from "./compute/client.ts";
import type { Config } from "./config.ts";
import { ModelService } from "./models/service.ts";

export type ServiceOptions = {
  registry?: RegistryReader;
  /** Keep API keys in `<dataDir>/credentials.json` instead of probing the OS keychain (tests). */
  forceFileCredentials?: boolean;
  /** Interval of the SSE heartbeat comment on subscriptions. Default 15 s. */
  heartbeatMs?: number;
};

export type Service = {
  readonly port: number;
  readonly harness: Harness;
  readonly compute: ComputeClient;
  readonly modelService: ModelService;
  readonly context: Context;
  /** Settles when the Harness closed: after `stop()`, or after a storage failure (`kind: "failed"`). */
  readonly closed: Promise<SessionEnd>;
  /** Stop listening, close compute and the Harness. Idempotent. */
  stop(): Promise<void>;
};

/** Open the Harness on `<dataDir>/datawhisper.sqlite`, resume interrupted work, and listen on `config.host:config.port`. */
export async function startService(config: Config, options: ServiceOptions = {}): Promise<Service> {
  const context = BACKGROUND_CONTEXT;
  mkdirSync(config.dataDir, { recursive: true });

  const modelService = await ModelService.open(config.dataDir, { forceFileCredentials: options.forceFileCredentials });
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(config.dataDir, "datawhisper.sqlite")),
    {
      models: modelService.models,
      registry: options.registry ?? createRegistry(),
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
    fetch: createApp({ token: config.token, harness, compute, modelService, context, heartbeatMs: options.heartbeatMs }).fetch,
  });

  let harnessClosed = false;
  const closed = harness.closed.then((end) => {
    harnessClosed = true;
    return end;
  });
  let stopping: Promise<void> | undefined;
  return {
    port: server.port ?? config.port,
    harness,
    compute,
    modelService,
    context,
    closed,
    stop() {
      stopping ??= (async () => {
        await server.stop(true);
        await compute.close();
        if (!harnessClosed) await harness.close(context);
      })();
      return stopping;
    },
  };
}
