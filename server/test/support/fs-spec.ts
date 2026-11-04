/**
 * 重建 scripts/golden/export_skills.py 以数据形式描述的 "dynamic" fixture 目录树
 * （超大文件、符号链接、非法 UTF-8、mtime），使 TS 测试与 Python 生成器看到完全相同的树。
 */
import { mkdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type FsEntry =
  | string
  | {
      text?: string;
      b64?: string;
      repeat?: { head?: string; unit: string; times: number; tail?: string };
      link?: string;
      dir?: true;
      mtime?: number;
    };

export type FsSpec = Record<string, FsEntry>;

/** 仓库根目录（本文件位于 server/test/support）。 */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");
export const FIXTURES = join(REPO_ROOT, "server", "test", "fixtures");
export const GOLDEN = join(REPO_ROOT, "server", "test", "golden");

export function materialize(root: string, files: FsSpec): void {
  for (const [relative, raw] of Object.entries(files)) {
    const entry = typeof raw === "string" ? { text: raw } : raw;
    const path = join(root, relative);
    if (entry.dir) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (entry.link !== undefined) {
      symlinkSync(entry.link, path);
      continue;
    }
    let data: Uint8Array | string;
    if (entry.b64 !== undefined) data = Buffer.from(entry.b64, "base64");
    else if (entry.repeat) data = (entry.repeat.head ?? "") + entry.repeat.unit.repeat(entry.repeat.times) + (entry.repeat.tail ?? "");
    else data = entry.text ?? "";
    writeFileSync(path, data);
    if (entry.mtime !== undefined) utimesSync(path, entry.mtime, entry.mtime);
  }
}

/** 删除文件，对应生成器的 `remove` 操作。 */
export function removeFile(root: string, relative: string): void {
  unlinkSync(join(root, relative));
}

/** 相对于 `base` 的 POSIX 路径，类似生成器的 `os.path.relpath`。 */
export function relativeTo(base: string, path: string): string {
  return relative(base, path).split("\\").join("/");
}
