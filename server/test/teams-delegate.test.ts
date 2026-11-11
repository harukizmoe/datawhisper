/**
 * P5.3：`team_delegate` 真的开子会话跑成员。
 *
 * 用 stub 模型起真实服务，覆盖：成功拿到正文/用量/子会话 id、成员工具收敛（越权工具被拒）、
 * 取消正在跑的委托（真的 abort 子会话）、团队视图里的子会话与用量、未知团队/成员的文案。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { afterEach as restoreLanguage, beforeEach as useChinese } from "bun:test";
import { setLanguage } from "../src/i18n.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolHooks,
  type ToolRegistration,
  type ConversationId,
  type HookApi,
} from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { type Service, startService } from "../src/service.ts";
import {
  APP_TOOL_NAMES,
  createMemoryDocHost,
  initialPlanStore,
  initialTaskBoard,
  initialTeamStore,
  NodeWorkspaceFs,
  type AppToolDetails,
  type AppToolDeps,
  type TeamDelegationPort,
} from "../src/tools/app/index.ts";
import { createTeamTools, WorkspaceTeamStore } from "../src/tools/app/teams.ts";
import type { PlanStoreDoc, TeamStoreDoc } from "../src/tools/app/docs.ts";
import {
  createTeamDelegateService,
  TEAM_DELEGATE_DOC,
  teamDelegationGuard,
  type TeamDelegationService,
} from "../src/teams/delegate.ts";
import type { ProviderSettings } from "../src/models/service.ts";
import { type Stub, startStub } from "./support/stub-openai.ts";
import { stubProvider } from "./support/stub-models.ts";

let service: Service;
let fastStub: Stub;
let slowStub: Stub;
let dir: string;
let tools: ToolRegistration[];
let teamDocs: ReturnType<typeof createMemoryDocHost<TeamStoreDoc>>;
let planDocs: ReturnType<typeof createMemoryDocHost<PlanStoreDoc>>;
let delegation: TeamDelegationService;
const aborted: number[] = [];
let writeCalls = 0;
const slowWaiters: (() => void)[] = [];

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
  const first = result.output?.[0];
  return first !== undefined && first.type === "text" ? (first.text ?? "") : "";
}

function byName(name: string): ToolRegistration {
  const tool = tools.find((item) => item.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

function run(name: string, args: object = {}, conversationId = 0) {
  const api = { conversationId } as unknown as ToolExecutionApi<AppToolDetails>;
  return byName(name).execute(args, api, BACKGROUND_CONTEXT);
}

let teamSeq = 0;
function uniqueTeam(): string {
  teamSeq += 1;
  return `团队_${teamSeq}`;
}

async function createTeam(name: string, members: { name: string; role?: string; instructions?: string }[]) {
  const result = await run("team_create", { name, members });
  expect(result.isError).toBeUndefined();
  return result;
}

async function teamStatus(name: string) {
  return JSON.parse(textOf(await run("team_status", { name }))) as {
    members: {
      name: string;
      status: string;
      last_conversation_id: number | null;
      last_conversation_title: string;
      last_usage: { input_tokens: number; output_tokens: number; tool_calls: number };
    }[];
    recent_messages: {
      recipient: string;
      message_type: string;
      conversation_id?: number;
      usage?: { input_tokens: number };
    }[];
    sub_conversations: {
      conversation_id: number;
      member_name: string;
      title: string;
      status: string;
      usage: { input_tokens: number; output_tokens: number; tool_calls: number };
    }[];
    usage: { input_tokens: number; output_tokens: number; tool_calls: number };
  };
}

const queryData: ToolRegistration = defineTool({
  name: "query_data",
  description: "Return a fixed row count. (test double)",
  parameters: { type: "object", properties: { sql: { type: "string" } } },
  replay: "safe",
  async execute() {
    return { output: [{ type: "text", text: '{"rows":42,"total":1234}' }] };
  },
});

const writeFile: ToolRegistration = defineTool({
  name: "workspace_write_file",
  description: "Write a workspace file. (test double, must never run in a delegated session)",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  replay: "unsafe",
  async execute() {
    writeCalls += 1;
    return { output: [{ type: "text", text: "written" }] };
  },
});

// 这个文件断言的是旧实现的中文文案（golden 或沿用旧文案的用例），所以按中文跑；英文输出另见 i18n 用例。
useChinese(() => setLanguage("zh"));
restoreLanguage(() => setLanguage("en"));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dw-teams-delegate-"));
  fastStub = startStub({ chunkDelayMs: 0 });
  slowStub = startStub({
    chunkDelayMs: 30,
    onRequest: () => {
      slowWaiters.shift()?.();
    },
  });

  let port: TeamDelegationPort | undefined;
  const docs = {
    tasks: createMemoryDocHost(initialTaskBoard()),
    teams: createMemoryDocHost(initialTeamStore()),
    plans: createMemoryDocHost(initialPlanStore()),
  };
  teamDocs = docs.teams;
  planDocs = docs.plans;
  const deps: AppToolDeps = {
    workspace: new NodeWorkspaceFs({ dataRoot: dir }),
    // 文档按会话现取；测试里一个会话固定用同一份内存文档。
    docs: () => docs,
    sessionId: "teams-delegate-test",
    teamDelegate: {
      run: (request) => {
        if (port === undefined) throw new Error("delegation port not wired");
        return port.run(request);
      },
      cancel: (teamName, memberName) => (port === undefined ? Promise.resolve(0) : port.cancel(teamName, memberName)),
      active: () => port?.active() ?? [],
    },
  };
  tools = [
    ...createTeamTools(deps),
    queryData,
    writeFile,
  ];

  service = await startService(loadConfig({ DW_DATA_DIR: dir }), {
    forceFileCredentials: true,
    tools,
  });
  await service.modelService.putProvider(stubProvider(fastStub.url));
  // stubProvider 返回自定义 provider 的联合类型；测试里断言它确实是 custom，再换 id/端口。
  const slowBase = stubProvider(slowStub.url) as Extract<ProviderSettings, { kind: "custom" }>;
  const slowProvider: ProviderSettings = { ...slowBase, id: "custom-slow", name: "Stub Slow" };
  await service.modelService.putProvider(slowProvider);
  await service.modelService.setDefault({ provider: "custom-stub", modelId: "stub-chat" }, null);

  delegation = createTeamDelegateService({
    harness: service.harness,
    context: service.context,
    conversations: {
      create: (body) => service.conversations.create(body),
      abort: async (id) => {
        aborted.push(Number(id));
        return await service.conversations.abort(id);
      },
    },
  });
  port = delegation;
});

afterAll(async () => {
  await service?.stop();
  fastStub?.stop();
  slowStub?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("team_delegate", () => {
  test("工具已注册，并真的跑出一个子会话（正文、用量、会话 id 都回到团队视图）", async () => {
    expect(APP_TOOL_NAMES).toContain("team_delegate");
    expect(tools.map((tool) => tool.name)).toContain("team_delegate");

    const team = uniqueTeam();
    await createTeam(team, [{ name: "分析师", role: "analyst", instructions: "只用 query_data 查数。" }]);
    const parent = await service.conversations.create({});

    const result = await run(
      "team_delegate",
      {
        team_name: team,
        goal: "核对一次指标",
        assignments: [
          {
            task_id: "t1",
            member_name: "分析师",
            prompt: "CALL:query_data 请核对订单数。",
            description: "订单数核对",
            allowed_tools: ["query_data"],
          },
        ],
      },
      parent.id,
    );
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(textOf(result)) as {
      status: string;
      assignment_count: number;
      completed_count: number;
      dynamic_plan_id: string;
      results: {
        task_id: string;
        member: string;
        status: string;
        result: string;
        tool_count: number;
        conversation_id: number;
        conversation_title: string;
        usage: { input_tokens: number; output_tokens: number; tool_calls: number };
      }[];
    };
    expect(payload.status).toBe("completed");
    expect(payload.assignment_count).toBe(1);
    expect(payload.completed_count).toBe(1);
    expect(payload.dynamic_plan_id.startsWith("tp_")).toBe(true);
    const item = payload.results[0]!;
    expect(item.member).toBe("分析师");
    expect(item.status).toBe("idle");
    expect(item.tool_count).toBe(1);
    expect(item.result).toContain("tool returned");
    expect(item.conversation_id).toBeGreaterThan(0);
    expect(item.conversation_title).toContain("分析师");
    expect(item.usage.input_tokens).toBeGreaterThan(0);
    expect(item.usage.output_tokens).toBeGreaterThan(0);
    expect(item.usage.tool_calls).toBe(1);

    // 子会话元数据：标题与成员一眼可见。
    const meta = await service.harness.snapshot(
      TEAM_DELEGATE_DOC,
      item.conversation_id as ConversationId,
      service.context,
    );
    expect(meta?.team_name).toBe(team);
    expect(meta?.member_name).toBe("分析师");
    expect(meta?.title).toContain("分析师");
    expect(meta?.status).toBe("completed");
    expect(meta?.allowed_tools).toEqual(["query_data"]);
    expect(meta?.usage.input_tokens).toBe(item.usage.input_tokens);

    // 团队视图：成员最近一次调用、子会话列表、累计用量、结果邮件都指向同一个子会话。
    const status = await teamStatus(team);
    const member = status.members.find((entry) => entry.name === "分析师")!;
    expect(member.status).toBe("idle");
    expect(member.last_conversation_id).toBe(item.conversation_id);
    expect(member.last_conversation_title).toBe(item.conversation_title);
    expect(member.last_usage.input_tokens).toBe(item.usage.input_tokens);
    expect(status.sub_conversations).toHaveLength(1);
    expect(status.sub_conversations[0]!.conversation_id).toBe(item.conversation_id);
    expect(status.sub_conversations[0]!.member_name).toBe("分析师");
    expect(status.sub_conversations[0]!.title).toContain("分析师");
    expect(status.sub_conversations[0]!.usage.tool_calls).toBe(1);
    expect(status.usage.input_tokens).toBe(item.usage.input_tokens);
    expect(status.usage.tool_calls).toBe(1);
    const resultMessage = status.recent_messages.find((message) => message.message_type === "result")!;
    expect(resultMessage.conversation_id).toBe(item.conversation_id);
    expect(resultMessage.usage?.input_tokens).toBe(item.usage.input_tokens);
  });

  test("成员只看到 allowed_tools；越权工具调用被拒且没有真的执行", async () => {
    const team = uniqueTeam();
    await createTeam(team, [{ name: "越权测试员", role: "analyst" }]);
    const beforeWrites = writeCalls;
    const slowLogsBefore = fastStub.log.length;

    const result = await run("team_delegate", {
      team_name: team,
      assignments: [
        {
          member_name: "越权测试员",
          prompt: 'CALL:workspace_write_file{"path":"secret.txt"} 请改写源表。',
          description: "越权尝试",
          allowed_tools: ["query_data"],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(textOf(result)) as {
      results: {
        status: string;
        tool_count: number;
        conversation_id: number;
        usage: { tool_calls: number };
      }[];
    };
    const item = payload.results[0]!;
    expect(item.tool_count).toBe(1);
    expect(item.usage.tool_calls).toBe(1);
    expect(item.status).toBe("idle");
    // 越权工具根本没被调用。
    expect(writeCalls).toBe(beforeWrites);

    // 子会话的请求里只提供了 query_data，没有 workspace_write_file。
    const childRequest = fastStub.log
      .slice(slowLogsBefore)
      .find((request) => request.lastUser.includes("workspace_write_file"));
    expect(childRequest).toBeDefined();
    expect(childRequest!.tools).toEqual(["query_data"]);

    // 守卫在运行时也会拦下同名调用（文本形式调用、嵌套调用绕路时）。
    const meta = await service.harness.snapshot(
      TEAM_DELEGATE_DOC,
      item.conversation_id as ConversationId,
      service.context,
    );
    const handlers = teamDelegationGuard().hooks?.[0]?.handlers as ToolHooks;
    const guardApi = {
      conversationId: item.conversation_id,
      snapshot: async () => ({ ...meta!, status: "running" as const, allowed_tools: ["query_data"] }),
    } as unknown as HookApi;
    const blocked = await handlers.beforeTool(
      { type: "toolCall", id: "call_guard", name: "workspace_write_file", arguments: { path: "x" } },
      guardApi,
      BACKGROUND_CONTEXT,
    );
    expect(blocked?.block).toContain("not allowed");
    const allowed = await handlers.beforeTool(
      { type: "toolCall", id: "call_guard_ok", name: "query_data", arguments: {} },
      guardApi,
      BACKGROUND_CONTEXT,
    );
    expect(allowed).toBeUndefined();
  });

  test("取消正在跑的委托会真的 abort 子会话", async () => {
    const team = uniqueTeam();
    await createTeam(team, [{ name: "慢速分析师", role: "analyst" }]);
    const parent = await service.conversations.create({ model: { provider: "custom-slow", modelId: "stub-chat" } });
    const abortedBefore = aborted.length;
    const requestSeen = Promise.withResolvers<void>();
    slowWaiters.push(requestSeen.resolve);

    const pending = run(
      "team_delegate",
      {
        team_name: team,
        assignments: [
          {
            member_name: "慢速分析师",
            prompt: "请写一份很长的分析结论。",
            description: "慢速任务",
            allowed_tools: ["query_data"],
          },
        ],
      },
      parent.id,
    );

    // 子会话的请求已经到达模型，说明这一轮真的在跑；此时取消必须 abort 子会话。
    await requestSeen.promise;
    const running = delegation.active().find((item) => item.team_name === team);
    if (running === undefined) throw new Error("delegation is not active");
    expect(running.conversation_id).toBeGreaterThan(0);
    const canceled = await delegation.cancel(team, "慢速分析师");
    expect(canceled).toBe(1);

    const result = await pending;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(textOf(result)) as {
      status: string;
      canceled_count: number;
      results: { status: string; error: string; conversation_id: number }[];
    };
    expect(payload.status).toBe("canceled");
    expect(payload.canceled_count).toBe(1);
    const item = payload.results[0]!;
    expect(item.status).toBe("canceled");
    expect(item.error).toContain("取消");
    expect(item.conversation_id).toBe(running.conversation_id);
    expect(aborted.slice(abortedBefore)).toContain(item.conversation_id);

    const status = await teamStatus(team);
    const member = status.members.find((entry) => entry.name === "慢速分析师")!;
    expect(member.status).toBe("failed");
    expect(status.sub_conversations.at(-1)!.status).toBe("canceled");
  });

  test("未知团队/未知成员的文案与旧实现一致", async () => {
    const missingTeam = await run("team_delegate", {
      team_name: "不存在的团队",
      assignments: [{ member_name: "分析师", prompt: "做事" }],
    });
    expect(missingTeam.isError).toBe(true);
    expect(textOf(missingTeam)).toContain("team not found: 不存在的团队");
    expect(textOf(missingTeam)).toContain("team_create");

    const team = uniqueTeam();
    await createTeam(team, [{ name: "分析师" }]);
    const missingMember = await run("team_delegate", {
      team_name: team,
      assignments: [{ member_name: "临时工", prompt: "做事" }],
    });
    expect(missingMember.isError).toBeUndefined();
    const payload = JSON.parse(textOf(missingMember)) as {
      status: string;
      failed_count: number;
      results: { status: string; error: string; error_code: string; conversation_id: number }[];
    };
    expect(payload.status).toBe("partial_failed");
    expect(payload.failed_count).toBe(1);
    expect(payload.results[0]!.status).toBe("failed");
    expect(payload.results[0]!.error).toContain("member not found: 临时工");
    expect(payload.results[0]!.error_code).toBe("member_not_found");
    expect(payload.results[0]!.conversation_id).toBe(0);
  });

  test("team_plan_create 的计划可以按 plan_id 执行，任务与用量写回计划", async () => {
    const team = uniqueTeam();
    await createTeam(team, [{ name: "计划执行员", role: "analyst" }]);
    const created = JSON.parse(
      textOf(
        await run("team_plan_create", {
          team_name: team,
          goal: "两段独立分析",
          assignments: [
            { task_id: "first", member_name: "计划执行员", prompt: "CALL:query_data 第一段", description: "第一段" },
            { task_id: "second", member_name: "计划执行员", prompt: "第二段", description: "第二段", depends_on: ["first"] },
          ],
        }),
      ),
    ) as { plan: { id: string; status: string } };
    expect(created.plan.status).toBe("planned");

    const result = await run("team_delegate", {
      team_name: team,
      plan_id: created.plan.id,
      allowed_tools: ["query_data"],
    });
    const payload = JSON.parse(textOf(result)) as {
      status: string;
      completed_count: number;
      dynamic_plan_id: string;
      plan_status: string;
      results: { task_id: string; status: string; usage: { input_tokens: number } }[];
    };
    expect(payload.dynamic_plan_id).toBe(created.plan.id);
    expect(payload.status).toBe("completed");
    expect(payload.plan_status).toBe("completed");
    expect(payload.completed_count).toBe(2);
    expect(payload.results.map((item) => item.task_id)).toEqual(["first", "second"]);
    expect(payload.results.every((item) => item.status === "idle" && item.usage.input_tokens > 0)).toBe(true);

    // 计划文档里的任务状态与预算也更新了。
    const plans = planDocs.peek();
    const plan = plans.plans.find((item) => item.id === created.plan.id);
    expect(plan?.status).toBe("completed");
    expect(plan?.tasks.map((task) => task.status)).toEqual(["completed", "completed"]);
    expect(plan!.budget.input_tokens).toBeGreaterThan(0);
    expect(plan!.budget.tool_calls).toBe(1);
  });
});

// 单独验证团队存储的 fencing 不会把完成后的成员又标回失败。
test("团队存储能按成员取到最近一次子会话", async () => {
  const team = uniqueTeam();
  await createTeam(team, [{ name: "存储测试员" }]);
  const store = new WorkspaceTeamStore(teamDocs);
  const member = await store.member(team, "存储测试员");
  expect(member.name).toBe("存储测试员");
});
