/**
 * 团队定义、邮箱与动态计划：6 个工具。
 *
 * 移植自 `agent/tools/workspace/teams.py` 与 `agent/teams/dynamic_plans.py`。
 * 存储改为 pi-durable 文档（`TEAM_STORE_DOC` / `PLAN_STORE_DOC`）；成员状态机
 * 里的 queued/running 仍可能由旧数据带入，因此保留 300 秒的陈旧成员清理规则。
 * 真正的成员执行与线程池调度属于 P5.1，不在本文件。
 */

import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppToolError, errorResult, makeAppTool, okResult, renderValue, type AppTool, type AppToolDeps } from "./types.ts";
import type { AppDocHost, AppToolDetails } from "./types.ts";
import { invalidDelegatedResult } from "../../teams/delegate.ts";
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
  type TeamSubConversation,
} from "./docs.ts";
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

/** `team_delegate` 的任务项；`allowed_tools` 只在本文件内用于建子会话，不写进动态计划。 */
type DelegateAssignment = {
  task_id?: string;
  member_name: string;
  prompt: string;
  description?: string;
  depends_on?: string[];
  allowed_tools?: string[];
};

type TeamDelegateArgs = {
  team_name: string;
  goal?: string;
  plan_id?: string;
  assignments?: DelegateAssignment[];
  member_name?: string;
  prompt?: string;
  description?: string;
  allowed_tools?: string[];
  timeout_seconds?: number;
  max_concurrency?: number;
  max_tool_calls?: number;
};

