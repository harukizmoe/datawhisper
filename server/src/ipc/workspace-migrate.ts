/**
 * 迁移：旧版每个对话各存一份工作区记录（`SourceDoc.workspaces`），同一目录在每个对话里各挂一次、
 * 各有一个来源 id。新版工作区是全局的，对话只记 `scope`。
 *
 * 做法（幂等，可以每次启动都跑）：
 * - 每条旧记录按路径派生的 `workspaceId` 进注册表；已有同 id 的记录就不覆盖；
 * - 已挂载的那条决定对话的 scope，没有挂载的对话变成普通聊天；
 * - 同一个工作区在注册表里只保留一个来源 id：别的对话文档里的来源改用这个 id
 *   （库文件是同一个，只是 id 不同）；
 * - 迁完删掉旧字段。
 */

import type { SourceDocStore } from "./source-store.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/** 旧版在工作区名和来源名前加了文件夹 emoji；迁移时去掉，界面与提示词都不再带它。 */
function bareName(name: string): string {
  return name.replace(/^📁\s*/u, "").trim();
}

/**
 * 去掉旧版留在名字里的 📁：注册表记录与属于该工作区的对话来源都清一遍。
 * 与 `migrateLegacyWorkspaces` 分开，因为旧字段删掉之后仍可能留着带 emoji 的名字。
 * 幂等：没有要改的记录时返回 0。
 */
export async function stripLegacyNames(options: {
  readonly state: SourceDocStore;
  readonly workspaces: WorkspaceStore;
  readonly conversationIds: readonly number[];
}): Promise<number> {
  const { state, workspaces } = options;
  const canonical = new Map<string, { name: string; sourceId: string }>();
  let cleaned = 0;
  for (const record of await workspaces.list()) {
    if (bareName(record.name) !== record.name) {
      const next = { ...record, name: bareName(record.name), updatedAt: new Date().toISOString() };
      await workspaces.put(next);
      canonical.set(next.workspaceId, { name: next.name, sourceId: next.sourceId });
      cleaned += 1;
    } else {
      canonical.set(record.workspaceId, { name: record.name, sourceId: record.sourceId });
    }
  }
  for (const conversationId of options.conversationIds) {
    const doc = await state.read(conversationId).catch(() => undefined);
    if (doc?.scope?.kind !== "workspace") continue;
    const workspace = canonical.get(doc.scope.workspaceId);
    if (workspace === undefined || workspace.sourceId === "") continue;
    const stale = doc.sources.some(
      (source) => source.id === workspace.sourceId && source.kind === "workspace_persistent" && source.name !== workspace.name,
    );
    if (!stale) continue;
    await state.update(conversationId, (draft) => {
      for (const source of draft.sources) {
        if (source.id !== workspace.sourceId || source.kind !== "workspace_persistent") continue;
        source.name = workspace.name;
        source.descriptor = { ...source.descriptor, name: workspace.name };
      }
    });
    cleaned += 1;
  }
  return cleaned;
}

/** 返回迁移了多少个对话文档。读不了的对话（例如已被删除）跳过。 */
export async function migrateLegacyWorkspaces(options: {
  readonly state: SourceDocStore;
  readonly workspaces: WorkspaceStore;
  readonly conversationIds: readonly number[];
}): Promise<number> {
  const { state, workspaces } = options;
  let migrated = 0;
  for (const conversationId of options.conversationIds) {
    const doc = await state.read(conversationId).catch(() => undefined);
    const legacy = doc?.workspaces;
    if (legacy === undefined) continue;

    /** 本对话文档里旧来源 id → 注册表里的来源 id。 */
    const renames = new Map<string, string>();
    for (const item of legacy) {
      const sourceId = item.mounted ? item.sourceId : "";
      const existing = await workspaces.get(item.workspaceId);
      if (existing === undefined) {
        await workspaces.put({
          workspaceId: item.workspaceId,
          workdir: item.workdir,
          name: bareName(item.name),
          instructions: "",
          sourceId,
          lastSyncedAt: item.mountedAt,
          createdAt: item.mountedAt,
          updatedAt: item.updatedAt,
        });
      } else if (existing.sourceId === "" && sourceId !== "") {
        await workspaces.put({ ...existing, sourceId });
      } else if (sourceId !== "" && existing.sourceId !== sourceId) {
        renames.set(sourceId, existing.sourceId);
      }
    }

    const mounted = legacy.find((item) => item.mounted);
    // 旧来源名也带 emoji；以注册表里的名字为准，顺便把改名后的显示名同步过来。
    const names = new Map<string, string>();
    for (const item of legacy) {
      const record = await workspaces.get(item.workspaceId);
      if (record !== undefined && record.sourceId !== "") names.set(record.sourceId, record.name);
    }
    await state.update(conversationId, (draft) => {
      for (const source of draft.sources) {
        const target = renames.get(source.id);
        if (target !== undefined) source.id = target;
        const name = names.get(source.id);
        if (name !== undefined && source.kind === "workspace_persistent") {
          source.name = name;
          source.descriptor = { ...source.descriptor, name };
        }
      }
      draft.scope = mounted === undefined ? { kind: "chat" } : { kind: "workspace", workspaceId: mounted.workspaceId };
      // 旧的只读/可读写并入权限模式：只读 ≈ 计划模式，可读写 ≈ 自动接受编辑（旧实现写文件不询问）。
      if (mounted !== undefined) draft.permissionMode = mounted.permission === "read_write" ? "accept_edits" : "plan";
      delete draft.workspaces;
    });
    migrated += 1;
  }
  return migrated;
}
