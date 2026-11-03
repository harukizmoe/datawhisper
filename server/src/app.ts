import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { ComputeClient } from "./compute/client.ts";

export type AppDeps = {
  token: string;
  harness: Harness;
  compute: ComputeClient;
  context: Context;
};

export function createApp({ token, harness, compute, context }: AppDeps): Hono {
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

  return app;
}
