import { describe, expect, test } from "bun:test";
import { Action, Hook, HookContext, ToolRejectedError, type HookInit } from "../src/agent/hooks/models.ts";
import {
  BackgroundQueue,
  HookEngine,
  OnceRegistry,
  type HookLogger,
  type HookScheduler,
} from "../src/agent/hooks/engine.ts";
import { executeAction } from "../src/agent/hooks/executors.ts";

const silent: HookLogger = { warn: () => {}, error: () => {} };

/** Python 线程池的确定性替身：任务只在测试 flush 时才运行。 */
class ManualScheduler implements HookScheduler {
  submitted = 0;
  private readonly tasks: (() => void | Promise<void>)[] = [];

  submit(task: () => void | Promise<void>): void {
    this.submitted++;
    this.tasks.push(task);
  }

  async flush(): Promise<void> {
    for (const task of this.tasks.splice(0)) await task();
  }
}

function promptHook(id: string, event: string, message: string, extra: Partial<HookInit> = {}): Hook {
  return new Hook({ id, event, action: new Action("prompt", { message }), ...extra });
}

function engineFor(hooks: Hook[], options: Partial<ConstructorParameters<typeof HookEngine>[1]> = {}): HookEngine {
  return new HookEngine(hooks, {
    onceRegistry: new OnceRegistry(),
    backgroundQueue: new BackgroundQueue(),
    logger: silent,
    ...options,
  });
}

describe("HookEngine dispatch", () => {
  test("runs matching hooks in declaration order and reports one notification each", async () => {
    const engine = engineFor([
      promptHook("first", "turn_start", "one"),
      promptHook("skipped-condition", "turn_start", "two", { condition: "tool_name == nope" }),
      promptHook("third", "turn_start", "three", { condition: "tool_name == query_data" }),
      promptHook("other-event", "turn_end", "four"),
    ]);
    const ctx = new HookContext({ toolName: "query_data" });
    const notifications = await engine.runHooks("turn_start", ctx);

    expect(notifications.map((n) => n.hookId)).toEqual(["first", "third"]);
    expect(notifications.map((n) => n.output)).toEqual(["one", "three"]);
    expect(notifications.every((n) => n.success)).toBe(true);
    expect(engine.drainPromptMessages()).toEqual(["one", "three"]);
    // `run_hooks` 会抽干通知缓冲区。
    expect(engine.drainNotifications()).toEqual([]);
    // 调用方的上下文不受影响：引擎只传 `child` 副本。
    expect(ctx.eventName).toBe("");
  });

  test("passes a child context whose event_name is the dispatched event", async () => {
    const seen: string[] = [];
    const engine = engineFor([promptHook("h", "turn_end", "x")], {
      execute: async (_action, ctx) => {
        seen.push(ctx.eventName);
        return { output: String(ctx.expand("$EVENT")), success: true };
      },
    });
    const notifications = await engine.runHooks("turn_end", new HookContext({ eventName: "turn_start" }));
    expect(seen).toEqual(["turn_end"]);
    expect(notifications[0]!.output).toBe("turn_end");
  });

  test("a disabled engine runs nothing", async () => {
    const scheduler = new ManualScheduler();
    const engine = engineFor([promptHook("h", "turn_start", "x")], { enabled: false, scheduler });
    expect(await engine.runHooks("turn_start", new HookContext())).toEqual([]);
    expect(engine.drainPromptMessages()).toEqual([]);
    expect(scheduler.submitted).toBe(0);
  });

  test("notifications carry the Python event payload and cap output at 500 code points", async () => {
    const long = "😀".repeat(600);
    const engine = engineFor([promptHook("h", "turn_start", long)]);
    const [notification] = await engine.runHooks("turn_start", new HookContext());
    const event = notification!.toEvent();
    expect(event).toMatchObject({ type: "hook_event", hook_id: "h", event: "turn_start", ok: true });
    expect([...(event.output as string)].length).toBe(500);
  });

  test("an executor failure is reported as a failed notification with the error text", async () => {
    const engine = engineFor([promptHook("h", "turn_start", "x")], {
      execute: async () => {
        throw new Error("boom");
      },
    });
    const [notification] = await engine.runHooks("turn_start", new HookContext());
    expect(notification).toMatchObject({ hookId: "h", output: "boom", success: false });
    expect(engine.drainPromptMessages()).toEqual([]);
  });

  test("a failed prompt is not injected as a prompt message", async () => {
    const engine = engineFor([promptHook("h", "turn_start", "x")], {
      execute: async () => ({ output: "partial", success: false }),
    });
    await engine.runHooks("turn_start", new HookContext());
    expect(engine.drainPromptMessages()).toEqual([]);
  });

  test("trigger records skip internal endpoints and test-mode contexts", async () => {
    const recorded: string[] = [];
    const engine = engineFor(
      [
        promptHook("visible", "turn_start", "x"),
        promptHook("internal", "turn_start", "x", { internalEndpoint: true }),
      ],
      { recordTrigger: (hook, _notification, _ctx, actionType) => recorded.push(`${hook.id}:${actionType}`) },
    );
    await engine.runHooks("turn_start", new HookContext());
    expect(recorded).toEqual(["visible:prompt"]);

    const testMode = engineFor([promptHook("visible", "turn_start", "x")], {
      recordTrigger: (hook) => recorded.push(hook.id),
    });
    await testMode.runHooks("turn_start", new HookContext({ extra: { test_mode: true } }));
    expect(recorded).toEqual(["visible:prompt"]);
  });
});

