/**
 * 画布操作集与并发：纯操作保证原子性，真实服务 IPC 保证 revision 冲突不会覆盖别人的修改。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { canvasFromTemplate, type CanvasRecord } from "../src/tools/app/canvas/document.ts";
import { CanvasOpError, applyCanvasOps } from "../src/tools/app/canvas/ops.ts";
import { createConversationDocs } from "../src/tools/app/docs.ts";
import { loadConfig } from "../src/config.ts";
import { startService } from "../src/service.ts";
import { connectToService } from "./support/pipe.ts";

const NOW = new Date("2026-11-22T00:00:00Z");

function record(): CanvasRecord {
  const built = canvasFromTemplate("blank_canvas", "Flow");
  return {
    id: "cv_edit", title: "Flow", revision: 1, template_id: "blank_canvas",
    updated_at: NOW.toISOString(),
    nodes: [
      { id: "a", kind: "rect", x: 20, y: 20, w: 120, h: 60, text: "A", parent: "", pinned: false, style: { fill: "default", border: "default", text: "default" }, fontSize: 14 },
      { id: "b", kind: "rect", x: 220, y: 20, w: 120, h: 60, text: "B", parent: "", pinned: false, style: { fill: "default", border: "default", text: "default" }, fontSize: 14 },
      { id: "box", kind: "container", x: 0, y: 0, w: 400, h: 300, text: "Box", parent: "", pinned: false, style: { fill: "default", border: "default", text: "default" }, fontSize: 14 },
    ],
    edges: [],
  };
}

test("拖动、缩放、文字、样式与字号在一次提交里生效", () => {
  const canvas = record();
  const result = applyCanvasOps(canvas, [
    { op: "update_node", id: "a", patch: { x: 80, y: 96, w: 200, h: 120 } },
    { op: "update_node", id: "a", patch: { text: "Start", fontSize: 22, style: { fill: "accent", border: "accent", text: "default" } } },
  ], NOW);
  const node = result.canvas.nodes.find((item) => item.id === "a")!;
  expect([node.x, node.y, node.w, node.h, node.text, node.fontSize]).toEqual([80, 96, 200, 120, "Start", 22]);
  expect(node.style).toEqual({ fill: "accent", border: "accent", text: "default" });
  expect(result.canvas.revision).toBe(2);
  expect(result.changedNodeIds).toEqual(["a"]);
  expect(canvas.nodes[0]!.x).toBe(20);
});

test("新增节点与连线同批执行，一次 revision", () => {
  const canvas = record();
  const result = applyCanvasOps(canvas, [
    { op: "add_node", node: { id: "c1", kind: "round", x: 40, y: 320, w: 120, h: 60, text: "C" } },
    { op: "add_node", node: { id: "c2", kind: "rect", x: 260, y: 320, w: 120, h: 60, text: "D" } },
    { op: "add_edge", edge: { from: "c1", to: "c2", label: "next" } },
  ], NOW);
  expect(result.createdNodeIds).toEqual(["c1", "c2"]);
  expect(result.createdEdgeIds).toHaveLength(1);
  expect(result.canvas.edges[0]!.from).toBe("c1");
  expect(result.canvas.revision).toBe(2);
});

test("整批操作原子失败，不留下半步修改", () => {
  const canvas = record();
  expect(() => applyCanvasOps(canvas, [
    { op: "update_node", id: "a", patch: { x: 999 } },
    { op: "update_node", id: "missing", patch: { x: 1 } },
  ], NOW)).toThrow(CanvasOpError);
  expect(canvas.nodes[0]!.x).toBe(20);
  expect(canvas.revision).toBe(1);
});

test("删除容器级联删除子节点与相连连线", () => {
  const canvas = record();
  canvas.nodes[0]!.parent = "box";
  canvas.edges.push({
    id: "e", from: "a", to: "b", route: "straight", arrow: "end", dashed: false, label: "",
    style: { fill: "default", border: "default", text: "default" },
  });
  const result = applyCanvasOps(canvas, [{ op: "delete_node", id: "box" }], NOW);
  expect(result.canvas.nodes.map((node) => node.id)).toEqual(["b"]);
  expect(result.canvas.edges).toEqual([]);
  expect(result.deletedNodeIds.sort()).toEqual(["a", "box"]);
  expect(result.deletedEdgeIds).toEqual(["e"]);
});

test("canvas.apply 使用 baseRevision，过期提交返回 canvas_conflict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-canvas-edit-"));
  const service = await startService(loadConfig({ DW_DATA_DIR: dir }), { forceFileCredentials: true, tools: [] });
  const pipe = connectToService(service);
  try {
    const conversation = await service.conversations.create({});
    const handle = await service.harness.conversation(conversation.id as ConversationId, ctx);
    const canvas = record();
    await createConversationDocs({ harness: service.harness, conversation: handle!, context: ctx }).canvas.update((doc) => {
      doc.canvases.push(canvas);
    });

    const applied = (await pipe.client.request("canvas.apply", {
      conversationId: conversation.id,
      canvasId: "cv_edit",
      baseRevision: 1,
      ops: [{ op: "update_node", id: "a", patch: { x: 120 } }],
    })) as { canvas: CanvasRecord };
    expect(applied.canvas.revision).toBe(2);
    expect(applied.canvas.nodes[0]!.x).toBe(120);

    let failure: any = null;
    try {
      await pipe.client.request("canvas.apply", {
        conversationId: conversation.id,
        canvasId: "cv_edit",
        baseRevision: 1,
        ops: [{ op: "update_node", id: "a", patch: { x: 1 } }],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.data).toEqual({ kind: "canvas_conflict", revision: 2 });

    const current = (await pipe.client.request("canvas.get", { conversationId: conversation.id, canvasId: "cv_edit" })) as { canvas: CanvasRecord };
    expect(current.canvas.nodes[0]!.x).toBe(120);
  } finally {
    pipe.close();
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
