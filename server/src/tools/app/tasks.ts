/**
 * 工作区任务板：4 个工具与存储规则。
 *
 * 存储从旧实现的 `agent_tasks.json` 改为 pi-durable conversation 文档
 * （`docs.ts::TASK_BOARD_DOC`），业务规则（ID 长度、状态集合、依赖去重、
 * 错误文案）保持旧 `agent/tools/workspace/tasks.py` 原样。
 */

import type { JsonValue } from "@earendil-works/chord";
import { AppToolError, errorResult, makeAppTool, okResult, renderValue, type AppTool, type AppToolDeps } from "./types.ts";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AppDocHost, AppToolDetails } from "./types.ts";
import {
  VALID_STATUS,
  type TaskBoardDoc,
  type TaskRecord,
  type TaskStatus,
} from "./docs.ts";

export class WorkspaceTaskError extends AppToolError {}

/** `datetime.now().isoformat(timespec="seconds")`：本地时间、无时区后缀。 */
export function isoSeconds(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function taskId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class WorkspaceTaskStore {
  readonly #doc: AppDocHost<TaskBoardDoc>;
  readonly #now: () => Date;

  constructor(doc: AppDocHost<TaskBoardDoc> | undefined, now: () => Date = () => new Date()) {
    if (doc === undefined) throw new WorkspaceTaskError("no workspace is mounted for this session");
    this.#doc = doc;
    this.#now = now;
  }

  async create(
    title: string,
    description = "",
    assignee = "",
    blocks: readonly string[] = [],
    blockedBy: readonly string[] = [],
  ): Promise<TaskRecord> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new WorkspaceTaskError("task title is required");
    return await this.#doc.update((board) => {
      const stamp = isoSeconds(this.#now());
      const task: TaskRecord = {
        id: taskId(),
        title: cleanTitle,
        description: description || "",
        assignee: assignee || "",
        status: "pending",
        blocks: unique(blocks),
        blocked_by: unique(blockedBy),
        created_at: stamp,
        updated_at: stamp,
      };
      board.tasks.push(task);
      return structuredClone(task);
    });
  }

  async get(id: string): Promise<TaskRecord> {
    const board = await this.#doc.read();
    const task = board.tasks.find((item) => item.id === id);
    if (task === undefined) throw new WorkspaceTaskError(`task not found: ${id}`);
    return task;
  }

  async list(status = "", assignee = ""): Promise<TaskRecord[]> {
    if (status && VALID_STATUS[status as TaskStatus] !== true) {
      throw new WorkspaceTaskError("invalid task status");
    }
    const board = await this.#doc.read();
    return board.tasks.filter(
      (task) => (!status || task.status === status) && (!assignee || task.assignee === assignee),
    );
  }

  async update(
    id: string,
    changes: {
      status?: string;
      assignee?: string;
      description?: string;
      addBlocks?: readonly string[];
      addBlockedBy?: readonly string[];
    },
  ): Promise<TaskRecord> {
    if (changes.status !== undefined && VALID_STATUS[changes.status as TaskStatus] !== true) {
      throw new WorkspaceTaskError("invalid task status");
    }
    return await this.#doc.update((board) => {
      const task = board.tasks.find((item) => item.id === id);
      if (task === undefined) throw new WorkspaceTaskError(`task not found: ${id}`);
      if (changes.status !== undefined) task.status = changes.status as TaskStatus;
      if (changes.assignee !== undefined) task.assignee = changes.assignee;
      if (changes.description !== undefined) task.description = changes.description;
      if (changes.addBlocks && changes.addBlocks.length > 0) {
        task.blocks = unique([...task.blocks, ...changes.addBlocks]);
      }
      if (changes.addBlockedBy && changes.addBlockedBy.length > 0) {
        task.blocked_by = unique([...task.blocked_by, ...changes.addBlockedBy]);
      }
      task.updated_at = isoSeconds(this.#now());
      return structuredClone(task);
    });
  }
}

function fail(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createTaskTools(deps: AppToolDeps): AppTool[] {
  const now = deps.now ?? (() => new Date());
  // 文档按会话现取：同一套工具对象服务所有会话，不能在装配时固定一份任务板。
  const store = (api: ToolExecutionApi<AppToolDetails>): WorkspaceTaskStore =>
    new WorkspaceTaskStore(deps.docs?.(api).tasks, now);
  return [
    makeAppTool<{
      title: string;
      description?: string;
      assignee?: string;
      blocks?: string[];
      blocked_by?: string[];
    }>({
      name: "task_create",
      description: "Create a persistent task in the mounted workspace task board, optionally with dependencies.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          assignee: { type: "string" },
          blocks: { type: "array", items: { type: "string" } },
          blocked_by: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          const task = await store(api).create(
            args.title ?? "",
            args.description ?? "",
            args.assignee ?? "",
            args.blocks ?? [],
            args.blocked_by ?? [],
          );
          return okResult("task_create", renderValue(task as unknown as JsonValue), {
            tool: "task_create",
            task: task as unknown as JsonValue,
          });
        } catch (error) {
          return fail("task_create", error);
        }
      },
    }),
    makeAppTool<{ task_id: string }>({
      name: "task_get",
      description: "Get one task from the mounted workspace task board.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
      replay: "safe",
      async execute(args, api) {
        try {
          const task = await store(api).get(args.task_id ?? "");
          return okResult("task_get", renderValue(task as unknown as JsonValue), {
            tool: "task_get",
            task: task as unknown as JsonValue,
          });
        } catch (error) {
          return fail("task_get", error);
        }
      },
    }),
    makeAppTool<{ status?: string; assignee?: string }>({
      name: "task_list",
      description: "List persistent tasks in the mounted workspace, optionally filtered by status or assignee.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
          assignee: { type: "string" },
        },
      },
      replay: "safe",
      async execute(args, api) {
        try {
          const tasks = await store(api).list(args.status ?? "", args.assignee ?? "");
          return okResult("task_list", renderValue(tasks as unknown as JsonValue), {
            tool: "task_list",
            tasks: tasks as unknown as JsonValue,
            count: tasks.length,
          });
        } catch (error) {
          return fail("task_list", error);
        }
      },
    }),
    makeAppTool<{
      task_id: string;
      status?: string;
      assignee?: string;
      description?: string;
      add_blocks?: string[];
      add_blocked_by?: string[];
    }>({
      name: "task_update",
      description: "Update a workspace task status, assignee, description, or dependencies.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
          assignee: { type: "string" },
          description: { type: "string" },
          add_blocks: { type: "array", items: { type: "string" } },
          add_blocked_by: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
      },
      replay: "unsafe",
      async execute(args, api) {
        try {
          const task = await store(api).update(args.task_id ?? "", {
            status: args.status,
            assignee: args.assignee,
            description: args.description,
            addBlocks: args.add_blocks,
            addBlockedBy: args.add_blocked_by,
          });
          return okResult("task_update", renderValue(task as unknown as JsonValue), {
            tool: "task_update",
            task: task as unknown as JsonValue,
          });
        } catch (error) {
          return fail("task_update", error);
        }
      },
    }),
  ];
}