describe("pre_tool_use rejection", () => {
  test("returns ToolRejectedError with the hook output as the reason", async () => {
    const engine = engineFor([
      promptHook("audit", "pre_tool_use", "logged"),
      promptHook("block", "pre_tool_use", "no writes allowed", { reject: true }),
      promptHook("never", "pre_tool_use", "unreachable"),
    ]);
    const error = await engine.runPreToolHooks(new HookContext({ toolName: "query_data" }));
    expect(error).toBeInstanceOf(ToolRejectedError);
    expect(error!.message).toBe("no writes allowed");
    expect(error!.reason).toBe("no writes allowed");
    expect(error!.tool).toBe("query_data");
    expect(error!.hookId).toBe("block");
    // 拒绝的那个 hook 之前的 hook 仍已运行；之后的都没有运行。
    expect(engine.drainPromptMessages()).toEqual(["logged", "no writes allowed"]);
    expect(engine.drainNotifications().map((n) => n.hookId)).toEqual(["audit", "block"]);
  });

  test("falls back to Python's default reason when the prompt output is empty", async () => {
    const engine = engineFor([
      promptHook("block", "pre_tool_use", "$NONEXISTENT", { reject: true }),
    ]);
    const error = await engine.runPreToolHooks(new HookContext({ toolName: "query_data" }));
    expect(error!.reason).toBe("tool call rejected by hook");
    expect(error!.message).toBe("tool call rejected by hook");
  });

  test("returns null when no hook rejects", async () => {
    const engine = engineFor([promptHook("audit", "pre_tool_use", "logged")]);
    expect(await engine.runPreToolHooks(new HookContext({ toolName: "query_data" }))).toBeNull();
    expect(engine.drainPromptMessages()).toEqual(["logged"]);
  });

  test("respects conditions and the once reservation", async () => {
    const engine = engineFor([
      promptHook("block", "pre_tool_use", "denied", { reject: true, once: true, onceScope: "session" }),
    ]);
    const ctx = new HookContext({ toolName: "query_data", sessionId: "s" });
    expect(await engine.runPreToolHooks(ctx)).toBeInstanceOf(ToolRejectedError);
    expect(await engine.runPreToolHooks(ctx)).toBeNull();

    const conditional = engineFor([
      promptHook("block", "pre_tool_use", "denied", { reject: true, condition: "tool_name == write_file" }),
    ]);
    expect(await conditional.runPreToolHooks(new HookContext({ toolName: "query_data" }))).toBeNull();
    expect(await conditional.runPreToolHooks(new HookContext({ toolName: "write_file" }))).toBeInstanceOf(
      ToolRejectedError,
    );
  });
});

