import type { ConversationId } from "@earendil-works/pi-durable";
import { createConversationDocs } from "../src/tools/app/docs.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startService, type Service } from "../src/service.ts";
import { connectToService, type ServicePipe } from "./support/pipe.ts";

let dir = "";
let service: Service;
let pipe: ServicePipe;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-wiring-"));
  service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true, tools: [] });
  pipe = connectToService(service, { dataDir: dir });
});

afterAll(async () => {
  pipe?.close();
  await service?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// 装配曾经漏传 jobs 与 workflows：真实服务里 jobs.* 与 workflow.runs.* 不存在，界面的「运行」页整节隐藏。
test("真实服务通过管道提供长任务、工作流定义与工作流运行的方法", async () => {
  const conversationId = (await service.conversations.create({})).id;
  expect(await pipe.client.request("jobs.list", { conversationId })).toEqual({ jobs: [] });
  expect(await pipe.client.request("workflow.runs.list", { conversationId })).toEqual({ runs: [] });
  expect(await pipe.client.request("workflow.definitions.list")).toEqual({ workflows: [] });
});

// 任务板文档不在订阅视图里，界面靠 `tasks.list` 读它。
test("tasks.list 返回会话任务板里的任务", async () => {
  const conversation = await service.conversations.create({});
  expect(await pipe.client.request("tasks.list", { conversationId: conversation.id })).toEqual({ tasks: [] });
  const handle = await service.harness.conversation(conversation.id as ConversationId, service.context);
  const docs = createConversationDocs({ harness: service.harness, conversation: handle!, context: service.context });
  await docs.tasks.update((board) => {
    board.tasks.push({
      id: "t1", title: "Profile the data", description: "", assignee: "", status: "in_progress",
      blocks: [], blocked_by: [], created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z",
    });
  });
  const listed = (await pipe.client.request("tasks.list", { conversationId: conversation.id })) as { tasks: { id: string; status: string }[] };
  expect(listed.tasks.map((task) => [task.id, task.status])).toEqual([["t1", "in_progress"]]);
});
