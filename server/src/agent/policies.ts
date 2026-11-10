import type { Context } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
  type HookApi,
  ToolTask,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { say } from "../i18n.ts";
import { confirmationBlock } from "../tools/guard/confirmation.ts";
import { applyToolResultGuard } from "../tools/guard/index.ts";
import type { EvidenceClaimStore } from "../tools/guard/evidence.ts";
import type { ToolResultStore } from "../tools/guard/spill.ts";
import { getToolSpec } from "../tools/registry.ts";
import { auditReportNumbers, collectNumberEvidence, NUMBER_EVIDENCE_TOOLS } from "./number-audit.ts";
import { blockedOutputTools, guardToken } from "./output-guard.ts";
import { parseTextFallbackToolCalls } from "./text-fallback.ts";
import { EMPTY_TURN_CONTEXT, TurnDoc } from "./turn.ts";

/**
 * 输出侧三条策略的 pi-durable 接线（P3.3）。
 *
 * 1. 输出类工具守卫（旧 `_OUTPUT_TOOL_GUARDS`）：普通对话里调用 propose/generate/export 一律拦下，让模型收到
 *    `[SYSTEM BLOCK]` 并改用纯文本回答；只有对应的斜杠命令（或内置技能）解锁。
 * 2. 数字溯源核对（旧 `number_audit.py` 的门禁）：本轮有证据类工具成功时才审计最终回答，发现无出处的数字就补
 *    一轮修复（旧实现 `_MAX_NUMBER_GATE_RETRIES = 1`）。旧实现修复轮用完后会往回答末尾追加脚注；pi-durable 的
 *    `onYield` 没有改写消息的通道，因此这里不再改正文——把未通过的数字记进通知，由界面提示，绝不假装已修正。
 * 3. 文本形式工具调用（旧 `_parse_text_fallback_tool_calls`）：旧实现解析模型写在正文里的伪 XML 并直接执行。
 *    hook 无权注入工具调用，所以这里只在"没有任何工具调用、正文却含可解析片段"时补一轮，明确要求改用原生工具
 *    调用；不静默丢弃，也不假装执行过。
 *
 * 「这一轮是否已经补过」不另存状态，而是读会话历史里的标记文本——崩溃重启后同一条修复轮不会重复触发。
 */

const QUALITY_GATE_MARK = "[QUALITY GATE]";
const SYSTEM_NOTE_MARK = "[SYSTEM NOTE]";
/** 一次分页读取的最大条目数；够覆盖一轮对话（旧实现也是整段 messages）。 */
const REQUEST_MEMO = "dw.request";

export type PolicyOptions = {
  /** 结果外溢与证据声明的宿主端口；省略时不做外溢（宿主装配时注入）。 */
  readonly toolResults?: ToolResultStore;
  readonly evidenceClaims?: EvidenceClaimStore;
  /** 本会话工作区 id，写入外溢制品与证据声明。 */
  readonly workspaceId?: string;
};

export function dataWhisperPolicies(options: PolicyOptions = {}): Extension {
  const toolHooks: Partial<ToolHooks> = {
    async beforeTool(call, api, context) {
      const turn = (await api.snapshot(TurnDoc, api.conversationId, context)) ?? EMPTY_TURN_CONTEXT;
      const token = guardToken(turn.command ?? undefined, turn.activation);
      // ① 旧 `_OUTPUT_TOOL_GUARDS`：普通对话里调用 propose/generate/export 一律拦下。
      const outputBlock = blockedOutputTools([call.name], token)[0];
      if (outputBlock !== undefined) return { block: outputBlock.reason };
      // ② 注册表 `confirmation` 的运行时检查（旧实现只有元数据）。
      const block = confirmationBlock({
        name: call.name,
        spec: getToolSpec(call.name),
        args: call.arguments,
        token,
        message: turn.message,
      });
      return block === undefined ? undefined : { block };
    },
  };

  if (options.toolResults !== undefined) {
    const store = options.toolResults;
    toolHooks.afterTool = async (call, result, api) =>
      applyToolResultGuard({
        name: call.name,
        args: call.arguments,
        result,
        store,
        evidence: options.evidenceClaims,
        sessionId: String(api.conversationId),
        workspaceId: options.workspaceId,
      });
  }

  return defineExtension({
    name: "datawhisper-policies",
    hooks: [
      hook(ToolTask, toolHooks),
      hook(GenerationTask, {
        // 本轮的请求消息就是模型看到的完整上下文（含工具结果）；工具结果条目本身不带 model 消息，
        // 所以只能从这里取证据，而不是从 entry.model 拼。
        async beforeRequest(request, api, context) {
          // memo 只接受 JsonValue：按 JSON 文本存一份，读的时候再解析。
          await api.memo(REQUEST_MEMO, JSON.stringify(request.messages), context);
          return undefined;
        },
        async onYield(answer, api, context) {
          const text = answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
          const history = await turnHistory(api, context);

          // ① 文本形式工具调用：模型没调工具、却在正文里写了伪 XML 调用。
          const parsed = parseTextFallbackToolCalls(text);
          if (parsed.length > 0 && !history.hasSystemNote) {
            const names = [...new Set(parsed.map((call) => call.name))].join(", ");
            return {
              continue: say(
                `[SYSTEM NOTE] You wrote tool calls as XML tags in the message body (${names}). Re-issue them as native tool calls and do not write tags in the body.`,
                `[SYSTEM NOTE] 你把工具调用写成了正文里的 XML 标签（${names}）。请改用原生工具调用重新发起，不要在正文里写标签。`,
              ),
            };
          }

          // ② 数字溯源：只有本轮有证据类工具成功才审计（与旧实现一致），且只补一轮。
          if (!history.hasEvidenceTool || history.hasQualityGate) return undefined;
          const { evidence, context: contextTexts } = collectNumberEvidence(history.messages);
          if (evidence.length === 0) return undefined;
          const { unsupported, total } = auditReportNumbers(text, evidence, contextTexts);
          if (unsupported.length === 0) return undefined;
          return {
            continue:
              `${QUALITY_GATE_MARK} Numeric provenance check failed for ${total} value(s): ${unsupported.join(", ")}. ` +
              "Each listed number appears in your draft but not in any tool result of this conversation. " +
              "Fix the final answer now: query the missing metric properly, or replace each unsupported number with " +
              "the exact value from the tool results, or remove the claim. Never keep a number that no tool result " +
              "supports.",
          };
        },
      }),
    ],
  });
}

type TurnHistory = {
  messages: Message[];
  hasQualityGate: boolean;
  hasSystemNote: boolean;
  hasEvidenceTool: boolean;
};

/** 请求消息里能读出的事实：是否已补过修复轮、本轮是否有证据类工具成功返回。 */
async function turnHistory(api: HookApi, context: Context): Promise<TurnHistory> {
  const stored = await api.memo<string>(REQUEST_MEMO, "[]", context);
  const messages = JSON.parse(stored) as Message[];
  let hasQualityGate = false;
  let hasSystemNote = false;
  let hasEvidenceTool = false;
  for (const message of messages) {
    if (message.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      if (text.startsWith(QUALITY_GATE_MARK)) hasQualityGate = true;
      if (text.startsWith(SYSTEM_NOTE_MARK)) hasSystemNote = true;
    }
    if (message.role === "toolResult" && NUMBER_EVIDENCE_TOOLS.has(message.toolName) && !message.isError) hasEvidenceTool = true;
  }
  return { messages, hasQualityGate, hasSystemNote, hasEvidenceTool };
}

