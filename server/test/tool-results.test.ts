/**
 * P4.4 结果侧：超长结果外溢（`tr_*`）、`read_tool_result` 授权与哈希校验、证据声明（`ec_*`）。
 *
 * 全部用临时目录与固定时钟，不启动 Harness、不访问网络。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import {
  createArtifactTool,
  type AppTool,
  type AppToolDeps,
  type AppToolDetails,
} from "../src/tools/app/index.ts";
import { dataWhisperPolicies } from "../src/agent/policies.ts";
import { createEvidenceClaimStore } from "../src/tools/guard/evidence.ts";
import { applyToolResultGuard } from "../src/tools/guard/index.ts";
import {
  classifyToolError,
  previewText,
  recoverableArtifactLine,
  TOOL_RESULT_ERROR_MAX_CHARS,
  toolResultPolicy,
} from "../src/tools/guard/result-policy.ts";
import { createToolResultStore, type ToolResultStore } from "../src/tools/guard/spill.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "dw-tool-results-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const API = {} as unknown as ToolExecutionApi<AppToolDetails>;

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

function result(text: string, extra: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return { output: [{ type: "text", text }], ...extra };
}

function readTool(store: ToolResultStore, sessionId = "s1", workspaceId = "w1"): AppTool {
  const deps = { artifacts: store, sessionId, workspaceId } as unknown as AppToolDeps;
  const tool = createArtifactTool(deps).find((item) => item.name === "read_tool_result");
  if (tool === undefined) throw new Error("missing read_tool_result");
  return tool;
}

async function read(store: ToolResultStore, args: object, sessionId = "s1", workspaceId = "w1"): Promise<string> {
  return textOf(await readTool(store, sessionId, workspaceId).execute(args, API, BACKGROUND_CONTEXT));
}

describe("结果外溢阈值与预览", () => {
  test("恰好等于阈值不落盘，超出 1 个字符就落盘", () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    // query_data 的阈值是 2000（旧 `_TOOL_RESULT_POLICIES`）。
    expect(toolResultPolicy("query_data").persistThreshold).toBe(2_000);
    const atThreshold = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "x".repeat(2_000) });
    expect(atThreshold.persisted).toBe(false);
    expect(atThreshold.artifact).toBeUndefined();
    expect(atThreshold.preview).toBe("x".repeat(2_000));

    const overThreshold = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "x".repeat(2_001) });
    expect(overThreshold.persisted).toBe(true);
    expect(overThreshold.artifact?.artifact_id).toMatch(/^tr_[0-9a-f]{32}$/);
    expect(overThreshold.preview.endsWith("…[full result persisted; 2,001 chars / 1 lines total]")).toBe(true);
  });

  test("head / tail 截断朝向与旧后缀文案", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    const head = previewText(lines, { maxChars: 200, maxLines: 3 });
    expect(head.startsWith("line-1\nline-2\nline-3")).toBe(true);
    expect(head.endsWith(`…[full result persisted; ${lines.length} chars / 50 lines total]`)).toBe(true);

    const tail = previewText(lines, { maxChars: 200, maxLines: 3, retain: "tail" });
    expect(tail.startsWith("line-48\nline-49\nline-50")).toBe(true);
    expect(tail.endsWith(`…[full result persisted; ${lines.length} chars / 50 lines total]`)).toBe(true);
  });

  test("每行预览都受 previewLines 限制（query_data 为 20 行）", () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const text = Array.from({ length: 30 }, (_, index) => `row-${index + 1}-` + "x".repeat(80)).join("\n");
    const outcome = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: text });
    expect(outcome.persisted).toBe(true);
    expect(outcome.preview.split("\n")).toHaveLength(21);
    expect(outcome.preview).not.toContain("row-21");
  });
});

describe("模型看到的外溢文案与制品读取", () => {
  test("超过阈值后模型看到预览 + 指路行，完整内容可从制品读回", async () => {
    const dir = tempDir();
    const store = createToolResultStore({ dirs: [dir] });
    const full = "HEAD\n" + "y".repeat(3_000) + "\nTAIL";
    const guarded = applyToolResultGuard({
      name: "workspace_read_file",
      args: { file_path: "notes.txt" },
      result: result(full),
      store,
      sessionId: "s1",
      workspaceId: "w1",
    });
    expect(guarded).toBeDefined();
    const modelText = textOf(guarded!);
    expect(modelText.startsWith("HEAD\n")).toBe(true);
    expect(modelText).toContain(`…[full result persisted; ${full.length.toLocaleString("en-US")} chars / 3 lines total]`);

    const artifactId = /artifact:\/\/tool-result\/(tr_[0-9a-f]{32})/.exec(modelText)?.[1];
    expect(artifactId).toBeDefined();
    expect(modelText.endsWith(recoverableArtifactLine(artifactId!))).toBe(true);

    const record = JSON.parse(readFileSync(join(dir, `${artifactId}.json`), "utf8"));
    expect(record.version).toBe(1);
    expect(record.artifact_id).toBe(artifactId);
    expect(record.session_id).toBe("s1");
    expect(record.workspace_id).toBe("w1");
    expect(record.tool).toBe("workspace_read_file");
    expect(record.data).toBe(full);
    expect(record.sha256).toBe(createHash("sha256").update(full, "utf8").digest("hex"));

    const page = JSON.parse(await read(store, { artifact_id: artifactId, offset: 0, limit: 4_000 }));
    expect(page.content).toBe(full);
    expect(page.next_offset).toBeNull();
  });

  test("未超过阈值的结果原样返回，不写制品", () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const guarded = applyToolResultGuard({
      name: "get_table_detail",
      args: {},
      result: result("small"),
      store,
      sessionId: "s1",
    });
    expect(guarded).toBeUndefined();
  });

  test("错误结果只截到 1500 字符，不落盘", () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const guarded = applyToolResultGuard({
      name: "query_data",
      args: {},
      result: result("ERROR: " + "z".repeat(2_000), { isError: true }),
      store,
      sessionId: "s1",
    });
    const text = textOf(guarded!);
    expect(text.endsWith("\n…[error details truncated]")).toBe(true);
    expect(text.startsWith("ERROR: " + "z".repeat(TOOL_RESULT_ERROR_MAX_CHARS - 7))).toBe(true);
    expect(store.allowlist("s1")).toHaveLength(0);
  });

  test("没有 isError 标志时按文本分类判断成功与否", () => {
    expect(classifyToolError("ERROR: boom", "query_data")).toBe("tool_error");
    expect(classifyToolError("SQL Error: no such column: x", "query_data")).toBe("field_not_found");
    expect(classifyToolError("查询成功", "query_data")).toBe("");
    const store = createToolResultStore({ dirs: [tempDir()] });
    const guarded = applyToolResultGuard({
      name: "workspace_read_file",
      args: {},
      result: result("ERROR: " + "e".repeat(2_000)),
      store,
      sessionId: "s1",
    });
    expect(textOf(guarded!)).toContain("…[error details truncated]");
  });
});

describe("read_tool_result 授权", () => {
  test("不属于本会话的制品被拒绝", async () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const outcome = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "a".repeat(2_100) });
    const id = outcome.artifact!.artifact_id;
    expect(await read(store, { artifact_id: id }, "s2")).toBe("artifact is not available in this session");
    expect(await read(store, { artifact_id: "tr_deadbeef" }, "s1")).toBe("artifact is not available in this session");
  });

  test("工作区不匹配的制品被拒绝", async () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const outcome = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "b".repeat(2_100) });
    const id = outcome.artifact!.artifact_id;
    expect(await read(store, { artifact_id: id }, "s1", "w2")).toBe("artifact belongs to a different workspace");
  });

  test("超过最近 20 条的旧制品视为过期", async () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const ids: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const outcome = store.spill({
        sessionId: "s1",
        workspaceId: "w1",
        tool: "workspace_read_file",
        raw: `chunk-${index}\n` + "q".repeat(2_100),
      });
      ids.push(outcome.artifact!.artifact_id);
    }
    expect(store.allowlist("s1")).toHaveLength(20);
    expect(await read(store, { artifact_id: ids[0]! })).toBe("artifact is not available in this session");
    expect(JSON.parse(await read(store, { artifact_id: ids[20]! })).content).toContain("chunk-20");
  });

  test("文件被改写后 SHA-256 校验失败", async () => {
    const dir = tempDir();
    const store = createToolResultStore({ dirs: [dir] });
    const outcome = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "c".repeat(2_100) });
    const id = outcome.artifact!.artifact_id;
    const path = join(dir, `${id}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, data: "tampered" }), "utf8");
    expect(await read(store, { artifact_id: id })).toBe("artifact is missing or failed SHA-256 verification");
  });

  test("查询模式在授权通过的制品上分页与定位", async () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const outcome = store.spill({ sessionId: "s1", workspaceId: "w1", tool: "query_data", raw: "0123456789 needle " + "d".repeat(2_100) });
    const id = outcome.artifact!.artifact_id;
    const paged = JSON.parse(await read(store, { artifact_id: id, offset: 3, limit: 5 }));
    expect(paged.content).toBe("34567");
    const queried = JSON.parse(await read(store, { artifact_id: id, query: "needle" }));
    expect(queried.match_count).toBe(1);
    expect(queried.content).toContain("needle");
  });
});

describe("证据声明 ec_*", () => {
  test("数据派生工具生成证据声明，哈希可校验", () => {
    const claims = createEvidenceClaimStore({ dir: tempDir(), now: () => new Date(2026, 10, 4, 9, 5, 7) });
    const store = createToolResultStore({ dirs: [tempDir()] });
    const text = "col\n1\n2";
    const guarded = applyToolResultGuard({
      name: "query_data",
      args: { sql: "SELECT * FROM t", limit_rows: 100 },
      result: result(text),
      store,
      evidence: claims,
      sessionId: "s1",
      workspaceId: "w1",
    });
    const details = guarded!.details as Record<string, unknown>;
    const artifacts = details.artifacts as { type: string; claim_id?: string; result_sha256?: string }[];
    const claim = artifacts.find((item) => item.type === "evidence_claim");
    expect(claim?.claim_id).toMatch(/^ec_[0-9a-f]{32}$/);
    expect(claim?.result_sha256).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    expect((guarded!.diagnostics ?? []).some((item) => item.code === "evidence_claim")).toBe(true);

    const verified = claims.verify(claim!.claim_id!, { sessionId: "s1", workspaceId: "w1", raw: text });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.record.sql).toBe("SELECT * FROM t");
      expect(verified.record.sql_hash).toBe(createHash("sha256").update("SELECT * FROM t", "utf8").digest("hex"));
      expect(verified.record.args).toEqual({ limit_rows: 100 });
      expect(verified.record.created_at).toBe("2026-11-04T09:05:07");
    }

    const tampered = claims.verify(claim!.claim_id!, { sessionId: "s1", workspaceId: "w1", raw: text + "?" });
    expect(tampered).toEqual({ ok: false, error: "evidence claim result hash mismatch" });
    const otherSession = claims.verify(claim!.claim_id!, { sessionId: "s2", workspaceId: "w1" });
    expect(otherSession).toEqual({ ok: false, error: "evidence claim belongs to a different session" });
    const otherWorkspace = claims.verify(claim!.claim_id!, { sessionId: "s1", workspaceId: "w2" });
    expect(otherWorkspace).toEqual({ ok: false, error: "evidence claim belongs to a different workspace" });
    expect(claims.verify("ec_nope", { sessionId: "s1" })).toEqual({ ok: false, error: "evidence claim is missing" });
  });

  test("非数据派生工具不生成证据声明", () => {
    const claims = createEvidenceClaimStore({ dir: tempDir() });
    const store = createToolResultStore({ dirs: [tempDir()] });
    const guarded = applyToolResultGuard({
      name: "workspace_read_file",
      args: {},
      result: result("plain text"),
      store,
      evidence: claims,
      sessionId: "s1",
    });
    expect(guarded).toBeUndefined();
    expect(claims.persist({
      sessionId: "s1",
      tool: "workspace_read_file",
      raw: "plain text",
    })).toBeUndefined();
  });
});

describe("policies 接线", () => {
  test("dataWhisperPolicies 注入 store 后 afterTool 会外溢", async () => {
    const store = createToolResultStore({ dirs: [tempDir()] });
    const extension = dataWhisperPolicies({ toolResults: store, workspaceId: "w1" });
    const registration = extension.hooks?.find((item) => item.task === "pi.tool");
    const handlers = registration!.handlers as {
      afterTool(
        call: { id: string; name: string; arguments: Record<string, unknown> },
        result: ToolExecutionResult,
        api: ToolExecutionApi<AppToolDetails>,
        context: typeof BACKGROUND_CONTEXT,
      ): Promise<ToolExecutionResult | undefined>;
    };
    const api = { conversationId: "c1" } as unknown as ToolExecutionApi<AppToolDetails>;
    const guarded = await handlers.afterTool(
      { id: "call-1", name: "workspace_read_file", arguments: { file_path: "a.txt" } },
      result("L\n" + "m".repeat(2_500)),
      api,
      BACKGROUND_CONTEXT,
    );
    expect(textOf(guarded!)).toContain("[RECOVERABLE_ARTIFACTS] artifact://tool-result/tr_");
    expect(store.allowlist("c1")).toHaveLength(1);
  });
});
