/**
 * 画布属于会话文档：服务重启后，同一会话的画布列表、标题与节点内容必须原样恢复。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { canvasFromTemplate, type CanvasRecord } from "../src/tools/app/canvas/document.ts";
import { createConversationDocs } from "../src/tools/app/docs.ts";
import { loadConfig } from "../src/config.ts";
import { startService } from "../src/service.ts";
import { connectToService } from "./support/pipe.ts";

test("重启服务后画布仍属于同一会话", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-canvas-persist-"));
  let service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true, tools: [] });
  try {
    const conversation = await service.conversations.create({});
    const handle = await service.harness.conversation(conversation.id as ConversationId, ctx);
    const built = canvasFromTemplate("business_model_canvas", "Retail model", { key_partners: "bean farms" });
    const record: CanvasRecord = {
      id: "cv_persist",
      title: built.title,
      template_id: "business_model_canvas",
      revision: 1,
      updated_at: "2026-11-22T00:00:00Z",
      nodes: built.nodes,
      edges: built.edges,
    };
    await createConversationDocs({ harness: service.harness, conversation: handle!, context: ctx }).canvas.update((doc) => {
      doc.canvases.push(record);
    });

    // 桌面端经 canvas.list 读画布；这里覆盖真实 IPC 链路。
    const pipe = connectToService(service);
    const listed = (await pipe.client.request("canvas.list", { conversationId: conversation.id })) as {
      canvases: { id: string; title: string }[];
    };
    pipe.close();
    expect(listed.canvases.map((canvas) => [canvas.id, canvas.title])).toEqual([["cv_persist", "Retail model"]]);

    await service.stop();
    service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true, tools: [] });
    const reopened = await service.harness.conversation(conversation.id as ConversationId, ctx);
    const doc = await createConversationDocs({ harness: service.harness, conversation: reopened!, context: ctx }).canvas.read();
    expect(doc.canvases.map((canvas) => [canvas.id, canvas.title])).toEqual([["cv_persist", "Retail model"]]);
    expect(doc.canvases[0]!.nodes.find((node) => node.id === "key_partners")?.text).toBe("bean farms");
    const reopenedPipe = connectToService(service);
    const reopenedList = (await reopenedPipe.client.request("canvas.list", { conversationId: conversation.id })) as {
      canvases: { title: string }[];
    };
    reopenedPipe.close();
    expect(reopenedList.canvases[0]!.title).toBe("Retail model");
  } finally {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
