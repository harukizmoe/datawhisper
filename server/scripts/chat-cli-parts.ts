import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";

/**
 * 把订阅到的 `snapshot` + `ops` 还原成会话视图，并负责终端输出。
 *
 * 与 Go 界面用的是同一套语义（docs/refactor/ui-protocol.md）：snapshot 是基线，ops 依次叠加；序号不连续说明
 * 漏帧，此时直接报错而不是继续渲染——静默的半份状态比报错更难查。
 */
export type ChatParts = {
  /** 喂一条 `conversation.event` 通知的 params。 */
  apply(params: Record<string, unknown>): void;
  /** 运行是否已结束（与服务端测试里的 answered 判定一致）。 */
  answered(): boolean;
  /** 订阅的结束原因；还没结束时为 undefined。 */
  ended(): string | undefined;
  printFinal(): void;
  readonly view: ConversationView | undefined;
};

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

export function createParts(options: { conversationId: string; out: (text: string) => void }): ChatParts {
  let view: ConversationView | undefined;
  let seq = 0;
  let printed = 0;
  let endKind: string | undefined;
  /** 工具名 -> 上次打印的状态；状态变化时打一行，避免重复刷屏。 */
  const toolStates = new Map<string, string>();

  function apply(params: Record<string, unknown>): void {
    const event = params.event;
    if (event === "snapshot") {
      view = params.view as ConversationView;
      seq = typeof params.seq === "number" ? params.seq : 0;
      printed = 0;
      return;
    }
    if (event === "ops") {
      if (view === undefined) throw new Error("收到 ops 之前没有 snapshot");
      if (params.seq !== seq + 1) throw new Error(`序号不连续：期望 ${seq + 1}，收到 ${params.seq}`);
      seq = params.seq as number;
      const ops = (params.ops ?? []) as Op[];
      // 工具状态可能在同一个事件里被设成 done 又随工具轮结束被删掉，折叠后的视图看不到它；
      // 因此状态变化直接从 ops 里读，而不是只看最终视图。
      reportToolStatus(ops, view);
      view = applyImmutable(view, ops);
      render();
      return;
    }
    if (event === "end") {
      endKind = typeof params.kind === "string" ? params.kind : "ended";
      options.out(`\n[订阅结束：${endKind}]`);
    }
  }

  /** 打印 `docs.pi.live.tools[i].status` 的每一次变化；同名的重复状态只打一次。 */
  function reportToolStatus(ops: Op[], before: ConversationView): void {
    for (const op of ops) {
      if (op[0] !== "s") continue;
      const path = op[1];
      if (path.length !== 5 || path[0] !== "docs" || path[1] !== "pi.live" || path[2] !== "tools" || path[4] !== "status") continue;
      const index = path[3];
      if (typeof index !== "number") continue;
      const slot = (liveOf(before).tools ?? [])[index];
      const name = slot?.name ?? `#${index}`;
      const status = String(op[2]);
      if (toolStates.get(name) === status) continue;
      toolStates.set(name, status);
      options.out(`\n[工具 ${name}: ${status}]\n`);
    }
  }

  /** 增量渲染：只打印新出现的助手正文与工具状态变化。 */
  function render(): void {
    if (view === undefined) return;
    const message = liveOf(view).generation?.message;
    const text = (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (text.length > printed) {
      options.out(text.slice(printed));
      printed = text.length;
    }
    for (const slot of liveOf(view).tools ?? []) {
      if (toolStates.get(slot.name) === slot.status) continue;
      toolStates.set(slot.name, slot.status);
      options.out(`\n[工具 ${slot.name}: ${slot.status}]\n`);
    }
  }

  function answered(): boolean {
    if (view === undefined) return false;
    return liveOf(view).run === undefined && view.entries.some((entry) => entry.kind === "pi.assistant");
  }

  function printFinal(): void {
    if (view === undefined) {
      options.out("没有收到任何快照");
      return;
    }
    const message = view.entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0] as AssistantMessage | undefined;
    const usage = view.docs["pi.usage"] as { models?: Record<string, { input: number; output: number }> } | undefined;
    options.out("\n");
    if (message !== undefined && message.content.some((block) => block.type === "text")) {
      const full = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (full.length > printed) options.out(full.slice(printed));
    }
    options.out(`\n\n[会话 ${options.conversationId}] stopReason=${message?.stopReason ?? "—"}\n`);
    options.out(`[用量] ${JSON.stringify(usage?.models ?? {})}\n`);
  }

  return {
    apply,
    answered,
    ended: () => endKind,
    printFinal,
    get view() {
      return view;
    },
  };
}
