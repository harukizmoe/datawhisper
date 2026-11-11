import { describe, expect, test } from "bun:test";
import golden from "./golden/exposure.json";
import {
  completedToolNames,
  DISCOVERED_TOOL_TTL_TURNS,
  discoverToolNamesForQuery,
  ESSENTIAL_TOOL_NAMES,
  FEISHU_TOOLS,
  filterToolsForStage,
  filterToolsForTurn,
  inferWorkflowStage,
  limitToolsForTurn,
  looksLikeWorkspaceFileReadRequest,
  MAX_ACTIVE_DISCOVERED_TOOLS,
  MAX_VISIBLE_TOOLS,
  recordDiscoveredToolTurn,
  restoreDiscoveredToolState,
  scopeToolResultReader,
  TASK_TOOLS,
  TEAM_TOOLS,
  toolName,
  WORKFLOW_TOOLS,
  type ActivationContext,
  type DiscoveredToolState,
  type ToolSchema,
} from "../src/tools/exposure.ts";

type ActivationJson = { skillName: string; commandName: string; internalAction: string };

type CaseInput = {
  id: string;
  toolSet: string;
  message: string;
  command: string;
  activation: ActivationJson | null;
  trustedSkill: string;
  skillAllowedTools: string[] | null;
  hasDataSource: boolean;
  hasWorkspace: boolean;
  teamsEnabled: boolean;
  includeMcp: boolean;
  allowedMcpTools: string[] | null;
  allowedArtifacts: { artifact_id?: string }[] | null;
  discoveredTools: string[] | null;
  stage: { needsChart: boolean; needsOutput: boolean; completedTools: string[] };
  recentDiscoveredTools: string[] | null;
  requiredTools: string[] | null;
  maxTools: number | null;
};

type Expected = {
  discovered: string[];
  filtered: string[];
  stage: string;
  staged: string[];
  scoped: string[];
  readToolResultEnum: string[] | null;
  limited: string[];
};

type Case = CaseInput & { expected: Expected };

type Golden = {
  maxVisibleTools: number;
  discoveredToolTtlTurns: number;
  maxActiveDiscoveredTools: number;
  essentialTools: string[];
  teamTools: string[];
  taskTools: string[];
  workflowTools: string[];
  feishuTools: string[];
  toolSets: Record<string, string[]>;
  cases: Case[];
  discovery: { message: string; names: string[] }[];
  ttl: { id: string; inputs: { message: string; isCommand: boolean }[]; after: { discovered: string[]; turns: string[][]; added: string[] }[] }[];
  restore: { id: string; rawTurns: unknown[] | null; legacyDiscovered: unknown[] | null; expected: { discovered: string[]; turns: string[][] } }[];
};

const data = golden as unknown as Golden;

function schemas(names: readonly string[]): ToolSchema[] {
  return names.map((name) => ({ type: "function", function: { name } }));
}

function namesOf(tools: readonly ToolSchema[]): string[] {
  return tools.map(toolName);
}

function activationOf(raw: ActivationJson | null): ActivationContext | null {
  if (raw === null) return null;
  return { skillName: raw.skillName, commandName: raw.commandName, internalAction: raw.internalAction };
}

function runCase(input: CaseInput): Expected {
  const activation = activationOf(input.activation);
  const filtered = filterToolsForTurn(schemas(data.toolSets[input.toolSet]!), {
    command: input.command,
    activation,
    skillAllowedTools: input.skillAllowedTools === null ? null : new Set(input.skillAllowedTools),
    trustedSkill: input.trustedSkill,
    userMessage: input.message,
    discoveredTools: input.discoveredTools,
    hasDataSource: input.hasDataSource,
    hasWorkspace: input.hasWorkspace,
    teamsEnabled: input.teamsEnabled,
    includeMcp: input.includeMcp,
    allowedMcpTools: input.allowedMcpTools,
  });
  const stage = inferWorkflowStage({
    activation,
    userMessage: input.message,
    hasDataSource: input.hasDataSource,
    needsChart: input.stage.needsChart,
    needsOutput: input.stage.needsOutput,
    completedTools: input.stage.completedTools,
  });
  const staged = filterToolsForStage(filtered, stage);
  const scoped = scopeToolResultReader(staged, input.allowedArtifacts);
  const limited = limitToolsForTurn(scoped, {
    userMessage: input.message,
    recentDiscoveredTools: input.recentDiscoveredTools,
    command: input.command,
    trustedSkill: input.trustedSkill,
    requiredTools: input.requiredTools === null ? null : new Set(input.requiredTools),
    maxTools: input.maxTools,
  });
  const readToolResult = scoped.find((schema) => toolName(schema) === "read_tool_result");
  const artifactParam = readToolResult?.function.parameters?.properties?.artifact_id as { enum?: string[] } | undefined;
  return {
    discovered: [...discoverToolNamesForQuery(input.message)].sort(),
    filtered: namesOf(filtered),
    stage: stage.stage,
    staged: namesOf(staged),
    scoped: namesOf(scoped),
    readToolResultEnum: artifactParam?.enum ?? null,
    limited: namesOf(limited),
  };
}

