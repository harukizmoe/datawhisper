/**
 * B 类工具外壳的行为测试：真的启动 `python -m compute`，用 `baseline/fixtures` 的
 * 数据重放 `baseline/recordings` 中的调用，并把输出与旧 agent 的录音逐字比较。
 *
 * 比较前使用与 `baseline/run_baseline.py::Normalizer` 相同的归一化（时间戳、会话 id、
 * 临时路径、uuid/hash），因为录音是在写入时归一化过的。另外覆盖三类错误形状与一次
 * 真实取消。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal, withContextValue } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ComputeCancelled, ComputeClient, ComputeError } from "../src/compute/client.ts";
import {
  computeToolContextKey,
  createComputeTools,
  COMPUTE_TOOL_NAMES,
  COMPUTE_TOOL_REPLAY,
  type ComputeTool,
  type ComputeToolContext,
  type ComputeToolDetails,
  type ComputeToolName,
} from "../src/tools/compute/index.ts";

const REPO = resolve(import.meta.dir, "../..");
const PYTHON = resolve(REPO, ".venv/bin/python");
const FIXTURES = join(REPO, "baseline", "fixtures");
const RECORDINGS = join(REPO, "baseline", "recordings");
const SESSION_ID = "4f1c2a9e-7b3d-4e8a-9c61-0d2e5f7a8b90";
const USER_ID = "local-default";

/** 覆盖全部 14 个工具的一份最小录音集合；每个调用按录制顺序重放。 */
const REPLAYED = [
  "knowledge",
  "schema_query",
  "analysis_tables",
  "analysis_ab_test",
  "chart",
  "profile",
  "clean_fill_na",
  "export_excel",
  "export_report",
  "generate_ppt",
  "generate_dashboard",
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Recording = {
  scenario: string;
  steps: {
    tool_results: { tool: string; arguments: Json; content: string }[];
    options?:
      | {
          internal_action?: string;
          data_context?: { tables?: { source_id: string; table: string }[] };
        }
      | null;
    final_text?: string;
  }[];
};

type ExpectedCall = { tool: ComputeToolName; args: Json; expected: { text: string; refs?: Json } };

let tmpRoot: string;
let compute: ComputeClient;
let tools: ComputeTool[];
let byName: Map<string, ComputeTool>;
let sourceCounter = 0;

function nextSourceId(): string {
  sourceCounter += 1;
  return `s${sourceCounter}`;
}

/** 录音里的工具消息是 `[TOOL_RESULT] <tool> OK|ERROR: ...` + JSON envelope。 */
function handlerOutput(modelText: string): { text: string; refs: Json } {
  const newline = modelText.indexOf("\n");
  const header = newline === -1 ? modelText : modelText.slice(0, newline);
  if (!header.startsWith("[TOOL_RESULT] ")) throw new Error(`not a tool envelope: ${header.slice(0, 80)}`);
  const envelope = JSON.parse(modelText.slice(newline + 1)) as {
    data?: unknown;
    sources?: Json;
    artifacts?: { type?: string }[];
  };
  if (envelope.artifacts?.some((item) => item.type === "tool_result")) {
    throw new Error("result spilled to a tool-result artifact");
  }
  if (typeof envelope.data !== "string") throw new Error("envelope data is not handler text");
  return { text: envelope.data, refs: envelope.sources ?? [] };
}

/** 确认走的是旧 agent 的 fast path（无模型调用的确认动作）。 */
const FAST_PATHS: Record<string, { tool: ComputeToolName; build: (options: Record<string, Json>) => Json }> = {
  excel_confirm: {
    tool: "export_excel",
    build: (o) => ({ tables: o.excel_tables ?? ["*"], filename: o.excel_filename ?? "" }),
  },
  report_confirm: {
    tool: "export_report",
    build: (o) => ({ title: o.report_title ?? null, sections: o.report_sections ?? [] }),
  },
  ppt_confirm: {
    tool: "generate_ppt",
    build: (o) => ({ title: o.ppt_title ?? null, slides: o.ppt_slides ?? [], filename: "" }),
  },
  dashboard_confirm: {
    tool: "generate_dashboard",
    build: (o) => ({ name: o.dashboard_name ?? null, widgets: o.dashboard_widgets ?? [] }),
  },
};

function isComputeToolName(value: string): value is ComputeToolName {
  return (COMPUTE_TOOL_NAMES as readonly string[]).includes(value);
}

/** 按录制顺序取出本模块负责的工具调用（含 fast path）。 */
function recordedCalls(recording: Recording): ExpectedCall[] {
  const calls: ExpectedCall[] = [];
  for (const step of recording.steps) {
    for (const item of step.tool_results) {
      if (isComputeToolName(item.tool)) calls.push({ tool: item.tool, args: item.arguments, expected: handlerOutput(item.content) });
    }
    const action = step.options?.internal_action;
    const fastPath = action === undefined ? undefined : FAST_PATHS[action];
    if (fastPath !== undefined) {
      calls.push({ tool: fastPath.tool, args: fastPath.build((step.options ?? {}) as Record<string, Json>), expected: { text: step.final_text ?? "" } });
    }
  }
  return calls;
}

function readRecording(name: string): Recording {
  return JSON.parse(readFileSync(join(RECORDINGS, `${name}.json`), "utf8")) as Recording;
}

const VOLATILE_KEYS: Record<string, true> = {
  elapsed_seconds: true,
  created_at: true,
  updated_at: true,
  duration: true,
  duration_ms: true,
  timestamp: true,
  generated_at: true,
  mtime: true,
  size_bytes: true,
};

const ISO_TS = /\b(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const COMPACT_TS = /(?<!\d)(\d{4})(\d{2})(\d{2})[_-]?\d{6}(?:\d{1,6})?(?!\d)/g;
const EPOCH = /(?<![\d.])(\d{10})(\d{3}|\.\d+)?(?![\d.])/g;

/** `baseline/run_baseline.py::Normalizer` 的 TS 版本；只覆盖工具结果里出现的模式。 */
function makeNormalizer(dataRoot: string, sessionId: string): (value: Json, key?: string) => Json {
  const now = new Date();
  const nowEpoch = now.getTime() / 1000;
  const bases = new Set([now.toISOString().slice(0, 10), localDate(now)]);
  const runDates = new Set<string>();
  for (const base of bases) {
    const midnight = Date.parse(`${base}T00:00:00Z`);
    for (const offset of [-1, 0, 1]) {
      runDates.add(new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10));
    }
  }
  const literals: [string, string][] = [
    [dataRoot, "<DATA_ROOT>"],
    [resolve(dataRoot), "<DATA_ROOT>"],
    [REPO, "<REPO>"],
    [sessionId, "<SID>"],
    [sessionId.slice(0, 8), "<SID8>"],
  ];
  for (const day of runDates) {
    const [year, month, date] = day.split("-") as [string, string, string];
    literals.push(
      [day, "<TODAY>"],
      [`${year}${month}${date}`, "<TODAY>"],
      [`${Number(year)}年${Number(month)}月${Number(date)}日`, "<TODAY>"],
      [`${year}年${month}月${date}日`, "<TODAY>"],
    );
  }
  literals.sort((a, b) => b[0].length - a[0].length);

  const keepDate = (match: string, year: string, month: string, day: string) =>
    runDates.has(`${year}-${month}-${day}`) ? "<TS>" : match;
  const text = (value: string): string => {
    let out = value.replace(ISO_TS, keepDate);
    out = out.replace(COMPACT_TS, keepDate);
    out = out.replace(EPOCH, (match, seconds: string) =>
      Math.abs(Number(seconds) - nowEpoch) < 2 * 86_400 ? "<EPOCH>" : match,
    );
    for (const [literal, replacement] of literals) {
      if (literal !== "") out = out.split(literal).join(replacement);
    }
    out = out
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
      .replace(/\btr_[0-9a-f]{16,64}\b/g, "tr_<ID>")
      .replace(/\bec_[0-9a-f]{16,64}\b/g, "ec_<ID>")
      .replace(/\b[0-9a-f]{64}\b/g, "<SHA256>")
      .replace(/(?<![0-9a-zA-Z])[0-9a-f]{12,40}(?![0-9a-zA-Z])/g, "<HEX>")
      .replace(/\b(127\.0\.0\.1|localhost):\d{2,5}\b/g, "$1:<PORT>")
      .replace(/(耗时|用时|elapsed)[:：\s]*\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒)/gi, "$1 <DUR>")
      .replace(/<TODAY>[_-]?\d{4,6}(?!\d)/g, "<TODAY>_<HHMMSS>")
      .replace(/\/tmp\/[^\s"'`)\]}>,;]+/g, "<TMP_PATH>");
    return out;
  };

  const normalize = (value: Json, key?: string): Json => {
    if (key !== undefined && VOLATILE_KEYS[key] === true && value !== null) return "<VOLATILE>";
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map((item) => normalize(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, name)]));
    }
    return value;
  };
  return normalize;
}

