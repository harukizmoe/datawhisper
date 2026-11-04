/**
 * 团队定义、邮箱与动态计划：6 个工具。
 *
 * 移植自 `agent/tools/workspace/teams.py` 与 `agent/teams/dynamic_plans.py`。
 * 存储改为 pi-durable 文档（`TEAM_STORE_DOC` / `PLAN_STORE_DOC`）；成员状态机
 * 里的 queued/running 仍可能由旧数据带入，因此保留 300 秒的陈旧成员清理规则。
 * 真正的成员执行与线程池调度属于 P5.1，不在本文件。
 */

import type { JsonValue } from "@earendil-works/chord";
import { AppToolError, errorResult, makeAppTool, okResult, renderValue, type AppTool, type AppToolDeps } from "../types.ts";
import type { AppDocHost } from "../types.ts";
import {
  type DynamicPlan,
  type PlanBudget,
  type PlanStoreDoc,
  type PlanTask,
  type PlanUsage,
  type TeamMember,
  type TeamMessage,
  type TeamRecord,
  type TeamStoreDoc,
} from "../docs.ts";
import { isoSeconds } from "./tasks.ts";

const BAD_NAME_RE = /[\x00-\x1f\x7f/\\]/;
export const LEAD_RECIPIENT = "leader";
const LEGACY_LEAD_RECIPIENTS: Readonly<Record<string, true>> = { leader: true, lead: true };
const QUALITY_REVIEWER_NAME = "质量复核员";
const QUALITY_REVIEWER_ROLE = "quality_reviewer";
const QUALITY_REVIEWER_INSTRUCTIONS =
  "固定质量复核员。只读复核团队输出中的数据口径、SQL、分子分母、样本范围、" +
  "工具错误、图表失败和无证据业务归因。必须独立使用 get_schema/profile_data/query_data " +
  "等只读工具复算关键指标；把结论分为通过、需修正、不可验证，并明确证据缺口。";

export class WorkspaceTeamError extends AppToolError {}

function nowIso(date: Date): string {
  return isoSeconds(date);
}

function ageSeconds(value: string, now: Date): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 0;
  return (now.getTime() - parsed) / 1000;
}

function messageId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function normalizeName(name: string, label: string): string {
  const value = name.replace(/\s+/g, " ").trim();
  if (!value || value.length > 64 || value === "*" || BAD_NAME_RE.test(value)) {
    throw new WorkspaceTeamError(`invalid ${label} name`);
  }
  return value;
}

function normalizeLeaderAlias(name: string): string {
  const value = name.replace(/\s+/g, " ").trim();
  return value.toLowerCase() === "lead" ? LEAD_RECIPIENT : value;
}

function qualityReviewerMember(): TeamMember {
  return {
    name: QUALITY_REVIEWER_NAME,
    agent_id: QUALITY_REVIEWER_NAME,
    role: QUALITY_REVIEWER_ROLE,
    instructions: QUALITY_REVIEWER_INSTRUCTIONS,
    status: "idle",
    last_message: "",
    last_active_at: "",
  };
}

function isQualityReviewer(member: TeamMember): boolean {
  return member.name === QUALITY_REVIEWER_NAME || member.role === QUALITY_REVIEWER_ROLE;
}

function withQualityReviewer(members: TeamMember[]): { members: TeamMember[]; added: boolean } {
  if (members.some(isQualityReviewer)) return { members, added: false };
  return { members: [...members, qualityReviewerMember()], added: true };
}

/** 模型偶尔把数组序列化成字符串；只接受 JSON 数组（Python 还接受 literal_eval）。 */
function coerceMembers(value: JsonValue | undefined): { name: string; agent_id?: string; role?: string; instructions?: string }[] {
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    try {
      return coerceMembers(JSON.parse(raw) as JsonValue);
    } catch {
      throw new WorkspaceTeamError("members must be an array");
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    if (Array.isArray(record.members)) return coerceMembers(record.members as JsonValue);
    return [record as unknown as { name: string }];
  }
  if (!Array.isArray(value)) throw new WorkspaceTeamError("members must be an array");
  return value.map((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as unknown as { name: string; agent_id?: string; role?: string; instructions?: string })
      : { name: String(item) }
  );
}

