import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { type Service, startService } from "../src/service.ts";
import { assembleTools } from "../src/tools/assemble.ts";
import { createComputeTools } from "../src/tools/compute/index.ts";

/**
 * 装配层面的接线：外溢器与 `read_tool_result` 必须是同一个 store。
 *
 * 分开建两个 store（一个写、一个读）时，模型会拿到 `tr_...` 指路行却读不到内容——
 * 这条用例就是防这个回归：走真实 `assembleTools`，外溢一次，再用工具读回来。
 */
let service: Service;
let dir: string;

afterAll(async () => {
  await service?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("工具结果外溢接线", () => {
  test("外溢的 tr_* 能被 read_tool_result 读到", async () => {
    dir = mkdtempSync(join(tmpdir(), "dw-spill-wiring-"));
    service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true });
    const assembled = assembleTools(loadConfig({ DW_DATA_DIR: dir }), service.compute, "local", {
      harness: () => service.harness,
      context: service.context,
    });
    const readTool = assembled.tools.find((tool) => tool.name === "read_tool_result");
    expect(readTool).toBeDefined();

    const payload = "x".repeat(20_000);
    const spilled = assembled.toolResults.spill({ sessionId: "local", tool: "workspace_read_file", raw: payload });
    expect(spilled.persisted).toBe(true);
    const artifactId = spilled.artifact?.artifact_id ?? "";
    expect(artifactId).toMatch(/^tr_/);

    const result = (await readTool!.execute({ artifact_id: artifactId, limit: 50 }, {} as never, undefined as never)) as {
      output: { type: string; text: string }[];
      isError?: true;
    };
    expect(result.isError).toBeUndefined();
    expect(result.output[0]!.text).toContain("x".repeat(50));

    // 读一个没外溢过的 id 必须被拒（授权来自 store 的会话 allowlist，不是目录存在即可读）。
    const denied = (await readTool!.execute({ artifact_id: "tr_00000000000000000000000000000000" }, {} as never, undefined as never)) as {
      isError?: true;
      output: { text: string }[];
    };
    expect(denied.isError).toBe(true);
    expect(denied.output[0]!.text).toContain("not available in this session");
    expect(createComputeTools({ compute: service.compute })).toHaveLength(14);
  });
});
