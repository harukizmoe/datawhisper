import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 与桌面 supervisor（Go）之间的环境变量契约。传输本身是进程的 stdin/stdout，因此这里没有端口与令牌：
 *
 *   DW_DATA_DIR  应用数据目录（默认：按操作系统的用户数据目录）
 *   DW_PYTHON    Python 解释器或冻结的 compute 可执行文件（默认：<repo>/.venv/bin/python）
 *   DW_COMPUTE_CWD  compute worker 的工作目录（默认：仓库根目录）
 */
export type Config = {
  dataDir: string;
  python: string;
  computeCwd: string;
};

const REPO_ROOT = resolve(import.meta.dir, "../..");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    dataDir: resolve(env.DW_DATA_DIR || defaultDataDir(env)),
    python: env.DW_PYTHON || join(REPO_ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"),
    computeCwd: env.DW_COMPUTE_CWD || REPO_ROOT,
  };
}

function defaultDataDir(env: Record<string, string | undefined>): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "DataWhisper");
  if (process.platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "DataWhisper");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "datawhisper");
}
