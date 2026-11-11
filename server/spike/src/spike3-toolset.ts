// Spike 3: a different tool subset (<=20 of 72) on every model request.
//
// Mechanism A — `conversation.configure({ modelTools })` (host, between submissions) and `configure(tx, …)` inside a
//   tool's `api.commit` (mid-run, between tool rounds). Durable records the change as a `pi.system` entry and
//   validates calls against what the request offered.
// Mechanism B — a `GenerationTask` `beforeProviderRequest` hook that filters the provider payload's `tools` per request.
//   Nothing is recorded; durable still resolves calls against `agent.tools`.
// A4 (observation, not pass/fail) — the same switching on a model whose pi-ai compat accepts mid-conversation tool
//   additions, to see where pi-ai puts the tools in the payload: that decides how much of the prompt-cache prefix survives.
// A5 — a parallel round in which two tools each change the next request's set from inside their own commit.
// A6 (observation, not pass/fail) — the host calls configure() while a run is inside a tool round, as it would to set
//   the tools for a follow-up typed during the run: does the running run's next request change?
import { rmSync } from "node:fs";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { ctx, MODEL, MODEL_ADDITIONS, openHarness } from "./common.ts";
import { startStub } from "./stub-openai.ts";

for (const f of ["spike3.sqlite", "spike3.sqlite-wal", "spike3.sqlite-shm"]) rmSync(`.data/${f}`, { force: true });
const stub = startStub({ chunkDelayMs: 1 });

const dummies: ToolRegistration[] = Array.from({ length: 71 }, (_, i) => {
  const name = `tool_${String(i + 1).padStart(2, "0")}`;
  return defineTool({
    name,
    description: `Dummy tool ${name}`,
    parameters: { type: "object", properties: {} },
    replay: "safe",
    execute: async () => ({ output: [{ type: "text", text: `${name} ran` }] }),
  });
});
const range = (from: number, to: number) => dummies.slice(from - 1, to);

// 72nd tool: keyword discovery. Mid-run it swaps the offered set for the next request of the same run.
const discover: ToolRegistration = defineTool({
  name: "discover_tools",
  description: "Load tools matching a keyword for the next request",
  parameters: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
  replay: "safe",
  execute: async (_args, api, context) => {
    const next = [...range(41, 59), discover];
    await api.commit((tx) => configure(tx, api.conversationId, { modelTools: next }), context);
    return { output: [{ type: "text", text: `loaded ${next.length} tools` }] };
  },
});

const allTools = [...dummies, discover];
const ToolsExt = defineExtension({ name: "tools72", tools: allTools });

// A5: each tool commits configure(tx, …) in its own api.commit, and the last commit wins. A tool that computes the
// set from what it alone knows drops a sibling's change ("naive_*"); folding every change into a conversation
// document in the same commit and computing the set from that document keeps them all ("shared_*").
const Exposure = defineDoc<{ completed: string[] }>({
  kind: "app.exposure",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ completed: [] }),
  checkpointWhen: () => true,
});
const unlocks: Record<string, string> = { naive_a: "tool_10", naive_b: "tool_11", shared_a: "tool_10", shared_b: "tool_11" };
const toolsByName = new Map<string, ToolRegistration>();
function stepTool(name: string, delayMs: number, shared: boolean): ToolRegistration {
  const family = name.slice(0, name.indexOf("_"));
  return defineTool({
    name,
    description: `Finish step ${name}; unlocks ${unlocks[name]}`,
    parameters: { type: "object", properties: {} },
    replay: "safe",
    execute: async (_args, api, context) => {
      await Bun.sleep(delayMs);
      await api.commit(async (tx) => {
        const state = await tx.doc(Exposure, api.conversationId);
        const completed = shared ? [...state.completed, name] : [name];
        const names = [`${family}_a`, `${family}_b`, ...completed.map((step) => unlocks[step]!)];
        await configure(tx, api.conversationId, { modelTools: names.map((n) => toolsByName.get(n)!) });
        if (shared) state.completed = completed;
      }, context);
      return { output: [{ type: "text", text: `${name} done` }] };
    },
  });
}
const stepTools = [stepTool("naive_a", 100, false), stepTool("naive_b", 400, false), stepTool("shared_a", 100, true), stepTool("shared_b", 400, true)];
// A6: a tool that stays in its round long enough for the host to configure() meanwhile.
const slowStep = defineTool({
  name: "slow_step",
  description: "Sleep 500ms",
  parameters: { type: "object", properties: {} },
  replay: "safe",
  execute: async () => {
    await Bun.sleep(500);
    return { output: [{ type: "text", text: "slow_step done" }] };
  },
});
for (const tool of [...allTools, ...stepTools, slowStep]) toolsByName.set(tool.name, tool);
const StepsExt = defineExtension({ name: "steps", tools: [...stepTools, slowStep] });