describe("once semantics", () => {
  test("a ran once hook is blocked in the same engine regardless of scope (the executed flag)", async () => {
    for (const onceScope of ["session", "turn", "global"]) {
      const engine = engineFor([promptHook("h", "turn_start", "once", { once: true, onceScope })]);
      expect(await engine.runHooks("turn_start", new HookContext({ sessionId: "s1", turnId: "t1" }))).toHaveLength(1);
      expect(await engine.runHooks("turn_start", new HookContext({ sessionId: "s2", turnId: "t2" }))).toHaveLength(0);
    }
  });

  test("a fresh engine per turn (production) is governed by the registry", async () => {
    const registry = new OnceRegistry();
    const run = (sessionId: string, turnId: string, onceScope: string) =>
      engineFor([promptHook("h", "turn_start", "once", { once: true, onceScope })], { onceRegistry: registry }).runHooks(
        "turn_start",
        new HookContext({ sessionId, turnId }),
      );

    // session 作用域：每个会话运行一次，而不是每个引擎一次。
    expect(await run("s1", "t1", "session")).toHaveLength(1);
    expect(await run("s1", "t2", "session")).toHaveLength(0);
    expect(await run("s2", "t3", "session")).toHaveLength(1);

    // turn 作用域：每个 turn id 运行一次。
    const turnRegistry = new OnceRegistry();
    const turnRun = (turnId: string) =>
      engineFor([promptHook("h", "turn_start", "once", { once: true, onceScope: "turn" })], {
        onceRegistry: turnRegistry,
      }).runHooks("turn_start", new HookContext({ sessionId: "s", turnId }));
    expect(await turnRun("t1")).toHaveLength(1);
    expect(await turnRun("t1")).toHaveLength(0);
    expect(await turnRun("t2")).toHaveLength(1);
  });

  test("global scope is shared across engines through the injected registry", async () => {
    const registry = new OnceRegistry();
    const make = () =>
      engineFor([promptHook("h", "startup", "hello", { once: true, onceScope: "global" })], { onceRegistry: registry });
    expect(await make().runHooks("startup", new HookContext())).toHaveLength(1);
    // 新建的引擎（每轮重建的那个）仍能看到已完成的预留。
    expect(await make().runHooks("startup", new HookContext())).toHaveLength(0);
  });

  test("non-once hooks rerun even after executed is set", async () => {
    const hook = promptHook("h", "turn_start", "again");
    hook.markExecuted();
    const engine = engineFor([hook]);
    expect(await engine.runHooks("turn_start", new HookContext())).toHaveLength(1);
  });
});

