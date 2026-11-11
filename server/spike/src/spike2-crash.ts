// Spike 2: crash resume + requestId dedupe. The stub model runs here (parent) so its request
// count survives child crashes; the Harness runs in a child process that is SIGKILLed mid-tool.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { startStub } from "./stub-openai.ts";

for (const f of ["spike2.sqlite", "spike2.sqlite-wal", "spike2.sqlite-shm", "slow_safe.count", "slow_unsafe.count"])
  rmSync(`.data/${f}`, { force: true });

const stub = startStub();
const counter = (name: string) => (existsSync(`.data/${name}.count`) ? readFileSync(`.data/${name}.count`, "utf8").trim().split("\n").length : 0);

/** Run the child; resolve with its stdout lines. With `killOn`, SIGKILL it `killDelayMs` after a line matches. */
async function child(args: string[], killOn?: RegExp, killDelayMs = 1500) {
  const proc = Bun.spawn(["bun", "run", "src/spike2-child.ts", stub.url, ...args], { stdout: "pipe", stderr: "inherit" });
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      console.log(`  [child ${proc.pid}] ${line}`);
      if (killOn?.test(line)) {
        await Bun.sleep(killDelayMs);
        proc.kill("SIGKILL");
        console.log(`  [parent] SIGKILL ${proc.pid}`);
      }
    }
  }
  const code = await proc.exited;
  console.log(`  [parent] child exited code=${code} signal=${proc.signalCode}`);
  return { lines, signal: proc.signalCode };
}

const results: Record<string, boolean> = {};

console.log("== A. replay:safe tool, SIGKILL mid-tool, then resume()");
const a1 = await child(["submit", "req-safe", "run it CALL:slow_safe"], /TOOL_START slow_safe/);
const submittedId = a1.lines.find((l) => l.startsWith("SUBMITTED"))?.split(" ")[1];
console.log(`  stub requests so far=${stub.log.length}, slow_safe executions=${counter("slow_safe")}`);
const a2 = await child(["resume"]);
console.log(`  stub requests=${stub.log.length}, slow_safe executions=${counter("slow_safe")}`);
results["A killed by SIGKILL"] = a1.signal === "SIGKILL";
results["A safe tool rerun after resume (2 executions)"] = counter("slow_safe") === 2;
results["A run completed with final answer"] = a2.lines.some((l) => l.startsWith("ENTRY pi.assistant text:"));
results["A model called exactly twice (tool call + final)"] = stub.log.length === 2;

console.log("== B. resubmit same requestId");
const before = stub.log.length;
const b = await child(["submit", "req-safe", "run it CALL:slow_safe"]);
const resubmittedId = b.lines.find((l) => l.startsWith("SUBMITTED"))?.split(" ")[1];
console.log(`  first id=${submittedId} resubmitted id=${resubmittedId} stub requests before=${before} after=${stub.log.length}`);
results["B same submission id"] = submittedId !== undefined && submittedId === resubmittedId;
results["B settled done"] = b.lines.some((l) => l === `SETTLED ${resubmittedId} done`);
results["B model not called again"] = stub.log.length === before;
results["B tool not rerun"] = counter("slow_safe") === 2;

console.log("== C. replay:unsafe tool, SIGKILL mid-tool, then resume()");
const c1 = await child(["submit", "req-unsafe", "run it CALL:slow_unsafe"], /TOOL_START slow_unsafe/);
const c2 = await child(["resume"]);
const lastRequest = stub.log[stub.log.length - 1]!;
console.log(`  slow_unsafe executions=${counter("slow_unsafe")}; last model request saw tool result: ${JSON.stringify(lastRequest.lastTool)}`);
results["C killed by SIGKILL"] = c1.signal === "SIGKILL";
results["C unsafe tool not rerun (1 execution)"] = counter("slow_unsafe") === 1;
results["C model told interrupted"] = /interrupt/i.test(lastRequest.lastTool ?? "");
results["C run completed"] = c2.lines.filter((l) => l.startsWith("ENTRY pi.assistant text:")).length === 2;

console.log("== stub request log");
for (const r of stub.log) console.log(`  #${r.n} roles=${r.roles.join(",")} lastUser=${JSON.stringify(r.lastUser)} lastTool=${JSON.stringify(r.lastTool)}`);
console.log("== results");
for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
const ok = Object.values(results).every(Boolean);
console.log(ok ? "SPIKE2 PASS" : "SPIKE2 FAIL");
stub.stop();
process.exit(ok ? 0 : 1);
