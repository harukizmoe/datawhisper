import { describe, expect, test } from "bun:test";
import golden from "./golden/registry.json";
import { pyCompare } from "../src/agent/py-compat.ts";
import {
  BUILTIN_TOOL_REGISTRY,
  getToolSpec,
  isJobEligible,
  ToolRegistry,
  ToolRegistryError,
  ToolSpec,
  type ToolSpecFields,
} from "../src/tools/registry.ts";

type GoldenSpec = {
  name: string;
  category: string;
  defaultExposed: boolean;
  discoverable: boolean;
  discoveryKeywords: string[];
  discoverySummary: string;
  commands: string[];
  skills: string[];
  requiresDataSource: boolean;
  concurrencySafe: boolean;
  executionMode: string;
  jobThreshold: string;
  requiresRuntime: boolean;
  requiresWorkspace: boolean;
  sideEffect: string;
  confirmation: string;
};

type Golden = {
  specs: GoldenSpec[];
  names: string[];
  jobEligible: string[];
  missingSpecLookup: string[];
  categoryCounts: Record<string, number>;
};

const cases = golden as unknown as Golden;

/** 字段名与 Python dump 相同；集合经过排序，因为 JSON 无法承载 frozenset。 */
function dumpSpec(spec: ToolSpec): GoldenSpec {
  return {
    name: spec.name,
    category: spec.category,
    defaultExposed: spec.defaultExposed,
    discoverable: spec.discoverable,
    discoveryKeywords: [...spec.discoveryKeywords].sort(pyCompare),
    discoverySummary: spec.discoverySummary,
    commands: [...spec.commands].sort(pyCompare),
    skills: [...spec.skills].sort(pyCompare),
    requiresDataSource: spec.requiresDataSource,
    concurrencySafe: spec.concurrencySafe,
    executionMode: spec.executionMode,
    jobThreshold: spec.jobThreshold,
    requiresRuntime: spec.requiresRuntime,
    requiresWorkspace: spec.requiresWorkspace,
    sideEffect: spec.sideEffect,
    confirmation: spec.confirmation,
  };
}

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("built-in tool registry", () => {
  // 期望值来自 agent/tools/registry.py（scripts/golden/export_registry.py）。
  test("matches the Python table spec for spec, in registry order", () => {
    expect(BUILTIN_TOOL_REGISTRY.all().map(dumpSpec)).toEqual(cases.specs);
  });

  test("has every name exactly once and matches the Python name set", () => {
    const names = BUILTIN_TOOL_REGISTRY.all().map((spec) => spec.name);
    expect(names.length).toBe(72);
    expect(new Set(names).size).toBe(72);
    expect([...BUILTIN_TOOL_REGISTRY.names()].sort(pyCompare)).toEqual(cases.names);
    expect([...BUILTIN_TOOL_REGISTRY.names()].sort(pyCompare)).toEqual(cases.specs.map((spec) => spec.name).sort(pyCompare));
    expect(cases.missingSpecLookup).toEqual([]);
  });

  test("get and isJobEligible follow the Python helpers", () => {
    expect(getToolSpec("query_data")?.executionMode).toBe("auto");
    expect(getToolSpec("no_such_tool")).toBeUndefined();
    expect([...BUILTIN_TOOL_REGISTRY.names()].filter((name) => isJobEligible(name)).sort(pyCompare)).toEqual(cases.jobEligible);
  });

  test("category counts match the inventory split", () => {
    const counts: Record<string, number> = {};
    for (const spec of BUILTIN_TOOL_REGISTRY.all()) counts[spec.category] = (counts[spec.category] ?? 0) + 1;
    expect(counts).toEqual(cases.categoryCounts);
    // 清单中为 40 A + 14 B + 18 C；registry 的分类以不同方式切分同样的 72 个工具。
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(40 + 14 + 18);
  });

  test("category defaults the side-effect scope for write/output tools", () => {
    expect(new ToolSpec({ name: "w", category: "write" }).sideEffect).toBe("workspace");
    expect(new ToolSpec({ name: "o", category: "output" }).sideEffect).toBe("workspace");
    expect(new ToolSpec({ name: "r", category: "read" }).sideEffect).toBe("none");
    expect(new ToolSpec({ name: "w", category: "write", sideEffect: "none" }).sideEffect).toBe("none");
  });
});

