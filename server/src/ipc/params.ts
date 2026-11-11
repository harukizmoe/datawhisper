/**
 * IPC 入参的形状校验：每个方法在入口处声明「这个键是什么类型、可不可以省略」，
 * 用一份声明代替散落的 `typeof x !== "string"` 判断。
 *
 * 只校验形状（类型、必填、模式、长度/项数），语义检查（工作区是否存在、路径是否越界、
 * 会话是否属于该工作区）仍在各自的方法里做。错误统一走 `invalidParams`，桌面端按
 * `code = -32602` 显示提示；文案由调用方按旧实现的措辞给出，避免界面上的文案漂移。
 */

import { invalidParams } from "./errors.ts";
import type { MethodParams } from "./rpc.ts";

/** 一个键的期望形状；`optional` 为真时 `undefined` 直接放行。 */
export type ParamRule = {
  readonly type: "string" | "integer" | "boolean" | "array" | "object";
  /** 覆盖默认错误文案；需要与旧实现逐字一致时用。 */
  readonly message?: string;
  /** 缺省时的文案（旧实现在「没传」与「传错」上常常给不同句子）。 */
  readonly missingMessage?: string;
  /** 只对字符串生效：整体必须匹配（不是「包含」）。 */
  readonly pattern?: RegExp;
  /** 只对字符串生效：最短长度。 */
  readonly minLength?: number;
  /** 只对数组生效：最少/最多项数。 */
  readonly minItems?: number;
  readonly maxItems?: number;
  /** 数组元素的形状；省略时元素不做进一步检查。 */
  readonly items?: ParamRule;
  readonly optional?: boolean;
};

export type ParamRules = Readonly<Record<string, ParamRule>>;

const TYPE_LABELS: Record<ParamRule["type"], string> = {
  string: "a string",
  integer: "an integer",
  boolean: "a boolean",
  array: "an array",
  object: "an object",
};

/** 校验一个值；不合法时返回要报的文案，合法时返回 undefined。 */
function failure(rule: ParamRule, value: unknown, key: string): string | undefined {
  const message = rule.message ?? `'${key}' must be ${TYPE_LABELS[rule.type]}`;
  switch (rule.type) {
    case "string":
      if (typeof value !== "string") return message;
      if (rule.pattern !== undefined && !rule.pattern.test(value)) return message;
      if (rule.minLength !== undefined && value.length < rule.minLength) return message;
      return undefined;
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? undefined : message;
    case "boolean":
      return typeof value === "boolean" ? undefined : message;
    case "array": {
      if (!Array.isArray(value)) return message;
      if (rule.minItems !== undefined && value.length < rule.minItems) return message;
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return message;
      for (const item of value) {
        const inner = rule.items === undefined ? undefined : failure(rule.items, item, key);
        if (inner !== undefined) return inner;
      }
      return undefined;
    }
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value) ? undefined : message;
  }
}

/** 按声明校验入参；不合法时抛 `-32602`，合法时什么都不做。 */
export function checkParams(params: MethodParams, rules: ParamRules): void {
  for (const [key, rule] of Object.entries(rules)) {
    const value = params[key];
    if (value === undefined) {
      if (rule.optional === true) continue;
      throw invalidParams(rule.missingMessage ?? rule.message ?? `'${key}' must be ${TYPE_LABELS[rule.type]}`);
    }
    const problem = failure(rule, value, key);
    if (problem !== undefined) throw invalidParams(problem);
  }
}

/** 会话 id：正整数；文案与 `conversationIdParam` 一致。 */
export const CONVERSATION_ID_RULE: ParamRule = {
  type: "integer",
  message: "'conversationId' must be a positive integer",
};

/** 来源 id 的固定形状：`s_` 加 8 位小写十六进制。 */
export const SOURCE_ID_RULE: ParamRule = {
  type: "string",
  pattern: /^s_[a-f0-9]{8}$/,
  message: "'sourceId' must look like s_xxxxxxxx",
  missingMessage: "'sourceId' must be a non-empty string",
};

/** 读出必填的工作区 id；形状不对时报与旧实现相同的两句话。 */
export function workspaceIdParam(params: MethodParams): string {
  checkParams(params, { workspaceId: WORKSPACE_ID_RULE });
  return params.workspaceId as string;
}

/** 工作区 id 的固定形状：`ws_` 加 16 位小写十六进制。 */
export const WORKSPACE_ID_RULE: ParamRule = {
  type: "string",
  pattern: /^ws_[0-9a-f]{16}$/,
  message: "'workspaceId' must look like ws_<16 hex>",
  missingMessage: "'workspaceId' must be a non-empty string",
};
