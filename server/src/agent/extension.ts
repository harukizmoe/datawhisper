import {
  defineExtension,
  type Extension,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { renderSystemPrompt } from "./system-prompt.ts";
import { EMPTY_TURN_CONTEXT, TurnDoc } from "./turn.ts";

/**
 * 数据分析 agent 的 pi-durable 扩展：只负责系统提示。
 *
 * 工具由注册表按轮次暴露（见 `selectToolsForTurn`），hooks（数字核对、输出类工具守卫）在 P3.3 的接线里挂上；
 * 这里保持单一职责，避免一个扩展既渲染提示又改工具集，出问题时难以定位是提示还是工具导致的。
 *
 * section 的 key 固定为 `dw-prompt`，`tag: false` 表示原样输出（旧实现的系统提示没有 XML 包裹）。
 */
export const PROMPT_SECTION_KEY = "dw-prompt";

export function dataWhisperPrompts(): Extension {
  return defineExtension({
    name: "datawhisper",
    sections: [
      section(
        PROMPT_SECTION_KEY,
        async (input, context) => {
          const turn = (await input.read.snapshot(TurnDoc, input.conversationId, context)) ?? EMPTY_TURN_CONTEXT;
          const prompt = renderSystemPrompt(turn, input.agent.tools);
          return prompt === "" ? undefined : prompt;
        },
        { tag: false },
      ),
    ],
  });
}

/**
 * 把工具列表收敛成本轮真正要给模型的集合。
 *
 * 依赖调用方提供 `filter`：它接收「全部可用工具」返回「本轮可提供的工具」（实现见 `tools/select.ts`，
 * 那里把 registry 元数据与 exposure 算法接起来）。这里只做两件这里才有的事：
 * 1. 保持 `filter` 决定的名字集合，但按传入工具的顺序输出（工具顺序会影响模型偏好，旧实现按注册顺序）；
 * 2. 过滤掉 filter 里没有的工具——`configure({ modelTools })` 是整体替换，漏掉就等于禁用。
 */
export function selectToolsForTurn(
  allTools: readonly ToolRegistration[],
  keep: ReadonlySet<string>,
): ToolRegistration[] {
  return allTools.filter((tool) => keep.has(tool.name));
}
