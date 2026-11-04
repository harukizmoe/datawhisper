/**
 * 交互/控制类工具：ask_user、structured_output、plan_complete、load_analysis_skill、
 * search_mcp_tools。
 *
 * ask_user/structured_output 不阻塞：它们把结构化请求放在 `details` 里交回调用方
 * （界面弹卡片），模型文本沿用旧实现的“等待用户”文案。
 */

import type { JsonValue } from "@earendil-works/chord";
import { BUILTIN_TOOL_REGISTRY } from "../registry.ts";
import { activateSkill, getSkill, type SkillDirs } from "../../agent/skills.ts";
import { errorResult, makeAppTool, okResult, renderValue, type AppTool, type AppToolDeps } from "./types.ts";
import { searchMcpCatalog } from "./mcp.ts";

const ASK_USER_EMPTY_OPTIONS = "ASKU-001";
const ASK_USER_OPTION_COUNT = "ASKU-002";
const ASK_USER_INVALID_ARGUMENT = "ASKU-003";

type AskUserArgs = { question: string; options: JsonValue; multi_select?: boolean };

/** `normalize_ask_user_args`：接受对象形式的 option，去空、去重、最多 6 个。 */
function normalizeAskUser(args: AskUserArgs): { question: string; options: string[] } {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  const options: string[] = [];
  if (Array.isArray(args.options)) {
    for (const raw of args.options) {
      let text: string | undefined;
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const record = raw as Record<string, JsonValue>;
        for (const key of ["label", "text", "title", "name", "value"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) {
            text = value;
            break;
          }
        }
      } else if (typeof raw === "string") {
        text = raw;
      }
      if (text === undefined) continue;
      const clean = text.trim();
      if (clean && !options.includes(clean)) options.push(clean);
      if (options.length === 6) break;
    }
  }
  return { question, options };
}

/** `validate_ask_user_args` 的稳定错误码与文案。 */
function validateAskUser(question: string, options: readonly string[], rawOptions: JsonValue): string | undefined {
  if (!question.trim()) {
    return (
      "'ask_user' requires a non-empty string 'question' " +
      `(error code: ${ASK_USER_INVALID_ARGUMENT}).`
    );
  }
  if (!Array.isArray(rawOptions)) {
    return `'ask_user': 'options' must be a list (error code: ${ASK_USER_INVALID_ARGUMENT}).`;
  }
  if (options.length === 0) {
    return `'ask_user': 'options' cannot be empty; provide 2-6 items (error code: ${ASK_USER_EMPTY_OPTIONS}).`;
  }
  if (options.length < 2 || options.length > 6) {
    return `'ask_user': 'options' must contain 2-6 items (error code: ${ASK_USER_OPTION_COUNT}).`;
  }
  return undefined;
}

function fail(tool: string, error: unknown) {
  return errorResult(tool, error instanceof Error ? error.message : String(error));
}