function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${date}`;
}

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
  const first = result.output?.[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

function recordingApi(hooks: { onDetails?: (details: ComputeToolDetails) => void } = {}): {
  api: ToolExecutionApi<ComputeToolDetails>;
  details: ComputeToolDetails[];
} {
  const details: ComputeToolDetails[] = [];
  const api = {
    async details(value: ComputeToolDetails) {
      details.push(value);
      hooks.onDetails?.(value);
    },
  } as unknown as ToolExecutionApi<ComputeToolDetails>;
  return { api, details };
}

/** 启动一次工具调用；`decode` 用工具 `Context` 传递会话数据上下文。 */
async function runTool(
  name: ComputeToolName,
  args: Json,
  toolContext: ComputeToolContext,
  options: { signal?: AbortSignal; onDetails?: (details: ComputeToolDetails) => void } = {},
) {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`tool not registered: ${name}`);
  const record = recordingApi({ onDetails: options.onDetails });
  let context = withContextValue(computeToolContextKey, toolContext, BACKGROUND_CONTEXT);
  if (options.signal !== undefined) context = withAbortSignal(options.signal, context);
  const result = await tool.execute(args, record.api, context);
  return { result, running: record.details };
}

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpRoot, "fixture-"));
  const path = join(dir, name);
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

async function openXlsx(): Promise<string> {
  const sourceId = nextSourceId();
  await compute.openSource(sourceId, { kind: "excel", file_path: copyFixture("baseline.xlsx"), name: "baseline.xlsx" });
  return sourceId;
}

async function openSqlite(tables: string[]): Promise<{ sourceId: string; tables: Record<string, string[]> }> {
  const sourceId = nextSourceId();
  const path = copyFixture("baseline.sqlite");
  await compute.openSource(sourceId, {
    kind: "sql",
    connection_string: `sqlite:///${path}`,
    name: "baseline_sqlite",
  });
  return { sourceId, tables: { [sourceId]: tables } };
}