// Mechanism B: per-request payload rewrite. Picks a window of 20 by the number of assistant entries so far.
const PayloadFilter = defineExtension({
  name: "payload-filter",
  hooks: [
    hook(GenerationTask, {
      beforeProviderRequest: async (request, api, context) => {
        if (request.model.api !== "openai-completions") return undefined;
        const { items } = await api.entries({ order: "ascending" }, 1000, undefined, context);
        const round = items.filter((e) => e.kind === "pi.assistant").length;
        const offered = new Set(range(round * 20 + 1, round * 20 + 20).map((t) => t.name));
        const payload = request.payload as { tools?: { function: { name: string } }[] }; // openai-completions body, checked above
        return { payload: { ...payload, tools: (payload.tools ?? []).filter((t) => offered.has(t.function.name)) } };
      },
    }),
  ],
});

const harness = await openHarness(".data/spike3.sqlite", stub.url, [ToolsExt, PayloadFilter, StepsExt]);
harness.resume();
const results: Record<string, boolean> = {};
const observations: Record<string, boolean> = {};
const toolsOf = (n: number) => stub.log[n - 1]!.tools;
const show = (from: number) => stub.log.slice(from).forEach((r) => console.log(`  req #${r.n}: ${r.tools.length} tools [${r.tools.join(",")}] roles=${r.roles.join(",")}`));

console.log("== A1. configure({ modelTools }) between submissions (payload filter not selected)");
const a = await harness.root(ctx, { agent: { model: MODEL, extensions: [ToolsExt] } });
await a.configure({ modelTools: range(1, 20) }, ctx);
await (await a.submit({ type: "input", content: "first question" }, ctx)).wait(ctx);
await a.configure({ modelTools: [...range(21, 39), discover] }, ctx);
await (await a.submit({ type: "input", content: "second question" }, ctx)).wait(ctx);
show(0);
results["A1 turn 1 offers tool_01..tool_20"] = toolsOf(1).join() === range(1, 20).map((t) => t.name).join();
results["A1 turn 2 offers tool_21..tool_39 + discover_tools"] = toolsOf(2).join() === [...range(21, 39), discover].map((t) => t.name).join();

console.log("== A2. mid-run: discover_tools calls configure(tx, …) inside api.commit");
const mark = stub.log.length;
await (await a.submit({ type: "input", content: 'find chart tools CALL:discover_tools{"keyword":"chart"}' }, ctx)).wait(ctx);
show(mark);
results["A2 request before tool round offers previous set"] = toolsOf(mark + 1).includes("tool_21");
results["A2 next request in same run offers tool_41..tool_59 + discover"] =
  toolsOf(mark + 2).join() === [...range(41, 59), discover].map((t) => t.name).join();

console.log("== A3. model calls a tool the request did not offer");
const mark3 = stub.log.length;
await (await a.submit({ type: "input", content: "CALL:tool_05" }, ctx)).wait(ctx);
show(mark3);
console.log(`  model saw tool result: ${JSON.stringify(stub.log[mark3 + 1]?.lastTool)}`);
results["A3 unoffered tool rejected as tool_unavailable"] = /not available/.test(stub.log[mark3 + 1]?.lastTool ?? "");

const { items } = await a.entries({ order: "ascending" }, 200, undefined, ctx);
const systemEntries = items.filter((e) => e.kind === "pi.system").length;
console.log(`  conversation A entries: ${items.map((e) => e.kind).join(" ")}`);
console.log(`  pi.system entries written for tool changes: ${systemEntries}`);

console.log("== A4. observation: same switching on a model with mid-conversation tool additions (compat)");
const c = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL_ADDITIONS, extensions: [ToolsExt] } }, ctx);
const markC = stub.log.length;
const steps: [string, ToolRegistration[]][] = [
  ["tool_01..05", range(1, 5)],
  ["+tool_06..08 (additions only)", range(1, 8)],
  ["-tool_01,02 (removal)", range(3, 8)],
];
for (const [label, set] of steps) {
  await c.configure({ modelTools: set }, ctx);
  await (await c.submit({ type: "input", content: `turn ${label}` }, ctx)).wait(ctx);
}
for (const r of stub.log.slice(markC))
  console.log(`  req #${r.n}: top-level tools [${r.tools.join(",")}] in-place system tools ${JSON.stringify(r.systemTools)} roles=${r.roles.join(",")}`);
