import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type Registry, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { APP_ERROR, INVALID_PARAMS, RpcError } from "../src/ipc/errors.ts";
import { mapSettingsError } from "../src/ipc/methods.ts";
import { orchestrationMethods } from "../src/ipc/orchestration.ts";
import { createJobs, JOB_TASK_KIND, jobsExtension, type Jobs } from "../src/jobs/service.ts";
import { WorkExecutorRegistry } from "../src/jobs/work-task.ts";
import { whenAborted } from "./support/gates.ts";
import { memoryServer } from "./support/rpc.ts";

const ctx = BACKGROUND_CONTEXT;

type Bench = {
  dir: string;
  registry: Registry;
  executors: WorkExecutorRegistry;
  harness: Harness;
  jobs: Jobs;
  conversationId: number;
  clock: { now: number };
};

const benches: Bench[] = [];

async function openHarness(dir: string, clock: { now: number }): Promise<{ harness: Harness; registry: Registry }> {
  const registry = createRegistry();
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "datawhisper.sqlite")),
    { models: createModels(), registry, identity: { attribution: null }, now: () => clock.now },
    ctx,
  );
  return { harness, registry };
}

async function createBench(options: { dir?: string; progressIntervalMs?: number } = {}): Promise<Bench> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "dw-jobs-test-"));
  const clock = { now: 1_700_000_000_000 };
  const executors = new WorkExecutorRegistry();
  const { harness, registry } = await openHarness(dir, clock);
  const jobs = createJobs({
    harness,
    context: ctx,
    executors,
    progressIntervalMs: options.progressIntervalMs ?? 0,
    now: () => clock.now,
  });
  // 注册表可以在 Harness.open 之后安装：task 按名字解析，下一次调度即可见。
  registry.install(jobsExtension(jobs));
  const root = await harness.root(ctx);
  const bench: Bench = { dir, registry, executors, harness, jobs, conversationId: root.id, clock };
  benches.push(bench);
  return bench;
}

/** 模拟进程崩溃后重开：同一个数据目录、同一份执行器注册表。 */
async function reopen(bench: Bench): Promise<void> {
  await bench.harness.close(ctx);
  const { harness, registry } = await openHarness(bench.dir, bench.clock);
  const jobs = createJobs({
    harness,
    context: ctx,
    executors: bench.executors,
    progressIntervalMs: 0,
    now: () => bench.clock.now,
  });
  registry.install(jobsExtension(jobs));
  bench.harness = harness;
  bench.registry = registry;
  bench.jobs = jobs;
}

afterEach(async () => {
  for (const bench of benches.splice(0)) {
    await bench.harness.close(ctx).catch(() => undefined);
    rmSync(bench.dir, { recursive: true, force: true });
  }
});

