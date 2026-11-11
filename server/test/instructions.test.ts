import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_INCLUDE_DEPTH,
  MAX_INSTRUCTION_CHARS,
  clearInstructionCache,
  renderInstructionSection,
} from "../src/agent/instructions.ts";
import { FIXTURES, GOLDEN, type FsSpec, materialize, removeFile } from "./support/fs-spec.ts";

const golden = JSON.parse(readFileSync(join(GOLDEN, "instructions.json"), "utf8"));
const instructionFixtures = join(FIXTURES, "instructions");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function render(caseRoot: string, hasWorkspace: boolean): string {
  return renderInstructionSection({ userRoot: join(caseRoot, "user"), workspaceRoot: hasWorkspace ? join(caseRoot, "ws") : undefined });
}

describe("instruction sections", () => {
  test("limits", () => {
    expect(MAX_INSTRUCTION_CHARS).toBe(golden.constants.MAX_INSTRUCTION_CHARS);
    expect(MAX_INCLUDE_DEPTH).toBe(golden.constants.MAX_INCLUDE_DEPTH);
  });

  test("static fixture trees (layers, includes, cycles, depth, outside-root, missing, syntax)", () => {
    expect(golden.static.length).toBeGreaterThanOrEqual(16);
    for (const c of golden.static) {
      clearInstructionCache();
      const caseRoot = join(instructionFixtures, c.id);
      expect(isDir(join(caseRoot, "ws"))).toBe(c.has_workspace);
      expect({ id: c.id, output: render(caseRoot, c.has_workspace) }).toEqual({ id: c.id, output: c.output });
    }
  });

  for (const c of golden.dynamic) {
    test(`dynamic: ${c.id}`, () => {
      const root = mkdtempSync(join(tmpdir(), "dw-instr-"));
      temps.push(root);
      materialize(root, c.files);
      clearInstructionCache();
      expect(render(root, c.has_workspace)).toBe(c.output);
    });
  }

  test("sanity: the interesting blocked/ok markers appear in the golden output", () => {
    const outputOf = (id: string) => golden.static.find((c: { id: string }) => c.id === id).output as string;
    expect(outputOf("cycle")).toContain("<!-- @include blocked: cycle detected -->");
    expect(outputOf("depth")).toContain("<!-- @include blocked: maximum depth reached -->");
    expect(outputOf("outside")).toContain("<!-- @include blocked: path outside root -->");
    expect(outputOf("missing")).toContain("<!-- @include missing: nope.md -->");
    expect(outputOf("basic")).toStartWith("\n\n[PROJECT INSTRUCTIONS]\n[USER INSTRUCTIONS]\n");
    expect(outputOf("whitespace")).toBe("");
    expect(golden.dynamic.find((c: { id: string }) => c.id === "truncate-over").output).toContain("\n<!-- instructions truncated -->");
  });

  test("mtime cache: same mtime is served from cache, new mtime or deletion invalidates", () => {
    const seq = golden.cache;
    const root = mkdtempSync(join(tmpdir(), "dw-instr-"));
    temps.push(root);
    materialize(root, seq.files);
    clearInstructionCache();
    const outputs = seq.ops.map((op: { op: string; path?: string; entry?: unknown }) => {
      if (op.op === "render") return render(root, true);
      if (op.op === "write") materialize(root, { [op.path!]: op.entry } as FsSpec);
      else removeFile(root, op.path!);
      return null;
    });
    expect(outputs).toEqual(seq.outputs);
    // 缓存只在无任何变化时才有用：陈旧结果是已知并接受的取舍
    expect(outputs.filter((o: string | null) => o !== null).length).toBe(11);
  });

  test("results are cached per root pair and refreshed when a file appears", () => {
    const root = mkdtempSync(join(tmpdir(), "dw-instr-"));
    temps.push(root);
    clearInstructionCache();
    expect(renderInstructionSection({ userRoot: root })).toBe("");
    writeFileSync(join(root, "ZHIXI.md"), "hello\n");
    utimesSync(join(root, "ZHIXI.md"), 4000, 4000);
    expect(renderInstructionSection({ userRoot: root })).toBe("\n\n[PROJECT INSTRUCTIONS]\n[USER INSTRUCTIONS]\nhello\n[END PROJECT INSTRUCTIONS]");
    expect(renderInstructionSection({ userRoot: root, workspaceRoot: join(root, "missing-workspace") })).toBe(
      "\n\n[PROJECT INSTRUCTIONS]\n[USER INSTRUCTIONS]\nhello\n[END PROJECT INSTRUCTIONS]",
    );
  });
});
