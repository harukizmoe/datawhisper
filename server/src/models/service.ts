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
 * 用户配置的模型 provider。这里不托管任何东西：provider、模型和密钥全部来自用户。
 * 设置（不含密钥）保存在 `<dataDir>/models.json`；密钥保存在 SecretCredentialStore。
 *
 * 两种 provider：
 *  - builtin：pi-ai 内置 provider（模型目录、原生 API、思考等级映射都来自 pi-ai）
 *  - custom:  任何 OpenAI 兼容端点（Ollama、AtlasCloud、中转服务、自建服务）；
 *             模型及其上限由用户列出。
 *
 * 变更会应用到一个长期存在的 `Models` 实例上，因此 Harness（它读取
 * `models: () => service.models`）在下一次请求时就会用到新配置。
 */

export type CustomModel = {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  vision?: boolean;
  /** 每百万 token 的美元价格，可选（用于展示用量成本）。 */
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
      /** 对 Ollama 这类本地服务为 false。 */
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
 * 从旧的 LLM 配置沿用下来的端点预设（ollama、atlascloud）。模型及其上限由用户填写，
 * 这里不猜测任何上限。
 */
export const CUSTOM_PRESETS: readonly CustomPreset[] = [
  { presetId: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", requiresKey: false },
  { presetId: "atlascloud", name: "AtlasCloud", baseUrl: "https://api.atlascloud.ai/v1", requiresKey: true },
];

/** 设置类错误在 RPC 里的细分（`error.data.kind`）；默认是普通的输入不合法。 */
export type SettingsErrorKind = "invalid_input" | "unknown_model" | "unsupported_thinking_level";

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly kind: SettingsErrorKind = "invalid_input",
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

const CUSTOM_ID = /^custom-[a-z0-9][a-z0-9-]{0,47}$/;

/** 思考强度的全部取值（pi-ai 的 `ModelThinkingLevel`），用于把线上传来的字符串收窄成该类型。 */
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `null`/缺省表示「不指定」；其他取值必须落在 `ModelThinkingLevel` 里，否则是设置错误。 */
export function parseThinkingLevel(value: unknown): ModelThinkingLevel | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new SettingsError(`thinking level must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return value as ModelThinkingLevel;
}

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

  /** 用户可以启用的内置 provider id。 */
  builtinIds(): string[] {
    return [...this.builtins.keys()].sort();
  }

  /** 设置加上各 provider 的鉴权状态；绝不返回密钥。 */
  async view() {
    const providers = await Promise.all(
      this.settings.providers.map(async (p) => ({
        ...p,
        name: p.kind === "custom" ? p.name : (this.builtins.get(p.id)?.name ?? p.id),
        hasStoredKey: (await this.credentials.read(p.id)) !== undefined,
        keyRequired: p.kind === "custom" ? p.requiresKey : true,
        /** 实际生效的鉴权来源（"stored"、环境变量名、"local server"）；null = 未配置或已禁用。 */
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

  /** 按当前模型目录校验每个会话的选择；不合法时抛 SettingsError。 */
  resolve(ref: ModelRef, thinking: ModelThinkingLevel | null): Model<Api> {
    const model = this.models.getModel(ref.provider, ref.modelId);
    if (model === undefined) throw new SettingsError(`unknown model: ${ref.provider}/${ref.modelId}`, "unknown_model");
    if (thinking !== null && !getSupportedThinkingLevels(model).includes(thinking)) {
      throw new SettingsError(`${ref.provider}/${ref.modelId} does not support thinking level ${thinking}`, "unsupported_thinking_level");
    }
    return model;
  }

  /** 已启用且鉴权完整的 provider 的聊天模型。 */
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
   * 会话没有指定模型时使用的 agent 模型：保存的默认模型仍可用则用它，否则用第一个可用
   * 模型；保存的思考等级会被钳制到该模型支持的范围内。没有任何可用模型时为 undefined。
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
   * 通过真实 provider 发一次极小请求。`draft` 用于测试尚未保存的输入（“先测后存”）：
   * 其中的 provider 和密钥仅用于本次请求。
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
      // pi-ai 对 Ollama/vLLM/SGLang 的建议就是 supportsDeveloperRole: false；而 "system" 被所有 OpenAI 兼容服务接受。
      // 其余 compat 字段仍根据 baseUrl 自动探测（例如 DeepSeek 的 thinking 格式）。
      // supportsLongCacheRetention：缓存保留策略为 long 时才会带 `prompt_cache_key`（P0.3 的发现）。不认这个字段的
      // 端点会忽略它；识别不了前缀缓存的服务只是多收一个字段。
      compat: { supportsDeveloperRole: false, supportsLongCacheRetention: true },
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

/** 用户常粘贴 Ollama 原生的 `/api` 或 `/api/chat` URL；其 OpenAI 端点应为 `/v1`。 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim().replace(/\/+$/, "");
  if (/:11434$/.test(value)) return `${value}/v1`;
  return value.replace(/\/api(\/chat)?$/, "/v1");
}