describe("registry invariants", () => {
  const base: ToolSpecFields = { name: "sample", category: "read" };

  test("keeps the Python error texts", () => {
    expect(errorMessage(() => new ToolRegistry([new ToolSpec({ ...base, name: "" })]))).toBe("tool name cannot be empty");
    expect(errorMessage(() => new ToolRegistry([new ToolSpec(base), new ToolSpec(base)]))).toBe("duplicate tool spec: sample");
    expect(errorMessage(() => new ToolRegistry([new ToolSpec({ ...base, executionMode: "auto" })]))).toBe(
      "auto tool requires job_threshold: sample",
    );
    expect(errorMessage(() => new ToolRegistry([new ToolSpec({ ...base, discoverable: true })]))).toBe(
      "discoverable tool requires keywords and summary: sample",
    );
    expect(
      errorMessage(() =>
        new ToolRegistry([
          new ToolSpec({ ...base, concurrencySafe: true, sideEffect: "session" }),
        ]),
      ),
    ).toBe("concurrency-safe tool cannot declare side effects: sample");
    expect(
      errorMessage(() =>
        new ToolRegistry([new ToolSpec({ ...base, confirmation: "explicit_request" })]),
      ),
    ).toBe("confirmation requires a side-effect scope: sample");
    expect(
      errorMessage(() => new ToolRegistry([new ToolSpec({ ...base, sideEffect: "external" })])),
    ).toBe("external side effect requires confirmation policy: sample");
  });

  test("accepts a valid spec and rejects a registry/schema mismatch with Python's message", () => {
    const registry = new ToolRegistry([
      new ToolSpec({
        ...base,
        discoverable: true,
        discoveryKeywords: ["kw"],
        discoverySummary: "summary",
        executionMode: "auto",
        jobThreshold: "rows_gte_1",
      }),
    ]);
    expect(registry.get("sample")?.jobThreshold).toBe("rows_gte_1");
    expect(registry.all().length).toBe(1);

    expect(errorMessage(() => registry.validateSchemaNames([]))).toBe(
      "tool registry/schema mismatch: missing schemas=['sample']",
    );
    expect(errorMessage(() => registry.validateSchemaNames([{ function: { name: "other" } }]))).toBe(
      "tool registry/schema mismatch: missing specs=['other']; missing schemas=['sample']",
    );
    expect(errorMessage(() => registry.validateSchemaNames([{ function: { name: "  sample " } }, { function: { name: "" } }]))).toBe("");
  });

  test("a duplicate name is an error, never an overwrite", () => {
    expect(() => new ToolRegistry([new ToolSpec(base), new ToolSpec({ ...base, requiresRuntime: true })])).toThrow(
      "duplicate tool spec: sample",
    );
    expect(BUILTIN_TOOL_REGISTRY).toBeInstanceOf(ToolRegistry);
    expect(() => new ToolRegistry([new ToolSpec({ ...base, name: "" })])).toThrow(ToolRegistryError);
  });
});

describe("ToolSpec.isExposed / exposedNames", () => {
  test("gates data source, workspace, command, skill and discovery", () => {
    const spec = new ToolSpec({ name: "t", category: "read", defaultExposed: false, discoverable: true, discoveryKeywords: ["k"], discoverySummary: "s", requiresDataSource: true, requiresWorkspace: true });
    expect(spec.isExposed({ hasDataSource: true, hasWorkspace: true })).toBe(false);
    expect(spec.isExposed({ hasDataSource: true, hasWorkspace: true, discovered: true })).toBe(true);
    expect(spec.isExposed({ hasDataSource: true, hasWorkspace: true, command: "cmd" })).toBe(false);
    expect(spec.isExposed({ hasDataSource: false, hasWorkspace: true, discovered: true })).toBe(false);
    expect(BUILTIN_TOOL_REGISTRY.exposedNames()).toEqual(
      new Set(BUILTIN_TOOL_REGISTRY.all().filter((item) => item.defaultExposed && !item.requiresDataSource && !item.requiresWorkspace).map((item) => item.name)),
    );
    expect(BUILTIN_TOOL_REGISTRY.exposedNames({ command: "ppt_confirm" }).has("generate_ppt")).toBe(true);
    expect(BUILTIN_TOOL_REGISTRY.exposedNames({ skill: "export" }).has("propose_excel_export")).toBe(true);
    expect(BUILTIN_TOOL_REGISTRY.exposedNames({ hasWorkspace: true, discoveredTools: ["workspace_bash"] }).has("workspace_bash")).toBe(true);
  });
});