describe("background hooks", () => {
  test("async_exec does not block the caller and reports only through the trigger record", async () => {
    const scheduler = new ManualScheduler();
    const recorded: string[] = [];
    const hook = new Hook({
      id: "async-http",
      event: "turn_end",
      action: new Action("http", { url: "https://example.com/hook" }),
      asyncExec: true,
      once: true,
    });
    const engine = engineFor([hook], {
      scheduler,
      execute: async () => ({ output: "posted", success: true }),
      recordTrigger: (triggered, notification) => recorded.push(`${triggered.id}:${notification.output}`),
    });
    const notifications = await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }));
    expect(notifications).toEqual([]);
    expect(scheduler.submitted).toBe(1);
    expect(engine.drainNotifications()).toEqual([]);

    await scheduler.flush();
    // Python 的 `_run_single_background` 记录触发，但从不追加通知。
    expect(engine.drainNotifications()).toEqual([]);
    expect(recorded).toEqual(["async-http:posted"]);
    expect(hook.executed).toBe(true);
    // 预留已完成：该 hook 不会被再次调度。
    expect(await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }))).toEqual([]);
    expect(scheduler.submitted).toBe(1);
  });

  test("a pending background run holds its reservation", async () => {
    const scheduler = new ManualScheduler();
    const engine = engineFor(
      [
        new Hook({
          id: "h",
          event: "turn_end",
          action: new Action("command", { command: "true" }),
          asyncExec: true,
          once: true,
        }),
      ],
      { scheduler, allowCommandHooks: true, execute: async () => ({ output: "", success: true }) },
    );
    await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }));
    await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }));
    expect(scheduler.submitted).toBe(1);
    await scheduler.flush();
  });

  test("fire_and_forget_side_effects backgrounds HTTP/command hooks but never a rejecting or prompt hook", async () => {
    const scheduler = new ManualScheduler();
    const recorded: string[] = [];
    const engine = engineFor(
      [
        new Hook({ id: "http", event: "turn_end", action: new Action("http", { url: "https://x" }) }),
        new Hook({ id: "command", event: "turn_end", action: new Action("command", { command: "true" }) }),
        promptHook("prompt", "turn_end", "inline"),
      ],
      {
        scheduler,
        allowCommandHooks: true,
        fireAndForgetSideEffects: true,
        execute: async (action) => ({ output: action.type, success: true }),
        recordTrigger: (hook) => recorded.push(hook.id),
      },
    );
    const notifications = await engine.runHooks("turn_end", new HookContext());
    expect(notifications.map((n) => n.hookId)).toEqual(["prompt"]);
    expect(scheduler.submitted).toBe(2);
    await scheduler.flush();
    expect(recorded).toEqual(["prompt", "http", "command"]);
    expect(engine.drainNotifications()).toEqual([]);
  });

  test("rejects beyond capacity with Python's notification and releases the reservation", async () => {
    const scheduler = new ManualScheduler();
    const queue = new BackgroundQueue(2);
    const hooks = ["a", "b", "c"].map(
      (id) =>
        new Hook({
          id,
          event: "turn_end",
          action: new Action("http", { url: "https://x" }),
          asyncExec: true,
          once: true,
        }),
    );
    const engine = engineFor(hooks, {
      scheduler,
      backgroundQueue: queue,
      execute: async () => ({ output: "ok", success: true }),
    });
    const notifications = await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }));
    expect(notifications.map((n) => [n.hookId, n.output, n.success])).toEqual([
      ["c", "background hook queue is full (capacity=2)", false],
    ]);
    expect(queue.active).toBe(2);

    await scheduler.flush();
    expect(queue.active).toBe(0);
    expect(engine.drainNotifications()).toEqual([]);

    // 被拒绝的 hook 已被释放，所以有空位时它会运行。
    await engine.runHooks("turn_end", new HookContext({ sessionId: "s" }));
    expect(scheduler.submitted).toBe(3); // a 和 b 已完成（registry），被释放的 c 再次运行
    await scheduler.flush();
  });

  test("the default queue capacity is 32", () => {
    expect(new BackgroundQueue().capacity).toBe(32);
  });

  test("33 asynchronous hooks with the default queue reject exactly the 33rd", async () => {
    const scheduler = new ManualScheduler();
    const queue = new BackgroundQueue();
    const hooks = Array.from(
      { length: 33 },
      (_, index) =>
        new Hook({
          id: `h${index}`,
          event: "turn_end",
          action: new Action("http", { url: "https://example.com" }),
          asyncExec: true,
        }),
    );
    const engine = engineFor(hooks, {
      scheduler,
      backgroundQueue: queue,
      execute: async () => ({ output: "ok", success: true }),
    });
    const notifications = await engine.runHooks("turn_end", new HookContext());
    expect(scheduler.submitted).toBe(32);
    expect(queue.active).toBe(32);
    expect(notifications.map((n) => [n.hookId, n.output])).toEqual([
      ["h32", "background hook queue is full (capacity=32)"],
    ]);
    await scheduler.flush();
    expect(queue.active).toBe(0);
  });

  test("a failing background action logs but emits no notification and frees the slot", async () => {
    const scheduler = new ManualScheduler();
    const queue = new BackgroundQueue(1);
    const hook = new Hook({
      id: "h",
      event: "turn_end",
      action: new Action("http", { url: "https://x" }),
      asyncExec: true,
    });
    const engine = engineFor([hook], {
      scheduler,
      backgroundQueue: queue,
      execute: async () => {
        throw new Error("network down");
      },
    });
    await engine.runHooks("turn_end", new HookContext());
    await scheduler.flush();
    expect(engine.drainNotifications()).toEqual([]);
    expect(hook.executed).toBe(true);
    expect(queue.active).toBe(0);
  });

  test("a scheduler that throws releases the slot and the reservation", async () => {
    const queue = new BackgroundQueue(1);
    const engine = engineFor(
      [
        new Hook({
          id: "h",
          event: "turn_end",
          action: new Action("command", { command: "true" }),
          asyncExec: true,
        }),
      ],
      {
        backgroundQueue: queue,
        allowCommandHooks: true,
        scheduler: {
          submit: () => {
            throw new Error("pool shut down");
          },
        },
      },
    );
    expect(await engine.runHooks("turn_end", new HookContext())).toEqual([]);
    expect(queue.active).toBe(0);
  });
});

