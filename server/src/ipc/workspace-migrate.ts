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
          name: item.name,
          permission: item.permission === "read_write" ? "read_write" : "read_only",
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
    await state.update(conversationId, (draft) => {
      for (const source of draft.sources) {
        const target = renames.get(source.id);
        if (target !== undefined) source.id = target;
      }
      draft.scope = mounted === undefined ? { kind: "chat" } : { kind: "workspace", workspaceId: mounted.workspaceId };
      delete draft.workspaces;
    });
    migrated += 1;
  }
  return migrated;
}
