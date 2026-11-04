/**
 * P4.4 确认策略的运行时检查：`registry` 的 `confirmation` 不再只是元数据。
 *
 * 直接调用检查函数覆盖四种模式，再通过 `dataWhisperPolicies()` 的 `beforeTool` 走一遍真实接线
 * （旧实现这里从未检查过，见 `docs/refactor/pi-durable-plan.md` §3 缺陷 2）。
 */

import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { dataWhisperPolicies } from "../src/agent/policies.ts";
import { EMPTY_TURN_CONTEXT, type TurnContext } from "../src/agent/turn.ts";
import { confirmationBlock } from "../src/tools/guard/confirmation.ts";
import { blockMessage } from "../src/agent/output-guard.ts";
import { getToolSpec, ToolSpec } from "../src/tools/registry.ts";

function check(name: string, options: { args?: Record<string, unknown>; token?: string; message?: string } = {}): string | undefined {
  return confirmationBlock({
    name,
    spec: getToolSpec(name),
    args: options.args ?? {},
    token: options.token ?? "",
    message: options.message ?? "",
  });
}

describe("confirmation = none", () => {
  test("放行，也不看参数与消息", () => {
    expect(check("workspace_glob", { message: "" })).toBeUndefined();
    expect(check("query_data", { args: { sql: "SELECT 1" }, message: "随便聊聊" })).toBeUndefined();
  });
});

describe("confirmation = explicit_request", () => {
  test("用户消息明确提到这个动作时放行", () => {
    expect(check("workspace_write_file", { message: "请新建文件 output.csv，把结果写进去" })).toBeUndefined();
    expect(check("team_create", { message: "帮我创建一个团队" })).toBeUndefined();
  });

  test("用户消息没有明确要求时拦下", () => {
    const block = check("workspace_write_file", { message: "看看这份数据的分布" });
    expect(block).toBe(
      "[SYSTEM BLOCK] 'workspace_write_file' has side effects and the user did not explicitly request it in this turn. " +
      "Tell the user what you would do and wait for them to ask; do not retry on your own.",
    );
  });

  test("空消息（例如仅继续）不放行", () => {
    expect(check("team_create", { message: "" })).toContain("[SYSTEM BLOCK]");
    expect(check("team_create", { message: "   " })).toContain("[SYSTEM BLOCK]");
  });

  test("本轮由 skill 启动时，技能名本身算明确请求", () => {
    // display_diagram 的 skills 含 business-model-canvas（旧 `_guard_token` 同款规则）。
    expect(check("display_diagram", { token: "business-model-canvas", message: "" })).toBeUndefined();
    expect(check("display_diagram", { token: "ppt", message: "" })).toContain("[SYSTEM BLOCK]");
  });
});

describe("confirmation = argument", () => {
  test("delete_analysis_tables 沿用旧文案「❌ 删除分析表需要 confirm=true。」", () => {
    expect(check("delete_analysis_tables", { args: { table_names: ["t"], confirm: true } })).toBeUndefined();
    expect(check("delete_analysis_tables", { args: { table_names: ["t"], confirm: false } })).toBe("❌ 删除分析表需要 confirm=true。");
    expect(check("delete_analysis_tables", { args: { table_names: ["t"] } })).toBe("❌ 删除分析表需要 confirm=true。");
  });

  test("workspace_delete_file 沿用旧文案「file deletion requires confirm=true」并接受字符串 true", () => {
    expect(check("workspace_delete_file", { args: { file_path: "a.csv", confirm: "true" } })).toBeUndefined();
    expect(check("workspace_delete_file", { args: { file_path: "a.csv", confirm: "False" } })).toBe("file deletion requires confirm=true");
  });

  test("未登记文案的工具退回通用文案", () => {
    const spec = new ToolSpec({ name: "custom_destructive", category: "write", confirmation: "argument" });
    const run = (args: Record<string, unknown>): string | undefined =>
      confirmationBlock({ name: "custom_destructive", spec, args, token: "", message: "删除" });
    expect(run({ confirm: true })).toBeUndefined();
    expect(run({})).toBe("[SYSTEM BLOCK] 'custom_destructive' requires confirm=true.");
  });
});

describe("confirmation = workflow", () => {
  test("只有对应的确认命令放行", () => {
    expect(check("generate_ppt", { token: "ppt_confirm" })).toBeUndefined();
    expect(check("export_excel", { token: "excel_confirm" })).toBeUndefined();
    expect(check("export_report", { token: "report_confirm" })).toBeUndefined();
    expect(check("generate_dashboard", { token: "dashboard_confirm" })).toBeUndefined();
  });

  test("其他命令与普通对话拦下，文案与输出类守卫逐字一致", () => {
    expect(check("generate_ppt", { token: "ppt" })).toBe(blockMessage("generate_ppt"));
    expect(check("generate_ppt", { token: "" })).toBe(
      "[SYSTEM BLOCK] 'generate_ppt' requires a slash command. " +
      "Do NOT call output tools in regular chat. " +
      "Reply to the user in plain text, and suggest the relevant slash command if appropriate.",
    );
    expect(check("generate_ppt", { token: "excel_confirm" })).toBe(blockMessage("generate_ppt"));
  });
});

describe("beforeTool 接线", () => {
  test("policies 的 beforeTool 真的拦下未确认的调用", async () => {
    const extension = dataWhisperPolicies();
    const registration = extension.hooks?.find((item) => item.task === "pi.tool");
    expect(registration).toBeDefined();
    const handlers = registration!.handlers as {
      beforeTool(call: ToolHookCall, api: HookApi, context: typeof BACKGROUND_CONTEXT): Promise<{ block?: string } | undefined>;
    };

    const makeApi = (turn: TurnContext): HookApi =>
      ({
        conversationId: "c1",
        snapshot: async () => turn,
      }) as unknown as HookApi;

    const call = (name: string, args: Record<string, unknown>): ToolHookCall =>
      ({ id: "call-1", name, arguments: args }) as ToolHookCall;

    const blocked = await handlers.beforeTool(
      call("delete_analysis_tables", { table_names: ["t"] }),
      makeApi({ ...EMPTY_TURN_CONTEXT, message: "删掉 t 表" }),
      BACKGROUND_CONTEXT,
    );
    expect(blocked).toEqual({ block: "❌ 删除分析表需要 confirm=true。" });

    const confirmed = await handlers.beforeTool(
      call("delete_analysis_tables", { table_names: ["t"], confirm: true }),
      makeApi({ ...EMPTY_TURN_CONTEXT, message: "删掉 t 表" }),
      BACKGROUND_CONTEXT,
    );
    expect(confirmed).toBeUndefined();

    // 普通对话里调用 propose 类输出工具仍走旧的输出类守卫（令牌不匹配）。
    const outputBlocked = await handlers.beforeTool(
      call("generate_ppt", { title: "x", slides: [] }),
      makeApi({ ...EMPTY_TURN_CONTEXT, message: "帮我生成 ppt" }),
      BACKGROUND_CONTEXT,
    );
    expect(outputBlocked).toEqual({ block: blockMessage("generate_ppt") });

    // 斜杠命令轮次放行。
    const allowed = await handlers.beforeTool(
      call("generate_ppt", { title: "x", slides: [] }),
      makeApi({ ...EMPTY_TURN_CONTEXT, message: "确认生成 ppt", command: "ppt_confirm", activation: { kind: "command", name: "ppt_confirm" } }),
      BACKGROUND_CONTEXT,
    );
    expect(allowed).toBeUndefined();
  });
});