const [c1, c2, c3] = stub.log.slice(markC);
observations["A4 turn 2 (additions only) keeps turn 1's top-level tools"] = c2!.tools.join() === c1!.tools.join();
observations["A4 turn 3 (removal) rewrites the top-level tools"] = c3!.tools.join() !== c2!.tools.join();

console.log("== A5. parallel tool round: two tools each change what the next request offers");
for (const family of ["naive", "shared"] as const) {
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, extensions: [ToolsExt, StepsExt] } }, ctx);
  await conv.configure({ modelTools: [`${family}_a`, `${family}_b`].map((n) => toolsByName.get(n)!) }, ctx);
  const markS = stub.log.length;
  await (await conv.submit({ type: "input", content: `CALL:${family}_a CALL:${family}_b` }, ctx)).wait(ctx);
  show(markS);
  const after = toolsOf(markS + 2).join();
  if (family === "naive") observations["A5 naive: the slower tool's set replaces the faster one's (tool_10 lost)"] = after === "naive_a,naive_b,tool_11";
  else results["A5 shared document: next request offers both unlocks"] = after === "shared_a,shared_b,tool_10,tool_11";
}

console.log("== A6. observation: the host calls configure() while a run is inside a tool round");
const d = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, extensions: [ToolsExt, StepsExt] } }, ctx);
await d.configure({ modelTools: [slowStep, ...range(1, 3)] }, ctx);
const markD = stub.log.length;
const busy = await d.submit({ type: "input", content: "CALL:slow_step" }, ctx);
while (stub.log.length === markD) await Bun.sleep(10); // the tool-calling request arrived; slow_step now sleeps 500ms
await Bun.sleep(200);
await d.configure({ modelTools: [slowStep, ...range(4, 6)] }, ctx);
await busy.wait(ctx);
show(markD);
const nextOffered = toolsOf(markD + 2);
observations["A6 host configure() during the tool round changes the running run's next request"] =
  nextOffered.includes("tool_04") && !nextOffered.includes("tool_01");

console.log("== B. beforeProviderRequest hook rewrites payload.tools per request (all 72 enabled)");
const b = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL, extensions: [ToolsExt, PayloadFilter] } }, ctx);
const markB = stub.log.length;
await (await b.submit({ type: "input", content: "CALL:tool_03" }, ctx)).wait(ctx);
show(markB);
results["B request 1 offers tool_01..tool_20"] = toolsOf(markB + 1).join() === range(1, 20).map((t) => t.name).join();
results["B request 2 (same run) offers tool_21..tool_40"] = toolsOf(markB + 2).join() === range(21, 40).map((t) => t.name).join();
const markB2 = stub.log.length;
await (await b.submit({ type: "input", content: "CALL:tool_70" }, ctx)).wait(ctx);
show(markB2);
console.log(`  model called tool_70 which was NOT in the payload; result: ${JSON.stringify(stub.log[markB2 + 1]?.lastTool)}`);
const bEntries = (await b.entries({ order: "ascending" }, 200, undefined, ctx)).items;
console.log(`  conversation B entries: ${bEntries.map((e) => e.kind).join(" ")}`);
results["B (gap) tool outside the payload still executes"] = stub.log[markB2 + 1]?.lastTool === "tool_70 ran";

console.log("== payload shape of last request (keys, order)");
console.log(`  keys: ${Object.keys(stub.log[stub.log.length - 1]!.body).join(",")}`);
console.log(`  prompt_cache_key: ${JSON.stringify(stub.log[stub.log.length - 1]!.body.prompt_cache_key)}`);

console.log("== results");
for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
console.log("== observations (informational, not pass/fail)");
for (const [k, v] of Object.entries(observations)) console.log(`  ${v ? "YES" : "NO "}  ${k}`);
const ok = Object.values(results).every(Boolean);
console.log(ok ? "SPIKE3 PASS" : "SPIKE3 FAIL");
await harness.close(ctx);
stub.stop();
process.exit(ok ? 0 : 1);
