import { describe, expect, test } from "bun:test";
import { createMemorySourceStore, type LegacyWorkspaceRecord, type StoredSource } from "../src/ipc/source-store.ts";
import { migrateLegacyWorkspaces } from "../src/ipc/workspace-migrate.ts";
import { createMemoryWorkspaceStore } from "../src/ipc/workspace-store.ts";

const WORKSPACE_ID = "ws_0123456789abcdef";

function legacy(overrides: Partial<LegacyWorkspaceRecord> = {}): LegacyWorkspaceRecord {
  return {
    workspaceId: WORKSPACE_ID,
    workdir: "/data/project",
    name: "project",
    permission: "read_write",
    sourceId: "s_old",
    mounted: true,
    mountedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function source(id: string): StoredSource {
  return {
    id,
    kind: "workspace_persistent",
    name: "📁 project",
    active: true,
    descriptor: { kind: "workspace_persistent", db_path: "/data/project/.zhixi/workspace.duckdb", name: "📁 project" },
    tables: ["data"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("旧版每对话工作区记录迁移", () => {
  test("挂载中的记录升格为全局记录，对话获得 workspace scope，旧字段被删除", async () => {
    const state = createMemorySourceStore([1]);
    const workspaces = createMemoryWorkspaceStore();
    await state.update(1, (draft) => {
      draft.sources = [source("s_old")];
      draft.workspaces = [legacy()];
    });

    expect(await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [1] })).toBe(1);

    const doc = state.peek(1);
    expect(doc.scope).toEqual({ kind: "workspace", workspaceId: WORKSPACE_ID });
    expect(doc.workspaces).toBeUndefined();
    expect(await workspaces.get(WORKSPACE_ID)).toMatchObject({
      workdir: "/data/project",
      sourceId: "s_old",
      instructions: "",
    });
    expect(doc.permissionMode).toBe("accept_edits");
  });

  test("旧的只读/可读写并入对话的权限模式：只读 → plan，可读写 → accept_edits", async () => {
    const state = createMemorySourceStore([1, 2]);
    const workspaces = createMemoryWorkspaceStore();
    await state.update(1, (draft) => {
      draft.workspaces = [legacy({ permission: "read_only" })];
    });
    await state.update(2, (draft) => {
      draft.workspaces = [legacy({ permission: "read_write" })];
    });
    await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [1, 2] });
    expect(state.peek(1).permissionMode).toBe("plan");
    expect(state.peek(2).permissionMode).toBe("accept_edits");
  });

  test("两个对话挂过同一目录：共用第一份来源 id，第二个对话的来源被改名指向它", async () => {
    const state = createMemorySourceStore([1, 2]);
    const workspaces = createMemoryWorkspaceStore();
    await state.update(1, (draft) => {
      draft.sources = [source("s_one")];
      draft.workspaces = [legacy({ sourceId: "s_one" })];
    });
    await state.update(2, (draft) => {
      draft.sources = [source("s_two")];
      draft.workspaces = [legacy({ sourceId: "s_two" })];
    });

    await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [1, 2] });

    expect((await workspaces.get(WORKSPACE_ID))!.sourceId).toBe("s_one");
    expect(state.peek(2).sources.map((item) => item.id)).toEqual(["s_one"]);
    expect(state.peek(2).scope).toEqual({ kind: "workspace", workspaceId: WORKSPACE_ID });
  });

  test("已卸载的记录只留下注册表项，对话回到普通聊天；再跑一遍什么都不改", async () => {
    const state = createMemorySourceStore([1]);
    const workspaces = createMemoryWorkspaceStore();
    await state.update(1, (draft) => {
      draft.workspaces = [legacy({ mounted: false, sourceId: "" })];
    });

    expect(await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [1] })).toBe(1);
    expect(state.peek(1).scope).toEqual({ kind: "chat" });
    expect((await workspaces.get(WORKSPACE_ID))!.sourceId).toBe("");

    expect(await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [1] })).toBe(0);
  });

  test("读不了的对话被跳过，不拖垮其余对话", async () => {
    const state = createMemorySourceStore([1]);
    const workspaces = createMemoryWorkspaceStore();
    await state.update(1, (draft) => {
      draft.workspaces = [legacy()];
    });
    expect(await migrateLegacyWorkspaces({ state, workspaces, conversationIds: [99, 1] })).toBe(1);
  });
});