function diff(got: Expected, expected: Expected): string[] {
  return (Object.keys(expected) as (keyof Expected)[])
    .filter((key) => JSON.stringify(got[key]) !== JSON.stringify(expected[key]))
    .map((key) => `${key}: want ${JSON.stringify(expected[key])} got ${JSON.stringify(got[key])}`);
}

describe("exposure golden matrix", () => {
  test("covers every command and skill axis with at least 120 messages", () => {
    expect(data.cases.length).toBeGreaterThanOrEqual(120);
    const messages = new Set(data.cases.map((item) => item.message));
    expect(messages.size).toBeGreaterThanOrEqual(120);
    for (const command of [
      "checkpoint", "clear", "compact", "data", "help", "instruction", "jobs", "knowledge",
      "mcp", "new", "robot", "sessions", "skills", "status", "stop", "teams", "workspace",
    ]) {
      expect(data.cases.some((item) => item.command === command && item.id.startsWith("cmd-"))).toBe(true);
    }
    for (const skill of ["export", "report", "ppt", "dashboard"]) {
      expect(data.cases.some((item) => item.trustedSkill === skill)).toBe(true);
    }
  });

  test("reproduces every Python pipeline result exactly", () => {
    // 期望值来自 Python 流水线（scripts/golden/export_exposure.py）。
    const failures = data.cases.flatMap((item) => {
      const problems = diff(runCase(item), item.expected);
      return problems.length === 0 ? [] : [`${item.id}: ${problems.join(" | ")}`];
    });
    expect(failures).toEqual([]);
  });

  test("exercises the cap, every inferred stage, and the artifact reader rule", () => {
    const stages = new Set(data.cases.map((item) => item.expected.stage));
    expect([...stages].sort()).toEqual(
      ["analyze", "general", "generate_output", "inspect", "propose_output", "verify", "visualize"],
    );
    expect(data.cases.some((item) => item.expected.staged.length > MAX_VISIBLE_TOOLS && item.expected.limited.length === MAX_VISIBLE_TOOLS)).toBe(true);
    expect(data.cases.some((item) => item.expected.filtered.includes("read_tool_result") && !item.expected.scoped.includes("read_tool_result"))).toBe(true);
    expect(data.cases.some((item) => (item.expected.readToolResultEnum?.length ?? 0) === 20)).toBe(true);
  });
});

