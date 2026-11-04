import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputeClient } from "../compute/client.ts";
import type { Config } from "../config.ts";
import { createAppTools } from "../tools/app/index.ts";
import { createDirectoryArtifactSource } from "../tools/app/artifacts.ts";
import { NodeWorkspaceFs } from "../tools/app/workspace/fs.ts";
import { createComputeTools } from "../tools/compute/index.ts";
import { createToolResultStore, type ToolResultStore } from "../tools/guard/spill.ts";

/**
 * 生产环境的工具集装配。
 *
 * 旧实现在 `agent/agent.py` 里按会话拼工具；新实现把「有哪些工具」与「本轮暴露哪些」分开：
 * 这里只决定前者（全部工具对象），后者由 `tools/select.ts` 按轮收敛。
 *
 * 组装原则：能纯 TS 做的（A 类）直接用；需要 pandas/DuckDB/Plotly 的（B 类）交给 compute 子进程；
 * 两者共用同一份 `tool_results` 外溢目录，`read_tool_result` 才能读到 B 类工具外溢的内容。
 */
export type ToolAssembly = {
  readonly tools: readonly ToolRegistration[];
  /** 外溢目录：外溢器与 `read_tool_result` 必须是同一个 store，否则读不到彼此写的制品。 */
  readonly toolResults: ToolResultStore;
};

export function assembleTools(config: Config, compute: ComputeClient, sessionId: string): ToolAssembly {
  const toolResults = createToolResultStore({ dirs: [join(config.dataDir, "tool_results")] });
  const workspace = new NodeWorkspaceFs({ dataRoot: config.dataDir, resourceRoot: config.dataDir });
  const appTools = createAppTools({
    workspace,
    sessionId,
    artifacts: createDirectoryArtifactSource({ dirs: [join(config.dataDir, "tool_results")], allowed: [] }),
    memoryDirs: { userDir: join(config.dataDir, "memory") },
    skillDirs: { builtinDir: join(config.computeCwd, "skills") },
    fetch: globalThis.fetch,
  });
  const computeTools = createComputeTools({ compute });
  return { tools: [...appTools, ...computeTools], toolResults };
}
