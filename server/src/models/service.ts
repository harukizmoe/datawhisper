import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Api,
  clampThinkingLevel,
  createModels,
  createProvider,
  type Credential,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelRef } from "@earendil-works/pi-durable";
import { SecretCredentialStore, writePrivateJson } from "./credentials.ts";

/**
 * User-configured model providers. Nothing is hosted: every provider, model and key comes from the
 * user. Settings (no secrets) live in `<dataDir>/models.json`; keys in SecretCredentialStore.
 *
 * Two provider kinds:
 *  - builtin: a pi-ai built-in provider (catalog, native API, thinking maps come from pi-ai)
 *  - custom:  any OpenAI-compatible endpoint (Ollama, AtlasCloud, relays, self-hosted servers);
 *             the user lists its models with their limits.
 *
 * Changes are applied to one long-lived `Models` instance, so the Harness (which reads
 * `models: () => service.models`) uses them on its next request.
 */

export type CustomModel = {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision?: boolean;
  /** USD per million tokens, optional (usage cost display). */
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
};

export type ProviderSettings =
  | { kind: "builtin"; id: string; enabled: boolean }
  | {
      kind: "custom";
      id: string;
      name: string;
      baseUrl: string;
      /** false for local servers such as Ollama. */
      requiresKey: boolean;
      enabled: boolean;
      models: CustomModel[];
    };

export type ModelSettings = {
  version: 1;
  providers: ProviderSettings[];
  defaultModel?: ModelRef;
  defaultThinking?: ModelThinkingLevel;
};

export type CustomPreset = Omit<Extract<ProviderSettings, { kind: "custom" }>, "kind" | "enabled" | "id" | "models"> & { presetId: string };

/**
 * Endpoint presets carried over from the old LLM config (ollama, atlascloud). The user lists the
 * models and their limits; no limits are guessed here.
 */