type DelegatedAssignmentResult = {
  task_id: string;
  member: string;
  status: string;
  error: string;
  error_code: string;
  result: string;
  tool_count: number;
  conversation_id: number;
  conversation_title: string;
  consumed_messages: number;
  usage: PlanUsage;
};

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
        usage: emptyUsage(),
        sub_conversations: [],
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
          last_conversation_id: member.last_conversation_id ?? null,
          last_usage: member.last_usage ?? emptyUsage(),
        })),
        message_count: team.messages.length,
        sub_conversation_count: (team.sub_conversations ?? []).length,
        usage: team.usage ?? emptyUsage(),
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
          last_conversation_id: member.last_conversation_id ?? null,
          last_conversation_title: member.last_conversation_title ?? "",
          last_usage: member.last_usage ?? emptyUsage(),
          unread_messages: team.messages.filter(
            (message) => message.recipient === member.name && !message.read,
          ).length,
        })),
        lead_unread_messages: leadUnread,
        recent_messages: team.messages.slice(-200),
        sub_conversations: (team.sub_conversations ?? []).slice(-50),
        usage: team.usage ?? emptyUsage(),
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

  /** 旧 `get()`：读整支团队，供委托前校验团队存在与成员清单。 */
  async get(teamName: string): Promise<TeamRecord> {
    const name = normalizeName(teamName, "team");
    const doc = await this.#doc.read();
    const team = doc.teams[name];
    if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
    return structuredClone(team);
  }

  /** 旧 `member()`：按名字取成员，供委托前校验。 */
  async member(teamName: string, memberName: string): Promise<TeamMember> {
    const name = normalizeName(teamName, "team");
    const member = normalizeName(memberName, "member");
    const doc = await this.#doc.read();
    const team = doc.teams[name];
    if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
    const found = team.members.find((item) => item.name === member);
    if (found === undefined) throw new WorkspaceTeamError(`member not found: ${member}`);
    return structuredClone(found);
  }

  /**
   * 旧 `send_message(..., read=True, queue=False, message_type="assignment")`：
   * 委托任务写进邮箱但不把成员标成 queued，随后 `beginMemberTurn` 才把状态改成 running。
   */
  async assignMember(teamName: string, memberName: string, message: string): Promise<TeamMessage> {
    const name = normalizeName(teamName, "team");
    const target = normalizeName(memberName, "member");
    return await this.#doc.update((doc) => {
      const team = doc.teams[name];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
      if (!team.members.some((item) => item.name === target)) {
        throw new WorkspaceTeamError(`member not found: ${target}`);
      }
      const now = nowIso(this.#now());
      const item: TeamMessage = {
        id: messageId(),
        sender: LEAD_RECIPIENT,
        recipient: target,
        message: (message ?? "").slice(0, 10_000),
        message_type: "assignment",
        read: true,
        created_at: now,
      };
      team.messages.push(item);
      team.messages = team.messages.slice(-500);
      team.updated_at = now;
      return structuredClone(item);
    });
  }

  /** 旧 `begin_member_turn`：标 running、吞掉未读邮件并返回收件箱。 */
  async beginMemberTurn(
    teamName: string,
    memberName: string,
  ): Promise<{ team: string; member: TeamMember; inbox: TeamMessage[] }> {
    const name = normalizeName(teamName, "team");
    const target = normalizeName(memberName, "member");
    return await this.#doc.update((doc) => {
      this.#fence(doc.teams, name);
      const team = doc.teams[name];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
      const member = team.members.find((item) => item.name === target);
      if (member === undefined) throw new WorkspaceTeamError(`member not found: ${target}`);
      const inbox: TeamMessage[] = [];
      for (const message of team.messages) {
        if (message.recipient === target && !message.read) {
          message.read = true;
          inbox.push(structuredClone(message));
        }
      }
      const now = nowIso(this.#now());
      member.status = "running";
      member.last_active_at = now;
      team.updated_at = now;
      return { team: name, member: structuredClone(member), inbox };
    });
  }

  /** 子会话一建好就把 id/标题挂到成员上：界面在运行期间也能跳到对应会话。 */
  async markMemberConversation(
    teamName: string,
    memberName: string,
    conversation: { conversation_id: number; title: string },
  ): Promise<void> {
    const name = normalizeName(teamName, "team");
    const target = normalizeName(memberName, "member");
    await this.#doc.update((doc) => {
      const team = doc.teams[name];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
      const member = team.members.find((item) => item.name === target);
      if (member === undefined) throw new WorkspaceTeamError(`member not found: ${target}`);
      member.last_conversation_id = conversation.conversation_id;
      member.last_conversation_title = conversation.title;
      team.updated_at = nowIso(this.#now());
    });
  }

  /**
   * 旧 `complete_member_turn`：写结果邮件、更新成员状态与最近一次子会话，
   * 并把这次委托的用量累加进团队视图。`ok=false` 时消息类型为 error。
   */
  async completeMemberTurn(
    teamName: string,
    memberName: string,
    result: string,
    options: {
      ok?: boolean;
      toolEvents?: readonly JsonValue[];
      conversationId?: number;
      conversationTitle?: string;
      usage?: PlanUsage;
      errorCode?: string;
    } = {},
  ): Promise<{ team: string; member: string; status: string; message: TeamMessage }> {
    const name = normalizeName(teamName, "team");
    const target = normalizeName(memberName, "member");
    const ok = options.ok !== false;
    return await this.#doc.update((doc) => {
      const team = doc.teams[name];
      if (team === undefined) throw new WorkspaceTeamError(`team not found: ${name}`);
      const member = team.members.find((item) => item.name === target);
      if (member === undefined) throw new WorkspaceTeamError(`member not found: ${target}`);
      const now = nowIso(this.#now());
      const startedAt = member.last_active_at || now;
      const usage = options.usage ?? emptyUsage();
      const message: TeamMessage = {
        id: messageId(),
        sender: target,
        recipient: LEAD_RECIPIENT,
        message: (result || "").slice(0, 20_000),
        message_type: ok ? "result" : "error",
        read: false,
        created_at: now,
        tool_events: normalizeToolEvents(options.toolEvents),
        ...(options.conversationId === undefined ? {} : { conversation_id: options.conversationId }),
        ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
        usage: structuredClone(usage),
      };
      member.status = ok ? "idle" : "failed";
      member.last_message = (result || "").slice(0, 500);
      member.last_active_at = now;
      member.last_usage = structuredClone(usage);
      if (options.conversationId !== undefined) {
        member.last_conversation_id = options.conversationId;
        member.last_conversation_title = options.conversationTitle ?? member.last_conversation_title ?? "";
      }
      team.messages.push(message);
      team.messages = team.messages.slice(-500);
      if (options.conversationId !== undefined) {
        const sub: TeamSubConversation = {
          conversation_id: options.conversationId,
          member_name: target,
          title: options.conversationTitle ?? "",
          status: ok ? "completed" : options.errorCode === "team_delegate_canceled" ? "canceled" : "failed",
          started_at: startedAt,
          finished_at: now,
          error: ok ? "" : (options.errorCode ?? ""),
          ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
          usage: structuredClone(usage),
        };
        team.sub_conversations = [...(team.sub_conversations ?? []), sub].slice(-200);
      }
      const total = team.usage ?? emptyUsage();
      addUsage(total, usage);
      team.usage = total;
      team.updated_at = now;
      return { team: name, member: target, status: member.status, message: structuredClone(message) };
    });
  }
}