describe("discoverToolNamesForQuery", () => {
  test("matches Python for every corpus message", () => {
    const failures = data.discovery.flatMap((item) => {
      const got = [...discoverToolNamesForQuery(item.message)].sort();
      return JSON.stringify(got) === JSON.stringify(item.names) ? [] : [`${JSON.stringify(item.message)}: want ${JSON.stringify(item.names)} got ${JSON.stringify(got)}`];
    });
    expect(failures).toEqual([]);
    expect(data.discovery.length).toBeGreaterThanOrEqual(120);
  });

  test("empty and whitespace-only queries discover nothing", () => {
    expect(discoverToolNamesForQuery("")).toEqual(new Set());
    expect(discoverToolNamesForQuery("   ")).toEqual(new Set());
    expect(looksLikeWorkspaceFileReadRequest("")).toBe(false);
    expect(looksLikeWorkspaceFileReadRequest("打开文件")).toBe(true);
    expect(looksLikeWorkspaceFileReadRequest("report.docx")).toBe(true);
  });

  test("capability context resolves lexical collisions", () => {
    expect(discoverToolNamesForQuery("搜索文件里的 TODO")).toContain("workspace_grep");
    expect(discoverToolNamesForQuery("搜索文件里的 TODO").has("browser_search")).toBe(false);
    expect(discoverToolNamesForQuery("搜索一下网页").has("browser_search")).toBe(true);
    expect(discoverToolNamesForQuery("搜索一下网页").has("workspace_grep")).toBe(false);
    expect(discoverToolNamesForQuery("打开 https://example.com 总结一下").has("browser_navigate")).toBe(false);
    expect([...discoverToolNamesForQuery("画一个商业模式画布")].filter((name) => name.includes("diagram"))).toEqual(["display_diagram"]);
    expect([...discoverToolNamesForQuery("修改画布")].filter((name) => name.includes("diagram")).sort()).toEqual([
      "edit_diagram",
      "get_diagram",
    ]);
    expect([...discoverToolNamesForQuery("查看画布")].filter((name) => name.includes("diagram"))).toEqual(["get_diagram"]);
    // "价值主张" 能匹配某个 diagram 工具，但匹配不上强 diagram 正则：所有 diagram 工具都被丢弃。
    expect([...discoverToolNamesForQuery("价值主张")].filter((name) => name.includes("diagram"))).toEqual([]);
  });
});

describe("discovery TTL state", () => {
  test("record_discovered_tools keeps three turns and an LRU view", () => {
    for (const sequence of data.ttl) {
      let state: DiscoveredToolState = { discovered: [], turns: [] };
      sequence.inputs.forEach((input, index) => {
        const result = recordDiscoveredToolTurn(state, input.isCommand ? "" : input.message);
        state = result.state;
        expect({ id: sequence.id, turn: index, discovered: [...state.discovered], turns: state.turns.map((turn) => [...turn]), added: result.added }).toEqual({
          id: sequence.id,
          turn: index,
          discovered: sequence.after[index]!.discovered,
          turns: sequence.after[index]!.turns,
          added: sequence.after[index]!.added,
        });
      });
    }
    expect(DISCOVERED_TOOL_TTL_TURNS).toBe(data.discoveredToolTtlTurns);
    expect(MAX_ACTIVE_DISCOVERED_TOOLS).toBe(data.maxActiveDiscoveredTools);
  });

  test("restore prefers per-turn history over the legacy flat list", () => {
    for (const item of data.restore) {
      const state = restoreDiscoveredToolState(item.rawTurns, item.legacyDiscovered);
      expect({ id: item.id, discovered: [...state.discovered], turns: state.turns.map((turn) => [...turn]) }).toEqual({
        id: item.id,
        discovered: item.expected.discovered,
        turns: item.expected.turns,
      });
    }
  });

  test("a rediscovery moves a tool to the most-recent end", () => {
    const first = recordDiscoveredToolTurn({ discovered: [], turns: [] }, "打开文件 a.md");
    const second = recordDiscoveredToolTurn(first.state, "打开说明文档");
    expect(second.state.discovered).toEqual(["workspace_glob", "workspace_read_file"]);
    expect(second.state.turns.at(-1)).toEqual(["workspace_read_file"]);
    expect(second.added).toEqual([]);
  });
});

describe("exposure constants and stage helpers", () => {
  test("constants match Python", () => {
    expect(MAX_VISIBLE_TOOLS).toBe(data.maxVisibleTools);
    expect([...ESSENTIAL_TOOL_NAMES].sort()).toEqual(data.essentialTools);
    expect([...TEAM_TOOLS].sort()).toEqual(data.teamTools);
    expect([...TASK_TOOLS].sort()).toEqual(data.taskTools);
    expect([...WORKFLOW_TOOLS].sort()).toEqual(data.workflowTools);
    expect([...FEISHU_TOOLS].sort()).toEqual(data.feishuTools);
  });

  test("completedToolNames reads assistant calls only", () => {
    expect(
      [...completedToolNames([
        { role: "assistant", tool_calls: [{ function: { name: "query_data" } }, { function: { name: " get_schema " } }, { function: { name: "" } }] },
        { role: "tool", tool_calls: [{ function: { name: "run_analysis" } }] },
        { role: "assistant" },
      ])],
    ).toEqual(["query_data", "get_schema"]);
  });

  test("_confirm internal actions jump straight to generate_output", () => {
    expect(inferWorkflowStage({ activation: { internalAction: "excel_confirm" }, needsChart: true, needsOutput: false })).toEqual({
      stage: "generate_output",
      needsChart: true,
      needsOutput: true,
    });
    expect(inferWorkflowStage({ completedTools: ["generate_ppt"], needsOutput: false }).stage).toBe("verify");
  });
});

