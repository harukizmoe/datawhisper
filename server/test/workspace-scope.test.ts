import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.ts";
import { RpcError } from "../src/ipc/errors.ts";
import type { ConversationListResponse } from "../src/protocol.ts";
import { type Service, startService } from "../src/service.ts";
import { type ServicePipe, connectToService } from "./support/pipe.ts";
import { stubProvider } from "./support/stub-models.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";

type Running = { service: Service; stub: Stub; pipe: ServicePipe; dir: string };
const running: Running[] = [];

afterEach(async () => {
  for (const { service, stub, pipe, dir } of running.splice(0)) {
    await service.stop();
    stub.stop();
    pipe.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function start(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), "dw-ws-scope-"));
  const stub = startStub({ chunkDelayMs: 1 });
  const service = await startService(loadConfig({ DW_DATA_DIR: join(dir, "data") }), { forceFileCredentials: true });
  await service.modelService.putProvider(stubProvider(stub.url));
  const pipe = connectToService(service);
  const entry = { service, stub, pipe, dir };
  running.push(entry);
  return entry;
}

/** 这一轮发给模型的整段请求体（系统提示在里面）。 */
const requestText = (stub: Stub, index: number): string => JSON.stringify(stub.log[index]!.body.messages);

async function submit(run: Running, id: number, text: string): Promise<void> {
  await run.pipe.client.request("conversation.submit", { id, requestId: `req-${id}-${text}`, text });
  const conversation = (await run.service.harness.conversation(id as never, BACKGROUND_CONTEXT))!;
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
}

test("工作区对话的系统提示带工作区块，普通聊天没有；目录没了时建对话失败且不留空对话", async () => {
  const run = await start();
  const workdir = join(run.dir, "sales");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "orders.csv"), "region,amount\neast,10\nwest,20\n");

  const created = await run.pipe.client.request<{ workspace: { workspace_id: string } }>("workspace.create", {
    path: workdir,
    name: "Sales",
    instructions: "Always answer in French.",
  });
  const workspaceId = created.workspace.workspace_id;

  const scoped = await run.pipe.client.request<{ id: number }>("conversation.create", { workspaceId });
  const chat = await run.pipe.client.request<{ id: number }>("conversation.create");

  const listed = await run.pipe.client.request<{ workspace: { workspace_id: string } | null }>("workspace.list", {
    conversationId: scoped.id,
  });
  expect(listed.workspace?.workspace_id).toBe(workspaceId);
  const plain = await run.pipe.client.request<{ workspace: unknown }>("workspace.list", { conversationId: chat.id });
  expect(plain.workspace).toBeNull();

  await submit(run, scoped.id, "hello scoped");
  const scopedPrompt = requestText(run.stub, 0);
  expect(scopedPrompt).toContain("[WORKSPACE]");
  expect(scopedPrompt).toContain(workdir);
  expect(scopedPrompt).toContain("Always answer in French.");

  await submit(run, chat.id, "hello chat");
  expect(requestText(run.stub, 1)).not.toContain("[WORKSPACE]");

  rmSync(workdir, { recursive: true, force: true });
  const before = await run.pipe.client.request<ConversationListResponse>("conversation.list");
  const failure = await run.pipe.client.request("conversation.create", { workspaceId }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RpcError);
  const after = await run.pipe.client.request<ConversationListResponse>("conversation.list");
  expect(after.conversations).toHaveLength(before.conversations.length);

  // 已有的工作区对话在目录消失后提交，也要明确报错，而不是悄悄退成普通聊天。
  const orphan = await run.pipe.client.request("conversation.submit", { id: scoped.id, requestId: "again", text: "still there?" }).catch((error: unknown) => error);
  expect(orphan).toBeInstanceOf(RpcError);
}, 60_000);