export const CUSTOM_PRESETS: readonly CustomPreset[] = [
  { presetId: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { presetId: "atlascloud", name: "AtlasCloud", baseUrl: "https://api.atlascloud.ai/v1", requiresKey: true },
];

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const CUSTOM_ID = /^custom-[a-z0-9][a-z0-9-]{0,47}$/;

export class ModelService {
  readonly models: MutableModels;
  private readonly builtins: ReadonlyMap<string, Provider>;

  private constructor(
    private settings: ModelSettings,
    private readonly settingsPath: string,
    readonly credentials: SecretCredentialStore,
  ) {
    this.models = createModels({ credentials });
    this.builtins = new Map(builtinProviders().map((p) => [p.id, p]));
    this.apply();
  }

  static async open(dataDir: string, options: { forceFileCredentials?: boolean } = {}): Promise<ModelService> {
    const settingsPath = join(dataDir, "models.json");
    const credentials = await SecretCredentialStore.open(join(dataDir, "credentials.json"), join(dataDir, "credentials.index.json"), {
      forceFile: options.forceFileCredentials,
    });
    let settings: ModelSettings = { version: 1, providers: [] };
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as ModelSettings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new ModelService(settings, settingsPath, credentials);
  }

  /** Built-in provider ids the user can enable. */
  builtinIds(): string[] {
    return [...this.builtins.keys()].sort();
  }

  /** Settings plus per-provider auth status; never returns secrets. */
  async view() {
    const providers = await Promise.all(
      this.settings.providers.map(async (p) => ({
        ...p,
        name: p.kind === "custom" ? p.name : (this.builtins.get(p.id)?.name ?? p.id),
        hasStoredKey: (await this.credentials.read(p.id)) !== undefined,
        keyRequired: p.kind === "custom" ? p.requiresKey : true,
        /** Where the effective auth comes from ("stored", an env var name, "local server"); null = not configured or disabled. */
        authSource: p.enabled ? ((await this.models.checkAuth(p.id))?.source ?? null) : null,
      })),
    );
    return {
      providers,
      defaultModel: this.settings.defaultModel ?? null,
      defaultThinking: this.settings.defaultThinking ?? null,
      credentialBackend: this.credentials.backend,
    };
  }

  async putProvider(input: ProviderSettings): Promise<void> {
    const provider = this.validate(input);
    const others = this.settings.providers.filter((p) => p.id !== provider.id);
    await this.save({ ...this.settings, providers: [...others, provider] });
  }

  async deleteProvider(id: string): Promise<void> {
    if (!this.settings.providers.some((p) => p.id === id)) throw new SettingsError(`unknown provider: ${id}`);
    await this.credentials.delete(id);
    const defaultModel = this.settings.defaultModel?.provider === id ? undefined : this.settings.defaultModel;
    await this.save({ ...this.settings, providers: this.settings.providers.filter((p) => p.id !== id), defaultModel });
  }

  async setApiKey(providerId: string, key: string): Promise<void> {
    if (!this.settings.providers.some((p) => p.id === providerId)) throw new SettingsError(`unknown provider: ${providerId}`);
    const trimmed = key.trim();
    if (trimmed === "") throw new SettingsError("API key is empty");
    await this.credentials.modify(providerId, async () => ({ type: "api_key", key: trimmed }));
  }

  async clearApiKey(providerId: string): Promise<void> {
    await this.credentials.delete(providerId);
  }

  async setDefault(model: ModelRef | null, thinking: ModelThinkingLevel | null): Promise<void> {
    if (model !== null) this.resolve(model, thinking);
    await this.save({ ...this.settings, defaultModel: model ?? undefined, defaultThinking: thinking ?? undefined });
  }

  /** Validates a per-conversation choice against the current catalog; throws SettingsError. */
  resolve(ref: ModelRef, thinking: ModelThinkingLevel | null): Model<Api> {
    const model = this.models.getModel(ref.provider, ref.modelId);
    if (model === undefined) throw new SettingsError(`unknown model: ${ref.provider}/${ref.modelId}`);
    if (thinking !== null && !getSupportedThinkingLevels(model).includes(thinking)) {
      throw new SettingsError(`${ref.provider}/${ref.modelId} does not support thinking level ${thinking}`);
    }
    return model;
  }

  /** Chat models of enabled providers whose auth is complete. */
  async available() {
    return (await this.models.getAvailable()).map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      vision: m.input.includes("image"),
      thinkingLevels: getSupportedThinkingLevels(m),
    }));
  }

  /**
   * The agent model for a conversation without one: the saved default when it is still available, otherwise the first
   * available model; the saved thinking level clamped to what that model supports. Undefined when nothing is available.
   */
  async defaultAgent(): Promise<{ model: ModelRef; thinkingLevel?: ModelThinkingLevel } | undefined> {
    const available = await this.models.getAvailable();
    const saved = this.settings.defaultModel;
    const model = available.find((m) => m.provider === saved?.provider && m.id === saved.modelId) ?? available[0];
    if (model === undefined) return undefined;
    const ref = { provider: model.provider, modelId: model.id };
    const thinking = this.settings.defaultThinking;
    return thinking === undefined ? { model: ref } : { model: ref, thinkingLevel: clampThinkingLevel(model, thinking) };
  }

  /**
   * One tiny request through the real provider. `draft` tests unsaved input ("test before save"):
   * its provider and key are used for this request only.
   */
  async test(
    ref: ModelRef,
    draft: { provider?: ProviderSettings; apiKey?: string } = {},
    signal?: AbortSignal,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const settings = draft.provider === undefined ? this.settings.providers.find((p) => p.id === ref.provider) : this.validate(draft.provider);
    const provider = settings === undefined ? undefined : this.buildProvider(settings);
    if (settings === undefined || provider === undefined) return { ok: false, error: `unknown provider: ${ref.provider}` };
    const model = provider.getModels().find((m) => m.id === ref.modelId);
    if (model === undefined) return { ok: false, error: `unknown model: ${ref.provider}/${ref.modelId}` };
    const draftKey = draft.apiKey?.trim();
    const credential: Credential | undefined = draftKey ? { type: "api_key", key: draftKey } : await this.credentials.read(settings.id);
    const scoped = createModels({
      credentials: {
        read: async () => credential,
        list: async () => [],
        modify: async () => credential,
        delete: async () => undefined,
      },
    });
    scoped.setProvider(provider);
    const reply = await scoped.completeSimple(
      model,
      { messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
      { maxTokens: 16, signal },
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return { ok: false, error: reply.errorMessage ?? reply.stopReason };
    }
    const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    return { ok: true, text };
  }

  private validate(input: ProviderSettings): ProviderSettings {
    if (input.kind === "builtin") {
      if (!this.builtins.has(input.id)) throw new SettingsError(`unknown built-in provider: ${input.id}`);
      return { kind: "builtin", id: input.id, enabled: input.enabled !== false };
    }
    if (input.kind !== "custom") throw new SettingsError("provider kind must be builtin or custom");
    if (!CUSTOM_ID.test(input.id)) throw new SettingsError("custom provider id must match custom-[a-z0-9-]");
    const name = String(input.name ?? "").trim();
    if (name === "") throw new SettingsError("provider name is empty");
    let baseUrl: URL;
    try {
      baseUrl = new URL(normalizeBaseUrl(String(input.baseUrl ?? "")));
    } catch {
      throw new SettingsError(`invalid base URL: ${input.baseUrl}`);
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") throw new SettingsError("base URL must be http(s)");
    const seen = new Set<string>();
    const models = (input.models ?? []).map((m) => {
      const id = String(m.id ?? "").trim();
      if (id === "" || seen.has(id)) throw new SettingsError(`model id empty or duplicated: ${id}`);
      seen.add(id);
      for (const [field, value] of [
        ["contextWindow", m.contextWindow],
        ["maxTokens", m.maxTokens],
      ] as const) {
        if (!Number.isInteger(value) || value <= 0) throw new SettingsError(`${id}: ${field} must be a positive integer`);
      }
      if (m.maxTokens > m.contextWindow) throw new SettingsError(`${id}: maxTokens exceeds contextWindow`);
      return { ...m, id, reasoning: Boolean(m.reasoning) };
    });
    return {
      kind: "custom",
      id: input.id,
      name,
      baseUrl: baseUrl.toString().replace(/\/$/, ""),
      requiresKey: input.requiresKey !== false,
      enabled: input.enabled !== false,
      models,
    };
  }

  private buildProvider(settings: ProviderSettings): Provider | undefined {
    if (settings.kind === "builtin") return this.builtins.get(settings.id);
    const models: Model<Api>[] = settings.models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      api: "openai-completions",
      provider: settings.id,
      baseUrl: settings.baseUrl,
      reasoning: m.reasoning,
      input: m.vision ? ["text", "image"] : ["text"],
      cost: { input: m.inputCostPerMillion ?? 0, output: m.outputCostPerMillion ?? 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      // pi-ai's own guidance for Ollama/vLLM/SGLang is supportsDeveloperRole: false; "system" is accepted by every OpenAI-compatible server.
      // Other compat fields stay auto-detected from baseUrl (e.g. DeepSeek thinking format).
      compat: { supportsDeveloperRole: false },
    }));
    const auth = settings.requiresKey
      ? envApiKeyAuth(`${settings.name} API key`, [])
      : { name: `${settings.name} (no key)`, resolve: async () => ({ auth: { apiKey: "no-key" }, source: "local server" }) };
    return createProvider({ id: settings.id, name: settings.name, baseUrl: settings.baseUrl, auth: { apiKey: auth }, models, api: openAICompletionsApi() });
  }

  private apply(): void {
    this.models.clearProviders();
    for (const settings of this.settings.providers) {
      if (!settings.enabled) continue;
      const provider = this.buildProvider(settings);
      if (provider !== undefined) this.models.setProvider(provider);
    }
  }

  private async save(next: ModelSettings): Promise<void> {
    await writePrivateJson(this.settingsPath, next);
    this.settings = next;
    this.apply();
  }
}

/** Ollama's native `/api` or `/api/chat` URL is a common paste; its OpenAI endpoint is `/v1`. */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (/:11434$/.test(value)) return `${value}/v1`;
  return value.replace(/\/api(\/chat)?$/, "/v1");
}
