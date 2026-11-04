import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelService, normalizeBaseUrl, type ProviderSettings, SettingsError } from "../src/models/service.ts";
import { modelRoutes } from "../src/routes/models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

let stub: Stub;
const dirs: string[] = [];

beforeAll(() => {
  stub = startStub({ chunkDelayMs: 0 });
});

afterAll(async () => {
  stub.stop();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function open(dir?: string): Promise<{ service: ModelService; dir: string }> {
  const dataDir = dir ?? (await mkdtemp(join(tmpdir(), "dw-models-")));
  if (dir === undefined) dirs.push(dataDir);
  return { service: await ModelService.open(dataDir, { forceFileCredentials: true }), dir: dataDir };
}

function custom(overrides: Partial<Extract<ProviderSettings, { kind: "custom" }>> = {}): ProviderSettings {
  return {
    kind: "custom",
    id: "custom-relay",
    name: "Relay",
    baseUrl: stub.url,
    requiresKey: true,
    enabled: true,
    models: [{ id: "relay-chat", contextWindow: 32_000, maxTokens: 4_000, reasoning: true }],
    ...overrides,
  };
}

describe("ModelService", () => {
  test("a keyed custom provider is unavailable until its key is stored, then requests carry the key", async () => {
    const { service } = await open();
    await service.putProvider(custom());
    expect(await service.available()).toEqual([]);

    await service.setApiKey("custom-relay", "  sk-relay  ");
    const [model] = await service.available();
    expect(model).toMatchObject({ provider: "custom-relay", id: "relay-chat", reasoning: true, contextWindow: 32_000 });
    expect(model!.thinkingLevels.length).toBeGreaterThan(1);

    const before = stub.log.length;
    expect(await service.test({ provider: "custom-relay", modelId: "relay-chat" })).toMatchObject({ ok: true });
    expect(stub.log.slice(before).map((r) => r.authorization)).toEqual(["Bearer sk-relay"]);
  });

  test("custom endpoints get the system role, never developer, for reasoning models", async () => {
    const { service } = await open();
    await service.putProvider(custom({ requiresKey: false }));
    const model = service.resolve({ provider: "custom-relay", modelId: "relay-chat" }, null);
    const before = stub.log.length;
    await service.models.completeSimple(model, {
      systemPrompt: "You are a data analyst.",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    });
    expect(stub.log.slice(before).map((r) => r.roles)).toEqual([["system", "user"]]);
  });

  test("a keyless local provider is available without a key and sends the placeholder", async () => {
    const { service } = await open();
    await service.putProvider(custom({ id: "custom-ollama", name: "Ollama", baseUrl: stub.url, requiresKey: false }));
    expect((await service.available()).map((m) => m.id)).toEqual(["relay-chat"]);
    const before = stub.log.length;
    expect(await service.test({ provider: "custom-ollama", modelId: "relay-chat" })).toMatchObject({ ok: true });
    expect(stub.log.slice(before).map((r) => r.authorization)).toEqual(["Bearer no-key"]);
  });

  test("testing a draft uses the draft key and persists nothing", async () => {
    const { service, dir } = await open();
    const before = stub.log.length;
    const result = await service.test({ provider: "custom-relay", modelId: "relay-chat" }, { provider: custom(), apiKey: "sk-draft" });
    expect(result).toMatchObject({ ok: true });
    expect(stub.log.slice(before).map((r) => r.authorization)).toEqual(["Bearer sk-draft"]);
    expect((await service.view()).providers).toEqual([]);
    expect(await service.credentials.read("custom-relay")).toBeUndefined();
    await expect(stat(join(dir, "models.json"))).rejects.toThrow();
  });

  test("a failing endpoint reports an error instead of throwing", async () => {
    const { service } = await open();
    const result = await service.test(
      { provider: "custom-dead", modelId: "m" },
      { provider: custom({ id: "custom-dead", baseUrl: "http://127.0.0.1:9/v1", requiresKey: false, models: [{ id: "m", contextWindow: 10, maxTokens: 5, reasoning: false }] }) },
    );
    expect(result.ok).toBe(false);
  });

  test("settings and keys survive reopen; keys never reach models.json and the key file is private", async () => {
    const { service, dir } = await open();
    await service.putProvider(custom());
    await service.setApiKey("custom-relay", "sk-persist");
    await service.setDefault({ provider: "custom-relay", modelId: "relay-chat" }, "high");

    const reopened = (await open(dir)).service;
    expect(await reopened.defaultAgent()).toEqual({ model: { provider: "custom-relay", modelId: "relay-chat" }, thinkingLevel: "high" });
    expect((await reopened.view()).defaultThinking).toBe("high");
    expect(await reopened.credentials.read("custom-relay")).toEqual({ type: "api_key", key: "sk-persist" });
    expect(await readFile(join(dir, "models.json"), "utf8")).not.toContain("sk-persist");
    if (process.platform !== "win32") expect((await stat(join(dir, "credentials.json"))).mode & 0o777).toBe(0o600);
  });

  test("concurrent key writes for different providers all persist", async () => {
    const { service, dir } = await open();
    const ids = ["custom-a", "custom-b", "custom-c", "custom-d"];
    for (const id of ids) await service.putProvider(custom({ id }));
    await Promise.all(ids.map((id) => service.setApiKey(id, `key-${id}`)));
    const reopened = (await open(dir)).service;
    expect((await reopened.credentials.list()).map((c) => c.providerId).sort()).toEqual(ids);
  });

  test("deleting a provider removes its key and clears a default that pointed at it", async () => {
    const { service } = await open();
    await service.putProvider(custom());
    await service.setApiKey("custom-relay", "sk");
    await service.setDefault({ provider: "custom-relay", modelId: "relay-chat" }, null);
    await service.deleteProvider("custom-relay");
    expect(await service.credentials.read("custom-relay")).toBeUndefined();
    expect((await service.view()).defaultModel).toBeNull();
    expect(await service.defaultAgent()).toBeUndefined();
  });

  test("the default falls back to the first available model when the saved one is disabled, clamping its thinking level", async () => {
    const { service } = await open();
    await service.putProvider(custom({ requiresKey: false }));
    await service.putProvider(custom({ id: "custom-other", requiresKey: false, models: [{ id: "other", contextWindow: 10, maxTokens: 5, reasoning: false }] }));
    await service.setDefault({ provider: "custom-relay", modelId: "relay-chat" }, "high");
    await service.putProvider(custom({ requiresKey: false, enabled: false }));
    expect(await service.defaultAgent()).toEqual({ model: { provider: "custom-other", modelId: "other" }, thinkingLevel: "off" });
  });

  test("thinking levels a model does not support are rejected", async () => {
    const { service } = await open();
    await service.putProvider(custom({ requiresKey: false, models: [{ id: "plain", contextWindow: 10, maxTokens: 5, reasoning: false }] }));
    expect(() => service.resolve({ provider: "custom-relay", modelId: "plain" }, "high")).toThrow(SettingsError);
    expect(() => service.resolve({ provider: "custom-relay", modelId: "missing" }, null)).toThrow(SettingsError);
    await expect(service.setDefault({ provider: "custom-relay", modelId: "plain" }, "high")).rejects.toThrow(SettingsError);
  });

  test("a built-in provider uses its own catalog and the stored key", async () => {
    const { service } = await open();
    expect(service.builtinIds()).toContain("deepseek");
    await expect(service.putProvider({ kind: "builtin", id: "no-such-provider", enabled: true })).rejects.toThrow(SettingsError);
    await service.putProvider({ kind: "builtin", id: "deepseek", enabled: true });
    await service.setApiKey("deepseek", "sk-deepseek");
    const models = await service.available();
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((m) => m.provider))).toEqual(new Set(["deepseek"]));
    expect((await service.view()).providers[0]).toMatchObject({ id: "deepseek", hasStoredKey: true });
    expect((await service.view()).providers[0]!.authSource).not.toBeNull();
  });

  test("invalid custom providers are rejected", async () => {
    const { service } = await open();
    const bad: ProviderSettings[] = [
      custom({ id: "relay" }),
      custom({ name: " " }),
      custom({ baseUrl: "ftp://example.com" }),
      custom({ baseUrl: "not a url" }),
      custom({ models: [{ id: "m", contextWindow: 100, maxTokens: 200, reasoning: false }] }),
      custom({ models: [{ id: "m", contextWindow: 0, maxTokens: 0, reasoning: false }] }),
      custom({ models: [{ id: "m", contextWindow: 10, maxTokens: 5, reasoning: false }, { id: "m", contextWindow: 10, maxTokens: 5, reasoning: false }] }),
    ];
    for (const input of bad) await expect(service.putProvider(input)).rejects.toThrow(SettingsError);
    expect((await service.view()).providers).toEqual([]);
  });

  test("Ollama native URLs are rewritten to its OpenAI-compatible /v1 endpoint", () => {
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://localhost:11434/api/chat/")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://gpu-box:11434/api")).toBe("http://gpu-box:11434/v1");
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
  });
});

