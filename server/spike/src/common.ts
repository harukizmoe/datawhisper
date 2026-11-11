import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createRegistry, type Extension, Harness, type HarnessSettings } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const ctx = BACKGROUND_CONTEXT;
export const MODEL = { provider: "stub", modelId: "stub-chat" } as const;
/** Same stub endpoint, declared as accepting mid-conversation system messages and tool additions (pi-ai compat). */
export const MODEL_ADDITIONS = { provider: "stub", modelId: "stub-chat-additions" } as const;

/** Models with one custom OpenAI-compatible provider pointed at `baseUrl` (the stub server). */
export function stubModels(baseUrl: string) {
  const model: Model<"openai-completions"> = {
    id: MODEL.modelId,
    name: "Stub chat",
    api: "openai-completions",
    provider: MODEL.provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  const models = createModels();
  models.setProvider(
    createProvider({
      id: MODEL.provider,
      name: "Stub",
      baseUrl,
      auth: { apiKey: { name: "Stub key", resolve: async () => ({ auth: { apiKey: "stub-key" } }) } },
      models: [
        model,
        {
          ...model,
          id: MODEL_ADDITIONS.modelId,
          name: "Stub chat (mid-conversation tool additions)",
          compat: { ...model.compat, supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}

/** Open a Harness on a SQLite file with the given extensions installed. Does not call `resume()`. */
export async function openHarness(dbPath: string, baseUrl: string, extensions: readonly Extension[], settings?: HarnessSettings) {
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const storage = await openNodeSqliteStorage(dbPath);
  return Harness.open(
    storage,
    {
      models: stubModels(baseUrl),
      registry,
      settings,
      identity: { attribution: null },
      onReport: (report) => console.error(`[report] ${report.kind}`, JSON.stringify({ ...report, error: String(report.error) })),
    },
    ctx,
  );
}