function emptyUsage(): PlanUsage {
  return { model: "", provider: "", input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, tool_calls: 0 };
}

/** 团队累计用量：分项相加，模型/提供方保留最后一个非空值（旧记录同样只有一个名字）。 */
function addUsage(target: PlanUsage, usage: PlanUsage): void {
  target.input_tokens += usage.input_tokens;
  target.output_tokens += usage.output_tokens;
  target.cached_input_tokens += usage.cached_input_tokens;
  target.tool_calls += usage.tool_calls;
  if (usage.model !== "") target.model = usage.model;
  if (usage.provider !== "") target.provider = usage.provider;
}

/** 旧 `_normalize_tool_events`：只保留 30 条、结果截到 2000 字符、字段名不变。 */
function normalizeToolEvents(events: readonly JsonValue[] | undefined): JsonValue[] {
  if (events === undefined) return [];
  const normalized: JsonValue[] = [];
  for (const item of events.slice(0, 30)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const tool = "tool" in item && typeof item.tool === "string" ? item.tool.slice(0, 120) : "";
    if (tool === "") continue;
    const args = "args" in item && item.args !== null && typeof item.args === "object" && !Array.isArray(item.args)
      ? item.args
      : {};
    const result = "result" in item && typeof item.result === "string" ? item.result.slice(0, 2000) : "";
    const status = "status" in item && typeof item.status === "string" ? item.status.slice(0, 30) : "ok";
    const elapsed = "elapsed_seconds" in item && typeof item.elapsed_seconds === "number" ? item.elapsed_seconds : null;
    const createdAt = "created_at" in item && typeof item.created_at === "string" ? item.created_at.slice(0, 40) : "";
    normalized.push({
      tool,
      args,
      result,
      status,
      elapsed_seconds: elapsed,
      created_at: createdAt,
    });
  }
  return normalized;
}

/** 计划预算里的“这次调用是否真的产生了用量”；四个字段任一非零即算。 */
function usageMeasured(usage: PlanUsage): boolean {
  return usage.input_tokens > 0 || usage.output_tokens > 0 || usage.cached_input_tokens > 0 || usage.tool_calls > 0;
}

function budgetFor(tasks: readonly PlanTask[], reviewUsage: PlanUsage): PlanBudget {
  const usages = [...tasks.map((task) => task.usage), reviewUsage];
  return {
    input_tokens: usages.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: usages.reduce((sum, usage) => sum + usage.output_tokens, 0),
    cached_input_tokens: usages.reduce((sum, usage) => sum + usage.cached_input_tokens, 0),
    tool_calls: usages.reduce((sum, usage) => sum + usage.tool_calls, 0),
    measured_task_count: tasks.filter((task) => usageMeasured(task.usage)).length,
    task_count: tasks.length,
    child_job_count: tasks.reduce((sum, task) => sum + task.job_ids.length, 0),
    quality_review_measured: usageMeasured(reviewUsage),
    estimated_cost: null,
  };
}

