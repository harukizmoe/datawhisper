import { describe, expect, test } from "bun:test";
import golden from "./golden/hook-policies.json";
import { blockedOutputTools, blockMessage, guardToken, OUTPUT_TOOL_GUARDS } from "../src/agent/output-guard.ts";
import { parseTextFallbackToolCalls } from "../src/agent/text-fallback.ts";

type Golden = { parse: { content: string; calls: [string, Record<string, string>][] }[]; guards: Record<string, string[]> };

const cases = golden as unknown as Golden;
const NONE = { kind: "none", name: "" };

describe("parseTextFallbackToolCalls", () => {
  // 期望值来自 agent/agent.py 的 `_parse_text_fallback_tool_calls`（scripts/golden/export_hook_policies.py）。
  test("matches the Python parser on every golden case", () => {
    const failures = cases.parse.flatMap(({ content, calls }) => {
      const got = parseTextFallbackToolCalls(content).map((c) => [c.name, c.args]);
      return JSON.stringify(got) === JSON.stringify(calls) ? [] : [`${JSON.stringify(content)}: want ${JSON.stringify(calls)} got ${JSON.stringify(got)}`];
    });
    expect(failures).toEqual([]);
    expect(cases.parse.some((c) => c.calls.length > 0)).toBe(true);
  });

  test("ignores unknown and differently-cased tool names; repeated parameters keep the last value", () => {
    expect(parseTextFallbackToolCalls('<other><parameter name="x">1</parameter></other>')).toEqual([]);
    // 标签正则是大小写不敏感的，但 allowlist 不是：Python 同样会丢弃大写名称。
    expect(parseTextFallbackToolCalls('<EDIT_DIAGRAM><PARAMETER NAME="id">3</PARAMETER></EDIT_DIAGRAM>')).toEqual([]);
    expect(parseTextFallbackToolCalls('<display_diagram><parameter name="xml">a</parameter><parameter name="xml">b</parameter></display_diagram>')).toEqual([
      { name: "display_diagram", args: { xml: "b" } },
    ]);
  });
});

describe("output tools", () => {
  test("the guard table matches Python's", () => {
    expect(Object.fromEntries(Object.entries(OUTPUT_TOOL_GUARDS).map(([name, tokens]) => [name, [...tokens].sort()]))).toEqual(cases.guards);
  });

  test("only the matching command or builtin skill unlocks a guarded tool", () => {
    const batch = ["propose_ppt_outline", "generate_ppt", "query_data"];
    expect(blockedOutputTools(batch, "").map((b) => b.name)).toEqual(["propose_ppt_outline", "generate_ppt"]);
    expect(blockedOutputTools(batch, "ppt").map((b) => b.name)).toEqual(["generate_ppt"]);
    // 每个工具有自己的 token 集合：confirm 步骤解锁 generate_*，但不解锁 propose_*。
    expect(blockedOutputTools(batch, "ppt_confirm").map((b) => b.name)).toEqual(["propose_ppt_outline"]);
    expect(blockedOutputTools(["generate_dashboard"], "dashboard").map((b) => b.name)).toEqual(["generate_dashboard"]);
    expect(blockedOutputTools(["export_report"], "report_confirm")).toEqual([]);
    expect(blockedOutputTools(["export_report"], "report").map((b) => b.name)).toEqual(["export_report"]);
    expect(blockedOutputTools(["export_excel"], "excel_revise").map((b) => b.name)).toEqual(["export_excel"]);
  });

  test("a blocked call carries the SYSTEM BLOCK instruction the model sees", () => {
    const [blocked] = blockedOutputTools(["generate_ppt"], "");
    expect(blocked!.reason).toBe(blockMessage("generate_ppt"));
    expect(blocked!.reason).toContain("[SYSTEM BLOCK] 'generate_ppt' requires a slash command.");
    expect(blocked!.reason).toContain("Do NOT call output tools in regular chat.");
  });

  test("a skill turn uses the skill name as the token; a chat turn has none", () => {
    expect(guardToken("report", { kind: "skill", name: "ppt" })).toBe("report");
    expect(guardToken(undefined, { kind: "skill", name: "dashboard" })).toBe("dashboard");
    expect(guardToken("", { kind: "none", name: "" })).toBe("");
    expect(guardToken(undefined, NONE)).toBe("");
    expect(blockedOutputTools(["propose_dashboard_outline"], guardToken(undefined, { kind: "skill", name: "dashboard" }))).toEqual([]);
  });
});