export class WorkspaceTeamStore {
  readonly #doc: AppDocHost<TeamStoreDoc>;
  readonly #now: () => Date;

  constructor(doc: AppDocHost<TeamStoreDoc> | undefined, now: () => Date = () => new Date()) {
    if (doc === undefined) throw new WorkspaceTeamError("no workspace is mounted for this session");
    this.#doc = doc;
    this.#now = now;
  }

  #fence(teams: Record<string, TeamRecord>, only?: string, maxAgeSeconds = 300): boolean {
    const now = this.#now();
    const selected = only ? [only] : Object.keys(teams);
    let changed = false;
    for (const name of selected) {
      const team = teams[name];
      if (team === undefined) continue;
      for (const member of team.members) {
        if (member.status === "running" && ageSeconds(member.last_active_at, now) > maxAgeSeconds) {
          member.status = "failed";
          member.last_message = "团队成员执行超时，已自动标记失败。";
          member.last_active_at = nowIso(now);
          team.messages.push({
            id: messageId(),
            sender: member.name,
            recipient: LEAD_RECIPIENT,
            message: "团队成员执行超过 5 分钟仍未完成，已自动标记为失败。",
            message_type: "error",
            read: false,
            created_at: nowIso(now),
          });
          team.messages = team.messages.slice(-500);
          team.updated_at = nowIso(now);
          changed = true;
        }
        if (member.status === "queued" && ageSeconds(member.last_active_at, now) > maxAgeSeconds) {
          for (const message of team.messages) {
            if (message.recipient === member.name && !message.read) message.read = true;
          }
          member.status = "idle";
          member.last_message = "";
          member.last_active_at = nowIso(now);
          team.updated_at = nowIso(now);
          changed = true;
        }
      }
    }
    return changed;
  }

  async create(name: string, description: string, members: JsonValue | undefined): Promise<TeamRecord> {
    const teamName = normalizeName(name, "team");
    const normalized: TeamMember[] = [];
    const seen = new Set<string>();
    for (const member of coerceMembers(members)) {
      const memberName = normalizeName(String(member.name ?? ""), "member");
      if (seen.has(memberName)) throw new WorkspaceTeamError(`duplicate member: ${memberName}`);
      seen.add(memberName);
      normalized.push({
        name: memberName,
        agent_id: String(member.agent_id ?? memberName).slice(0, 100),
        role: String(member.role ?? "analyst").slice(0, 100),
        instructions: String(member.instructions ?? "").slice(0, 4000),
        status: "idle",
        last_message: "",
        last_active_at: "",
      });
    }
    if (normalized.length === 0) throw new WorkspaceTeamError("at least one member is required");
    const reviewer = withQualityReviewer(normalized);
    return await this.#doc.update((doc) => {
      const now = nowIso(this.#now());
      const existing = doc.teams[teamName];
      const team: TeamRecord = {
        name: teamName,
        description: (description || existing?.description || "").slice(0, 1000),
        members: reviewer.members,
        messages: [],
        created_at: existing?.created_at ?? now,
        updated_at: now,
        reused: existing !== undefined,
        quality_reviewer: { name: QUALITY_REVIEWER_NAME, auto_added: reviewer.added },
      };
      doc.teams[teamName] = team;
      return structuredClone(team);
    });
  }

  async delete(name: string, force: boolean): Promise<{ deleted: string; force: boolean }> {
    const teamName = normalizeName(name, "team");
    return await this.#doc.update((doc) => {
      this.#fence(doc.teams, teamName);
      const team = doc.teams[teamName];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${teamName}`);
      const active = team.members
        .filter((member) => member.status === "queued" || member.status === "running")
        .map((member) => member.name);
      if (active.length > 0) {
        throw new WorkspaceTeamError(
          "团队成员仍在执行或排队，暂不能解散团队：" + active.join(", "),
        );
      }
      if (team.messages.length > 0 && !force) {
        throw new WorkspaceTeamError(
          "团队已有委派结果、错误或质量复核记录，默认保留以便复盘；" +
            "请先使用 team_status 查看证据。只有用户明确确认删除时，" +
            "才可再次调用 team_delete 并传 force=true。",
        );
      }
      delete doc.teams[teamName];
      return { deleted: teamName, force };
    });
  }

  async list(): Promise<unknown[]> {
    return await this.#doc.update((doc) => {
      this.#fence(doc.teams);
      return Object.values(doc.teams).map((team) => ({
        name: team.name,
        description: team.description,
        member_count: team.members.length,
        members: team.members.map((member) => ({
          name: member.name,
          role: member.role,
          status: member.status,
          last_active_at: member.last_active_at,
        })),
        message_count: team.messages.length,
        created_at: team.created_at,
        updated_at: team.updated_at,
      }));
    });
  }

  async status(name: string): Promise<unknown> {
    const teamName = normalizeName(name, "team");
    return await this.#doc.update((doc) => {
      this.#fence(doc.teams, teamName);
      const team = doc.teams[teamName];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${teamName}`);
      const leadUnread = team.messages.filter(
        (message) => LEGACY_LEAD_RECIPIENTS[message.recipient] === true && !message.read,
      ).length;
      return {
        name: team.name,
        description: team.description,
        members: team.members.map((member) => ({
          name: member.name,
          agent_id: member.agent_id || member.name,
          role: member.role,
          instructions: member.instructions,
          status: member.status,
          last_message: member.last_message,
          last_active_at: member.last_active_at,
          unread_messages: team.messages.filter(
            (message) => message.recipient === member.name && !message.read,
          ).length,
        })),
        lead_unread_messages: leadUnread,
        recent_messages: team.messages.slice(-200),
        created_at: team.created_at,
        updated_at: team.updated_at,
      };
    });
  }

  async sendMessage(teamName: string, recipientValue: string, message: string): Promise<unknown> {
    const name = normalizeName(teamName, "team");
    const recipient = normalizeLeaderAlias(recipientValue);
    const target = recipient === "*" ? "*" : normalizeName(recipient, "recipient");
    return await this.#doc.update((doc) => {
      const team = doc.teams[name];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
      const members = new Map(team.members.map((member) => [member.name, member]));
      if (target !== "*" && target !== LEAD_RECIPIENT && !members.has(target)) {
        throw new WorkspaceTeamError(`member not found: ${target}`);
      }
      const now = nowIso(this.#now());
      const recipients = target === "*" ? [...members.keys()] : [target];
      const created: TeamMessage[] = [];
      for (const current of recipients) {
        const item: TeamMessage = {
          id: messageId(),
          sender: normalizeName(normalizeLeaderAlias(LEAD_RECIPIENT), "sender"),
          recipient: current,
          message: (message ?? "").slice(0, 10_000),
          message_type: "text",
          read: false,
          created_at: now,
        };
        team.messages.push(item);
        created.push(item);
        const member = members.get(current);
        if (member !== undefined && item.sender !== current) {
          member.status = "queued";
          member.last_message = item.message.slice(0, 500);
          member.last_active_at = now;
        }
      }
      team.messages = team.messages.slice(-500);
      team.updated_at = now;
      return {
        sent: created.length,
        messages: structuredClone(created),
        ...(created.length === 1 ? structuredClone(created[0] as TeamMessage) : {}),
      };
    });
  }
}

