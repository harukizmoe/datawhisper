#!/usr/bin/env node
/**
 * 测试用的最小 MCP stdio 服务器：只在 stdin/stdout 上跑 JSON-RPC 2.0，不依赖任何包。
 *
 * 工具：
 * - echo {message}          原样回显
 * - add {a,b}               求和（验证参数校验）
 * - fail                    返回 isError 结果
 * - rpc_fail                返回 JSON-RPC error 对象
 * - slow {delay_ms}         延迟响应（测并发/超时）
 * - crash                   直接退出进程（测崩溃重连）
 * - needs_env               返回 FAKE_TOKEN 环境变量（测 env 透传）
 * - big                     返回 60KB 文本（测外溢接口）
 *
 * 环境变量 FAKE_START_FILE：每次进程启动追加一行 "start"，测试用它确认重启次数。
 */

import { appendFileSync } from "node:fs";

if (process.env.FAKE_START_FILE) appendFileSync(process.env.FAKE_START_FILE, "start\n");

const TOOLS = [
  { name: "echo", description: "Echo a message back.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "add", description: "Add two integers.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] } },
  { name: "fail", description: "Always fail with an isError result.", inputSchema: { type: "object", properties: {} } },
  { name: "rpc_fail", description: "Always fail with a JSON-RPC error.", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Respond after a delay.", inputSchema: { type: "object", properties: { delay_ms: { type: "integer" } }, required: ["delay_ms"] } },
  { name: "crash", description: "Exit the process without responding.", inputSchema: { type: "object", properties: {} } },
  { name: "needs_env", description: "Return the FAKE_TOKEN environment variable.", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "Return a large text block.", inputSchema: { type: "object", properties: {} } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0.1" } } });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method !== "tools/call") {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
    return;
  }
  const name = params?.name;
  const args = params?.arguments ?? {};
  switch (name) {
    case "echo":
      send({ jsonrpc: "2.0", id, result: textResult(String(args.message ?? "")) });
      return;
    case "add":
      send({ jsonrpc: "2.0", id, result: textResult(String(Number(args.a) + Number(args.b))) });
      return;
    case "fail":
      send({ jsonrpc: "2.0", id, result: textResult("boom from fake server", true) });
      return;
    case "rpc_fail":
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "rpc exploded" } });
      return;
    case "slow":
      setTimeout(() => send({ jsonrpc: "2.0", id, result: textResult(`slept ${args.delay_ms}`) }), Number(args.delay_ms) || 0);
      return;
    case "crash":
      process.exit(3);
      return;
    case "needs_env":
      send({ jsonrpc: "2.0", id, result: textResult(String(process.env.FAKE_TOKEN ?? "")) });
      return;
    case "big":
      send({ jsonrpc: "2.0", id, result: textResult("x".repeat(60_000)) });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    const text = line.trim();
    if (text === "") continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    // 每个请求独立处理：故意不排队，便于验证客户端并发。
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
