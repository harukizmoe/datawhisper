/**
 * Real-provider smoke check (P3.1 acceptance): one streamed conversation turn per given model, through the same path the
 * app uses (ModelService -> Harness -> conversation -> pi.live.generation partials). Runs in a throwaway data dir that is
 * deleted afterwards; never prints or persists keys outside it.
 *
 *   bun --env-file ~/.config/datawhisper/smoke.env run scripts/provider-smoke.ts \
 *     deepseek/deepseek-flash anthropic/claude-haiku-4-5 ollama/qwen3:0.6b atlascloud/moonshotai/kimi-k2.6
 *
 * `<provider>/<modelId>`: a pi-ai built-in provider id (its usual env var, e.g. DEEPSEEK_API_KEY, supplies the key) or a
 * custom endpoint preset id (ollama: no key; atlascloud: ATLASCLOUD_API_KEY). Exit code 1 when any model fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { CUSTOM_PRESETS } from "../src/models/service.ts";
import { startService } from "../src/service.ts";

const TURN_TIMEOUT_MS = 120_000;
const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error("usage: bun run scripts/provider-smoke.ts <provider>/<modelId> ...");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "dw-provider-smoke-"));
const service = await startService(loadConfig({ DW_DATA_DIR: dir }), {
  forceFileCredentials: true,
});
const { modelService, harness } = service;
let failures = 0;

try {
  for (const spec of specs) {
    const slash = spec.indexOf("/");
    const providerArg = spec.slice(0, slash);
    const modelId = spec.slice(slash + 1);
    const preset = CUSTOM_PRESETS.find((p) => p.presetId === providerArg);
    const provider = preset === undefined ? providerArg : `custom-${preset.presetId}`;
    const report = (ok: boolean, detail: string) => {
      if (!ok) failures += 1;
      console.log(`${ok ? "OK  " : "FAIL"} ${spec}  ${detail}`);
    };
    if (slash <= 0 || modelId === "") {
      report(false, "expected <provider>/<modelId>");
      continue;
    }

    try {
      if (preset === undefined) {
        await modelService.putProvider({ kind: "builtin", id: provider, enabled: true });
      } else {
        await modelService.putProvider({
          kind: "custom",
          id: provider,
          name: preset.name,
          baseUrl: preset.baseUrl,
          requiresKey: preset.requiresKey,
          enabled: true,
          models: [{ id: modelId, contextWindow: 128_000, maxTokens: 4_096, reasoning: false }],
        });
        const envName = `${preset.presetId.toUpperCase()}_API_KEY`;
        const key = process.env[envName];
        if (preset.requiresKey && key === undefined) throw new Error(`${envName} is not set`);
        if (key !== undefined) await modelService.setApiKey(provider, key);
      }
      const auth = await modelService.models.checkAuth(provider);
      if (auth === undefined) throw new Error(`no key configured for ${provider} (set its API key env var)`);
      const model = { provider, modelId };
      try {
        modelService.resolve(model, null);
      } catch {
        const known = modelService.models.getModels(provider).map((m) => m.id);
        throw new Error(`unknown model; ${provider} has: ${known.join(", ")}`);
      }

      const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
      const watch = await conversation.watch(ctx);
      let partials = 0;
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const live = (watch.value.docs["pi.live"] ?? {}) as LiveState;
        if (live.generation?.message?.content.some((block) => block.type === "text" && block.text !== "")) partials += 1;
      });
      await conversation.submit({ type: "input", content: "用一句话介绍你自己。", requestId: "smoke", whenBusy: "followUp" }, ctx);
      const timeout = Promise.withResolvers<"timeout">();
      const timer = setTimeout(() => timeout.resolve("timeout"), TURN_TIMEOUT_MS);
      const outcome = await Promise.race([conversation.waitForIdle(ctx).then(() => "idle" as const), timeout.promise]);
      clearTimeout(timer);
      if (outcome === "timeout") await conversation.abort(ctx);
      const entries = watch.value.entries;
      await watch.stop();
      if (outcome === "timeout") throw new Error(`no answer within ${TURN_TIMEOUT_MS / 1000}s`);

      const message = entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0] as AssistantMessage | undefined;
      if (message === undefined) throw new Error("run ended without an assistant entry");
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (message.stopReason === "error" || message.stopReason === "aborted" || text === "") {
        throw new Error(`stopReason=${message.stopReason} ${message.errorMessage ?? ""}`.trim());
      }
      report(
        true,
        `auth=${auth.source ?? auth.type} partials=${partials} tokens in/out=${message.usage.input}/${message.usage.output} ` +
          `reply=${JSON.stringify(text.slice(0, 80))}`,
      );
    } catch (error) {
      report(false, error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  await service.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