function emptyUsage(): PlanUsage {
  return { model: "", provider: "", input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, tool_calls: 0 };
}

function budgetFor(tasks: readonly PlanTask[], reviewUsage: PlanUsage): PlanBudget {
  const usages = [...tasks.map((task) => task.usage), reviewUsage];
  const measured = (usage: PlanUsage): boolean =>
    usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cached_input_tokens > 0 || usage.tool_calls > 0;
  return {
    input_tokens: usages.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: usages.reduce((sum, usage) => sum + usage.output_tokens, 0),
    cached_input_tokens: usages.reduce((sum, usage) => sum + usage.cached_input_tokens, 0),
    tool_calls: usages.reduce((sum, usage) => sum + usage.tool_calls, 0),
    measured_task_count: tasks.filter((task) => measured(task.usage)).length,
    task_count: tasks.length,
    child_job_count: tasks.reduce((sum, task) => sum + task.job_ids.length, 0),
    quality_review_measured: measured(reviewUsage),
    estimated_cost: null,
  };
}

export class DynamicTeamPlanStore {
  readonly #doc: AppDocHost<PlanStoreDoc>;
  readonly #now: () => Date;
  readonly #workspaceId: string;

  constructor(doc: AppDocHost<PlanStoreDoc> | undefined, workspaceId: string, now: () => Date = () => new Date()) {
    if (doc === undefined) throw new WorkspaceTeamError("no workspace is mounted for this session");
    this.#doc = doc;
    this.#workspaceId = workspaceId;
    this.#now = now;
  }

