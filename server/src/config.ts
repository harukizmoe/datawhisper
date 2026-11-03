import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Environment contract with the desktop supervisor (Go):
 *   DW_TOKEN     bearer token for every /v1 request (generated here when absent, for development)
 *   DW_PORT      port on 127.0.0.1 (default 0 = any free port; the ready line reports it)
 *   DW_DATA_DIR  app data directory (default: per-OS user data dir)
 *   DW_PYTHON    Python interpreter or frozen compute executable (default: <repo>/.venv/bin/python)
 *   DW_COMPUTE_CWD  working directory of the compute worker (default: repo root)
 */
export type Config = {
  host: "127.0.0.1";
  port: number;
  token: string;
  tokenGenerated: boolean;
  dataDir: string;
  python: string;
  computeCwd: string;
};

const REPO_ROOT = resolve(import.meta.dir, "../..");

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const token = env.DW_TOKEN ?? "";
  const port = Number(env.DW_PORT ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`DW_PORT is not a port: ${env.DW_PORT}`);
  return {
    host: "127.0.0.1",
    port,
    token: token || randomBytes(32).toString("base64url"),
    tokenGenerated: token === "",
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
