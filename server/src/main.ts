/**
 * Agent 服务入口，由桌面应用作为子进程启动。
 *
 * 就绪记录：stdout 的第一行是 `{"type":"ready","pid":<n>}`；此后 stdout 只承载 JSON-RPC 记录，
 * 所有日志（含 pi-durable 的 `onReport`、compute 的 stderr）都走 stderr。
 * 生命周期：收到 SIGTERM/SIGINT，或 stdin 读到 EOF（父进程已退出），都走同一个优雅退出：先给所有
 * 订阅发 `end`，再关闭 compute 与 Harness。存储失败会关闭 Harness；随后进程以退出码 1 退出，交由
 * supervisor 重启，由 `resume()` 继续被中断的工作。
 */
import { loadConfig } from "./config.ts";
import { attachIpc } from "./ipc/attach.ts";
import { type Service, startService } from "./service.ts";

let service: Service | undefined;
let exiting = false;
async function shutdown(exitCode: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  try {
    await service?.stop();
  } finally {
    process.exit(exitCode);
  }
}

// 先装信号处理器再启动服务：父进程一看到 ready 就可能发 SIGTERM，晚装会按默认动作直接终止。
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));

service = await startService(loadConfig());

process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);

if (process.stdin.isTTY) {
  // 交互式终端里没有对端发请求；读 stdin 只会把键盘输入当成坏记录。
  console.error("[ipc] stdin 是终端，不读取请求");
} else {
  attachIpc(service, { input: process.stdin, output: process.stdout }, { onInputEnd: () => void shutdown(0) });
}

void service.closed.then((end) => {
  if (end.kind === "failed") {
    console.error("[harness] closed after a storage failure:", end.error);
    void shutdown(1);
  }
});