describe("jobs", () => {
  test("长任务：进度可见、结果持久化、列表过滤", async () => {
    const bench = await createBench();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const flushed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    bench.executors.register("scan", async (_input, work) => {
      work.progress(10, "读取文件");
      await work.flush();
      first.resolve();
      await second.promise;
      work.progress(60, "汇总");
      await work.flush();
      flushed.resolve();
      await finish.promise;
      work.progress(100, "完成");
      return { rows: 42 };
    });

    const { id } = await bench.jobs.start({
      conversationId: bench.conversationId,
      kind: "scan",
      label: "扫描",
      args: { path: "sales.csv" },
    });
    // Harness 还没 resume：任务停在 queued。
    expect((await bench.jobs.get(id)).status).toBe("queued");
    bench.harness.resume();

    await first.promise;
    const running = await bench.jobs.get(id);
    expect(running.status).toBe("running");
    expect(running.progress).toBe(10);
    expect(running.message).toBe("读取文件");
    expect(running.startedAt).not.toBeNull();
    expect(running.parentId).toBeNull();
    expect(running.type).toBe("scan");
    expect(running.label).toBe("扫描");

    second.resolve();
    await flushed.promise;
    expect((await bench.jobs.get(id)).progress).toBe(60);

    finish.resolve();
    const done = await bench.jobs.wait(id);
    expect(done.status).toBe("succeeded");
    expect(done.progress).toBe(100);
    expect(done.message).toBe("完成");
    expect(done.result).toEqual({ rows: 42 });
    expect(done.error).toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.updatedAt).toBe(done.finishedAt!);

    const listed = await bench.jobs.list({ type: "scan" });
    expect(listed.jobs.map((job) => job.id)).toEqual([id]);
    expect((await bench.jobs.list({ status: "succeeded" })).jobs).toHaveLength(1);
    expect((await bench.jobs.list({ activeOnly: true })).jobs).toHaveLength(0);
    expect((await bench.jobs.list({ conversationId: bench.conversationId })).jobs).toHaveLength(1);
    expect((await bench.jobs.list({ conversationId: bench.conversationId + 1 })).jobs).toHaveLength(0);

    // 记录本身也是任务记录：终态仍可从存储读到（重启后 list/get 不依赖内存）。
    const record = await bench.harness.getTask(id as TaskId<JsonValue>, ctx);
    expect(record?.kind).toBe(JOB_TASK_KIND);
    expect(record?.state.status).toBe("terminal");
  });

  test("显式取消与 conversation.abort 都能真的停下执行器", async () => {
    const bench = await createBench();
    const started = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<void>();
    let steps = 0;
    bench.executors.register("loop", async (_input, work) => {
      work.progress(40, "处理中");
      await work.flush();
      started.resolve();
      await whenAborted(work.signal);
      observed.resolve();
      return { steps };
    });
    const { id } = await bench.jobs.start({ conversationId: bench.conversationId, kind: "loop", args: {} });
    bench.harness.resume();
    await started.promise;

    const canceled = await bench.jobs.cancel(id);
    await observed.promise;
    expect(canceled.status).toBe("canceled");
    expect(canceled.finishedAt).not.toBeNull();
    // 取消保留最后提交的进度与消息。
    expect(canceled.progress).toBe(40);
    expect(canceled.message).toBe("处理中");
    expect(steps).toBe(0);

    // 会话中止同样级联到 conversation-owned 任务。
    const secondStarted = Promise.withResolvers<void>();
    const secondObserved = Promise.withResolvers<void>();
    bench.executors.register("loop2", async (_input, work) => {
      secondStarted.resolve();
      await whenAborted(work.signal);
      secondObserved.resolve();
      return { steps };
    });
    const second = await bench.jobs.start({ conversationId: bench.conversationId, kind: "loop2", args: {} });
    bench.harness.resume();
    await secondStarted.promise;
    await (await bench.harness.root(ctx)).abort(ctx);
    await secondObserved.promise;
    expect((await bench.jobs.wait(second.id)).status).toBe("canceled");
  });

  test("崩溃后 resume() 续跑（replay=safe），进度从 checkpoint 恢复", async () => {
    const bench = await createBench();
    let calls = 0;
    const started = Promise.withResolvers<void>();
    bench.executors.register("resume", async (_input, work) => {
      calls += 1;
      work.progress(50, `第 ${calls} 次启动`);
      await work.flush();
      if (calls === 1) {
        started.resolve();
        await whenAborted(work.signal);
        return null;
      }
      return { calls };
    });
    const { id } = await bench.jobs.start({ conversationId: bench.conversationId, kind: "resume", args: {} });
    bench.harness.resume();
    await started.promise;
    await reopen(bench);

    const before = await bench.jobs.get(id);
    // 被切断的任务重开后回到 pending（等调度），进度来自 checkpoint。
    expect(["queued", "running"]).toContain(before.status);
    expect(before.progress).toBe(50);
    bench.harness.resume();
    const done = await bench.jobs.wait(id);
    expect(calls).toBe(2);
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ calls: 2 });
  });

  test("replay=unsafe 被打断后不重跑执行器", async () => {
    const bench = await createBench();
    let calls = 0;
    const started = Promise.withResolvers<void>();
    bench.executors.register("write", async (_input, work) => {
      calls += 1;
      started.resolve();
      await whenAborted(work.signal);
      return { calls };
    });
    const { id } = await bench.jobs.start({
      conversationId: bench.conversationId,
      kind: "write",
      replay: "unsafe",
      args: {},
    });
    bench.harness.resume();
    await started.promise;
    await reopen(bench);

    const done = await bench.jobs.wait(id);
    expect(calls).toBe(1);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("replay=unsafe");
  });

  test("未知执行器是确定的失败，而不是崩溃", async () => {
    const bench = await createBench();
    const { id } = await bench.jobs.start({ conversationId: bench.conversationId, kind: "missing", args: {} });
    bench.harness.resume();
    const done = await bench.jobs.wait(id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("unknown work kind: missing");
  });

  test("进度提交按注入的时钟节流", async () => {
    const bench = await createBench({ progressIntervalMs: 100 });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const throttled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    bench.executors.register("tick", async (_input, work) => {
      work.progress(10, "a");
      await work.flush();
      first.resolve();
      await second.promise;
      work.progress(20, "b");
      await work.flush(); // 同一个时钟，被节流
      bench.clock.now += 200;
      work.progress(30, "c");
      await work.flush();
      throttled.resolve();
      await release.promise;
      return null;
    });
    const { id } = await bench.jobs.start({ conversationId: bench.conversationId, kind: "tick", args: {} });
    bench.harness.resume();
    await first.promise;
    expect((await bench.jobs.get(id)).progress).toBe(10);
    second.resolve();
    await throttled.promise;
    expect((await bench.jobs.get(id)).progress).toBe(30);
    release.resolve();
    await bench.jobs.wait(id);
  });

  test("IPC 查询面：jobs.list / jobs.get / jobs.cancel 的参数与错误码", async () => {
    const bench = await createBench();
    bench.executors.register("quick", async () => ({ ok: true }));
    const { id } = await bench.jobs.start({ conversationId: bench.conversationId, kind: "quick", args: {} });
    bench.harness.resume();
    await bench.jobs.wait(id);

    const server = memoryServer(orchestrationMethods({ jobs: bench.jobs }), mapSettingsError);
    const listed = await server.call<{ jobs: { id: number }[] }>("jobs.list", { limit: 10 });
    expect(listed.result?.jobs.map((job) => job.id)).toEqual([id]);

    const got = await server.call<{ id: number; status: string }>("jobs.get", { id });
    expect(got.result).toMatchObject({ id, status: "succeeded" });

    expect((await server.call("jobs.get", { id: 0 })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("jobs.get", { id: "7" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("jobs.list", { status: "bogus" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("jobs.list", { activeOnly: "yes" })).error?.code).toBe(INVALID_PARAMS);
    expect((await server.call("jobs.list", { limit: 0 })).error?.code).toBe(INVALID_PARAMS);
    const missing = await server.call("jobs.get", { id: 999_999 });
    expect(missing.error).toMatchObject({ code: APP_ERROR, data: { kind: "not_found" } });

    // 服务层同样按 not_found 报错。
    await expect(bench.jobs.get(999_999)).rejects.toBeInstanceOf(RpcError);
  });
});
