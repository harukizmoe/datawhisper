import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import golden from "./golden/number-audit.json";
import { auditReportNumbers, collectNumberEvidence } from "../src/agent/number-audit.ts";

type Case = { report: string; evidence: string[]; context: string[]; unsupported: string[]; total: number };

describe("auditReportNumbers", () => {
  // 期望值来自运行 agent/number_audit.py（scripts/golden/export_number_audit.py）。
  test("matches the Python implementation on every golden case", () => {
    const failures: string[] = [];
    for (const [i, c] of (golden as Case[]).entries()) {
      const got = auditReportNumbers(c.report, c.evidence, c.context);
      if (got.total !== c.total || got.unsupported.join("|") !== c.unsupported.join("|")) {
        failures.push(`#${i} ${JSON.stringify(c.report.slice(0, 60))}: want ${c.total} [${c.unsupported}], got ${got.total} [${got.unsupported}]`);
      }
    }
    expect(failures).toEqual([]);
    expect((golden as Case[]).some((c) => c.total > 0)).toBe(true);
    expect((golden as Case[]).some((c) => c.total === 0)).toBe(true);
  });

  test("catches a transcription error and lists first-appearance order, capped at 15 with the full count", () => {
    expect(auditReportNumbers("总订单 2,956 单", ["rows: 1,956"])).toEqual({ unsupported: ["2956"], total: 1 });
    const report = Array.from({ length: 20 }, (_, i) => String(5000 + i * 11)).join(" ");
    const result = auditReportNumbers(report, []);
    expect(result.total).toBe(20);
    expect(result.unsupported).toHaveLength(15);
    expect(result.unsupported[0]).toBe("5000");
  });
});

describe("collectNumberEvidence", () => {
  test("tool results are evidence; user text and tool-call arguments are context; assistant prose is neither", () => {
    const messages: Message[] = [
      { role: "user", content: "我们有 8800 人", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我猜是 7777" },
          { type: "toolCall", id: "c1", name: "query_data", arguments: { sql: "SELECT 1 WHERE aqi > 150" } },
        ],
      } as Message,
      { role: "toolResult", toolCallId: "c1", toolName: "query_data", content: [{ type: "text", text: "rows: 1,956" }], isError: false, timestamp: 0 },
    ];
    const { evidence, context } = collectNumberEvidence(messages);
    expect(evidence).toEqual(["rows: 1,956"]);
    expect(context).toEqual(["我们有 8800 人", '{"sql":"SELECT 1 WHERE aqi > 150"}']);
    expect(auditReportNumbers("7777 与 8800 与 1956", evidence, context)).toEqual({ unsupported: ["7777"], total: 1 });
  });
});
