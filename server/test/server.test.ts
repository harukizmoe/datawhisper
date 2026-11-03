import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MAIN = resolve(import.meta.dir, "../src/main.ts");

type Ready = { type: "ready"; port: number; pid: number; token?: string };
type Running = { proc: Bun.Subprocess<"pipe", "pipe", "pipe">; ready: Ready; base: string };

const dirs: string[] = [];
const procs: Running["proc"][] = [];

afterEach(() => {
  for (const proc of procs.splice(0)) proc.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-server-test-"));
  dirs.push(dir);
  return dir;
}

async function start(env: Record<string, string>): Promise<Running> {
  const proc = Bun.spawn(["bun", "run", MAIN], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited before ready: ${await new Response(proc.stderr).text()}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const ready = JSON.parse(text.slice(0, text.indexOf("\n"))) as Ready;
  return { proc, ready, base: `http://127.0.0.1:${ready.port}` };
}

describe("agent service process", () => {
  test("requires the bearer token and reports health", async () => {
    const dataDir = tempDir();
    const { ready, base, proc } = await start({ DW_DATA_DIR: dataDir, DW_TOKEN: "test-token" });
    expect(ready.type).toBe("ready");
    expect(ready.pid).toBe(proc.pid);
    expect(ready.token).toBeUndefined();

    expect((await fetch(`${base}/v1/health`)).status).toBe(401);
    expect((await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const health = await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer test-token" } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, scheduling: "running", tasks: 0, submissions: 0, computePid: null });
    expect(existsSync(join(dataDir, "datawhisper.sqlite"))).toBe(true);
  });

  test("generates a token when none is supplied and reports it once", async () => {
    const { ready, base } = await start({ DW_DATA_DIR: tempDir(), DW_TOKEN: "" });
    expect(ready.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const health = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${ready.token}` } });
    expect(health.status).toBe(200);
  });

  test("SIGTERM stops gracefully; a restart reopens the same storage", async () => {
    const dataDir = tempDir();
    const first = await start({ DW_DATA_DIR: dataDir, DW_TOKEN: "t" });
    first.proc.kill("SIGTERM");
    expect(await first.proc.exited).toBe(0);

    const second = await start({ DW_DATA_DIR: dataDir, DW_TOKEN: "t" });
    const health = await fetch(`${second.base}/v1/health`, { headers: { authorization: "Bearer t" } });
    expect((await health.json()).scheduling).toBe("running");
  });

  test("closing stdin (parent gone) stops the service", async () => {
    const { proc } = await start({ DW_DATA_DIR: tempDir(), DW_TOKEN: "t" });
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });

  test("rejects an invalid port", async () => {
    const proc = Bun.spawn(["bun", "run", MAIN], {
      env: { ...process.env, DW_DATA_DIR: tempDir(), DW_PORT: "70000" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    expect(await proc.exited).not.toBe(0);
    expect(await new Response(proc.stderr).text()).toContain("DW_PORT is not a port");
  });
});
