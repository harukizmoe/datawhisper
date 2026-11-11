// Child process for spike 2. Owns the SQLite storage; the parent SIGKILLs it mid-tool.
// Usage: bun run src/spike2-child.ts <stubUrl> submit <requestId> <text>
//        bun run src/spike2-child.ts <stubUrl> resume
import { appendFileSync } from "node:fs";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { ctx, MODEL, openHarness } from "./common.ts";

const [stubUrl, mode, requestId, text] = process.argv.slice(2);
const db = ".data/spike2.sqlite";

function slowTool(name: "slow_safe" | "slow_unsafe", replay: "safe" | "unsafe") {
  return defineTool({
    name,
    description: `Sleep 3s (replay: ${replay}); counts every execution in .data/${name}.count`,
    parameters: { type: "object", properties: {} },
    replay,
    execute: async (_args, api) => {
      appendFileSync(`.data/${name}.count`, `pid=${process.pid} task=${api.taskId}\n`);
      console.log(`TOOL_START ${name} pid=${process.pid}`);
      api.output(`${name}: started in pid ${process.pid}\n`);
      await Bun.sleep(3000);
      api.output(`${name}: finished\n`);
      return { output: [{ type: "text", text: `${name} finished in pid ${process.pid}` }] };
    },
  });
}

const harness = await openHarness(db, stubUrl!, [
  defineExtension({ name: "spike2", tools: [slowTool("slow_safe", "safe"), slowTool("slow_unsafe", "unsafe")] }),
]);
const root = await harness.root(ctx, { agent: { model: MODEL } });

if (mode === "submit") {
  harness.resume();
  const submission = await root.submit({ type: "input", content: text!, requestId }, ctx);
  console.log(`SUBMITTED ${submission.id}`);
  const settled = await submission.wait(ctx);
  console.log(`SETTLED ${submission.id} ${settled.status}`);
} else if (mode === "resume") {
  const pending = await harness.inspect(ctx);
  console.log(`BEFORE_RESUME tasks=${JSON.stringify(pending.tasks.map((t) => ({ kind: t.record.kind, status: t.record.state.status, state: t.state.kind })))}`);
  harness.resume();
  await root.waitForIdle(ctx);
  const { items } = await root.entries({ order: "ascending" }, 200, undefined, ctx);
  for (const entry of items) {
    const message = entry.model?.[0];
    if (message?.role === "toolResult")
      console.log(`ENTRY ${entry.kind} ${message.toolName} isError=${message.isError} ${JSON.stringify(message.content.map((c) => (c.type === "text" ? c.text : c.type)).join(""))} data=${JSON.stringify(entry.data)}`);
    else if (message?.role === "assistant")
      console.log(`ENTRY ${entry.kind} ${message.content.map((c) => (c.type === "toolCall" ? `toolCall:${c.name}` : c.type === "text" ? `text:${JSON.stringify(c.text.slice(0, 50))}` : c.type)).join(" ")}`);
    else console.log(`ENTRY ${entry.kind}`);
  }
}
await harness.close(ctx);
process.exit(0);