function dailyRows(count: number): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  for (let i = 0; i < count; i += 1) {
    const day = new Date(1_577_836_800_000 + i * 86_400_000).toISOString().slice(0, 10);
    const value = 1000 + 3 * i + 120 * Math.sin(i / 7) + ((i * 37) % 23);
    rows.push({ day, store: `S${i % 5}`, value: Math.round(value * 100) / 100, units: i % 17 });
  }
  return rows;
}

async function openCsv(name: string, rows: Record<string, string | number>[]): Promise<{ sourceId: string; table: string }> {
  const path = join(mkdtempSync(join(tmpRoot, "csv-")), `${name}.csv`);
  const header = Object.keys(rows[0] ?? {});
  const lines = [header.join(","), ...rows.map((row) => header.map((column) => String(row[column])).join(","))];
  writeFileSync(path, `${lines.join("\n")}\n`);
  const sourceId = nextSourceId();
  const opened = await compute.openSource(sourceId, { kind: "csv", file_path: path, name: `${name}.csv` });
  return { sourceId, table: opened.tables[0] ?? name };
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "dw-compute-tools-"));
  const dataRoot = join(tmpRoot, "data");
  mkdirSync(dataRoot);
  compute = new ComputeClient({
    python: PYTHON,
    cwd: REPO,
    env: {
      BAA_DATA_DIR: dataRoot,
      BAA_SKIP_DEPENDENCY_CHECK: "1",
      PYTHONHASHSEED: "0",
      TZ: "UTC",
    },
  });
  tools = createComputeTools({ compute });
  byName = new Map(tools.map((tool) => [tool.name, tool]));
  // 与 Python parity 测试相同：知识库种子决定 query_knowledge 的输出。
  const seed = JSON.parse(readFileSync(join(REPO, "baseline", "scenarios.json"), "utf8")) as {
    knowledge_seed?: { metrics?: Json[]; rules?: Json[]; notes?: Json[] };
  };
  for (const [kind, key] of [
    ["metric", "metrics"],
    ["rule", "rules"],
    ["note", "notes"],
  ] as const) {
    for (const record of seed.knowledge_seed?.[key] ?? []) {
      await compute.call("knowledge.add", { kind, record, user_id: USER_ID });
    }
  }
});

