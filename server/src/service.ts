import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type Registry, type SessionEnd, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createApp } from "./app.ts";
import { ComputeClient } from "./compute/client.ts";
import type { Config } from "./config.ts";
import { dataWhisperPrompts } from "./agent/extension.ts";
import { ModelService } from "./models/service.ts";

export type ServiceOptions = {
  registry?: Registry;
  /** 本轮可用的工具（P4 提供；为空表示还没有工具，模型只能纯对话）。 */
  tools?: readonly ToolRegistration[];
  /** 数据源/工作区状态，供每轮的工具暴露与系统提示判定使用。 */
  turnState?: () => { hasDataSource: boolean; sourceCount: number; hasWorkspace: boolean; hasUnnamedColumns: boolean; teamsEnabled: boolean };
  /** 把 API key 保存在 `<dataDir>/credentials.json`，而不是探测操作系统钥匙串（测试用）。 */
  forceFileCredentials?: boolean;
  /** 订阅上 SSE 心跳注释的间隔。默认 15 秒。 */
  heartbeatMs?: number;
};

export type Service = {
  readonly port: number;
  readonly harness: Harness;
  readonly compute: ComputeClient;
  readonly modelService: ModelService;
  readonly context: Context;
  /** Harness 关闭时落定：`stop()` 之后，或存储失败之后（`kind: "failed"`）。 */
  readonly closed: Promise<SessionEnd>;
  /** 停止监听，关闭 compute 与 Harness。幂等。 */
  stop(): Promise<void>;
};

/** 在 `<dataDir>/datawhisper.sqlite` 上打开 Harness，恢复被中断的工作，并在 `config.host:config.port` 上监听。 */
export async function startService(config: Config, options: ServiceOptions = {}): Promise<Service> {
  const context = BACKGROUND_CONTEXT;
  mkdirSync(config.dataDir, { recursive: true });

  const modelService = await ModelService.open(config.dataDir, { forceFileCredentials: options.forceFileCredentials });
  const registry = options.registry ?? createRegistry();
  // 系统提示扩展常驻；工具必须真的装进注册表，否则 `configure({ modelTools })` 只是在空集合里筛选。
  registry.install(dataWhisperPrompts());
  if (options.tools !== undefined && options.tools.length > 0) {
    registry.install(defineExtension({ name: "datawhisper-tools", tools: options.tools }));
  }
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(config.dataDir, "datawhisper.sqlite")),
    {
      models: modelService.models,
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
    fetch: createApp({
      token: config.token,
      harness,
      compute,
      modelService,
      context,
      heartbeatMs: options.heartbeatMs,
      tools: options.tools ?? [],
      turnState: options.turnState,
    }).fetch,
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
