import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  ComputeCancelled,
  ComputeClient,
  ComputeCrashed,
  ComputeError,
  ComputeUnavailable,
  type RestartReport,
} from "../src/compute/client.ts";

const REPO = resolve(import.meta.dir, "../..");
const PYTHON = resolve(REPO, ".venv/bin/python");
const SALES = { kind: "csv", file_path: resolve(REPO, "baseline/fixtures/sales.csv"), name: "sales.csv" };

const clients: ComputeClient[] = [];
function fake(extra: Partial<ConstructorParameters<typeof ComputeClient>[0]> = {}) {
  const client = new ComputeClient({ python: PYTHON, args: ["-m", "compute.tests._fake_worker"], cwd: REPO, ...extra });
  clients.push(client);
  return client;
}
function real(extra: Partial<ConstructorParameters<typeof ComputeClient>[0]> = {}) {
  const client = new ComputeClient({ python: PYTHON, cwd: REPO, ...extra });
  clients.push(client);
  return client;
}
async function killWorker(client: ComputeClient) {
  const exited = client.exited!;
  process.kill(client.pid!, "SIGKILL");
  await exited;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("protocol", () => {
  test("concurrent calls resolve independently, out of order", async () => {
    const client = fake();
    const order: string[] = [];
    await Promise.all([
      client.call("sleep", { seconds: 0.5 }).then(() => order.push("slow")),
      client.call("echo", { x: "销售额" }).then((r) => order.push(`fast:${JSON.stringify(r)}`)),
    ]);
    expect(order).toEqual(['fast:{"x":"销售额"}', "slow"]);
  });

  test("abort cancels the running method and reports progress until then", async () => {
    const client = fake();
    const controller = new AbortController();
    const progress: number[] = [];
    const call = client.call("loop", {}, {
      signal: controller.signal,
      onProgress: (p) => {
        progress.push(p ?? -1);
        if (progress.length === 3) controller.abort();
      },
    });
    await expect(call).rejects.toBeInstanceOf(ComputeCancelled);
    expect(progress.slice(0, 3)).toEqual([0, 1, 2]);
    expect(await client.call("echo", { alive: true })).toEqual({ alive: true });
  });

  test("an already-aborted signal rejects without starting the worker", async () => {
    const client = fake();
    const controller = new AbortController();
    controller.abort();
    await expect(client.call("echo", {}, { signal: controller.signal })).rejects.toThrow();
    expect(client.pid).toBeUndefined();
  });

  test("events reach the caller that issued the request", async () => {
    const client = fake();
    const events: unknown[] = [];
    expect(await client.call("event", {}, { onEvent: (e) => events.push(e) })).toEqual({ sent: true });
    expect(events).toEqual([{ type: "chart", html: "<div>图表</div>" }]);
  });

  test("application errors keep code and data", async () => {
    const client = fake();
    const error = await client.call("app_error").catch((e) => e);
    expect(error).toBeInstanceOf(ComputeError);
    expect([error.code, error.message, error.data]).toEqual([-32000, "bad table", { kind: "table_not_found" }]);
  });

  test("stdout noise from the worker does not break the stream", async () => {
    const client = fake();
    expect(await client.call("noisy")).toEqual({ ok: true });
    expect(await client.call("not_finite")).toEqual({ nan: null, inf: null, np_nan: null, nested: [1.5, null] });
  });
});

describe("crash and restart", () => {
  test("in-flight calls reject with ComputeCrashed; next call restarts", async () => {
    const client = fake();
    await client.call("echo", {});
    const firstPid = client.pid;
    const inflight = client.call("sleep", { seconds: 5 });
    await killWorker(client);
    await expect(inflight).rejects.toBeInstanceOf(ComputeCrashed);
    expect(await client.call("echo", { again: 1 })).toEqual({ again: 1 });
    expect(client.pid).not.toBe(firstPid);
  });

  test("restart reopens sources and reports runtime tables that were lost", async () => {
    const reports: RestartReport[] = [];
    const client = real({ onRestart: (r) => reports.push(r) });
    const opened = await client.openSource("s1", SALES);
    expect(opened.tables).toEqual(["sales"]);
    const created = await client.call<{ ok: boolean; error?: string }>("source.query", {
      source_id: "s1",
      sql: "CREATE TABLE analysis_tmp AS SELECT region, count(*) AS n FROM sales GROUP BY 1",
    });
    expect(created.ok).toBe(true);
    expect((await client.refreshTables("s1")).sort()).toEqual(["analysis_tmp", "sales"]);

    await killWorker(client);
    const schema = await client.call<{ schema: string }>("source.schema", { source_id: "s1" });
    expect(schema.schema).toContain("Table: sales");
    expect(reports).toEqual([{ generation: 2, reopened: [{ sourceId: "s1", lostTables: ["analysis_tmp"] }], failed: [] }]);
  });

  test("a source that cannot be reopened is reported, others still work", async () => {
    const reports: RestartReport[] = [];
    const client = real({ onRestart: (r) => reports.push(r) });
    const tmp = resolve(REPO, "server/.data/client-test.csv");
    await Bun.write(tmp, "a,b\n1,2\n");
    await client.openSource("gone", { kind: "csv", file_path: tmp, name: "gone.csv" });
    await client.openSource("s1", SALES);
    await Bun.file(tmp).delete();
    await killWorker(client);
    await client.call("ping");
    expect(reports[0]!.failed.map((f) => f.sourceId)).toEqual(["gone"]);
    expect(reports[0]!.reopened.map((r) => r.sourceId)).toEqual(["s1"]);
    const missing = await client.call("source.schema", { source_id: "gone" }).catch((e) => e);
    expect(missing).toBeInstanceOf(ComputeError);
    expect(missing.data).toEqual({ kind: "source_not_open" });
  });

  test("repeated crashes stop restarting", async () => {
    const client = fake({ maxRestarts: 2, restartWindowMs: 60_000 });
    for (let i = 0; i < 3; i++) {
      await client.call("echo", {});
      await killWorker(client);
    }
    await expect(client.call("echo", {})).rejects.toBeInstanceOf(ComputeUnavailable);
  });

  test("a worker that cannot start is reported as unavailable", async () => {
    const client = new ComputeClient({ python: PYTHON, args: ["-c", "import sys; sys.exit(7)"], cwd: REPO });
    clients.push(client);
    const error = await client.call("ping").catch((e) => e);
    expect(error).toBeInstanceOf(ComputeUnavailable);
    expect(error.message).toContain("code 7");
  });

  test("close() lets in-flight work finish and stops the worker", async () => {
    const client = fake();
    await client.call("echo", {});
    const pid = client.pid!;
    const slow = client.call("sleep", { seconds: 0.3 });
    await client.close();
    expect(await slow).toEqual({ slept: 0.3 });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(client.call("echo")).rejects.toBeInstanceOf(ComputeUnavailable);
  });
});
