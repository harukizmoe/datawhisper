/**
 * Rebuilds the "dynamic" fixture trees that scripts/golden/export_skills.py describes as data
 * (huge files, symlinks, invalid UTF-8, mtimes), so TS tests and the Python generator see identical trees.
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

/** Repository root (this file lives in server/test/support). */
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

/** Removes a file, mirroring the generator's `remove` op. */
export function removeFile(root: string, relative: string): void {
  unlinkSync(join(root, relative));
}

/** POSIX path relative to `base`, like the generator's `os.path.relpath`. */
export function relativeTo(base: string, path: string): string {
  return relative(base, path).split("\\").join("/");
}
