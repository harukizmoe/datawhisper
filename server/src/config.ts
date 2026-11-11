import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * 与桌面 supervisor（Go）之间的环境变量契约。传输本身是进程的 stdin/stdout，因此这里没有端口与令牌：
 *
 *   DW_DATA_DIR     应用数据目录（默认：按操作系统的用户数据目录）
 *   DW_PYTHON       Python 解释器或冻结的 compute 可执行文件（默认：仓库里的 .venv，编译后用同目录的 datawhisper-compute）
 *   DW_COMPUTE_CWD  compute worker 的工作目录（默认：仓库根；编译后是资源根）
 *   DW_PROJECT_ROOT 工作区/数据源文件的根（默认：仓库根；编译后是数据目录）
 *
 * 编译后的服务（`bun build --compile`）没有仓库目录：`import.meta.dir` 是 Bun 的虚拟路径
 * `/$bunfs/root`（Windows 上是 `B:\~BUN\root`），所以默认值必须从 `process.execPath` 推算。
 */
export type Config = {
  dataDir: string;
  python: string;
  computeCwd: string;
  projectRoot: string;
};

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** 服务是否由 `bun build --compile` 编译（运行时没有仓库目录）。 */
function isCompiled(): boolean {
  const dir = import.meta.dir;
  return dir.includes("$bunfs") || dir.includes("~BUN");
}

/** 编译后：服务在 <资源根>/bin/datawhisper-server，所以上一级就是资源根。 */
const BUNDLE_ROOT = resolve(dirname(process.execPath), "..");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = resolve(env.DW_DATA_DIR || defaultDataDir(env));
  const compiled = isCompiled();
  return {
    dataDir,
    python: env.DW_PYTHON || (compiled ? bundledCompute() : join(REPO_ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")),
    computeCwd: env.DW_COMPUTE_CWD || (compiled ? BUNDLE_ROOT : REPO_ROOT),
    // 工作区文件的根：源码模式是仓库，打包后是用户数据目录（资源目录是只读的）。
    projectRoot: env.DW_PROJECT_ROOT || (compiled ? dataDir : REPO_ROOT),
  };
}

/** 随包的 compute 可执行文件：与服务同一个 bin/ 目录。 */
function bundledCompute(): string {
  const name = process.platform === "win32" ? "datawhisper-compute.exe" : "datawhisper-compute";
  return join(dirname(process.execPath), name);
}

function defaultDataDir(env: Record<string, string | undefined>): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "DataWhisper");
  if (process.platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "DataWhisper");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "datawhisper");
}