export function createInteractionTools(deps: AppToolDeps): AppTool[] {
  const knownTools = deps.knownToolNames ?? BUILTIN_TOOL_REGISTRY.names();
  const skillDirs: SkillDirs = deps.skillDirs ?? {};
  return [
    makeAppTool<AskUserArgs>({
      name: "ask_user",
      description:
        "Ask the user a clarifying question when their request is ambiguous or " +
        "underspecified, especially open-ended requests like '帮我分析一下' / " +
        "'analyse this' / '看看数据'. Present a short question and 2-6 predefined " +
        "options the user can click as chips — this is the ONLY sanctioned way to " +
        "offer analysis direction choices to the user. The options array is REQUIRED " +
        "and MUST NEVER be empty. The UI adds a custom-answer option automatically, " +
        "so do not add one yourself. NEVER enumerate 2+ analysis " +
        "directions as plain text bullets for the user to pick from — convert them " +
        "into an ask_user call instead. Example: user uploads data and says '帮我" +
        "分析一下' -> call ask_user with options like 盈利分析 / 结构分析 / 趋势" +
        "分析 / 用户分析 rather than replying with a text menu.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The clarifying question to show the user (one sentence, ≤120 chars).",
            minLength: 1,
            maxLength: 120,
          },
          options: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 40 },
            description:
              "REQUIRED: 2–6 predefined answer options; NEVER return an empty array. " +
              "Keep each option short (≤40 chars). " +
              "Do NOT include an 'Other' option — it is added automatically.",
            minItems: 2,
            maxItems: 6,
          },
          multi_select: {
            type: "boolean",
            description:
              "If true, the user may select multiple options before submitting. " +
              "Use for questions like 'which dimensions to include'. " +
              "Defaults to false (single-select).",
          },
        },
        required: ["question", "options"],
      },
      replay: "safe",
      async execute(args) {
        const normalized = normalizeAskUser(args);
        const problem = validateAskUser(normalized.question, normalized.options, args.options);
        if (problem !== undefined) return errorResult("ask_user", problem);
        return okResult("ask_user", "问题已展示给用户，等待用户回答后继续。请不要输出任何文字。", {
          tool: "ask_user",
          question: normalized.question,
          options: normalized.options,
          multi_select: args.multi_select === true,
        });
      },
    }),
    makeAppTool<{ output: JsonValue; required_fields?: string[] }>({
      name: "structured_output",
      description:
        "Return machine-readable output and optionally require object fields. Reserved for structured/coordinator workflows.",
      parameters: {
        type: "object",
        properties: {
          output: {},
          required_fields: { type: "array", items: { type: "string" } },
        },
        required: ["output"],
      },
      replay: "safe",
      async execute(args) {
        const output = args.output;
        const isRecord = output !== null && typeof output === "object" && !Array.isArray(output);
        if (!isRecord && !Array.isArray(output) && typeof output !== "string") {
          return errorResult("structured_output", "output must be an object, array, or string");
        }
        const required = args.required_fields ?? [];
        if (required.length > 0 && !isRecord) {
          return errorResult("structured_output", "required_fields can only validate object output");
        }
        const missing = required.filter((field) => !Object.hasOwn(output as object, field));
        if (missing.length > 0) {
          return errorResult("structured_output", "missing required fields: " + missing.join(", "));
        }
        const result = { output };
        return okResult("structured_output", renderValue(result as unknown as JsonValue), {
          tool: "structured_output",
          output,
          required_fields: required,
        });
      },
    }),
    makeAppTool<{ summary: string; steps: JsonValue[] }>({
      name: "plan_complete",
      description: "Return a completed structured plan in coordinator workflows.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          steps: { type: "array", items: { type: "object" } },
        },
        required: ["summary", "steps"],
      },
      replay: "safe",
      async execute(args) {
        const result = { summary: args.summary ?? "", steps: args.steps ?? [] };
        return okResult("plan_complete", renderValue(result as unknown as JsonValue), {
          tool: "plan_complete",
          ...(result as unknown as Record<string, JsonValue>),
        });
      },
    }),
    makeAppTool<{ name: string }>({
      name: "load_analysis_skill",
      description: "Load a named project analysis skill and return its full SOP body.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      replay: "safe",
      async execute(args) {
        try {
          const name = String(args.name ?? "");
          if (!name) {
            return errorResult("load_analysis_skill", "ERROR: unknown analysis skill. Check available skills in the system prompt.");
          }
          const skill = getSkill(name, skillDirs);
          if (skill === undefined) {
            return errorResult("load_analysis_skill", "ERROR: unknown analysis skill. Check available skills in the system prompt.");
          }
          const activation = activateSkill(skill, "", knownTools);
          const text =
            `[SKILL LOADED: ${skill.name}]\n\n` +
            `${activation.prompt}\n\n` +
            "[NEXT STEP] Follow the skill instructions above for the current user request. " +
            "Do NOT call load_analysis_skill again.";
          return okResult("load_analysis_skill", text, {
            tool: "load_analysis_skill",
            event: "skill_activated",
            name: skill.name,
            source: skill.source,
          });
        } catch (error) {
          return fail("load_analysis_skill", error);
        }
      },
    }),
    makeAppTool<{ query: string; server?: string; limit?: number }>({
      name: "search_mcp_tools",
      description:
        "Search the compact catalog of currently connected MCP tools. Returns up to 5 names and summaries without loading every full parameter schema. Use when the user needs an external capability that is not already exposed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Capability, service, or exact MCP tool name to find.",
          },
          server: { type: "string", description: "Optional exact MCP server id." },
          limit: { type: "integer", minimum: 1, maximum: 5, default: 5 },
        },
        required: ["query"],
      },
      replay: "safe",
      async execute(args) {
        const reader = deps.mcpCatalog;
        if (reader === undefined) {
          return okResult(
            "search_mcp_tools",
            renderValue({
              query: args.query ?? "",
              catalog_version: "",
              matches: [],
              hint: "No connected MCP tool matched this query.",
            }),
            { tool: "search_mcp_tools", matches: [], count: 0 },
          );
        }
        try {
          const snapshot = await reader.read();
          const matches = searchMcpCatalog(
            snapshot.catalog,
            args.query ?? "",
            args.server ?? "",
            args.limit ?? 5,
          );
          reader.record?.(matches.map((match) => match.name));
          const result = {
            query: args.query ?? "",
            catalog_version: snapshot.version,
            matches: matches as unknown as JsonValue,
            hint: matches.length > 0
              ? "Matched tools will be available on the next model step."
              : "No connected MCP tool matched this query.",
          };
          return okResult("search_mcp_tools", renderValue(result as unknown as JsonValue), {
            tool: "search_mcp_tools",
            query: result.query,
            catalog_version: result.catalog_version,
            matches: matches as unknown as JsonValue,
            count: matches.length,
            hint: result.hint,
          });
        } catch (error) {
          return fail("search_mcp_tools", error);
        }
      },
    }),
  ];
}
