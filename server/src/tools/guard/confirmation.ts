/**
 * 工具确认策略的运行时检查（旧 `agent/tools/registry.py` 的 `confirmation` 只是元数据，运行时从未检查）。
 *
 * 四种模式的含义：
 * - `none`：直接放行。
 * - `explicit_request`：本轮用户消息里没有明确要求这个动作就拦下，让模型改为用纯文本提出请求。
 * - `argument`：调用参数里的确认字段必须为真（旧实现由各工具自己判 `confirm`，见
 *   `compute/tools/dispatch.py:46` 的 `as_bool_arg`、`agent/tools/workspace/files.py:752`）。
 * - `workflow`：只允许对应的确认/提案命令轮次调用，令牌与 `agent/output-guard.ts` 的输出类守卫同一套
 *   （斜杠命令或本轮 skill 名），文案也沿用旧实现的 `[SYSTEM BLOCK] … requires a slash command.`。
 *
 * 拦截用 pi-durable `beforeTool` 的 `block` 交回模型，模型能读到原因并改道。
 */

import { blockMessage } from "../../agent/output-guard.ts";
import { say } from "../../i18n.ts";
import type { ToolSpec } from "../registry.ts";

/** 旧 `compute/tools/dispatch.py:46` 的 `as_bool_arg`：字符串 `"False"` 不算 true。 */
export function asBoolArg(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return false;
}

/**
 * `argument` 模式各工具的确认字段与旧实现原话。
 *
 * 旧实现没有统一的运行时检查，拦截文案来自各工具自身；这里原样保留，
 * 未知工具退回通用文案。
 */
const ARGUMENT_POLICY: Readonly<Record<string, { readonly field: string; readonly message: string }>> = {
  delete_analysis_tables: {
    field: "confirm",
    // 取值时才按当前语言生成，策略表本身在模块加载时构建。
    get message() {
      return say("❌ Deleting analysis tables requires confirm=true.", "❌ 删除分析表需要 confirm=true。");
    },
  },
  workspace_delete_file: { field: "confirm", message: "file deletion requires confirm=true" },
};

export type ConfirmationInput = {
  readonly name: string;
  /** 注册表元数据；查不到时按 `none` 放行（未登记的工具由别的层负责）。 */
  readonly spec: ToolSpec | undefined;
  readonly args: Readonly<Record<string, unknown>>;
  /** 本轮解锁令牌：斜杠命令名，或本轮由 skill 启动时的技能名；都没有时为空串。 */
  readonly token: string;
  /** 本轮用户消息原文。 */
  readonly message: string;
};

/** 本轮用户消息是否明确要求了该工具的动作：命令/技能激活，或命中该工具的发现关键词。 */
function messageRequestsTool(spec: ToolSpec, token: string, message: string): boolean {
  if (token !== "" && (spec.commands.has(token) || spec.skills.has(token))) return true;
  const text = message.trim().toLowerCase();
  if (text === "") return false;
  // 发现关键词就是用户提到这个动作时的自然说法（旧实现用它决定工具可见性）。
  const terms = [spec.name, ...spec.discoveryKeywords];
  return terms.some((term) => term !== "" && text.includes(term.toLowerCase()));
}

/** 返回拦下原因；放行时返回 `undefined`。 */
export function confirmationBlock(input: ConfirmationInput): string | undefined {
  const spec = input.spec;
  if (spec === undefined || spec.confirmation === "none") return undefined;
  const unlocked = input.token !== "" && (spec.commands.has(input.token) || spec.skills.has(input.token));

  if (spec.confirmation === "workflow") {
    return unlocked ? undefined : blockMessage(input.name);
  }

  if (spec.confirmation === "argument") {
    const policy = ARGUMENT_POLICY[input.name] ?? { field: "confirm", message: `[SYSTEM BLOCK] '${input.name}' requires confirm=true.` };
    return asBoolArg(input.args[policy.field]) ? undefined : policy.message;
  }

  // explicit_request：命令/技能激活本身就算用户明确请求；否则看消息里有没有提到这个动作。
  if (unlocked) return undefined;
  if (messageRequestsTool(spec, input.token, input.message)) return undefined;
  return (
    `[SYSTEM BLOCK] '${input.name}' has side effects and the user did not explicitly request it in this turn. ` +
    "Tell the user what you would do and wait for them to ask; do not retry on your own."
  );
}
