/**
 * `beforeTool` 里的权限闸门：只管工作区对话里会改文件的工具（见 `permission-mode.ts`）。
 *
 * 模式与「本对话都允许」的名单存在会话来源文档里，每次调用现读——用户在一轮中途切换模式，下一次工具调用就生效。
 * 普通聊天没有工作区，所以不受管。
 */

import type { Context } from "@earendil-works/chord/context";
import { say } from "../i18n.ts";
import type { SourceDocStore } from "../ipc/source-store.ts";
import { changeClassOf, decidePermission, DEFAULT_PERMISSION_MODE } from "./permission-mode.ts";
import type { PermissionBroker } from "./permission-broker.ts";

export type PermissionGate = {
  /** 返回 `{ block }` 表示拒绝这次调用，理由原样交给模型；放行返回 undefined。 */
  check(
    call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> },
    conversationId: number,
    context: Context,
  ): Promise<{ block: string } | undefined>;
};

const SUMMARY_LIMIT = 200;
const DETAIL_LIMIT = 600;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 给用户看的「要做什么」。参数缺失时仍给出工具名，让审批卡片永远有一句话可显示。 */
export function describeCall(tool: string, args: Readonly<Record<string, unknown>>): { summary: string; detail: string } {
  switch (tool) {
    case "workspace_write_file":
      return { summary: clip(`Write file ${str(args.file_path)}`, SUMMARY_LIMIT), detail: clip(str(args.content), DETAIL_LIMIT) };
    case "workspace_edit_file":
      return { summary: clip(`Edit file ${str(args.file_path)}`, SUMMARY_LIMIT), detail: clip(str(args.new_string), DETAIL_LIMIT) };
    case "workspace_delete_file":
      return { summary: clip(`Delete ${str(args.file_path)}`, SUMMARY_LIMIT), detail: "" };
    case "workspace_move_file":
      return { summary: clip(`Move ${str(args.source_path)} to ${str(args.destination_path)}`, SUMMARY_LIMIT), detail: "" };
    case "workspace_bash":
      return { summary: "Run a shell command", detail: clip(str(args.command), DETAIL_LIMIT) };
    default:
      return { summary: `Run ${tool}`, detail: "" };
  }
}

export function createPermissionGate(options: {
  /** 来源文档在会话服务之后才建好，所以用迟绑定的取值函数。 */
  readonly state: () => SourceDocStore;
  readonly broker: PermissionBroker;
}): PermissionGate {
  return {
    async check(call, conversationId, context) {
      const change = changeClassOf(call.name);
      if (change === undefined) return undefined;
      const state = options.state();
      const doc = await state.read(conversationId).catch(() => undefined);
      if (doc?.scope?.kind !== "workspace") return undefined;

      const decision = decidePermission({
        mode: doc.permissionMode ?? DEFAULT_PERMISSION_MODE,
        tool: call.name,
        args: call.arguments,
        allowed: doc.permissionAllow ?? [],
      });
      if (decision.kind === "allow") return undefined;
      if (decision.kind === "block") return { block: decision.reason };

      const reply = await options.broker.request(
        { conversationId, tool: call.name, ...describeCall(call.name, call.arguments), allowChat: change === "edit" },
        context,
      );
      if (reply === "deny") {
        return {
          block: say(
            `[PERMISSION] The user denied ${call.name}. Do not retry it; ask what they would like instead.`,
            `[PERMISSION] 用户拒绝了 ${call.name}。不要重试，询问用户想怎么做。`,
          ),
        };
      }
      if (reply === "allow_chat") {
        await state.update(conversationId, (draft) => {
          const allowed = new Set(draft.permissionAllow ?? []);
          allowed.add(call.name);
          draft.permissionAllow = [...allowed];
        });
      }
      return undefined;
    },
  };
}
