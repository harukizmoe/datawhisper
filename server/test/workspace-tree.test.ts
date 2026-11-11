import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory, listPendingFiles, TREE_LIMIT, workspaceTreeMethods } from "../src/ipc/workspace-tree.ts";

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

describe("import state", () => {
  /** 写一条 compute 会写的 registry 记录：大小与修改时间取自文件本身。 */
  function record(root: string, rel: string) {
    const full = join(root, rel);
    const stats = statSync(full);
    const registryFile = join(root, ".zhixi", "registry.json");
    mkdirSync(join(root, ".zhixi"), { recursive: true });
    const registry = existsSync(registryFile) ? JSON.parse(readFileSync(registryFile, "utf8")) : {};
    registry[rel] = { sha256: "x", size: stats.size, mtime_ns: Math.round(stats.mtimeMs * 1e6), tables: ["t"] };
    writeFileSync(registryFile, JSON.stringify(registry));
  }

  test("没导入 / 已导入 / 导入后变了三种状态，目录带上子树里的待导入数", () => {
    const root = workdir();
    mkdirSync(join(root, "reports", "q1"), { recursive: true });
    writeFileSync(join(root, "ready.csv"), "a,b\n1,2\n");
    writeFileSync(join(root, "fresh.csv"), "a\n1\n");
    writeFileSync(join(root, "reports", "q1", "old.xlsx"), "x");
    record(root, "ready.csv");
    record(root, "reports/q1/old.xlsx");

    let listing = listDirectory(root, "");
    expect(listing.entries.find((e) => e.name === "ready.csv")).toMatchObject({ importState: "imported" });
    expect(listing.entries.find((e) => e.name === "fresh.csv")).toMatchObject({ importState: "new" });
    // reports 里只有已导入的文件，不该有圆点。
    expect(listing.entries.find((e) => e.name === "reports/q1")).toMatchObject({ pending: 0 });
    expect(listing.entries.find((e) => e.name === "fresh.csv")!.pending).toBe(0);

    // 改动一个已导入文件：它变成 changed，祖先目录各 +1。
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "reports", "q1", "old.xlsx"), later, later);
    listing = listDirectory(root, "");
    expect(listing.entries.find((e) => e.name === "reports/q1")).toMatchObject({ pending: 1 });
    const nested = listDirectory(root, "reports/q1");
    expect(nested.entries[0]).toMatchObject({ importState: "changed" });

    // 目录行自己不带导入状态，文件行的 pending 恒为 0。
    expect(listing.entries.find((e) => e.name === "reports/q1")!.importState).toBe("none");
    expect(listDirectory(root, "reports/q1").entries[0]!.pending).toBe(0);
  });

  test("非数据文件没有导入状态；registry 损坏时按「没导入」处理", () => {
    const root = workdir();
    writeFileSync(join(root, "notes.md"), "hi");
    writeFileSync(join(root, "data.csv"), "a\n1\n");
    mkdirSync(join(root, ".zhixi"));
    writeFileSync(join(root, ".zhixi", "registry.json"), "{not json");
    const entries = listDirectory(root, "").entries;
    expect(entries.find((e) => e.name === "notes.md")).toMatchObject({ importState: "none", data: false });
    expect(entries.find((e) => e.name === "data.csv")).toMatchObject({ importState: "new", data: true });
  });
});

describe("listPendingFiles", () => {
  test("只列没导入或已变化的数据文件，按路径排序；注册表里的条目按大小与时间判断", () => {
    const root = workdir();
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "b.csv"), "b\n1\n");
    writeFileSync(join(root, "a.csv"), "a\n1\n");
    writeFileSync(join(root, "reports", "c.xlsx"), "c");
    writeFileSync(join(root, "notes.md"), "x");
    const stats = statSync(join(root, "a.csv"));
    mkdirSync(join(root, ".zhixi"));
    writeFileSync(
      join(root, ".zhixi", "registry.json"),
      JSON.stringify({ "a.csv": { sha256: "x", size: stats.size, mtime_ns: Math.round(stats.mtimeMs * 1e6) } }),
    );
    const { files, truncated } = listPendingFiles(root);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.state])).toEqual([
      ["b.csv", "new"],
      ["reports/c.xlsx", "new"],
    ]);
  });

  test("两个 RPC 都注册了", () => {
    const methods = workspaceTreeMethods({ workspaces: { list: async () => [], get: async () => undefined, put: async () => {}, remove: async () => {} } });
    expect(Object.keys(methods).sort()).toEqual(["workspace.pending", "workspace.tree"]);
  });
});