describe("model routes", () => {
  test("keys go in but never come out, and bad input answers 400", async () => {
    const { service } = await open();
    const app = modelRoutes(service);
    const put = (path: string, body: unknown) =>
      app.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await put("/providers/custom-relay", custom())).status).toBe(200);
    expect((await put("/providers/custom-relay/key", { apiKey: "sk-route-secret" })).status).toBe(200);

    const view = await (await app.request("/")).text();
    expect(view).not.toContain("sk-route-secret");
    expect(JSON.parse(view)).toMatchObject({ credentialBackend: "file", providers: [{ id: "custom-relay", hasStoredKey: true }] });
    expect(JSON.parse(view).presets.map((p: { presetId: string }) => p.presetId)).toEqual(["ollama", "atlascloud"]);

    expect((await put("/providers/custom-other", custom())).status).toBe(400);
    expect((await put("/providers/custom-relay/key", { apiKey: 1 })).status).toBe(400);
    expect((await put("/default", { model: { provider: "custom-relay", modelId: "nope" }, thinkingLevel: null })).status).toBe(400);
    expect((await app.request("/providers/custom-relay", { method: "PUT", body: "{" })).status).toBe(400);

    const tested = await app.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { provider: "custom-relay", modelId: "relay-chat" } }),
    });
    expect(await tested.json()).toMatchObject({ ok: true });
  });
});
