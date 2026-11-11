import { describe, expect, test } from "bun:test";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import golden from "./golden/compaction.json";
import { compactionOverrides, harnessSettings, reserveTokensFor } from "../src/agent/settings.ts";
import { loadConfig } from "../src/config.ts";
import { type Service, startService } from "../src/service.ts";
import { startStub } from "./support/stub-openai.ts";
import { STUB_MODEL, stubProvider } from "./support/stub-models.ts";

type Case = { contextWindow: number; threshold: number };
const cases = golden as unknown as Case[];

describe("压缩阈值", () => {
  // 期望值来自旧实现 agent/compaction.py 的 compaction_threshold（scripts/golden/export_compaction.py）。
  test("预留量等于旧实现的固定预留阈值：窗口减预留即可输入上限", () => {
    const failures = cases
      .map(({ contextWindow, threshold }) => ({ contextWindow, got: contextWindow - reserveTokensFor(contextWindow), want: threshold }))
      .filter((row) => row.got !== row.want);
    expect(failures).toEqual([]);
  });

  test("逐模型覆盖按 provider/modelId 生成，且预留不超过窗口本身", () => {
    const overrides = compactionOverrides(
      [
        { provider: "p", modelId: "small" },
        { provider: "p", modelId: "large" },
        { provider: "p", modelId: "unknown" },
      ],
      (ref) => (ref.modelId === "small" ? 8_192 : ref.modelId === "large" ? 1_000_000 : undefined),
    );
    expect(Object.keys(overrides).sort()).toEqual(["p/large", "p/small"]);
    expect(overrides["p/small"]!.reserveTokens).toBe(8_192 - 3_278);
    for (const [key, value] of Object.entries(overrides)) {
      const window = key === "p/small" ? 8_192 : 1_000_000;
      expect(value.reserveTokens).toBeLessThan(window);
      expect(value.backgroundTokens).toBeGreaterThan(0);
      expect(value.backgroundTokens).toBeLessThanOrEqual(value.reserveTokens);
    }
  });

  test("设置默认开启压缩与 long 缓存保留，并把 afterFailedRun 设为 continue", () => {
    const settings = harnessSettings({ models: [], contextWindowOf: () => undefined });
    expect(settings.stream).toEqual({ cacheRetention: "long" });
    expect(settings.compaction).toMatchObject({ enabled: true, keepRecentTokens: 8_000 });
    expect(settings.afterFailedRun).toBe("continue");
  });
});

describe("prompt cache", () => {
  test("请求体带 prompt_cache_key 与 24h 保留（P0.3 发现的问题不再出现）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-cache-test-"));
    const stub = startStub({ chunkDelayMs: 0 });
    const service: Service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
    try {
      await service.modelService.putProvider(stubProvider(stub.url));
      await service.submitTurn("root", { requestId: "cache", text: "你好" });
      await (await service.harness.root(ctx)).waitForIdle(ctx);
      const body = stub.log[0]!.body as Record<string, unknown>;
      expect(typeof body.prompt_cache_key).toBe("string");
      expect(body.prompt_cache_key).not.toBe("");
      expect(body.prompt_cache_retention).toBe("24h");
    } finally {
      await service.stop();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("用量汇总可通过 usage.summary 读到（与订阅视图里的 pi.usage 同一份数据）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-usage-test-"));
    const stub = startStub({ chunkDelayMs: 0 });
    const service: Service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
    try {
      await service.modelService.putProvider(stubProvider(stub.url));
      await service.submitTurn("root", { requestId: "usage", text: "你好" });
      const root = await service.harness.root(ctx);
      await root.waitForIdle(ctx);
      const usage = await service.harness.usage(ctx);
      const key = `${STUB_MODEL.provider}/${STUB_MODEL.modelId}`;
      expect(Object.keys(usage.models)).toContain(key);
      expect(usage.models[key]!.input).toBeGreaterThan(0);
      const view = (await root.watch(ctx)).value;
      expect(view.docs["pi.usage"]).toBeDefined();
    } finally {
      await service.stop();
      stub.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
