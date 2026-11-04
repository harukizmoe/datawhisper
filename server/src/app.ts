import type { Context } from "@earendil-works/chord/context";
import type { Harness, ToolRegistration } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { ComputeClient } from "./compute/client.ts";
import type { ModelService } from "./models/service.ts";
import { type TurnState, conversationRoutes } from "./routes/conversations.ts";
import { modelRoutes } from "./routes/models.ts";

export type AppDeps = {
  token: string;
  harness: Harness;
  compute: ComputeClient;
  modelService: ModelService;
  context: Context;
  /** 订阅的 SSE 心跳间隔；默认 15 秒。 */
  heartbeatMs?: number;
  /** 本轮可用的工具，由 P4 提供。 */
  tools?: readonly ToolRegistration[];
  /** 数据源/工作区状态；未提供时按「没有数据源」处理。 */
  turnState?: () => TurnState;
};

export function createApp({ token, harness, compute, modelService, context, heartbeatMs, tools, turnState }: AppDeps): Hono {
  const app = new Hono();
  app.use("/v1/*", bearerAuth({ token }));

  app.get("/v1/health", async (c) => {
    const inspection = await harness.inspect(context);
    return c.json({
      ok: true,
      scheduling: inspection.scheduling,
      tasks: inspection.tasks.length,
      submissions: inspection.submissions.length,
      computePid: compute.pid ?? null,
    });
  });

  app.route("/v1/conversations", conversationRoutes({ harness, modelService, context, heartbeatMs, tools: tools ?? [], turnState }));
  app.route("/v1/models", modelRoutes(modelService));

  return app;
}
