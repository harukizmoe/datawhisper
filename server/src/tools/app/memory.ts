/**
 * `memory_read`：读取长期记忆记录正文。
 *
 * 读取端已由 `agent/memory.ts` 移植（`readMemory`）。写入/抽取属于 P3.3，
 * 这里只把目录从依赖注入传入，沿用旧实现的不可用文案。
 */

import { readMemory } from "../../agent/memory.ts";
import { makeAppTool, okResult, type AppTool, type AppToolDeps } from "./types.ts";

export function createMemoryTools(deps: AppToolDeps): AppTool[] {
  return [
    makeAppTool<{ name: string }>({
      name: "memory_read",
      description:
        "Read the full body of a named long-term memory record from the current user and workspace scope only. Use only when the injected memory index identifies a relevant record.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The kebab-case memory name from the long-term memory index." },
        },
        required: ["name"],
      },
      replay: "safe",
      async execute(args) {
        if (deps.memoryDirs === undefined) {
          return okResult("memory_read", "Memory record is unavailable in the current scope.", {
            tool: "memory_read",
            available: false,
          });
        }
        const text = readMemory(String(args.name ?? ""), deps.memoryDirs);
        return okResult("memory_read", text, {
          tool: "memory_read",
          available: !text.startsWith("Memory record is unavailable"),
          name: String(args.name ?? ""),
        });
      },
    }),
  ];
}
