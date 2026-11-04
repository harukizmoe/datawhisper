import type { ProviderSettings } from "../../src/models/service.ts";

export const STUB_MODEL = { provider: "custom-stub", modelId: "stub-chat" } as const;

/** 一个指向 `baseUrl`（stub-openai.ts 的 stub 服务器）的免密钥自定义 OpenAI 兼容 provider。 */
export function stubProvider(baseUrl: string): ProviderSettings {
  return {
    kind: "custom",
    id: STUB_MODEL.provider,
    name: "Stub",
    baseUrl,
    requiresKey: false,
    enabled: true,
    models: [
      { id: STUB_MODEL.modelId, contextWindow: 128_000, maxTokens: 4_096, reasoning: false },
      { id: "stub-reasoner", contextWindow: 128_000, maxTokens: 4_096, reasoning: true },
    ],
  };
}