  async create(
    teamName: string,
    goal: string,
    assignments: readonly {
      task_id?: string;
      member_name?: string;
      prompt?: string;
      description?: string;
      depends_on?: string[];
    }[],
  ): Promise<DynamicPlan> {
    if (assignments.length < 1 || assignments.length > 8) {
      throw new WorkspaceTeamError("dynamic plan requires 1-8 tasks");
    }
    const now = nowIso(this.#now());
    const seen = new Set<string>();
    const tasks: PlanTask[] = [];
    assignments.forEach((item, index) => {
      const id = String(item.task_id || `task_${index + 1}`).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 64);
      if (!id || seen.has(id)) throw new WorkspaceTeamError("duplicate dynamic task id");
      seen.add(id);
      tasks.push({
        id,
        member_name: String(item.member_name || "").slice(0, 64),
        title: String(item.description || id).slice(0, 240),
        prompt: String(item.prompt || "").slice(0, 12_000),
        depends_on: (item.depends_on ?? []).map((value) => String(value).slice(0, 64)).slice(0, 8),
        status: "pending",
        attempt: 1,
        job_id: "",
        result_summary: "",
        error: "",
        tool_count: 0,
        artifacts: [],
        usage: emptyUsage(),
        usage_history: [],
        job_ids: [],
        started_at: "",
        finished_at: "",
        updated_at: now,
      });
    });
    if (
      tasks.some(
        (task) =>
          !task.member_name ||
          !task.prompt ||
          task.depends_on.includes(task.id) ||
          task.depends_on.some((dependency) => !seen.has(dependency)),
      )
    ) {
      throw new WorkspaceTeamError("invalid dynamic task");
    }
    const dependencies = new Map(tasks.map((task) => [task.id, new Set(task.depends_on)]));
    const resolved = new Set<string>();
    while (dependencies.size > 0) {
      const ready = [...dependencies.entries()].filter(([, deps]) => [...deps].every((dep) => resolved.has(dep)));
      if (ready.length === 0) throw new WorkspaceTeamError("dynamic task dependencies contain a cycle");
      for (const [id] of ready) {
        resolved.add(id);
        dependencies.delete(id);
      }
    }
    const reviewUsage = emptyUsage();
    const plan: DynamicPlan = {
      id: `tp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
      workspace_id: this.#workspaceId,
      team_name: String(teamName).slice(0, 64),
      goal: String(goal || "团队动态协作").slice(0, 4000),
      status: "planned",
      created_by: "lead",
      tasks,
      quality_review_usage: reviewUsage,
      quality_review_usage_history: [],
      created_at: now,
      updated_at: now,
      finished_at: "",
      workflow_draft_id: "",
      budget: budgetFor(tasks, reviewUsage),
    };
    return await this.#doc.update((doc) => {
      doc.plans.push(plan);
      doc.plans = doc.plans.slice(-100);
      return structuredClone(plan);
    });
  }
}

function fail(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createTeamTools(deps: AppToolDeps): AppTool[] {
  const now = deps.now ?? (() => new Date());
  const teamStore = (): WorkspaceTeamStore => new WorkspaceTeamStore(deps.docs?.teams, now);
  const planStore = (): DynamicTeamPlanStore =>
    new DynamicTeamPlanStore(deps.docs?.plans, deps.workspaceId ?? "", now);
  return [
    makeAppTool<{ name: string; description?: string; members: JsonValue }>({
      name: "team_create",
      description:
        "Create a persistent analyst team definition in the mounted workspace. Members are roles, not unrestricted OS processes. Team and member names may be Chinese or English. Pass members as an array of objects, not a string. The platform automatically adds a fixed read-only quality reviewer member for data/SQL evidence checks.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string" },
                instructions: { type: "string" },
              },
              required: ["name"],
            },
          },
        },
        required: ["name", "members"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const team = await teamStore().create(args.name ?? "", args.description ?? "", args.members);
          return okResult("team_create", renderValue(team as unknown as JsonValue), {
            tool: "team_create",
            team: team as unknown as JsonValue,
          });
        } catch (error) {
          return fail("team_create", error);
        }
      },
    }),
    makeAppTool<{ name: string; force?: boolean }>({
      name: "team_delete",
      description:
        "Delete a team definition and mailbox from the mounted workspace. Protected by default: if the team has messages, errors, or quality-review evidence, first inspect team_status and keep it for audit. Only pass force=true when the user explicitly confirms deletion after review.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          force: {
            type: "boolean",
            description: "Set true only after explicit user confirmation; bypasses evidence-retention protection but still refuses active queued/running teams.",
          },
        },
        required: ["name"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await teamStore().delete(args.name ?? "", args.force === true);
          return okResult("team_delete", renderValue(result as unknown as JsonValue), {
            tool: "team_delete",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("team_delete", error);
        }
      },
    }),
    makeAppTool({
      name: "team_list",
      description: "List persistent analyst teams in the mounted workspace with member statuses.",
      parameters: { type: "object", properties: {} },
      replay: "safe",
      async execute() {
        try {
          const teams = await teamStore().list();
          return okResult("team_list", renderValue(teams as unknown as JsonValue), {
            tool: "team_list",
            teams: teams as unknown as JsonValue,
            count: teams.length,
          });
        } catch (error) {
          return fail("team_list", error);
        }
      },
    }),
    makeAppTool<{ name: string }>({
      name: "team_status",
      description: "Get one workspace team status, member inbox counts, and recent mailbox messages.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const status = await teamStore().status(args.name ?? "");
          return okResult("team_status", renderValue(status as unknown as JsonValue), {
            tool: "team_status",
            team: status as unknown as JsonValue,
          });
        } catch (error) {
          return fail("team_status", error);
        }
      },
    }),
    makeAppTool<{ team_name: string; recipient: string; message: string }>({
      name: "send_message",
      description:
        "Store a message for a named member in a mounted-workspace team mailbox. Use recipient='*' to broadcast to all members.",
      parameters: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          recipient: { type: "string" },
          message: { type: "string" },
        },
        required: ["team_name", "recipient", "message"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const result = await teamStore().sendMessage(
            args.team_name ?? "",
            args.recipient ?? "",
            args.message ?? "",
          );
          return okResult("send_message", renderValue(result as unknown as JsonValue), {
            tool: "send_message",
            ...(result as unknown as JsonValue as Record<string, JsonValue>),
          });
        } catch (error) {
          return fail("send_message", error);
        }
      },
    }),
    makeAppTool<{
      team_name: string;
      goal: string;
      assignments: {
        task_id?: string;
        member_name: string;
        prompt: string;
        description?: string;
        depends_on?: string[];
      }[];
    }>({
      name: "team_plan_create",
      description:
        "Create a bounded dynamic team plan without running members. Use this when the user explicitly asks to create, preview, or confirm a team plan first. Execute the returned plan_id later with team_delegate(plan_id=...).",
      parameters: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          goal: { type: "string" },
          assignments: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                task_id: { type: "string" },
                member_name: { type: "string" },
                prompt: { type: "string" },
                description: { type: "string" },
                depends_on: { type: "array", items: { type: "string" } },
              },
              required: ["member_name", "prompt"],
            },
          },
        },
        required: ["team_name", "goal", "assignments"],
      },
      replay: "unsafe",
      async execute(args) {
        try {
          const teamName = String(args.team_name ?? "").trim();
          const assignments = args.assignments ?? [];
          if (!teamName || !Array.isArray(assignments)) {
            throw new WorkspaceTeamError("team_plan_create requires team_name and assignments");
          }
          const plan = await planStore().create(teamName, String(args.goal || "团队动态协作").slice(0, 4000), assignments);
          const result = {
            plan: plan as unknown as JsonValue,
            execution_instruction: "After user confirmation, call team_delegate with this plan_id.",
          };
          return okResult("team_plan_create", renderValue(result), {
            tool: "team_plan_create",
            plan: plan as unknown as JsonValue,
            execution_instruction: result.execution_instruction,
          });
        } catch (error) {
          return fail("team_plan_create", error);
        }
      },
    }),
  ];
}
