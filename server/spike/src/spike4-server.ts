// Spike 4: Hono server on 127.0.0.1 with a bearer token, over a pi-durable Harness.
//
//   POST /v1/conversations/:id/submit  {requestId, text} -> {submissionId}   (id "root" = root conversation)
//   GET  /v1/conversations/:id/subscribe                 -> SSE: `snapshot` {seq:0, view}, then `ops` {seq, ops}
//                                                            (Chord delta ops on ConversationView, from conversation.watch())
//   GET  /static/plotly.min.js, /chart.html              -> web-view assets (token as ?token=: a page load sends no header)
//
// Env: SPIKE_PORT (default 0 = random), SPIKE_TOKEN (default random), SPIKE_DB (default .data/spike4.sqlite),
//      SPIKE_CHUNK_MS (stub model delay per streamed chunk, default 40; raise it to watch a reply stream in).
// Prints `LISTEN <url> TOKEN=<token>` on stdout once ready. The OpenAI stub model runs in-process.
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { type Conversation, type ConversationId, defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { ctx, MODEL, openHarness } from "./common.ts";
import { startStub } from "./stub-openai.ts";

const token = process.env.SPIKE_TOKEN ?? randomBytes(24).toString("base64url");
const plotlyPath = resolve(import.meta.dir, "../../../static/vendor/plotly.min.js");
const stub = startStub({ chunkDelayMs: Number(process.env.SPIKE_CHUNK_MS ?? 40) });

const describeTable = defineTool({
  name: "describe_table",
  description: "Describe a table",
  parameters: { type: "object", properties: { table: { type: "string" } }, required: ["table"] },
  replay: "safe",
  execute: async (args, api) => {
    const { table } = args as { table: string }; // validated by the Harness against `parameters`
    api.output(`scanning ${table}…\n`);
    await Bun.sleep(500);
    return { output: [{ type: "text", text: `${table}: 42 rows, 7 columns` }] };
  },
});

const harness = await openHarness(process.env.SPIKE_DB ?? ".data/spike4.sqlite", stub.url, [
  defineExtension({ name: "spike4", tools: [describeTable] }),
]);
harness.resume();
await harness.root(ctx, { agent: { model: MODEL } });

/** `root`, or a conversation's numeric id: ids are integers in the view JSON (`"conversation":{"id":1}`). */
async function conversation(param: string): Promise<Conversation | undefined> {
  if (param === "root") return harness.conversation(ROOT_CONVERSATION_ID, ctx);
  if (!/^[1-9][0-9]*$/.test(param)) return undefined;
  // ConversationId is an erased brand over an integer (pi-durable's idFromNumber is not exported); checked above.
  const id = Number(param) as ConversationId;
  return harness.conversation(id, ctx);
}

const app = new Hono();
app.use("/v1/*", bearerAuth({ token }));

app.post("/v1/conversations/:id/submit", async (c) => {
  const conv = await conversation(c.req.param("id"));
  if (conv === undefined) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json<{ requestId?: string; text?: string }>();
  if (typeof body.requestId !== "string" || typeof body.text !== "string") return c.json({ error: "requestId and text required" }, 400);
  const submission = await conv.submit({ type: "input", content: body.text, requestId: body.requestId }, ctx);
  return c.json({ submissionId: submission.id, status: (await submission.status(ctx)).status });
});

app.get("/v1/conversations/:id/subscribe", async (c) => {
  const conv = await conversation(c.req.param("id"));
  if (conv === undefined) return c.json({ error: "not_found" }, 404);
  return streamSSE(c, async (sse) => {
    const watch = await conv.watch(ctx);
    let seq = 0;
    await sse.writeSSE({ event: "snapshot", id: "0", data: JSON.stringify({ seq, view: watch.value }) });
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      seq += 1;
      await sse.writeSSE({ event: "ops", id: String(seq), data: JSON.stringify({ seq, ops: call.ops }) });
    });
    sse.onAbort(() => void watch.stop());
    const end = await watch.closed;
    await sse.writeSSE({ event: "end", data: JSON.stringify({ kind: end.kind }) });
  });
});

// Web-view assets. WebKit cannot set an Authorization header on a page load, so ?token= is accepted here.
app.get("/static/plotly.min.js", async (c) => {
  if (c.req.query("token") !== token) return c.text("unauthorized", 401);
  return new Response(Bun.file(plotlyPath), { headers: { "content-type": "text/javascript" } });
});
app.get("/chart.html", (c) => {
  if (c.req.query("token") !== token) return c.text("unauthorized", 401);
  return c.html(`<!doctype html><html><head><meta charset="utf-8">
<script src="/static/plotly.min.js?token=${encodeURIComponent(token)}"></script>
<style>html,body{margin:0;height:100%;background:#fff}#chart{width:100%;height:100%}</style></head>
<body><div id="chart"></div><script>
Plotly.newPlot("chart", [{ type: "bar", x: ["Jan","Feb","Mar","Apr","May"], y: [12, 19, 7, 23, 15], marker: { color: "#4f7cff" } }],
  { title: { text: "Monthly sales (spike)" }, margin: { t: 48, l: 40, r: 16, b: 32 } }, { displayModeBar: false, responsive: true });
</script></body></html>`);
});

const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.SPIKE_PORT ?? 0), idleTimeout: 0, fetch: app.fetch });
console.log(`LISTEN http://127.0.0.1:${server.port} TOKEN=${token}`);

const shutdown = async () => {
  server.stop(true);
  await harness.close(ctx);
  stub.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
