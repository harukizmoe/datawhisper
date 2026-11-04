/**
 * 任务板、团队邮箱与动态团队计划的 pi-durable 文档定义。
 *
 * 旧 Python 实现把三者写成 `agent_tasks.json` / `agent_teams.json` /
 * `dynamic_plans.json`。这里改成 conversation 作用域的 durable 文档：
 * 每次修改都走一次 `conversation.commit`，崩溃后由 pi-durable 回放/检查点恢复，
 * 不再有“读到半个 JSON”的窗口。
 *
 * 文档 token 只描述格式；真正的 commit 由宿主注入的 {@link AppDocHost} 完成，
 * 因此本模块可以在没有 Harness 的单元测试里用内存宿主验证业务规则。
 */

import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDoc, type Conversation, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { AppDocHost, AppDocHosts, AppDocToken } from "./types.ts";

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

/** 静态状态集合；`task_list`/`task_update` 用它校验模型参数。 */
export const VALID_STATUS: Readonly<Record<TaskStatus, true>> = {
  pending: true,
  in_progress: true,
  completed: true,
  blocked: true,
};

export type TaskRecord = {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: TaskStatus;
  blocks: string[];
  blocked_by: string[];
  created_at: string;
  updated_at: string;
};

export type TaskBoardDoc = { tasks: TaskRecord[] };

export type TeamMember = {
  name: string;
  agent_id: string;
  role: string;
  instructions: string;
  status: string;
  last_message: string;
  last_active_at: string;
};

export type TeamMessage = {
  id: string;
  sender: string;
  recipient: string;
  message: string;
  message_type: string;
  read: boolean;
  created_at: string;
  tool_events?: JsonValue[];
};

export type TeamRecord = {
  name: string;
  description: string;
  members: TeamMember[];
  messages: TeamMessage[];
  created_at: string;
  updated_at: string;
  reused?: boolean;
  quality_reviewer?: { name: string; auto_added: boolean };
};

export type TeamStoreDoc = { teams: Record<string, TeamRecord> };

export type PlanUsage = {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  tool_calls: number;
};

export type PlanTask = {
  id: string;
  member_name: string;
  title: string;
  prompt: string;
  depends_on: string[];
  status: string;
  attempt: number;
  job_id: string;
  result_summary: string;
  error: string;
  tool_count: number;
  artifacts: JsonValue[];
  usage: PlanUsage;
  usage_history: PlanUsage[];
  job_ids: string[];
  started_at: string;
  finished_at: string;
  updated_at: string;
};

export type PlanBudget = {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  tool_calls: number;
  measured_task_count: number;
  task_count: number;
  child_job_count: number;
  quality_review_measured: boolean;
  estimated_cost: null;
};

export type DynamicPlan = {
  id: string;
  workspace_id: string;
  team_name: string;
  goal: string;
  status: string;
  created_by: string;
  tasks: PlanTask[];
  quality_review_usage: PlanUsage;
  quality_review_usage_history: PlanUsage[];
  created_at: string;
  updated_at: string;
  finished_at: string;
  workflow_draft_id: string;
  budget: PlanBudget;
};

export type PlanStoreDoc = { plans: DynamicPlan[] };

/**
 * 三个文档都很小，每次提交都存完整基线（`checkpointWhen` 返回 true），
 * 避免薄文档也留下很长的增量链。
 */
export const TASK_BOARD_DOC = defineDoc<TaskBoardDoc>({
  kind: "datawhisper.tasks",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ tasks: [] }),
  checkpointWhen: () => true,
});

export const TEAM_STORE_DOC = defineDoc<TeamStoreDoc>({
  kind: "datawhisper.teams",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ teams: {} }),
  checkpointWhen: () => true,
});

export const PLAN_STORE_DOC = defineDoc<PlanStoreDoc>({
  kind: "datawhisper.team-plans",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ plans: [] }),
  checkpointWhen: () => true,
});

/**
 * 生产宿主：把 `AppDocHost` 接到一个 conversation 与它的 Session 上。
 *
 * 读走 `snapshot`（不产生写入）；写走 `conversation.commit`，在一次事务里读完再改，
 * 避免两个工具调用交错覆盖。
 */
export function createConversationDocs(options: {
  readonly harness: Pick<Harness, "snapshot">;
  readonly conversation: Pick<Conversation, "id" | "commit">;
  readonly context: Context;
}): AppDocHosts {
  const { harness, conversation, context } = options;
  function host<T extends JsonObject>(token: AppDocToken<T>): AppDocHost<T> {
    const initial = (): T => token.definition.initial() as T;
    return {
      async read(): Promise<T> {
        const value = await harness.snapshot(token, conversation.id, context);
        return structuredClone(value ?? initial()) as T;
      },
      async update<R>(mutate: (draft: T) => R | Promise<R>): Promise<R> {
        return await conversation.commit(async (tx) => {
          const draft = (await tx.doc(token, conversation.id)) as T;
          return await mutate(draft);
        }, context);
      },
    };
  }
  return {
    tasks: host(TASK_BOARD_DOC),
    teams: host(TEAM_STORE_DOC),
    plans: host(PLAN_STORE_DOC),
  };
}

/** 内存宿主：测试与“无 durable 会话”的嵌入场景使用；语义与生产宿主一致。 */
export function createMemoryDocHost<T extends JsonObject>(initial: T): AppDocHost<T> & { peek(): T } {
  let value = structuredClone(initial) as T;
  return {
    async read(): Promise<T> {
      return structuredClone(value);
    },
    async update<R>(mutate: (draft: T) => R | Promise<R>): Promise<R> {
      const draft = structuredClone(value);
      const result = await mutate(draft);
      value = structuredClone(draft);
      return result;
    },
    peek(): T {
      return structuredClone(value);
    },
  };
}

/** 空文档工厂，便于测试与无会话场景。 */
export function initialTaskBoard(): TaskBoardDoc {
  return { tasks: [] };
}

export function initialTeamStore(): TeamStoreDoc {
  return { teams: {} };
}

export function initialPlanStore(): PlanStoreDoc {
  return { plans: [] };
}