/** 旧 `_refresh_budget`：重试过的任务把 `usage_history` 里的每次尝试都算进去。 */
function refreshPlanBudget(plan: DynamicPlan): void {
  const taskUsages = plan.tasks.flatMap((task) =>
    task.usage_history.length > 0 ? task.usage_history : [task.usage],
  );
  const reviewUsages =
    plan.quality_review_usage_history.length > 0
      ? plan.quality_review_usage_history
      : [plan.quality_review_usage];
  const all = [...taskUsages, ...reviewUsages];
  plan.budget = {
    input_tokens: all.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: all.reduce((sum, usage) => sum + usage.output_tokens, 0),
    cached_input_tokens: all.reduce((sum, usage) => sum + usage.cached_input_tokens, 0),
    tool_calls: all.reduce((sum, usage) => sum + usage.tool_calls, 0),
    measured_task_count: plan.tasks.filter((task) => usageMeasured(task.usage)).length,
    task_count: plan.tasks.length,
    child_job_count: plan.tasks.reduce((sum, task) => sum + task.job_ids.length, 0),
    quality_review_measured: reviewUsages.some(usageMeasured),
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

  async get(planId: string): Promise<DynamicPlan> {
    const id = String(planId).trim();
    const doc = await this.#doc.read();
    const plan = doc.plans.find((item) => item.id === id);
    if (plan === undefined) throw new WorkspaceTeamError(`dynamic plan not found: ${id}`);
    return structuredClone(plan);
  }

  async start(planId: string): Promise<DynamicPlan> {
    const id = String(planId).trim();
    return await this.#doc.update((doc) => {
      const plan = doc.plans.find((item) => item.id === id);
      if (plan === undefined) throw new WorkspaceTeamError(`dynamic plan not found: ${id}`);
      if (plan.status !== "planned") {
        throw new WorkspaceTeamError("cannot start dynamic plan unless status is planned");
      }
      plan.status = "running";
      plan.updated_at = nowIso(this.#now());
      return structuredClone(plan);
    });
  }

  /** 旧 `task()`：状态机与用量历史都在同一份 plan 文档里更新。 */
  async task(
    planId: string,
    taskId: string,
    status: string,
    options: {
      result?: string;
      error?: string;
      toolEvents?: readonly JsonValue[];
      usage?: PlanUsage;
    } = {},
  ): Promise<PlanTask | undefined> {
    const id = String(planId).trim();
    const taskKey = String(taskId).trim();
    return await this.#doc.update((doc) => {
      const plan = doc.plans.find((item) => item.id === id);
      if (plan === undefined) throw new WorkspaceTeamError(`dynamic plan not found: ${id}`);
      const task = plan.tasks.find((item) => item.id === taskKey);
      if (plan.status === "canceled") return task === undefined ? undefined : structuredClone(task);
      if (task === undefined) throw new WorkspaceTeamError(`dynamic task not found: ${taskKey}`);
      const now = nowIso(this.#now());
      task.status = status;
      task.updated_at = now;
      if (options.usage !== undefined) {
        task.usage = structuredClone(options.usage);
        if (status === "completed" || status === "failed" || status === "canceled") {
          task.usage_history.push({ attempt: task.attempt, ...structuredClone(options.usage) });
        }
      }
      if (status === "running" && task.started_at === "") task.started_at = now;
      if (status === "completed" || status === "failed" || status === "canceled") task.finished_at = now;
      task.result_summary = (options.result ?? "").slice(0, 500);
      task.error = (options.error ?? "").slice(0, 2000);
      if (options.toolEvents !== undefined) {
        const events = normalizeToolEvents(options.toolEvents);
        task.tool_count = events.length;
      }
      refreshPlanBudget(plan);
      plan.updated_at = now;
      return structuredClone(task);
    });
  }

  /** 旧 `finalize()`：所有任务 completed 才算 completed，否则 partial_failed。 */
  async finalize(planId: string): Promise<DynamicPlan> {
    const id = String(planId).trim();
    return await this.#doc.update((doc) => {
      const plan = doc.plans.find((item) => item.id === id);
      if (plan === undefined) throw new WorkspaceTeamError(`dynamic plan not found: ${id}`);
      if (plan.status !== "canceled") {
        const statuses = plan.tasks.map((task) => task.status);
        plan.status =
          statuses.length > 0 && statuses.every((status) => status === "completed")
            ? "completed"
            : "partial_failed";
      }
      plan.finished_at = nowIso(this.#now());
      plan.updated_at = plan.finished_at;
      refreshPlanBudget(plan);
      return structuredClone(plan);
    });
  }
}