describe("command gating", () => {
  test("allow_command_hooks=false turns a command hook into a failed notification", async () => {
    const engine = engineFor([new Hook({ id: "cmd", event: "turn_start", action: new Action("command", { command: "true" }) })]);
    const [notification] = await engine.runHooks("turn_start", new HookContext());
    expect(notification).toMatchObject({ output: "command hooks are disabled", success: false });
    expect(engine.drainPromptMessages()).toEqual([]);
  });

  test("allow_command_hooks=true runs the argv via the injected spawn", async () => {
    const calls: string[][] = [];
    const engine = engineFor([new Hook({ id: "cmd", event: "turn_start", action: new Action("command", { command: "echo $TOOL_NAME" }) })], {
      allowCommandHooks: true,
      spawn: async (args, timeoutMs) => {
        calls.push([...args, String(timeoutMs)]);
        return { stdout: "ok\n", stderr: "", exitCode: 0 };
      },
    });
    const [notification] = await engine.runHooks("turn_start", new HookContext({ toolName: "query_data" }));
    expect(calls).toEqual([["echo", "query_data", "10000"]]);
    expect(notification).toMatchObject({ output: "ok", success: true });
  });
});

describe("executeAction", () => {
  test("prompt expands the context", async () => {
    const ctx = new HookContext({ toolName: "query_data", message: "请分析" });
    expect(await executeAction(new Action("prompt", { message: "[$TOOL_NAME] $MESSAGE" }), ctx)).toEqual({
      output: "[query_data] 请分析",
      success: true,
    });
  });

  test("unsupported action types are reported", async () => {
    expect(await executeAction(new Action("sms"), new HookContext())).toEqual({
      output: "unsupported hook action: sms",
      success: false,
    });
  });

  test("http sends the expanded URL, merged headers and a Python-formatted JSON body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("accepted", { status: 201 });
    }) as unknown as typeof fetch;
    const action = new Action("http", {
      url: "https://example.com/$TOOL_NAME",
      method: "post",
      headers: { "X-Trace": "$SESSION_ID", "Content-Type": "text/plain" },
      body: { tool: "$TOOL_NAME", args: [1, true, null], note: "中文" },
    });
    const result = await executeAction(action, new HookContext({ toolName: "query_data", sessionId: "s-1" }), {
      fetch: fakeFetch,
    });
    expect(result).toEqual({ output: "accepted", success: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.com/query_data");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "Content-Type": "text/plain", "X-Trace": "s-1" });
    expect(calls[0]!.init.body).toBe('{"tool": "query_data", "args": [1, true, null], "note": "中文"}');
  });

  test("http GET carries no body", async () => {
    const calls: RequestInit[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await executeAction(new Action("http", { url: "https://example.com", method: "get", body: { a: 1 } }), new HookContext(), {
      fetch: fakeFetch,
    });
    expect(result).toEqual({ output: "", success: true });
    expect(calls[0]!.body).toBeUndefined();
  });

  test("http reports non-2xx exactly like urllib's HTTPError", async () => {
    const fakeFetch = (async () => new Response("ignored", { status: 404 })) as unknown as typeof fetch;
    expect(await executeAction(new Action("http", { url: "https://example.com" }), new HookContext(), { fetch: fakeFetch })).toEqual({
      output: "HTTP Error 404: Not Found",
      success: false,
    });
  });

  test("http keeps only the first 4096 bytes of the response", async () => {
    const body = "x".repeat(5000);
    const fakeFetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const result = await executeAction(new Action("http", { url: "https://example.com" }), new HookContext(), { fetch: fakeFetch });
    expect(result.success).toBe(true);
    expect(result.output.length).toBe(4096);
  });

  test("http rejects other schemes without calling fetch", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    expect(await executeAction(new Action("http", { url: "ftp://example.com/$TOOL_NAME" }), new HookContext({ toolName: "q" }), { fetch: fakeFetch })).toEqual({
      output: "http action only supports http:// and https:// URLs",
      success: false,
    });
    expect(called).toBe(false);
  });

  test("http timeout aborts the request and reports urllib's timeout text", async () => {
    let fire: (() => void) | null = null;
    let cleared: unknown = null;
    let delay = 0;
    const fakeFetch = ((_url: string, init: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      return promise;
    }) as unknown as typeof fetch;
    const pending = executeAction(new Action("http", { url: "https://example.com", timeout: 3 }), new HookContext(), {
      fetch: fakeFetch,
      timers: {
        set: (callback, milliseconds) => {
          fire = callback;
          delay = milliseconds;
          return "handle";
        },
        clear: (handle) => {
          cleared = handle;
        },
      },
    });
    expect(delay).toBe(3000);
    expect(cleared).toBeNull();
    fire!();
    expect(await pending).toEqual({ output: "<urlopen error timed out>", success: false });
    expect(cleared).toBe("handle");
  });

  test("command needs allow_command, a non-empty argv and valid quoting", async () => {
    const empty = new Action("command", { command: "   " });
    expect(await executeAction(new Action("command", { command: "echo hi" }), new HookContext())).toEqual({
      output: "command hooks are disabled",
      success: false,
    });
    expect(await executeAction(empty, new HookContext(), { allowCommand: true })).toEqual({
      output: "command is empty",
      success: false,
    });
    expect(await executeAction(new Action("command", { command: "echo 'unclosed" }), new HookContext(), { allowCommand: true })).toEqual({
      output: "invalid command syntax: No closing quotation",
      success: false,
    });
    expect(await executeAction(new Action("command", { command: "echo trailing\\" }), new HookContext(), { allowCommand: true })).toEqual({
      output: "invalid command syntax: No escaped character",
      success: false,
    });
  });

  test("command runs argv with no shell, strips output and reports the exit status", async () => {
    const run = (command: string) =>
      executeAction(new Action("command", { command, timeout: 30 }), new HookContext(), { allowCommand: true });

    expect(await run("printf 'hello\\n'")).toEqual({ output: "hello", success: true });
    expect(await run("printf '中文'")).toEqual({ output: "中文", success: true });
    expect(await run("sh -c 'echo out; echo err 1>&2; exit 3'")).toEqual({ output: "out", success: false });
    expect(await run("sh -c 'echo err 1>&2'")).toEqual({ output: "err", success: true });
    // Python 的 `(stdout or stderr)` 会选中 stdout，即使 strip 之后它是 ""。
    expect(await run("sh -c 'printf \"\\n\"; echo err 1>&2'")).toEqual({ output: "", success: true });
  });

  test("command truncates to 4000 code points and honours the timeout", async () => {
    const seen: string[][] = [];
    const truncating = await executeAction(new Action("command", { command: "emit", timeout: 5 }), new HookContext(), {
      allowCommand: true,
      spawn: async (args, timeoutMs) => {
        seen.push([...args, String(timeoutMs)]);
        return { stdout: "x".repeat(5000), stderr: "", exitCode: 0 };
      },
    });
    expect(seen).toEqual([["emit", "5000"]]);
    expect(truncating.output.length).toBe(4000);
    expect(truncating.success).toBe(true);

    expect(
      await executeAction(new Action("command", { command: "sleep 100", timeout: 5 }), new HookContext(), {
        allowCommand: true,
        spawn: async () => ({ stdout: "", stderr: "", exitCode: null, timedOut: true }),
      }),
    ).toEqual({ output: "command timed out after 5s", success: false });
  });

  test("command expands the command before splitting", async () => {
    const seen: string[][] = [];
    await executeAction(new Action("command", { command: "echo $TOOL_NAME '$MESSAGE'" }), new HookContext({ toolName: "query_data", message: "hi there" }), {
      allowCommand: true,
      spawn: async (args) => {
        seen.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(seen).toEqual([["echo", "query_data", "hi there"]]);
  });
});
