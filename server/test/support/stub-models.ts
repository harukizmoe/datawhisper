import type { ProviderSettings } from "../../src/models/service.ts";

export const STUB_MODEL = { provider: "custom-stub", modelId: "stub-chat" } as const;

/** A keyless custom OpenAI-compatible provider pointed at `baseUrl` (the stub server of stub-openai.ts). */
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
