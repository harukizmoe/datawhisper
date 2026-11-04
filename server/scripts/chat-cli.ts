/**
 * 命令行客户端（P3.5 的验收工具，也是界面接入前的调试入口）。
 *
 * 用法：
 *   DW_TOKEN=… DW_PORT=… bun run scripts/chat-cli.ts "你好" [--conversation 1] [--command ppt]
 *
 * 它走的就是界面用的 HTTP 协议：先 `POST /v1/conversations`（或复用给定会话），再订阅 SSE 拿 `snapshot`+`ops`，
 * 提交一轮，边收边打印增量，运行结束后打印最终消息与用量。任何一步失败都以非零码退出并打印服务端返回的错误。
 */
import { createParts } from "./chat-cli-parts.ts";

const args = process.argv.slice(2);
const text = args.find((arg) => !arg.startsWith("--"));
if (text === undefined) {
  console.error('用法：bun run scripts/chat-cli.ts "你的问题" [--conversation <id>] [--command <name>]');
  process.exit(2);
}

const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const base = `http://127.0.0.1:${process.env.DW_PORT ?? "0"}/v1`;
const token = process.env.DW_TOKEN ?? "";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { headers, ...init });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

const requested = flag("conversation");
const conversationId = requested ?? String((await api<{ id: number }>("/conversations", { method: "POST" })).id);
// `root` 是保留会话的别名，原样用于 URL；只有数字 id 才转成数字。
const parts = createParts({ conversationId });

// 订阅要先于提交建立，否则会丢掉最早的增量。
const controller = new AbortController();
const stream = await fetch(`${base}/conversations/${conversationId}/subscribe`, { headers, signal: controller.signal });
if (!stream.ok || stream.body === null) throw new Error(`订阅失败：${stream.status}`);

const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const pump = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      parts.consume(frame);
      split = buffer.indexOf("\n\n");
    }
  }
})();

await api(`/conversations/${conversationId}/submit`, {
  method: "POST",
  body: JSON.stringify({
    requestId: crypto.randomUUID(),
    text,
    ...(flag("command") === undefined ? {} : { command: flag("command") }),
  }),
});

// 运行结束的判定交给增量：`pi.live.run` 消失且已有助手条目（与服务端的 answered 判定一致）。
while (!parts.answered()) await Bun.sleep(50);

controller.abort();
await pump.catch(() => undefined);
parts.printFinal();
process.exit(0);
