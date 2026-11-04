import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import type { Settings } from "@earendil-works/pi-durable";

/**
 * Harness 运行策略：自动压缩与 prompt cache。
 *
 * 旧实现自己写了一套压缩（`agent/compaction.py`：固定预留阈值、超阈值后摘要、早期触发），新实现用 pi-durable
 * 自带的压缩。这里只把旧实现的阈值换算成 pi-durable 的策略字段，并保留"小窗口也要留出可用输入"这条约束。
 *
 * prompt cache：P0.3 发现请求体里没有 `prompt_cache_key`。原因在 pi-ai：它只在 baseUrl 属于 api.openai.com、或
 * `cacheRetention === "long"` 时补这个字段（`dist/api/openai-completions.js` 的 `buildParams`）。pi-durable 的
 * `ConversationStreamOptions.cacheRetention` 会一路传到 pi-ai，所以正确做法是配置 `stream.cacheRetention`，
 * 而不是在 `beforeProviderRequest` 里手工塞字段——后者还要自己判断"这个提供商认不认这个字段"。
 */

/** 旧实现的输出预留上限，与 `agent/compaction.py` 的 `_DEFAULT_OUTPUT_RESERVE` 一致。 */
const OUTPUT_RESERVE = 384_000;
/** 旧实现每轮的额外安全余量。 */
const TURN_SAFETY_MARGIN = 8_000;
/** 旧实现保留最近上下文的大小；与 pi-durable 文档示例一致。 */
const KEEP_RECENT_TOKENS = 8_000;
/** 后台压缩最多提前这么多 token 开始，避免小窗口模型毫无提前量的同时也不拖太早。 */
const MAX_BACKGROUND_LEAD = 32_768;

/**
 * 旧 `compaction_threshold` 的等价预留量：输出预留与安全余量各按窗口比例封顶，总预留不超过 65%，保证至少 35%
 * 的窗口留给输入。
 */
export function reserveTokensFor(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  const output = Math.min(OUTPUT_RESERVE, Math.max(1_000, Math.trunc(contextWindow * 0.45)));
  const safety = Math.min(TURN_SAFETY_MARGIN, Math.max(1_000, Math.trunc(contextWindow * 0.15)));
  // 极小窗口下 65% 可能为 0：此时不预留（旧实现同样退化成"阈值等于窗口"），但仍不能占满整个窗口。
  const reserve = Math.min(output + safety, Math.trunc(contextWindow * 0.65));
  return Math.max(0, Math.min(reserve, contextWindow - 1));
}

/** 为已知模型逐个算预留量；pi-durable 的 `modelOverrides` 按精确 `"provider/modelId"` 生效。 */
export function compactionOverrides(refs: readonly ModelRef[], contextWindowOf: (ref: ModelRef) => number | undefined) {
  const overrides: Record<string, { reserveTokens: number; backgroundTokens: number }> = {};
  for (const ref of refs) {
    const contextWindow = contextWindowOf(ref);
    if (contextWindow === undefined) continue;
    const reserve = reserveTokensFor(contextWindow);
    const background = Math.max(4_096, Math.min(reserve, MAX_BACKGROUND_LEAD));
    overrides[`${ref.provider}/${ref.modelId}`] = { reserveTokens: reserve, backgroundTokens: background };
  }
  return overrides;
}

/**
 * 组装 Harness 设置。`cacheRetention` 的默认值是 "long"：pi-ai 只在 long 时才给任意 OpenAI 兼容端点带
 * `prompt_cache_key` 与 24h 保留（api.openai.com 上 short 也会带）。提供商不支持时由它自己忽略。
 */
export function harnessSettings(options: {
  /** 当前可用的模型，用于生成逐模型压缩阈值。 */
  models: readonly ModelRef[];
  contextWindowOf: (ref: ModelRef) => number | undefined;
  /** 覆盖默认缓存保留策略；用户可在设置里关掉。 */
  cacheRetention?: Settings["stream"]["cacheRetention"];
}): HarnessSettings {
  return {
    stream: { cacheRetention: options.cacheRetention ?? "long" },
    compaction: {
      enabled: true,
      keepRecentTokens: KEEP_RECENT_TOKENS,
      modelOverrides: compactionOverrides(options.models, options.contextWindowOf),
    },
    // 一轮失败但后面还有排队输入时继续跑，避免用户连发两条消息后第二条永远卡住。
    afterFailedRun: "continue",
  };
}
