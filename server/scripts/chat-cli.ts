/**
 * 命令行客户端（P3.5 的验收工具，也是界面接入前的调试入口）。
 *
 * 用法：
 *   bun run scripts/chat-cli.ts "你好" [--conversation 1] [--command ppt] [--service <路径>]
 *
 * 它走的就是界面用的管道协议：默认自己拉起 `src/main.ts` 作为子进程（stdin/stdout 就是管道），
 * 也可以 `--service` 指定别的服务入口。先 `conversation.create`（或复用给定会话），再
 * `conversation.subscribe` 拿 `snapshot`+`ops`，提交一轮，边收边打印增量，运行结束后打印最终消息与用量。
 * 任何一步失败都以非零码退出并打印错误（业务错误的 `data.kind` 会出现在消息里）。
 */
import { Readable } from "node:stream";
import { join } from "node:path";
import { IpcClient } from "../src/ipc/client.ts";
import { RpcError } from "../src/ipc/errors.ts";
import type { LineSink } from "../src/ipc/framing.ts";
import type { SubmitResponse } from "../src/protocol.ts";
import { createParts } from "./chat-cli-parts.ts";

export type ChatConnection = { client: IpcClient; close(): void | Promise<void> };

export type ChatCliOptions = {
  /** 注入连接（测试用）；不给时 CLI 自己拉起服务进程。 */
  connect?: () => Promise<ChatConnection>;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** 自拉起服务时追加/覆盖的环境变量。 */
  env?: Record<string, string | undefined>;
};

const USAGE = '用法：bun run scripts/chat-cli.ts "你的问题" [--conversation <id>] [--command <name>] [--service <路径>]\n';

function describe(error: unknown): string {
  if (error instanceof RpcError) {
    const kind = error.data?.kind;
    return kind === undefined ? error.message : `${kind}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** 拉起服务子进程并把它的 stdin/stdout 当管道用；父进程关闭 stdin 即服务优雅退出。 */
async function spawnService(servicePath: string | undefined, env: Record<string, string | undefined>): Promise<ChatConnection> {
  const serverDir = join(import.meta.dir, "..");
  const proc = Bun.spawn(["bun", "run", servicePath ?? join(serverDir, "src/main.ts")], {
    cwd: serverDir,
    env: { ...process.env, ...env } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const input = Readable.fromWeb(proc.stdout as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const write: LineSink = (line) => {
    proc.stdin.write(`${line}\n`);
    proc.stdin.flush();
  };
  const client = new IpcClient({ input, write, endOutput: () => void proc.stdin.end() });
  await client.ready;
  return {
    client,
    async close() {
      client.close();
      await proc.exited;
    },
  };
}

export async function runChatCli(args: string[], options: ChatCliOptions = {}): Promise<number> {
  const out = options.out ?? ((text: string) => void process.stdout.write(text));
  const err = options.err ?? ((text: string) => void process.stderr.write(text));
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const text = args.find((arg) => !arg.startsWith("--"));
  if (text === undefined) {
    err(USAGE);
    return 2;
  }

  let connection: ChatConnection;
  try {
    connection = options.connect === undefined ? await spawnService(flag("service"), options.env ?? {}) : await options.connect();
  } catch (error) {
    err(`[失败] ${describe(error)}\n`);
    return 1;
  }

  try {
    const { client } = connection;
    const requested = flag("conversation");
    const conversationId = requested ?? String((await client.request<{ id: number }>("conversation.create")).id);
    const parts = createParts({ conversationId, out });
    client.onNotification((notification) => {
      if (notification.method === "conversation.event") parts.apply(notification.params);
    });

    // 订阅要先于提交建立，否则会丢掉最早的增量。
    const { subscriptionId } = await client.request<{ subscriptionId: number }>("conversation.subscribe", { id: conversationId });
    const command = flag("command");
    const submit: Record<string, unknown> = { id: conversationId, requestId: crypto.randomUUID(), text };
    if (command !== undefined) submit.command = command;
    await client.request<SubmitResponse>("conversation.submit", submit);

    // 运行结束的判定交给增量：`pi.live.run` 消失且已有助手条目（与服务端的 answered 判定一致）。
    while (!parts.answered()) {
      const ended = parts.ended();
      if (ended !== undefined) throw new Error(`订阅结束（${ended}）时还没有回答`);
      await client.until(() => parts.answered() || parts.ended() !== undefined);
    }
    // 先退订再打印结尾，免得退出时的 `end` 通知落在报告后面。
    await client.request("conversation.unsubscribe", { subscriptionId }).catch(() => undefined);
    parts.printFinal();
    return 0;
  } catch (error) {
    err(`\n[失败] ${describe(error)}\n`);
    return 1;
  } finally {
    await connection.close();
  }
}

if (import.meta.main) process.exit(await runChatCli(process.argv.slice(2)));
