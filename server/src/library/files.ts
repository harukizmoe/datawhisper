/**
 * 库视图的落盘小工具：目录创建、原子替换、JSON 读写与文件名清洗。
 *
 * 这里的写入都是「同目录临时文件 + rename」：进程在写到一半时被杀，旧文件仍然是完整的；
 * 不会留下半截 JSON 或半截记忆记录。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 先写 `<path>.<pid>.<随机>.tmp`，再 rename；失败时删掉临时文件。 */
export function writeAtomic(path: string, text: string): void {
  ensureDir(dirname(path));
  const temp = join(dirname(path), `.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 清理失败不能盖住真正的错误。
    }
    throw error;
  }
}

/** 读 JSON；文件不存在返回 undefined，内容不是合法 JSON 时抛出。 */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text);
}

export function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 秒级 UTC 时间戳，与旧 Python 存储的 `isoformat(timespec="seconds")` 形状一致。 */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 旧代码的文件名规则：路径分隔符与控制字符替换为 `_`，去掉首尾空白。
 * 不限制为 ASCII，中文标题保持原样（与 Python 的 `re.sub(r'[\\/:*?"<>|]', "_", name)` 一致）。
 */
export function safeFileStem(name: string, fallback: string): string {
  const stem = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (stem || fallback).slice(0, 120);
}
