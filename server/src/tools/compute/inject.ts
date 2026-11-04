/**
 * 给 B 类工具注入「本会话的数据上下文」。
 *
 * compute worker 是跨会话共享的单个进程：它只认 `source_id`，不知道哪个界面会话在用哪些来源。
 * 因此每次工具调用都要把「当前会话参与分析的来源」放进工具 `Context`，工具外壳再转成 RPC 参数
 * （`toRpcContext`）。工具对象是整个进程共用的，所以注入只能在 `execute` 里按 `api.conversationId` 现取。
 */

import type { Context } from "@earendil-works/chord/context";
import { withContextValue } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { computeToolContextKey, type ComputeToolContext } from "./types.ts";


/** 按会话现取数据上下文；没有来源时返回空 `sources`，工具会给出「no data source」的原文案。 */
export type ConversationSourceReader = (conversationId: number) => Promise<ComputeToolContext | undefined>;

export function withConversationSources(
  tools: readonly ToolRegistration[],
  read: ConversationSourceReader,
): ToolRegistration[] {
  return tools.map((tool) => {
    const wrapped: ToolRegistration = defineTool<object>({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: tool.replay,
      async execute(args, api, context) {
        const value = await read(api.conversationId as unknown as number);
        const scoped: Context =
          value === undefined ? context : withContextValue(computeToolContextKey, value, context);
        // 内层外壳仍会走 `resolveContext`：有注入值时用注入值，否则退回它自己的 `options.context`。
        // 内外层的 details 泛型不同（外层只做转发），这里按同一个执行签名转交给内层。
        const run = tool.execute as unknown as (args: unknown, api: unknown, context: Context) => Promise<unknown>;
        return (await run(args, api, scoped)) as never;
      },
    });
    return wrapped;
  });
}
