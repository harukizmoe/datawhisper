/**
 * Model settings routes, mounted at /v1/models. Secrets go in, never out.
 *
 *   GET    /                     settings view, built-in provider ids, custom endpoint presets
 *   GET    /available            chat models of enabled providers whose auth is complete
 *   PUT    /providers/:id        create or replace a provider (body: ProviderSettings, id must match)
 *   DELETE /providers/:id        remove a provider and its stored key
 *   PUT    /providers/:id/key    {apiKey}
 *   DELETE /providers/:id/key
 *   PUT    /default              {model: ModelRef | null, thinkingLevel: ModelThinkingLevel | null}
 *   POST   /test                 {model: ModelRef, provider?: ProviderSettings, apiKey?: string} -> {ok, text} | {ok:false, error}
 *
 * Invalid input answers 400 {error}.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { CUSTOM_PRESETS, type ModelService, type ProviderSettings, SettingsError } from "../models/service.ts";

export type PutDefaultRequest = { model: ModelRef | null; thinkingLevel: ModelThinkingLevel | null };
export type TestModelRequest = { model: ModelRef; provider?: ProviderSettings; apiKey?: string };

export function modelRoutes(service: ModelService): Hono {
  const routes = new Hono();

  routes.onError((error, c) => {
    if (error instanceof SettingsError || error instanceof SyntaxError) return c.json({ error: error.message }, 400);
    throw error;
  });

  routes.get("/", async (c) => c.json({ ...(await service.view()), builtinProviders: service.builtinIds(), presets: CUSTOM_PRESETS }));

  routes.get("/available", async (c) => c.json({ models: await service.available() }));

  routes.put("/providers/:id", async (c) => {
    const body = await c.req.json<ProviderSettings>();
    if (body?.id !== c.req.param("id")) throw new SettingsError("provider id in body does not match the URL");
    await service.putProvider(body);
    return c.json(await service.view());
  });

  routes.delete("/providers/:id", async (c) => {
    await service.deleteProvider(c.req.param("id"));
    return c.json(await service.view());
  });

  routes.put("/providers/:id/key", async (c) => {
    const { apiKey } = await c.req.json<{ apiKey?: unknown }>();
    if (typeof apiKey !== "string") throw new SettingsError("apiKey must be a string");
    await service.setApiKey(c.req.param("id"), apiKey);
    return c.json(await service.view());
  });

  routes.delete("/providers/:id/key", async (c) => {
    await service.clearApiKey(c.req.param("id"));
    return c.json(await service.view());
  });

  routes.put("/default", async (c) => {
    const { model, thinkingLevel } = await c.req.json<PutDefaultRequest>();
    await service.setDefault(model ?? null, thinkingLevel ?? null);
    return c.json(await service.view());
  });

  routes.post("/test", async (c) => {
    const { model, provider, apiKey } = await c.req.json<TestModelRequest>();
    if (typeof model?.provider !== "string" || typeof model.modelId !== "string") throw new SettingsError("model must be {provider, modelId}");
    return c.json(await service.test(model, { provider, apiKey }, c.req.raw.signal));
  });

  return routes;
}
