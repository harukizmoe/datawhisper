import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, TREE_LIMIT } from "../src/ipc/workspace-tree.ts";

const dirs: string[] = [];
function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dw-tree-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listDirectory", () => {
  test("目录在前文件在后，各自不分大小写排序；数据文件打标记", () => {
    const root = workdir();
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "Alpha"));
    writeFileSync(join(root, "b.csv"), "a,b\n1,2\n");
    writeFileSync(join(root, "A.txt"), "hi");
    const listing = listDirectory(root, "");
    expect(listing.entries.map((e) => [e.name, e.kind, e.data])).toEqual([
      ["Alpha", "dir", false],
      ["beta", "dir", false],
      ["A.txt", "file", false],
      ["b.csv", "file", true],
    ]);
    expect(listing.entries.find((e) => e.name === "b.csv")?.size).toBe(8);
  });

  test("单子目录链折叠成一行，path 指向最里层，空目录带 empty", () => {
    const root = workdir();
    mkdirSync(join(root, "docs", "refactor", "plans"), { recursive: true });
    mkdirSync(join(root, "docs2", "x"), { recursive: true });
    writeFileSync(join(root, "docs2", "y.txt"), "");
    const entries = listDirectory(root, "").entries;
    expect(entries.find((e) => e.name === "docs/refactor/plans")).toMatchObject({ path: "docs/refactor/plans", empty: true });
    // docs2 里有两项，不折叠。
    expect(entries.find((e) => e.name === "docs2")).toMatchObject({ path: "docs2", empty: false });
    expect(listDirectory(root, "docs2").entries.map((e) => e.name)).toEqual(["x", "y.txt"]);
  });

  test("敏感文件不出现，大目录灰显且不折叠，符号链接被跳过", () => {
    const root = workdir();
    const outside = workdir();
    writeFileSync(join(root, ".env"), "SECRET=1");
    writeFileSync(join(root, ".env.local"), "SECRET=1");
    writeFileSync(join(root, "server.pem"), "-----");
    mkdirSync(join(root, ".ssh"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    symlinkSync(outside, join(root, "link"));
    writeFileSync(join(root, "ok.md"), "");
    const entries = listDirectory(root, "").entries;
    expect(entries.map((e) => e.name)).toEqual(["node_modules", "ok.md"]);
    expect(entries[0]).toMatchObject({ ignored: true, path: "node_modules" });
  });

  test("拒绝绝对路径、越界与符号链接逃逸，不存在或不是目录也报错", () => {
    const root = workdir();
    const outside = workdir();
    writeFileSync(join(root, "f.txt"), "");
    symlinkSync(outside, join(root, "escape"));
    expect(() => listDirectory(root, outside)).toThrow("inside the workspace");
    expect(() => listDirectory(root, "../")).toThrow("inside the workspace");
    expect(() => listDirectory(root, "escape")).toThrow("inside the workspace");
    expect(() => listDirectory(root, "nope")).toThrow("does not exist");
    expect(() => listDirectory(root, "f.txt")).toThrow("not a directory");
  });

  test("一层超过上限时截断并返回总数", () => {
    const root = workdir();
    for (let i = 0; i < TREE_LIMIT + 5; i += 1) writeFileSync(join(root, `f${String(i).padStart(4, "0")}.txt`), "");
    const listing = listDirectory(root, "");
    expect(listing.entries).toHaveLength(TREE_LIMIT);
    expect(listing.truncated).toBe(true);
    expect(listing.total).toBe(TREE_LIMIT + 5);
  });
});
