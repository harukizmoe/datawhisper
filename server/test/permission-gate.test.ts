import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createPermissionBroker, type PermissionEvent, type PermissionRequest } from "../src/agent/permission-broker.ts";
import { createPermissionGate } from "../src/agent/permission-gate.ts";
import type { PermissionMode } from "../src/agent/permission-mode.ts";
import { createMemorySourceStore } from "../src/ipc/source-store.ts";

const ctx = BACKGROUND_CONTEXT;

async function setup(mode: PermissionMode | undefined, scoped = true) {
  const state = createMemorySourceStore([1]);
  await state.update(1, (draft) => {
    if (scoped) draft.scope = { kind: "workspace", workspaceId: "ws_0123456789abcdef" };
    if (mode !== undefined) draft.permissionMode = mode;
  });
  const broker = createPermissionBroker();
  const events: PermissionEvent[] = [];
  broker.onEvent((event) => events.push(event));
  const gate = createPermissionGate({ state: () => state, broker });
  return { state, broker, events, gate };
}

/** 下一条「请求审批」事件：闸门读会话文档是异步的，不能靠让出一次微任务来等。 */
function nextRequest(broker: ReturnType<typeof createPermissionBroker>): Promise<PermissionRequest> {
  const slot = Promise.withResolvers<PermissionRequest>();
  const off = broker.onEvent((event) => {
    if (event.type !== "requested") return;
    off();
    slot.resolve(event.request);
  });
  return slot.promise;
}

const write = { name: "workspace_write_file", arguments: { file_path: "a.md", content: "# hi" } };

describe("审批 broker", () => {
  test("挂起直到回复；回复后请求从待审批里消失，重复回复返回 false", async () => {
    const broker = createPermissionBroker();
    const waiting = broker.request({ conversationId: 1, tool: "workspace_bash", summary: "Run a shell command", detail: "rm a", allowChat: false }, ctx);
    const [request] = broker.pending(1);
    expect(request).toMatchObject({ tool: "workspace_bash", detail: "rm a", allowChat: false });
    expect(broker.pending(2)).toEqual([]);

    expect(broker.respond(request!.requestId, "allow")).toBe(true);
    expect(await waiting).toBe("allow");
    expect(broker.pending()).toEqual([]);
    expect(broker.respond(request!.requestId, "deny")).toBe(false);
  });

  test("中止本轮会结束等待并通知界面撤下请求", async () => {
    const broker = createPermissionBroker();
    const events: PermissionEvent[] = [];
    broker.onEvent((event) => events.push(event));
    const { context, cancel } = withCancel(ctx);
    const waiting = broker.request({ conversationId: 1, tool: "workspace_bash", summary: "s", detail: "", allowChat: false }, context);
    const settled = waiting.then(() => "resolved", () => "cancelled");
    cancel(new Error("abort"));
    expect(await settled).toBe("cancelled");
    expect(broker.pending()).toEqual([]);
    expect(events.map((event) => (event.type === "resolved" ? `resolved:${event.reply}` : event.type))).toEqual(["requested", "resolved:cancelled"]);
  });
});

describe("权限闸门", () => {
  test("普通聊天（没有工作区）不受管，改动类工具也不询问", async () => {
    const { gate, broker } = await setup("manual", false);
    expect(await gate.check({ name: "workspace_delete_file", arguments: {} }, 1, ctx)).toBeUndefined();
    expect(broker.pending()).toEqual([]);
  });

  test("manual 询问：允许 → 放行；拒绝 → 把拒绝理由交给模型", async () => {
    const { gate, broker, events } = await setup("manual");
    const seen = nextRequest(broker);
    const allowed = gate.check(write, 1, ctx);
    const request = await seen;
    expect(request).toMatchObject({ conversationId: 1, tool: "workspace_write_file", summary: "Write file a.md", detail: "# hi", allowChat: true });
    broker.respond(request.requestId, "allow");
    expect(await allowed).toBeUndefined();

    const seenAgain = nextRequest(broker);
    const denied = gate.check(write, 1, ctx);
    broker.respond((await seenAgain).requestId, "deny");
    expect((await denied)?.block).toContain("denied workspace_write_file");
    expect(events.filter((event) => event.type === "requested")).toHaveLength(2);
  });

  test("未设置模式的工作区对话按 manual 处理", async () => {
    const { gate, broker } = await setup(undefined);
    const seen = nextRequest(broker);
    void gate.check(write, 1, ctx).catch(() => undefined);
    expect((await seen).tool).toBe("workspace_write_file");
  });

  test("「本对话都允许」写进会话文档，之后同一个 edit 类工具不再询问", async () => {
    const { gate, broker, state } = await setup("manual");
    const seen = nextRequest(broker);
    const first = gate.check(write, 1, ctx);
    broker.respond((await seen).requestId, "allow_chat");
    expect(await first).toBeUndefined();
    expect((await state.read(1)).permissionAllow).toEqual(["workspace_write_file"]);

    expect(await gate.check(write, 1, ctx)).toBeUndefined();
    expect(broker.pending()).toEqual([]);
    // 别的 edit 类工具仍要问。
    const other = nextRequest(broker);
    void gate.check({ name: "workspace_edit_file", arguments: {} }, 1, ctx).catch(() => undefined);
    expect((await other).tool).toBe("workspace_edit_file");
  });

  test("plan 直接拒绝、bypass 直接放行，两者都不打扰用户", async () => {
    const plan = await setup("plan");
    expect((await plan.gate.check(write, 1, ctx))?.block).toContain("Plan mode");
    expect(plan.broker.pending()).toEqual([]);

    const bypass = await setup("bypass");
    expect(await bypass.gate.check({ name: "workspace_delete_file", arguments: {} }, 1, ctx)).toBeUndefined();
    expect(bypass.broker.pending()).toEqual([]);
  });

  test("一轮中途切换模式，下一次调用按新模式判断", async () => {
    const { gate, state, broker } = await setup("plan");
    expect((await gate.check(write, 1, ctx))?.block).toBeString();
    await state.update(1, (draft) => {
      draft.permissionMode = "accept_edits";
    });
    expect(await gate.check(write, 1, ctx)).toBeUndefined();
    expect(broker.pending()).toEqual([]);
  });
});
