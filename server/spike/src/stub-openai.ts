// Scripted OpenAI-compatible chat-completions stub (streaming SSE only).
//
// Behaviour, decided from the request's messages:
// - last message is a tool result  -> stream a final text answer that quotes the tool result
// - last user message contains `CALL:<tool>` markers (each optionally `CALL:<tool>{flat json}`) and no tool
//   result has been seen since that user message -> stream one tool call per marker, in one response
// - otherwise -> stream a markdown answer in small chunks
//
// Every request is appended to `log` (offered tool names, message roles, last user text) so
// spikes can assert how often and with what the model was called.

export type StubRequest = {
  n: number;
  model: string;
  tools: string[];
  /** Tools declared in place by mid-conversation system messages (pi-ai "additions" mode), one list per message. */
  systemTools: string[][];
  roles: string[];
  lastUser: string;
  lastTool?: string;
  authorization: string | null;
  /** Raw request body, for inspecting payload shape (tools/messages order, cache keys). */
  body: Record<string, unknown>;
};

export type Stub = { url: string; log: StubRequest[]; stop(): void };

type Msg = { role: string; content?: unknown; tool_calls?: unknown; tools?: { function: { name: string } }[] };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("");
  return "";
}

export function startStub(options: { port?: number; chunkDelayMs?: number; onRequest?: (r: StubRequest) => void } = {}): Stub {
  const log: StubRequest[] = [];
  const delay = options.chunkDelayMs ?? 15;
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const body = (await req.json()) as { model: string; messages: Msg[]; tools?: { function: { name: string } }[] };
      const messages = body.messages;
      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") { lastUserIndex = i; break; }
      const lastUser = lastUserIndex >= 0 ? text(messages[lastUserIndex]!.content) : "";
      const last = messages[messages.length - 1]!;
      const entry: StubRequest = {
        n: log.length + 1,
        model: body.model,
        tools: (body.tools ?? []).map((t) => t.function.name),
        roles: messages.map((m) => m.role),
        systemTools: messages.flatMap((m) => (m.role === "system" && m.tools ? [m.tools.map((t) => t.function.name)] : [])),
        lastUser,
        ...(last.role === "tool" ? { lastTool: text(last.content) } : {}),
        authorization: req.headers.get("authorization"),
        body,
      };
      log.push(entry);
      options.onRequest?.(entry);

      const id = `chatcmpl-${entry.n}`;
      const created = Math.floor(Date.now() / 1000);
      const chunk = (delta: object, finish: string | null = null, usage?: object) =>
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      const usage = { prompt_tokens: 100 + entry.n, completion_tokens: 20, total_tokens: 120 + entry.n };

      const calls = [...lastUser.matchAll(/CALL:([A-Za-z0-9_]+)(\{[^}]*\})?/g)];
      const toolSeenSinceUser = messages.slice(lastUserIndex + 1).some((m) => m.role === "tool");
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (s: string) => controller.enqueue(enc.encode(s));
          send(chunk({ role: "assistant", content: "" }));
          if (last.role !== "tool" && calls.length > 0 && !toolSeenSinceUser) {
            for (const [index, call] of calls.entries()) {
              const args = call[2] ?? "{}";
              const callId = index === 0 ? `call_${entry.n}` : `call_${entry.n}_${index}`;
              send(chunk({ tool_calls: [{ index, id: callId, type: "function", function: { name: call[1], arguments: "" } }] }));
              for (let i = 0; i < args.length; i += 4) {
                await Bun.sleep(delay);
                send(chunk({ tool_calls: [{ index, function: { arguments: args.slice(i, i + 4) } }] }));
              }
            }
            send(chunk({}, "tool_calls"));
          } else {
            const answer = last.role === "tool"
              ? `## Result\n\nThe tool returned: **${(entry.lastTool ?? "").slice(0, 200)}**\n\n- request #${entry.n}\n- tools offered: ${entry.tools.length}\n`
              : `## Hello\n\nThis is a **streamed** markdown reply from the stub (request #${entry.n}).\n\n| metric | value |\n|---|---|\n| rows | 42 |\n| cols | 7 |\n\n\`\`\`python\nprint("ok")\n\`\`\`\n`;
            for (let i = 0; i < answer.length; i += 6) {
              await Bun.sleep(delay);
              send(chunk({ content: answer.slice(i, i + 6) }));
            }
            send(chunk({}, "stop"));
          }
          send(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage })}\n\n`);
          send("data: [DONE]\n\n");
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, log, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.env.STUB_PORT ?? 0);
  const stub = startStub({ port, onRequest: (r) => console.log(JSON.stringify(r)) });
  console.log(`STUB_URL=${stub.url}`);
}
