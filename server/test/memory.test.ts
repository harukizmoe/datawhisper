import { afterAll, describe, expect, test } from "bun:test";
import { afterEach as restoreLanguage, beforeEach as useChinese } from "bun:test";
import { setLanguage } from "../src/i18n.ts";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BODY_CHARS,
  MAX_INDEX_CHARS,
  MAX_RECORDS,
  MAX_TITLE_CHARS,
  type MemoryDirs,
  type MemoryRecord,
  MemoryValidationError,
  getMemoryRecord,
  listMemoryRecords,
  readMemory,
  renderMemoryIndex,
  renderMemorySection,
  validateMemoryPayload,
} from "../src/agent/memory.ts";
import { FIXTURES, GOLDEN, materialize } from "./support/fs-spec.ts";

const golden = JSON.parse(readFileSync(join(GOLDEN, "memory.json"), "utf8"));
const memoryFixtures = join(FIXTURES, "memory");
const temps: string[] = [];
// 这个文件断言的是旧实现的中文文案（golden 或沿用旧文案的用例），所以按中文跑；英文输出另见 i18n 用例。
useChinese(() => setLanguage("zh"));
restoreLanguage(() => setLanguage("en"));

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function pyRecord(r: MemoryRecord) {
  return {
    name: r.name,
    type: r.type,
    scope: r.scope,
    title: r.title,
    body: r.body,
    why: r.why,
    how_to_apply: r.howToApply,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    last_seen_at: r.lastSeenAt,
    source_session: r.sourceSession,
  };
}

const dirsFor = (root: string, hasWorkspace: boolean): MemoryDirs => ({
  userDir: join(root, "data", "memory"),
  workspaceRoot: hasWorkspace ? join(root, "ws") : undefined,
});

// biome-ignore lint/suspicious/noExplicitAny: golden JSON 行按结构比较
function checkCase(root: string, c: any, trimmed = false) {
  const dirs = dirsFor(root, c.has_workspace);
  const records = listMemoryRecords(dirs);
  if (trimmed) {
    expect(records.map((r) => ({ name: r.name, type: r.type, title: r.title, updated_at: r.updatedAt }))).toEqual(c.records);
  } else expect(records.map(pyRecord)).toEqual(c.records);
  expect(renderMemorySection(dirs)).toBe(c.section);
  for (const [name, expected] of Object.entries(c.reads)) {
    const record = getMemoryRecord(name, dirs);
    const actual: object = { name, get: record ? pyRecord(record) : null, read: readMemory(name, dirs) };
    expect(actual).toEqual({ name, ...(expected as object) });
  }
}

describe("memory read side: static fixtures", () => {
  test("constants", () => {
    expect({ MAX_TITLE_CHARS, MAX_BODY_CHARS, MAX_RECORDS, MAX_INDEX_CHARS }).toEqual(golden.constants);
  });

  for (const c of golden.static) {
    test(c.id, () => {
      expect(existsSync(join(memoryFixtures, c.id, "ws"))).toBe(c.has_workspace);
      checkCase(join(memoryFixtures, c.id), c);
    });
  }

  test("record validity rules show up in the invalid fixture", () => {
    const invalid = golden.static.find((c: { id: string }) => c.id === "invalid");
    const names = invalid.records.map((r: { name: string }) => r.name);
    expect(names).toContain("title-180");
    expect(names).not.toContain("title-181");
    expect(names).not.toContain("body-2001");
    expect(names).not.toContain("wrong-scope");
    expect(names).not.toContain("bom");
    expect(invalid.section).toStartWith("\n\n[LONG-TERM MEMORY]\n- [");
    // user 作用域的记录总是排在 workspace 作用域之前
    const scopes: string[] = invalid.records.map((r: { scope: string }) => r.scope);
    expect(scopes.indexOf("workspace")).toBeGreaterThan(scopes.lastIndexOf("user"));
  });

  test("scope order beats recency: user records first even when workspace records are newer", () => {
    const order = golden.static.find((c: { id: string }) => c.id === "order");
    expect(order.records.map((r: { name: string }) => r.name)).toEqual(["u-new", "u-old", "w-new", "w-old", "w-empty-ts"]);
  });
});

describe("memory read side: dynamic trees", () => {
  for (const c of golden.dynamic) {
    test(c.id, () => {
      const root = mkdtempSync(join(tmpdir(), "dw-memory-"));
      temps.push(root);
      materialize(root, c.files);
      checkCase(root, c, Object.keys(c.files).length > 20);
    });
  }

  test("index limits: 200 records, then characters", () => {
    const over = golden.dynamic.find((c: { id: string }) => c.id === "over-200-records");
    expect(over.section).toContain("<!-- memory index truncated, 5 more -->");
    const chars = golden.dynamic.find((c: { id: string }) => c.id === "index-char-limit");
    expect(chars.section).toMatch(/<!-- memory index truncated, \d+ more -->/);
  });
});

describe("validation and index rendering", () => {
  test("validateMemoryPayload accepts / rejects like _validate_payload", () => {
    expect(golden.payloads.length).toBeGreaterThan(50);
    for (const row of golden.payloads) {
      const run = () => validateMemoryPayload(row.payload, { automatic: row.options.automatic, existing: row.options.existing });
      if (row.error !== undefined) {
        expect(run, row.label).toThrow(MemoryValidationError);
        expect(run, row.label).toThrow(row.error);
      } else {
        const { howToApply, ...rest } = run();
        expect({ label: row.label, ok: { ...rest, how_to_apply: howToApply } }).toEqual({ label: row.label, ok: row.ok });
      }
    }
  });

  test("renderMemoryIndex labels and truncation", () => {
    for (const [type, text] of Object.entries(golden.labels)) {
      expect(renderMemoryIndex([{ type: type as MemoryRecord["type"], title: "T", name: "n" }])).toBe(text as string);
    }
    for (const row of golden.index_probe) expect(renderMemoryIndex(row.records)).toBe(row.index);
  });

  test("reading never writes: no MEMORY.md, no .zhixi directory is created", () => {
    const root = mkdtempSync(join(tmpdir(), "dw-memory-"));
    temps.push(root);
    cpSync(join(memoryFixtures, "basic"), root, { recursive: true });
    const before = (p: string) => existsSync(join(root, p));
    expect(before("data/memory/MEMORY.md")).toBe(false);
    renderMemorySection(dirsFor(root, true));
    expect(before("data/memory/MEMORY.md")).toBe(false);
    expect(before("ws/.zhixi/memory/MEMORY.md")).toBe(false);
    const fresh = join(root, "fresh-ws");
    mkdirSync(fresh);
    renderMemorySection({ userDir: join(root, "data", "memory"), workspaceRoot: fresh });
    expect(existsSync(join(fresh, ".zhixi"))).toBe(false);
  });

  test("equal updated_at keeps file-name order (Python's order there is filesystem-dependent)", () => {
    const root = mkdtempSync(join(tmpdir(), "dw-memory-"));
    temps.push(root);
    const same = (name: string) => `---\nname: ${name}\ntype: user\ntitle: ${name}\nupdated_at: '2026-01-01'\n---\nb\n`;
    materialize(root, { "memories/b.md": same("b"), "memories/a.md": same("a"), "memories/c.md": same("c") });
    expect(listMemoryRecords({ userDir: root }).map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});
