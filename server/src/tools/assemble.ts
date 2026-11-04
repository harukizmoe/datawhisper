import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputeClient } from "../compute/client.ts";
import type { Config } from "../config.ts";
import { createAppTools } from "../tools/app/index.ts";
import { createDirectoryArtifactSource } from "../tools/app/artifacts.ts";
import { NodeWorkspaceFs } from "../tools/app/workspace/fs.ts";
import { createComputeTools } from "../tools/compute/index.ts";
import { createToolResultStore, type ToolResultStore } from "../tools/guard/spill.ts";
import { createConversationDocs } from "../tools/app/docs.ts";
import type { AppDocHosts, TeamDelegationPort } from "../tools/app/types.ts";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, ToolExecutionApi } from "@earendil-works/pi-durable";

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

export type AssembleOptions = {
  /** Harness 本身：装配在 `Harness.open` 之前完成，所以按需取（工具执行时一定已经就绪）。 */
  readonly harness: () => Harness;
  readonly context: Context;
  /**
   * 团队委托端口。工具集在 `Harness.open` 之前就要装进注册表，而委托服务需要会话服务，
   * 所以这里用一个迟绑定的转发器：装配时给对象，会话服务就绪后再填 `current`。
   */
  readonly teamDelegation?: { current?: TeamDelegationPort };
};

export function assembleTools(config: Config, compute: ComputeClient, sessionId: string, options: AssembleOptions): ToolAssembly {
  const toolResults = createToolResultStore({ dirs: [join(config.dataDir, "tool_results")] });
  const workspace = new NodeWorkspaceFs({ dataRoot: config.dataDir, resourceRoot: config.dataDir });
  // 任务板/团队/动态计划是会话级文档：按调用时的会话现取，一套工具对象服务所有会话。
  const docsFor = (api: ToolExecutionApi<never>): AppDocHosts => {
    const conversationId = api.conversationId as unknown as ConversationId;
    // `createConversationDocs` 只用到会话 id 与 commit，执行上下文正好提供这两样。
    return createConversationDocs({
      harness: options.harness(),
      context: options.context,
      conversation: { id: conversationId, commit: api.commit },
    });
  };
  const delegation = options.teamDelegation;
  const teamDelegate: TeamDelegationPort | undefined =
    delegation === undefined
      ? undefined
      : {
          run: (request) => {
            if (delegation.current === undefined) throw new Error("team delegation is not wired yet");
            return delegation.current.run(request);
          },
          cancel: (teamName, memberName) =>
            delegation.current === undefined ? Promise.resolve(0) : delegation.current.cancel(teamName, memberName),
          active: () => delegation.current?.active() ?? [],
        };
  const appTools = createAppTools({
    workspace,
    sessionId,
    docs: docsFor,
    ...(teamDelegate === undefined ? {} : { teamDelegate }),
    artifacts: createDirectoryArtifactSource({ dirs: [join(config.dataDir, "tool_results")], allowed: [] }),
    memoryDirs: { userDir: join(config.dataDir, "memory") },
    skillDirs: { builtinDir: join(config.computeCwd, "skills") },
    fetch: globalThis.fetch,
  });
  const computeTools = createComputeTools({ compute });
  return { tools: [...appTools, ...computeTools], toolResults };
}