describe("visibility cap priority", () => {
  const wide = schemas([
    "query_data", "workspace_status", "ask_user", "browser_click", "generate_chart",
    "select_chart", "memory_read", "task_list", "team_status", "workflow_list",
    "display_diagram", "set_ppt_color_scheme", "profile_data", "clean_data",
    "workspace_grep", "workspace_glob", "configure_hooks", "read_tool_result",
    "search_mcp_tools", "query_knowledge", "get_schema", "get_table_detail",
    "run_analysis", "load_analysis_skill", "structured_output",
  ]);

  test("current intent and essentials outrank generic default-exposed tools", () => {
    const limited = limitToolsForTurn(wide, { userMessage: "清洗数据", maxTools: 5 }).map(toolName);
    expect(limited).toContain("clean_data");
    expect(limited.filter((name) => ESSENTIAL_TOOL_NAMES.has(name)).length).toBeGreaterThan(0);
    expect(limited.length).toBe(5);
    const order = wide.map(toolName).filter((name) => limited.includes(name));
    expect(limited).toEqual(order);
  });

  test("required tools always survive, MCP ranks just below them", () => {
    const withMcp = schemas([...namesOf(wide), "mcp__github__search_code"]);
    const limited = limitToolsForTurn(withMcp, {
      userMessage: "你好",
      requiredTools: new Set(["configure_hooks"]),
      maxTools: 3,
    }).map(toolName);
    // 按分数选择；返回的列表保持规范的输入顺序。
    expect(limited).toEqual(["query_data", "configure_hooks", "mcp__github__search_code"]);
  });

  test("maxTools 0 falls back to the default cap instead of hiding everything", () => {
    expect(limitToolsForTurn(wide, { maxTools: 0 }).length).toBe(MAX_VISIBLE_TOOLS);
    expect(limitToolsForTurn(wide, { maxTools: 1 }).length).toBe(1);
  });
});

describe("filterToolsForTurn contracts", () => {
  const tools = schemas(["ask_user", "read_tool_result", "workspace_bash", "generate_ppt"]);

  test("returns copies so callers cannot mutate the shared schemas", () => {
    const filtered = filterToolsForTurn(tools, {});
    filtered[0]!.function.description = "changed";
    expect(tools[0]!.function.description).toBeUndefined();
  });

  test("an empty skillAllowedTools means no restriction, like Python truthiness", () => {
    expect(namesOf(filterToolsForTurn(tools, { skillAllowedTools: new Set() }))).toEqual(
      namesOf(filterToolsForTurn(tools, {})),
    );
    expect(namesOf(filterToolsForTurn(tools, { skillAllowedTools: new Set(["ask_user"]) }))).toEqual(["ask_user"]);
  });

  test("MCP schemas need both a selection and the skill restriction", () => {
    const mcp = schemas(["mcp__github__search_code", "mcp__linear__list_issues"]);
    expect(namesOf(filterToolsForTurn(mcp, { allowedMcpTools: ["mcp__github__search_code"] }))).toEqual([
      "mcp__github__search_code",
    ]);
    expect(namesOf(filterToolsForTurn(mcp, { includeMcp: false, allowedMcpTools: ["mcp__github__search_code"] }))).toEqual([]);
    expect(
      namesOf(filterToolsForTurn(mcp, {
        allowedMcpTools: ["mcp__github__search_code"],
        skillAllowedTools: new Set(["mcp__linear__list_issues"]),
      })),
    ).toEqual([]);
  });

  test("activation overrides the raw command for policy and suppresses discovery", () => {
    expect(namesOf(filterToolsForTurn(schemas(["generate_ppt"]), { activation: { internalAction: "ppt_confirm" } }))).toEqual(["generate_ppt"]);
    expect(namesOf(filterToolsForTurn(schemas(["workspace_read_file"]), { command: "status", userMessage: "打开文件 a.md" }))).toEqual([]);
    expect(namesOf(filterToolsForTurn(schemas(["workspace_read_file"]), { userMessage: "打开文件 a.md" }))).toEqual(["workspace_read_file"]);
  });
});
