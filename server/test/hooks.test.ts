import { describe, expect, test } from "bun:test";
import golden from "./golden/hooks.json";
import { evaluateCondition } from "../src/agent/hooks/conditions.ts";
import { DISPATCHED_EVENTS, EVENT_ALIASES, SUPPORTED_EVENTS, normalizeEventName } from "../src/agent/hooks/events.ts";
import { HookConfigError, loadSettings, serializeSettings } from "../src/agent/hooks/loader.ts";
import { Action, Hook, HookContext, type HookContextInit } from "../src/agent/hooks/models.ts";
import { OnceRegistry, type OnceKey } from "../src/agent/hooks/engine.ts";
import { shlexSplit } from "../src/agent/hooks/shlex.ts";

type HookJson = {
  id: string;
  event: string;
  name?: string;
  enabled?: boolean;
  internalEndpoint?: boolean;
  condition?: string;
  reject?: boolean;
  once?: boolean;
  onceScope?: string;
  asyncExec?: boolean;
  executed?: boolean;
};

type OnceOp =
  | { op: "reserve"; hook: { id: string; once: boolean; onceScope: string }; context: HookContextInit }
  | { op: "release" | "complete"; key: OnceKey | null };

type Golden = {
  contexts: Record<string, HookContextInit>;
  conditions: { context: string; expr: string; expected: boolean }[];
  expansion: { context: HookContextInit; template: unknown; expected: unknown }[];
  loader: { raw: unknown; settings?: unknown; error?: string }[];
  should_run: { hook: HookJson; context: HookContextInit; expected: boolean }[];
  once: { name: string; max_completed: number | null; ops: OnceOp[]; expected: (OnceKey | null | true)[] }[];
  events: { supported: string[]; dispatched: string[]; normalize: { input: string; expected: string }[] };
  shlex: { input: string; posix: boolean; tokens?: string[]; error?: string }[];
};

// 期望值来自真实的 Python 实现（scripts/golden/export_hooks.py）。
const cases = golden as unknown as Golden;

function hookFromJson(json: HookJson): Hook {
  return new Hook({
    id: json.id,
    event: json.event,
    action: new Action("prompt", { message: "x" }),
    ...(json.name === undefined ? {} : { name: json.name }),
    ...(json.enabled === undefined ? {} : { enabled: json.enabled }),
    ...(json.internalEndpoint === undefined ? {} : { internalEndpoint: json.internalEndpoint }),
    ...(json.condition === undefined ? {} : { condition: json.condition }),
    ...(json.reject === undefined ? {} : { reject: json.reject }),
    ...(json.once === undefined ? {} : { once: json.once }),
    ...(json.onceScope === undefined ? {} : { onceScope: json.onceScope }),
    ...(json.asyncExec === undefined ? {} : { asyncExec: json.asyncExec }),
    ...(json.executed === undefined ? {} : { executed: json.executed }),
  });
}

describe("shlexSplit", () => {
  // agent/hooks/conditions.py 和命令执行器都调用 shlex.split。
  test("matches CPython's shlex.split on every golden input", () => {
    const failures = cases.shlex.flatMap(({ input, posix, tokens, error }) => {
      let got: string[] | string;
      try {
        got = shlexSplit(input, posix);
      } catch (thrown) {
        got = String(thrown);
        if (!error || !got.endsWith(error)) return [`${JSON.stringify(input)} posix=${posix}: want error ${error} got ${got}`];
        return [];
      }
      return error ? [`${JSON.stringify(input)} posix=${posix}: want error ${error} got ${JSON.stringify(got)}`] : [];
    });
    expect(failures).toEqual([]);

    const tokenFailures = cases.shlex.flatMap(({ input, posix, tokens, error }) => {
      if (error) return [];
      const got = shlexSplit(input, posix);
      return JSON.stringify(got) === JSON.stringify(tokens) ? [] : [`${JSON.stringify(input)} posix=${posix}: want ${JSON.stringify(tokens)} got ${JSON.stringify(got)}`];
    });
    expect(tokenFailures).toEqual([]);
    expect(cases.shlex.some((c) => c.error !== undefined)).toBe(true);
    expect(cases.shlex.some((c) => !c.posix)).toBe(true);
  });

  test("keeps an empty quoted argument but drops bare whitespace", () => {
    expect(shlexSplit("echo ''")).toEqual(["echo", ""]);
    expect(shlexSplit("   ")).toEqual([]);
    expect(() => shlexSplit("echo 'x")).toThrow("No closing quotation");
    expect(() => shlexSplit("echo x\\")).toThrow("No escaped character");
  });
});

describe("evaluateCondition", () => {
  test("matches Python on every golden expression/context pair", () => {
    const failures = cases.conditions.flatMap(({ context, expr, expected }) => {
      const got = evaluateCondition(expr, new HookContext(cases.contexts[context]!));
      return got === expected ? [] : [`${context} ${JSON.stringify(expr)}: want ${expected} got ${got}`];
    });
    expect(failures).toEqual([]);
    expect(new Set(cases.conditions.map((c) => c.expr)).size).toBeGreaterThanOrEqual(80);
    expect(Object.keys(cases.contexts).length).toBeGreaterThanOrEqual(4);
  });

  test("empty expressions are true; malformed clauses are false", () => {
    const ctx = new HookContext(cases.contexts.rich!);
    expect(evaluateCondition("", ctx)).toBe(true);
    expect(evaluateCondition("   ", ctx)).toBe(true);
    expect(evaluateCondition("tool_name == 'unclosed", ctx)).toBe(false);
    expect(evaluateCondition("tool_name ~ query_data", ctx)).toBe(false);
  });
});