function fail(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createTeamTools(deps: AppToolDeps): AppTool[] {
  const now = deps.now ?? (() => new Date());
  // 文档按会话现取（同 `tasks.ts`）：团队表与动态计划都是会话级文档。
  const teamStore = (api: ToolExecutionApi<AppToolDetails>): WorkspaceTeamStore =>
    new WorkspaceTeamStore(deps.docs?.(api).teams, now);
  const planStore = (api: ToolExecutionApi<AppToolDetails>): DynamicTeamPlanStore =>
    new DynamicTeamPlanStore(deps.docs?.(api).plans, deps.workspaceId ?? "", now);

  const delegateFail = (message: string, code: string) =>
    errorResult("team_delegate", message, { tool: "team_delegate", error_code: code });

  function delegateErrorCode(message: string): string {
    if (message.startsWith("team not found:")) return "team_not_found";
    if (message.startsWith("member not found:")) return "member_not_found";
    if (message.startsWith("dynamic plan not found:")) return "plan_not_found";
    if (message.includes("different team")) return "plan_team_mismatch";
    if (message.includes("cannot start dynamic plan")) return "plan_status";
    if (
      message.startsWith("team_delegate requires") ||
      message.startsWith("invalid ") ||
      message.includes("must be an array") ||
      message.includes("invalid dynamic task") ||
      message.includes("duplicate dynamic task") ||
      message.includes("dynamic plan requires") ||
      message.includes("at least one member is required")
    ) {
      return "invalid_input";
    }
    return "team_delegate_failed";
  }

  function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  /**
   * 一次 `team_delegate`：先落动态计划（旧实现同样把每次委派记成 plan），再按依赖分波次开子会话。
   * 成员调用的结果、用量、子会话 id 同时写回计划、团队邮箱与团队视图。
   */
  async function executeTeamDelegate(args: TeamDelegateArgs, api: ToolExecutionApi) {
    const port = deps.teamDelegate;
    if (port === undefined) {
      return delegateFail("team delegation is not available in this session", "team_delegate_unavailable");
    }
    const teamName = String(args.team_name ?? "").trim();
    if (teamName === "") return delegateFail("team_delegate requires team_name", "invalid_input");

    try {
      const store = teamStore(api);
      const plans = planStore(api);
      // 先校验团队：会话恢复后旧的团队状态可能已经不存在，要给出可执行的恢复指令。
      const teamKey = (await store.get(teamName)).name;

      const planIdArg = String(args.plan_id ?? "").trim();
      let plan: DynamicPlan;
      let perTaskAllowed: (string[] | undefined)[] = [];
      if (planIdArg !== "") {
        const existing = await plans.get(planIdArg);
        if (existing.team_name !== teamKey) {
          throw new WorkspaceTeamError("planned dynamic plan belongs to a different team");
        }
        plan = await plans.start(planIdArg);
      } else {
        let provided = args.assignments ?? [];
        if (provided.length === 0 && typeof args.member_name === "string" && typeof args.prompt === "string") {
          provided = [{ member_name: args.member_name, prompt: args.prompt, description: args.description }];
        }
        if (provided.length === 0) {
          return delegateFail("team_delegate requires non-empty assignments", "invalid_input");
        }
        perTaskAllowed = provided.map((item) => item.allowed_tools);
        const created = await plans.create(teamKey, String(args.goal ?? "团队动态协作"), provided);
        plan = await plans.start(created.id);
      }

      const team = await store.get(teamKey);
      const members = new Map(team.members.map((member) => [member.name, member]));
      const maxConcurrency = clampInt(
        args.max_concurrency ?? plan.tasks.length,
        1,
        Math.max(1, Math.min(plan.tasks.length, 6)),
        1,
      );
      const timeoutSeconds = clampInt(args.timeout_seconds, 10, 300, 300);
      const maxToolCalls = clampInt(args.max_tool_calls, 1, 1000, 100);
      const results: DelegatedAssignmentResult[] = [];
      const succeeded = new Set<string>();
      const failedTasks = new Set<string>();

      const completeFailure = async (
        taskId: string,
        memberName: string,
        reason: string,
        code: string,
      ): Promise<void> => {
        try {
          await store.completeMemberTurn(teamKey, memberName, reason, { ok: false, errorCode: code });
        } catch {
          // 成员本身不存在时无法写回团队邮箱；失败仍要出现在工具结果里。
        }
        try {
          await plans.task(plan.id, taskId, "failed", { error: reason });
        } catch {
          // 计划已被取消时 task() 只返回当前记录，不阻断工具结果。
        }
        failedTasks.add(taskId);
        results.push({
          task_id: taskId,
          member: memberName,
          status: "failed",
          error: reason,
          error_code: code,
          result: "",
          tool_count: 0,
          conversation_id: 0,
          conversation_title: "",
          consumed_messages: 0,
          usage: emptyUsage(),
        });
      };

      const runAssignment = async (taskId: string): Promise<void> => {
        const index = plan.tasks.findIndex((task) => task.id === taskId);
        const task = plan.tasks[index];
        if (task === undefined) return;
        const member = members.get(task.member_name);
        if (member === undefined) {
          await completeFailure(task.id, task.member_name, `member not found: ${task.member_name}`, "member_not_found");
          return;
        }
        const assignmentText =
          (task.title.trim() !== "" ? `任务：${task.title.trim()}\n\n` : "任务：团队并行分析\n\n") + task.prompt;
        try {
          await plans.task(plan.id, task.id, "running");
          await store.assignMember(teamKey, member.name, assignmentText);
          const turn = await store.beginMemberTurn(teamKey, member.name);
          const parentConversationId = Number(api.conversationId);
          const inboxContext =
            turn.inbox.length === 0
              ? ""
              : "\n\n[Unread team mailbox]\n" +
                turn.inbox.map((message) => `- From ${message.sender}: ${message.message}`).join("\n");
          const delegated = await port.run({
            team_name: teamKey,
            member,
            prompt: task.prompt,
            description: task.title,
            inbox_context: inboxContext,
            allowed_tools: perTaskAllowed[index] ?? args.allowed_tools ?? null,
            timeout_seconds: timeoutSeconds,
            max_tool_calls: maxToolCalls,
            ...(Number.isFinite(parentConversationId) && parentConversationId > 0
              ? { parent_conversation_id: parentConversationId }
              : {}),
            on_start: async (info) => {
              await store.markMemberConversation(teamKey, member.name, info);
            },
          });
          const invalid =
            delegated.status === "completed"
              ? invalidDelegatedResult(delegated.content, delegated.tool_events)
              : undefined;
          const ok = delegated.status === "completed" && invalid === undefined;
          const error = invalid?.error ?? delegated.error;
          const code = invalid?.code ?? delegated.code;
          const outcome = ok ? "idle" : delegated.status === "canceled" ? "canceled" : "failed";
          await store.completeMemberTurn(
            teamKey,
            member.name,
            delegated.content.trim() !== "" ? delegated.content : error,
            {
              ok,
              toolEvents: delegated.tool_events,
              conversationId: delegated.conversation_id === 0 ? undefined : delegated.conversation_id,
              conversationTitle: delegated.conversation_title,
              usage: delegated.usage,
              errorCode: ok ? undefined : code,
            },
          );
          const planTaskStatus = ok ? "completed" : delegated.status === "canceled" ? "canceled" : "failed";
          await plans.task(plan.id, task.id, planTaskStatus, {
            result: delegated.content,
            error,
            toolEvents: delegated.tool_events,
            usage: delegated.usage,
          });
          results.push({
            task_id: task.id,
            member: member.name,
            status: outcome,
            error: ok ? "" : error,
            error_code: ok ? "" : code,
            result: delegated.content,
            tool_count: delegated.tool_events.length,
            conversation_id: delegated.conversation_id,
            conversation_title: delegated.conversation_title,
            consumed_messages: turn.inbox.length,
            usage: delegated.usage,
          });
          if (ok) succeeded.add(task.id);
          else failedTasks.add(task.id);
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : String(failure);
          await completeFailure(task.id, member.name, message, delegateErrorCode(message));
        }
      };

      const pending = new Map<string, PlanTask>(
        plan.tasks.map((task) => [task.id, task] as const),
      );
      while (pending.size > 0) {
        for (const task of [...pending.values()]) {
          const failedDependency = task.depends_on.find((dependency) => failedTasks.has(dependency));
          if (failedDependency === undefined) continue;
          pending.delete(task.id);
          const memberName = task.member_name;
          if (!members.has(memberName)) {
            await completeFailure(task.id, memberName, `member not found: ${memberName}`, "member_not_found");
            continue;
          }
          await completeFailure(
            task.id,
            memberName,
            `前置任务失败，当前任务未派发：${failedDependency}`,
            "team_delegate_dependency_failed",
          );
        }
        if (pending.size === 0) break;
        const ready = [...pending.values()].filter((task) =>
          task.depends_on.every((dependency) => succeeded.has(dependency)),
        );
        if (ready.length === 0) {
          for (const task of [...pending.values()]) {
            pending.delete(task.id);
            await completeFailure(
              task.id,
              task.member_name,
              "前置任务未满足，当前任务未派发。",
              "team_delegate_dependency_unmet",
            );
          }
          break;
        }
        for (let offset = 0; offset < ready.length; offset += maxConcurrency) {
          const chunk = ready.slice(offset, offset + maxConcurrency);
          for (const task of chunk) pending.delete(task.id);
          await Promise.all(
            chunk.map(async (task) => {
              if (!members.has(task.member_name)) {
                await completeFailure(
                  task.id,
                  task.member_name,
                  `member not found: ${task.member_name}`,
                  "member_not_found",
                );
                return;
              }
              await runAssignment(task.id);
            }),
          );
        }
      }

      const finished = await plans.finalize(plan.id);
      const completedCount = results.filter((item) => item.status === "idle").length;
      const failedCount = results.filter((item) => item.status === "failed").length;
      const canceledCount = results.filter((item) => item.status === "canceled").length;
      const status =
        results.length > 0 && canceledCount === results.length
          ? "canceled"
          : failedCount > 0 || canceledCount > 0
            ? "partial_failed"
            : "completed";
      const firstError = results.find((item) => item.error_code !== "");
      const payload = {
        team: teamKey,
        status,
        parallel: results.length > 1,
        assignment_count: results.length,
        completed_count: completedCount,
        failed_count: failedCount,
        canceled_count: canceledCount,
        needs_review_count: 0,
        results,
        delivered_to: "leader",
        dynamic_plan_id: finished.id,
        plan_status: finished.status,
        usage: finished.budget,
        ...(firstError === undefined ? {} : { error_code: firstError.error_code }),
      };
      return okResult("team_delegate", renderValue(payload as unknown as JsonValue), {
        tool: "team_delegate",
        team: teamKey,
        status,
        assignment_count: results.length,
        completed_count: completedCount,
        failed_count: failedCount,
        canceled_count: canceledCount,
        dynamic_plan_id: finished.id,
        plan_status: finished.status,
        results: results as unknown as JsonValue,
        ...(firstError === undefined ? {} : { error_code: firstError.error_code }),
      });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      const code = delegateErrorCode(message);
      if (code === "team_not_found") {
        return delegateFail(
          `${message}. The restored conversation references stale team state; ` +
            "call team_create to recreate the team before calling team_delegate.",
          code,
        );
      }
      return delegateFail(message, code);
    }
  }

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
      async execute(args, api) {
        try {
          const team = await teamStore(api).create(args.name ?? "", args.description ?? "", args.members);
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
      async execute(args, api) {
        try {
          const result = await teamStore(api).delete(args.name ?? "", args.force === true);
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
      async execute(_args, api) {
        try {
          const teams = await teamStore(api).list();
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
      async execute(args, api) {
        try {
          const status = await teamStore(api).status(args.name ?? "");
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
      async execute(args, api) {
        try {
          const result = await teamStore(api).sendMessage(
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
      async execute(args, api) {
        try {
          const teamName = String(args.team_name ?? "").trim();
          const assignments = args.assignments ?? [];
          if (!teamName || !Array.isArray(assignments)) {
            throw new WorkspaceTeamError("team_plan_create requires team_name and assignments");
          }
          const plan = await planStore(api).create(teamName, String(args.goal || "团队动态协作").slice(0, 4000), assignments);
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
    makeAppTool<TeamDelegateArgs>({
      name: "team_delegate",
      description:
        "Delegate bounded reasoning tasks to named team members. Each assignment runs in its own child conversation " +
        "with only the allowed read-only tools, and returns the member's Markdown result, usage, and child conversation id. " +
        "Members consume unread mailbox messages and write the result back to the leader mailbox. " +
        "Pass 1-8 assignments with dependencies, or a plan_id returned by team_plan_create. " +
        "Use this instead of repeated single-agent delegation when teams are enabled.",
      parameters: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          goal: { type: "string", description: "Bounded overall goal recorded on the dynamic plan." },
          plan_id: {
            type: "string",
            description: "Existing planned dynamic plan id to execute after explicit confirmation.",
          },
          member_name: {
            type: "string",
            description: "Single-member convenience target; use assignments for multiple members.",
          },
          prompt: { type: "string", description: "Single-member convenience prompt." },
          description: { type: "string" },
          allowed_tools: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional allowlist for every member; it can only narrow the bounded read-only default set.",
          },
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
                allowed_tools: { type: "array", items: { type: "string" } },
              },
              required: ["member_name", "prompt"],
            },
          },
          timeout_seconds: {
            type: "integer",
            minimum: 10,
            maximum: 300,
            description: "Per-member timeout. Default 300.",
          },
          max_concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description: "Parallel member conversations. Default is the assignment count, capped at 6.",
          },
        },
        required: ["team_name"],
      },
      replay: "unsafe",
      async execute(args, api) {
        return await executeTeamDelegate(args, api);
      },
    }),
  ];
}
