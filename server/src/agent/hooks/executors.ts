/**
 * Hook action executors (port of `agent/hooks/executors.py`).
 *
 * - `prompt` returns the expanded message. Nothing is dispatched by the executor itself; the engine collects prompt
 *   output and injects it into the turn.
 * - `http` posts a JSON body (JSON separators and unicode exactly like `json.dumps(..., ensure_ascii=False)`) and keeps
 *   only the first 4096 bytes of the response. Non-2xx is an error whose text matches Python's `HTTPError`:
 *   `HTTP Error 404: Not Found`. Redirects are followed, GET/HEAD never carry a body.
 * - `command` runs argv with no shell, after `shlex.split` (POSIX rules off Windows) and expansion, killed at
 *   `timeout` seconds. The result is `stdout or stderr`, stripped, truncated to 4000 code points.
 */
import { STATUS_CODES } from "node:http";
import { pyHead, pyStrip } from "../py-compat.ts";
import type { Action, ActionResult, HookContext } from "./models.ts";
import { jsonDumps } from "./models.ts";
import { ShlexError, shlexSplit } from "./shlex.ts";

/** `subprocess.run(..., text=True)` with universal newlines and UTF-8 decoding. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface TimerApi {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}

export interface ExecutorDeps {
  /** Engine-wide `allow_command_hooks` gate. */
  allowCommand?: boolean;
  fetch?: typeof fetch;
  /** Spawns argv and resolves when the process exits or `timeoutMs` elapses (the process is then killed). */
  spawn?: (args: string[], timeoutMs: number) => Promise<CommandResult & { timedOut?: boolean }>;
  timers?: TimerApi;
}

const WINDOWS = process.platform === "win32";

export async function executeAction(
  action: Action,
  ctx: HookContext,
  deps: ExecutorDeps = {},
): Promise<ActionResult> {
  if (action.type === "prompt") {
    return { output: String(ctx.expand(action.message)), success: true };
  }
  if (action.type === "http") return executeHttp(action, ctx, deps);
  if (action.type === "command") {
    if (!deps.allowCommand) return { output: "command hooks are disabled", success: false };
    return executeCommand(action, ctx, deps);
  }
  return { output: `unsupported hook action: ${action.type}`, success: false };
}

async function executeCommand(action: Action, ctx: HookContext, deps: ExecutorDeps): Promise<ActionResult> {
  let args: string[];
  try {
    args = shlexSplit(String(ctx.expand(action.command)), !WINDOWS);
  } catch (error) {
    if (error instanceof ShlexError) return { output: `invalid command syntax: ${error.message}`, success: false };
    throw error;
  }
  if (args.length === 0) return { output: "command is empty", success: false };
  const result = await (deps.spawn ?? spawnCommand)(args, action.timeout * 1000);
  if (result.timedOut) return { output: `command timed out after ${action.timeout}s`, success: false };
  const output = pyStrip(result.stdout || result.stderr || "");
  return { output: pyHead(output, 4000), success: result.exitCode === 0 };
}

/** argv with `shell: false`; the process is killed when the timeout elapses. */
async function spawnCommand(args: string[], timeoutMs: number): Promise<CommandResult & { timedOut?: boolean }> {
  const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Python's `subprocess.run` kills the child on TimeoutExpired (SIGKILL on POSIX).
    proc.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    // `text=True` translates newlines.
    return {
      stdout: stdout.replace(/\r\n?/g, "\n"),
      stderr: stderr.replace(/\r\n?/g, "\n"),
      exitCode: timedOut ? null : exitCode,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function executeHttp(action: Action, ctx: HookContext, deps: ExecutorDeps): Promise<ActionResult> {
  const url = String(ctx.expand(action.url));
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { output: "http action only supports http:// and https:// URLs", success: false };
  }
  const method = (action.method || "POST").toUpperCase();
  const body = ctx.expand(action.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(ctx.expand(action.headers) as Record<string, string>),
  };
  const data = body !== null && body !== undefined && method !== "GET" && method !== "HEAD" ? jsonDumps(body) : undefined;

  const timers = deps.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown,
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const controller = new AbortController();
  const timer = timers.set(() => controller.abort(), action.timeout * 1000);
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method,
      headers,
      body: data,
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status < 200 || response.status >= 300) {
      const reason = STATUS_CODES[response.status] ?? response.statusText ?? "";
      return { output: `HTTP Error ${response.status}: ${reason}`, success: false };
    }
    return { output: new TextDecoder("utf-8").decode((await response.arrayBuffer()).slice(0, 4096)), success: true };
  } catch (error) {
    return { output: httpErrorText(error), success: false };
  } finally {
    timers.clear(timer);
  }
}

const ERRNO_TEXT: Readonly<Record<string, [number, string]>> = {
  ECONNREFUSED: [111, "Connection refused"],
  ECONNRESET: [104, "Connection reset by peer"],
  EHOSTUNREACH: [113, "No route to host"],
  ENETUNREACH: [101, "Network is unreachable"],
  ETIMEDOUT: [110, "Connection timed out"],
  ENOTFOUND: [-2, "Name or service not known"],
};

/** `str(exc)` for a urllib failure: the text `urlopen` would have raised with. */
function httpErrorText(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "<urlopen error timed out>";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ERRNO_TEXT[code]) {
    const [errno, text] = ERRNO_TEXT[code]!;
    return `<urlopen error [Errno ${errno}] ${text}>`;
  }
  return error instanceof Error ? error.message : String(error);
}