afterAll(async () => {
  await compute?.close();
  if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("registration", () => {
  test("registers exactly the 14 B-class tools with their replay policy", () => {
    expect(tools.map((tool) => tool.name)).toEqual([...COMPUTE_TOOL_NAMES]);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(14);
    for (const tool of tools) {
      expect(tool.replay).toBe(COMPUTE_TOOL_REPLAY[tool.name as ComputeToolName]);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("the recorded scenarios exercise every tool", () => {
    const covered = new Set<string>();
    for (const name of REPLAYED) {
      for (const call of recordedCalls(readRecording(name))) covered.add(call.tool);
    }
    expect([...covered].sort()).toEqual([...COMPUTE_TOOL_NAMES].sort());
  });
});

describe("baseline parity", () => {
  for (const name of REPLAYED) {
    test(
      name,
      async () => {
        const recording = readRecording(name);
        const calls = recordedCalls(recording);
        expect(calls.length).toBeGreaterThan(0);
        const tableSelection = recording.steps[0]?.options?.data_context?.tables;
        let toolContext: ComputeToolContext;
        if (tableSelection !== undefined && tableSelection.length > 0) {
          const opened = await openSqlite(tableSelection.map((entry) => entry.table));
          toolContext = { sources: [opened.sourceId], tables: opened.tables, sessionId: SESSION_ID, userId: USER_ID };
        } else {
          toolContext = { sources: [await openXlsx()], sessionId: SESSION_ID, userId: USER_ID };
        }
        const normalize = makeNormalizer(join(tmpRoot, "data"), SESSION_ID);
        for (const [index, call] of calls.entries()) {
          const label = `${name} call ${index} ${call.tool}`;
          const { result } = await runTool(call.tool, call.args, toolContext);
          expect(result.isError, label).not.toBe(true);
          expect(normalize(textOf(result)), label).toBe(call.expected.text);
          const details = result.details;
          expect(details, label).toBeDefined();
          if (details === undefined) throw new Error(label);
          if (call.expected.refs !== undefined) expect(normalize(details.refs as Json), label).toEqual(call.expected.refs);
          for (const file of details.files) expect(existsSync(file), `${label}: ${file}`).toBe(true);
          if (["export_excel", "export_report", "generate_ppt", "generate_dashboard"].includes(call.tool)) {
            expect(details.files.length, `${label}: no file reported`).toBeGreaterThan(0);
          }
          if (call.tool === "generate_chart") {
            expect(details.charts, label).toHaveLength(1);
            const chart = details.charts[0] as Record<string, Json>;
            expect(String(chart.html).toLowerCase(), label).toContain("<html");
          }
          if (call.tool === "generate_dashboard") {
            const widgets = (call.args as Record<string, Json>).widgets as Json[];
            expect(details.charts, label).toHaveLength(widgets.length);
            expect(details.dashboard_id, label).toBeTruthy();
          }
        }
      },
      180_000,
    );
  }
});

describe("failures", () => {
  test("arg validation carries the old tool text and a structured kind", async () => {
    const sourceId = await openXlsx();
    const { result } = await runTool(
      "query_data",
      { sql: "SELECT * FROM read_csv('/etc/passwd')" },
      { sources: [sourceId], sessionId: SESSION_ID, userId: USER_ID },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toStartWith("[ARG ERROR] 'query_data' SQL validation failed");
    expect(result.details?.error?.kind).toBe("arg_validation");
  });

  test("SQL sources need an analysis-table selection first", async () => {
    const opened = await openSqlite([]);
    const { result } = await runTool("get_schema", {}, { sources: [opened.sourceId], userId: USER_ID });
    expect(result.isError).toBe(true);
    expect(result.details?.error?.kind).toBe("sql_table_selection_required");
    expect(result.details?.error?.sources.length).toBe(1);
    expect(textOf(result)).toBe("请先为 SQL 数据源选择分析表");
  });

  test("an unopened source is reported, not swallowed", async () => {
    const { result } = await runTool("get_schema", {}, { sources: ["missing-source"], userId: USER_ID });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("data source not open");
    expect(result.details?.error?.kind).toBe("source_not_open");
  });

  test("tool_error keeps the worker text verbatim", async () => {
    const failing = createComputeTools({
      compute: {
        call: async () => {
          throw new ComputeError("boom", -32603, { kind: "tool_error", text: "工具执行错误 [get_schema]: boom" });
        },
      },
      context: { sources: [], userId: USER_ID },
    });
    const tool = failing.find((item) => item.name === "get_schema");
    expect(tool).toBeDefined();
    const { api } = recordingApi();
    const result = await tool!.execute({}, api, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("工具执行错误 [get_schema]: boom");
    expect(result.details?.error?.kind).toBe("tool_error");
  });

  test("an unexpected exception still fails the call", async () => {
    const failing = createComputeTools({
      compute: {
        call: async () => {
          throw new Error("socket closed");
        },
      },
      context: { sources: [], userId: USER_ID },
    });
    const tool = failing.find((item) => item.name === "query_data");
    const { api } = recordingApi();
    const result = await tool!.execute({ sql: "SELECT 1" }, api, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("socket closed");
    expect(result.details?.error?.kind).toBe("tool_error");
  });
});

describe("minimal call on the fixture CSV", () => {
  test("get_schema and query_data run against baseline/fixtures/sales.csv", async () => {
    const path = copyFixture("sales.csv");
    const sourceId = nextSourceId();
    const opened = await compute.openSource(sourceId, { kind: "csv", file_path: path, name: "sales.csv" });
    const table = opened.tables[0] ?? "sales";
    const toolContext: ComputeToolContext = { sources: [sourceId], sessionId: SESSION_ID, userId: USER_ID };
    const schema = await runTool("get_schema", {}, toolContext);
    expect(schema.result.isError).not.toBe(true);
    expect(textOf(schema.result)).toContain(`Table: ${table}`);
    const rows = await runTool("query_data", { sql: `SELECT COUNT(*) AS n FROM "${table}"` }, toolContext);
    expect(rows.result.isError).not.toBe(true);
    expect(textOf(rows.result)).toContain("200");
  });
});

describe("progress and cancellation", () => {
  test(
    "a job-path tool forwards worker progress through details",
    async () => {
      // 50k 行触发 profile 的 job 路径，worker 会发 10/40/100 三次进度。
      const opened = await openCsv("big", dailyRows(50_000));
      const seen: number[] = [];
      const { result, running } = await runTool(
        "profile_data",
        { table_name: opened.table },
        { sources: [opened.sourceId], sessionId: SESSION_ID, userId: USER_ID },
        {
          onDetails: (details) => {
            if (details.progress?.percent !== undefined) seen.push(details.progress.percent);
          },
        },
      );
      expect(result.isError).not.toBe(true);
      expect(seen).toEqual([10, 40, 100]);
      expect(result.details?.progress).toBeUndefined();
      expect(running.at(-1)?.progress?.percent).toBe(100);
      expect((result.details?.charts.length ?? 0)).toBeGreaterThan(0);
    },
    180_000,
  );

  test(
    "aborting the invocation cancels the worker call and is not a tool failure",
    async () => {
      const opened = await openCsv("series", dailyRows(1_500));
      const controller = new AbortController();
      const toolContext: ComputeToolContext = { sources: [opened.sourceId], sessionId: SESSION_ID, userId: USER_ID };
      let aborted = false;
      const running = runTool(
        "run_analysis",
        {
          analysis_name: "Time_Series_ARIMA",
          sql: `SELECT day, value FROM "${opened.table}" ORDER BY day`,
          target_column: "value",
          groupby_column: "day",
          n_deciles: 7,
        },
        toolContext,
        {
          signal: controller.signal,
          onDetails: (details) => {
            if (details.progress !== undefined && !aborted) {
              aborted = true;
              controller.abort();
            }
          },
        },
      );
      await expect(running).rejects.toBeInstanceOf(ComputeCancelled);
      expect(aborted).toBe(true);
      // 取消后 source 仍可用，说明 worker 真的终止了这次分析而不是把它留在运行中。
      const after = await compute.call<{ text: string }>("tool.query_data", {
        context: { sources: [opened.sourceId] },
        args: { sql: `SELECT COUNT(*) AS n FROM "${opened.table}"` },
      });
      expect(after.text).toContain("1500");
    },
    180_000,
  );
});
