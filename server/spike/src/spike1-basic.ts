// Spike 1: pi-durable on Bun with node:sqlite storage and a custom OpenAI-compatible provider.
// One turn: the stub model calls a tool, gets its result, then streams a final answer.
import { rmSync } from "node:fs";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { ctx, MODEL, openHarness } from "./common.ts";
import { startStub } from "./stub-openai.ts";

const db = ".data/spike1.sqlite";
rmSync(".data/spike1.sqlite", { force: true });
rmSync(".data/spike1.sqlite-wal", { force: true });
rmSync(".data/spike1.sqlite-shm", { force: true });

console.log(`runtime: Bun ${Bun.version}, process.versions.node=${process.versions.node}`);
const stub = startStub();

const rowCount = defineTool({
  name: "get_row_count",
  description: "Return the number of rows in a table",
  parameters: { type: "object", properties: { table: { type: "string" } }, required: ["table"] },
  replay: "safe",
  execute: async (args) => {
    const { table } = args as { table: string }; // validated by the Harness against `parameters`
    return { output: [{ type: "text", text: `table ${table} has 1234 rows` }], details: { table, rows: 1234 } };
  },
});

const harness = await openHarness(db, stub.url, [defineExtension({ name: "spike1", tools: [rowCount] })]);
harness.resume();
const root = await harness.root(ctx, { agent: { model: MODEL } });
const submission = await root.submit({ type: "input", content: 'How many rows? CALL:get_row_count{"table":"sales"}', requestId: "spike1-req-1" }, ctx);
const settled = await submission.wait(ctx);
console.log("submission", submission.id, "status", settled.status);

const { items } = await root.entries({ order: "ascending" }, 100, undefined, ctx);
for (const entry of items) {
  const message = entry.model?.[0];
  const summary = message === undefined
    ? ""
    : message.role === "assistant"
      ? message.content.map((c) => (c.type === "text" ? `text(${JSON.stringify(c.text.slice(0, 60))}…)` : c.type === "toolCall" ? `toolCall(${c.name} ${JSON.stringify(c.arguments)})` : c.type)).join(" ")
      : message.role === "toolResult"
        ? `toolResult(${message.toolName}: ${message.content.map((c) => (c.type === "text" ? c.text : c.type)).join("")})`
        : message.role;
  console.log(`entry ${entry.kind} ${summary}`);
}
console.log("stub requests:", stub.log.map((r) => ({ n: r.n, tools: r.tools, roles: r.roles.join(","), auth: r.authorization })));
const usage = await harness.usage(ctx);
console.log("usage:", JSON.stringify(usage).slice(0, 300));

const ok = settled.status === "done" && stub.log.length === 2 && items.some((e) => e.kind === "pi.tool-result");
console.log(ok ? "SPIKE1 PASS" : "SPIKE1 FAIL");
await harness.close(ctx);
stub.stop();
process.exit(ok ? 0 : 1);
