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
  /** 喂一段完整的 SSE 帧（不含结尾空行）。 */
  consume(frame: string): void;
  /** 运行是否已结束（与服务端测试里的 answered 判定一致）。 */
  answered(): boolean;
  printFinal(): void;
  readonly view: ConversationView | undefined;
};

const liveOf = (view: ConversationView): LiveState => (view.docs["pi.live"] ?? {}) as LiveState;

export function createParts(options: { conversationId: string }): ChatParts {
  let view: ConversationView | undefined;
  let seq = 0;
  let printed = 0;
  /** 工具名 -> 上次打印的状态；状态变化时打一行，避免重复刷屏。 */
  const toolStates = new Map<string, string>();

  function consume(frame: string): void {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data === "") return;
    const payload = JSON.parse(data) as { seq?: number; view?: ConversationView; ops?: Op[]; kind?: string };

    if (event === "snapshot") {
      view = payload.view;
      seq = payload.seq ?? 0;
      printed = 0;
      return;
    }
    if (event === "ops") {
      if (view === undefined) throw new Error("收到 ops 之前没有 snapshot");
      if (payload.seq !== seq + 1) throw new Error(`序号不连续：期望 ${seq + 1}，收到 ${payload.seq}`);
      seq = payload.seq;
      view = applyImmutable(view, payload.ops ?? []);
      render();
      return;
    }
    if (event === "end") {
      console.error(`\n[订阅结束：${payload.kind}]`);
    }
  }

  /** 增量渲染：只打印新出现的助手正文与工具状态变化。 */
  function render(): void {
    if (view === undefined) return;
    const message = liveOf(view).generation?.message;
    const text = (message?.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    if (text.length > printed) {
      process.stdout.write(text.slice(printed));
      printed = text.length;
    }
    for (const slot of liveOf(view).tools ?? []) {
      if (toolStates.get(slot.name) === slot.status) continue;
      toolStates.set(slot.name, slot.status);
      process.stdout.write(`\n[工具 ${slot.name}: ${slot.status}]\n`);
    }
  }

  function answered(): boolean {
    if (view === undefined) return false;
    return liveOf(view).run === undefined && view.entries.some((entry) => entry.kind === "pi.assistant");
  }

  function printFinal(): void {
    if (view === undefined) {
      console.error("没有收到任何快照");
      return;
    }
    const message = view.entries.findLast((entry) => entry.kind === "pi.assistant")?.model?.[0] as AssistantMessage | undefined;
    const usage = view.docs["pi.usage"] as { models?: Record<string, { input: number; output: number }> } | undefined;
    process.stdout.write("\n");
    if (message !== undefined && message.content.some((block) => block.type === "text")) {
      const full = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      if (full.length > printed) process.stdout.write(full.slice(printed));
    }
    console.log(`\n\n[会话 ${options.conversationId}] stopReason=${message?.stopReason ?? "—"}`);
    console.log(`[用量] ${JSON.stringify(usage?.models ?? {})}`);
  }

  return { consume, answered, printFinal, get view() { return view; } };
}
