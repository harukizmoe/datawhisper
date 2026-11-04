import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { ComputeClient } from "./compute/client.ts";
import type { ModelService } from "./models/service.ts";
import { conversationRoutes } from "./routes/conversations.ts";
import { modelRoutes } from "./routes/models.ts";

export type AppDeps = {
  token: string;
  harness: Harness;
  compute: ComputeClient;
  modelService: ModelService;
  context: Context;
  /** SSE heartbeat interval of subscriptions; default 15 s. */
  heartbeatMs?: number;
};

export function createApp({ token, harness, compute, modelService, context, heartbeatMs }: AppDeps): Hono {
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

  app.route("/v1/conversations", conversationRoutes({ harness, modelService, context, heartbeatMs }));
  app.route("/v1/models", modelRoutes(modelService));

  return app;
}
