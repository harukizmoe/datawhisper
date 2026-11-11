import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // 侧栏按工作区分组靠它：只列工作区对话，普通聊天不出现。
  const scopes = await run.pipe.client.request<{ scopes: { conversationId: number; workspace_id: string }[] }>("conversation.scopes");
  expect(scopes.scopes).toEqual([{ conversationId: scoped.id, workspace_id: workspaceId }]);

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

/** 只发出这一轮、不等它结束：权限询问会让这一轮停在工具调用上。 */
async function send(run: Running, id: number, text: string): Promise<void> {
  await run.pipe.client.request("conversation.submit", { id, requestId: `req-${id}-${text}`, text });
}

async function idle(run: Running, id: number): Promise<void> {
  const conversation = (await run.service.harness.conversation(id as never, BACKGROUND_CONTEXT))!;
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
}

const writeCall = (file: string, content: string): string => `CALL:workspace_write_file{"file_path":"${file}","content":"${content}"}`;

type PendingRequest = { requestId: string; tool: string; summary: string; detail: string; allowChat: boolean };

/** 等到界面收到一条新的 `permission.requested` 通知，返回它的载荷。 */
async function nextRequest(run: Running, seen: number): Promise<PendingRequest> {
  const requested = () => run.pipe.client.notifications.filter((item) => item.method === "permission.requested");
  await run.pipe.client.until(() => requested().length > seen);
  return requested()[seen]!.params as PendingRequest;
}

test("权限模式：manual 询问并按回复放行或拒绝，plan 拦截、bypass 直通，普通聊天没有模式", async () => {
  const run = await start();
  const workdir = join(run.dir, "notes");
  mkdirSync(workdir, { recursive: true });
  const created = await run.pipe.client.request<{ workspace: { workspace_id: string } }>("workspace.create", { path: workdir });
  const { id } = await run.pipe.client.request<{ id: number }>("conversation.create", { workspaceId: created.workspace.workspace_id });
  const chat = await run.pipe.client.request<{ id: number }>("conversation.create");

  const scope = await run.pipe.client.request<{ scope: string; mode: string | null }>("conversation.scope", { conversationId: id });
  expect(scope).toMatchObject({ scope: "workspace", mode: "manual" });
  expect(await run.pipe.client.request("conversation.scope", { conversationId: chat.id })).toMatchObject({ scope: "chat", mode: null });
  const noMode = await run.pipe.client.request("conversation.setMode", { conversationId: chat.id, mode: "bypass" }).catch((error: unknown) => error);
  expect(noMode).toBeInstanceOf(RpcError);

  // manual：这一轮停在工具调用上，界面收到请求；允许后文件写出。
  await send(run, id, writeCall("one.md", "first"));
  const first = await nextRequest(run, 0);
  expect(first).toMatchObject({ tool: "workspace_write_file", summary: "Write file one.md", detail: "first", allowChat: true });
  expect((await run.pipe.client.request<{ requests: unknown[] }>("permission.pending", { conversationId: id })).requests).toHaveLength(1);
  expect(existsSync(join(workdir, "one.md"))).toBe(false);
  await run.pipe.client.request("permission.respond", { requestId: first.requestId, decision: "allow" });
  await idle(run, id);
  expect(readFileSync(join(workdir, "one.md"), "utf8")).toBe("first");
  expect(run.pipe.client.notifications.some((item) => item.method === "permission.resolved")).toBe(true);
  // 同一个请求不能回复两次。
  const twice = await run.pipe.client.request("permission.respond", { requestId: first.requestId, decision: "deny" }).catch((error: unknown) => error);
  expect(twice).toBeInstanceOf(RpcError);

  // 拒绝：文件不写，模型收到拒绝理由。
  await send(run, id, writeCall("two.md", "second"));
  const second = await nextRequest(run, 1);
  await run.pipe.client.request("permission.respond", { requestId: second.requestId, decision: "deny" });
  await idle(run, id);
  expect(existsSync(join(workdir, "two.md"))).toBe(false);
  expect(run.stub.log.at(-1)!.lastTool).toContain("denied workspace_write_file");

  // plan：不询问，直接把拒绝理由交给模型。
  await run.pipe.client.request("conversation.setMode", { conversationId: id, mode: "plan" });
  await send(run, id, writeCall("three.md", "third"));
  await idle(run, id);
  expect(existsSync(join(workdir, "three.md"))).toBe(false);
  expect(run.stub.log.at(-1)!.lastTool).toContain("Plan mode");
  expect(requestText(run.stub, run.stub.log.length - 1)).toContain("Permission mode: plan");

  // bypass：直接写出，不再有新的请求。
  await run.pipe.client.request("conversation.setMode", { conversationId: id, mode: "bypass" });
  await send(run, id, writeCall("four.md", "fourth"));
  await idle(run, id);
  expect(readFileSync(join(workdir, "four.md"), "utf8")).toBe("fourth");
  expect(run.pipe.client.notifications.filter((item) => item.method === "permission.requested")).toHaveLength(2);
}, 60_000);
