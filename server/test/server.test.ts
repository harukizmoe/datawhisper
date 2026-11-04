import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { IpcClient } from "../src/ipc/client.ts";
import { INVALID_PARAMS, METHOD_NOT_FOUND, RpcError } from "../src/ipc/errors.ts";
import { JsonLinesDecoder } from "../src/ipc/framing.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");

type Ready = { type: "ready"; pid: number };
type Proc = Bun.Subprocess<"pipe", "pipe", "pipe">;
type Running = { proc: Proc; ready: Ready; client: IpcClient; lines: string[] };

const dirs: string[] = [];
const procs: Proc[] = [];
const clients: IpcClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const proc of procs.splice(0)) proc.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-server-test-"));
  dirs.push(dir);
  return dir;
}

/** 起一个真实的服务进程，并把它的 stdin/stdout 当管道；stdout 的原始行另存一份用于检查协议纯净度。 */
async function start(env: Record<string, string>): Promise<Running> {
  const proc = Bun.spawn(["bun", "run", MAIN], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const input = Readable.fromWeb(proc.stdout as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const lines: string[] = [];
  const decoder = new JsonLinesDecoder();
  input.on("data", (chunk: Uint8Array) => {
    for (const line of decoder.push(chunk)) lines.push(line);
  });
  const client = new IpcClient({
    input,
    write: (line) => {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    },
    endOutput: () => void proc.stdin.end(),
  });
  clients.push(client);
  const ready = await Promise.race([
    client.ready,
    proc.exited.then(async (code) => {
      throw new Error(`server exited before ready (${code}): ${await new Response(proc.stderr).text()}`);
    }),
  ]);
  return { proc, ready: ready as Ready, client, lines };
}

describe("agent service process", () => {
  test("reports readiness on stdout and answers health over the pipe", async () => {
    const dataDir = tempDir();
    const { ready, client, proc, lines } = await start({ DW_DATA_DIR: dataDir });
    // 就绪记录只有类型与 pid：不再有端口与令牌。
    expect(ready).toEqual({ type: "ready", pid: proc.pid });

    const health = await client.request("health");
    expect(health).toEqual({ ok: true, scheduling: "running", tasks: 0, submissions: 0, computePid: null });
    expect(existsSync(join(dataDir, "datawhisper.sqlite"))).toBe(true);
    // stdout 上除了这条响应没有别的东西：日志一律走 stderr。
    expect(lines).toEqual([JSON.stringify({ type: "ready", pid: proc.pid }), JSON.stringify({ jsonrpc: "2.0", id: 1, result: health })]);
  });

  test("unknown methods and bad params are protocol errors, and the process keeps serving", async () => {
    const { client } = await start({ DW_DATA_DIR: tempDir() });
    const unknown = await client.request("no.such.method").catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(RpcError);
    expect((unknown as RpcError).code).toBe(METHOD_NOT_FOUND);
    const bad = await client.request("conversation.unsubscribe", { subscriptionId: "one" }).catch((error: unknown) => error);
    expect((bad as RpcError).code).toBe(INVALID_PARAMS);
    // 坏记录不污染后续：服务照常工作。
    expect((await client.request<{ scheduling: string }>("health")).scheduling).toBe("running");
  });

  test("SIGTERM stops gracefully; a restart reopens the same storage", async () => {
    const dataDir = tempDir();
    const first = await start({ DW_DATA_DIR: dataDir });
    first.proc.kill("SIGTERM");
    expect(await first.proc.exited).toBe(0);

    const second = await start({ DW_DATA_DIR: dataDir });
    const health = await second.client.request<{ scheduling: string }>("health");
    expect(health.scheduling).toBe("running");
  });

  test("closing stdin (parent gone) stops the service", async () => {
    const { client, proc } = await start({ DW_DATA_DIR: tempDir() });
    client.close();
    expect(await proc.exited).toBe(0);
  });
});