describe("HookContext.expand", () => {
  test("matches Python's $NAME substitution on every golden template", () => {
    const failures = cases.expansion.flatMap(({ context, template, expected }) => {
      const got = new HookContext(context).expand(template);
      return JSON.stringify(got) === JSON.stringify(expected)
        ? []
        : [`${JSON.stringify(template)}: want ${JSON.stringify(expected)} got ${JSON.stringify(got)}`];
    });
    expect(failures).toEqual([]);
  });

  test("is $NAME, not ${NAME}, and never reads the environment", () => {
    const ctx = new HookContext({ toolName: "query_data", toolArgs: { sql: "SELECT 1" } });
    expect(ctx.expand("${TOOL_NAME}")).toBe("${TOOL_NAME}");
    expect(ctx.expand("$TOOL_NAME")).toBe("query_data");
    expect(ctx.expand("$TOOL_ARGS.SQL")).toBe("SELECT 1");
    expect(ctx.expand("$ARGS")).toBe('{"sql": "SELECT 1"}');
    expect(ctx.expand("$NONEXISTENT")).toBe("");
  });
});

describe("loadSettings", () => {
  test("matches every golden validation outcome", () => {
    const failures = cases.loader.flatMap(({ raw, settings, error }) => {
      try {
        const got = serializeSettings(loadSettings(raw));
        if (error) return [`${JSON.stringify(raw)}: want error ${JSON.stringify(error)} got ${JSON.stringify(got)}`];
        return JSON.stringify(got) === JSON.stringify(settings)
          ? []
          : [`${JSON.stringify(raw)}: want ${JSON.stringify(settings)} got ${JSON.stringify(got)}`];
      } catch (thrown) {
        if (!(thrown instanceof HookConfigError)) return [`${JSON.stringify(raw)}: threw ${String(thrown)}`];
        if (!error) return [`${JSON.stringify(raw)}: unexpected error ${JSON.stringify(thrown.message)}`];
        return thrown.message === error ? [] : [`${JSON.stringify(raw)}: want error ${JSON.stringify(error)} got ${JSON.stringify(thrown.message)}`];
      }
    });
    expect(failures).toEqual([]);
    expect(cases.loader.some((c) => c.error !== undefined)).toBe(true);
  });

  test("checks the hook list before the top-level booleans", () => {
    expect(() => loadSettings({ enabled: "yes", hooks: [{}] })).toThrow("hook[0].id is required");
    expect(() => loadSettings({ hooks: [{ id: "a", event: "turn_start", action: { type: "prompt", message: "x" } }, { id: "a", event: "turn_start", action: { type: "prompt", message: "x" } }] })).toThrow(
      "hook ids must be unique",
    );
  });
});

describe("Hook.shouldRun", () => {
  test("matches the golden truth table", () => {
    const failures = cases.should_run.flatMap(({ hook, context, expected }) => {
      const got = hookFromJson(hook).shouldRun(new HookContext(context));
      return got === expected ? [] : [`${JSON.stringify(hook)}: want ${expected} got ${got}`];
    });
    expect(failures).toEqual([]);
  });
});

describe("OnceRegistry", () => {
  test("replays every golden sequence", () => {
    const failures = cases.once.flatMap((sequence) => {
      const registry = new OnceRegistry(sequence.max_completed ?? 10_000);
      return sequence.ops.flatMap((op, index) => {
        let got: OnceKey | null | true;
        if (op.op === "reserve") {
          const hook = new Hook({
            id: op.hook.id,
            event: "turn_start",
            action: new Action("prompt", { message: "x" }),
            once: op.hook.once,
            onceScope: op.hook.onceScope,
          });
          got = registry.reserve(hook, new HookContext(op.context));
        } else {
          if (op.op === "release") registry.release(op.key ?? ["", ""]);
          else registry.complete(op.key ?? ["", ""]);
          got = true;
        }
        const expected = sequence.expected[index];
        return JSON.stringify(got) === JSON.stringify(expected)
          ? []
          : [`${sequence.name}[${index}] ${op.op}: want ${JSON.stringify(expected)} got ${JSON.stringify(got)}`];
      });
    });
    expect(failures).toEqual([]);
  });

  test("reserving twice before completion is refused, and a released reservation frees the hook", () => {
    const registry = new OnceRegistry();
    const hook = new Hook({ id: "h", event: "turn_start", action: new Action("prompt", { message: "x" }), once: true });
    const ctx = new HookContext({ sessionId: "s", turnId: "t" });
    const key = registry.reserve(hook, ctx);
    expect(key).toEqual(["h", "session:s"]);
    expect(registry.reserve(hook, ctx)).toBeNull();
    registry.release(key!);
    expect(registry.reserve(hook, ctx)).toEqual(["h", "session:s"]);
  });
});

describe("event vocabulary", () => {
  test("supported and dispatched sets match Python", () => {
    expect(Object.keys(SUPPORTED_EVENTS).sort()).toEqual(cases.events.supported);
    expect(Object.keys(DISPATCHED_EVENTS).sort()).toEqual(cases.events.dispatched);
  });

  test("session_end and permission_request are declared but never dispatched", () => {
    expect(SUPPORTED_EVENTS.session_end).toBe(true);
    expect(SUPPORTED_EVENTS.permission_request).toBe(true);
    expect(DISPATCHED_EVENTS.session_end).toBeUndefined();
    expect(DISPATCHED_EVENTS.permission_request).toBeUndefined();
  });

  test("normalizes every golden spelling", () => {
    const failures = cases.events.normalize.flatMap(({ input, expected }) => {
      const got = normalizeEventName(input);
      return got === expected ? [] : [`${JSON.stringify(input)}: want ${expected} got ${got}`];
    });
    expect(failures).toEqual([]);
    expect(EVENT_ALIASES.turnbegin).toBe("turn_start");
  });
});
