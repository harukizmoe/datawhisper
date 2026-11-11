import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ComputeClient } from "../compute/client.ts";
import type { Config } from "../config.ts";
import { createAppTools } from "../tools/app/index.ts";
import { NodeWorkspaceFs, type WorkspaceFs } from "../tools/app/workspace/fs.ts";
import { createComputeTools } from "../tools/compute/index.ts";
import { withConversationSources } from "../tools/compute/inject.ts";
import { withChartPersistence } from "../tools/compute/persist.ts";
import type { SourceDoc, SourceDocStore } from "../ipc/source-store.ts";
import { isDirectory, type WorkspaceRecord, type WorkspaceStore } from "../ipc/workspace-store.ts";
import { say } from "../i18n.ts";
import { createToolResultStore, type ToolResultStore } from "../tools/guard/spill.ts";
import { createConversationDocs } from "../tools/app/docs.ts";
import type { AppDocHosts, IngestPort, TeamDelegationPort } from "../tools/app/types.ts";
import type { WorkflowCatalog } from "../workflows/catalog.ts";
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
  /** 工作流目录的迟绑定端口（目录依赖会话服务，工具先装配）。 */
  readonly workflowCatalog?: { current?: WorkflowCatalog };
  /**
   * 会话的来源文档：B 类工具每次调用都要知道本会话在用哪些来源（compute worker 是跨会话共享的）。
   * 省略时 B 类工具不带数据上下文，只会得到 compute 原文的「no data source」。
   */
  readonly sources?: () => SourceDocStore;
  /** 工作区注册表：对话的 scope 指向其中一条记录。省略时所有对话都按普通聊天处理。 */
  readonly workspaces?: WorkspaceStore;
  /** 抓取/飞书工具的来源登记端口；由 `sourceMethods` 在装配后填 `ingest`（迟绑定）。 */
  readonly ingest?: { ingest?: IngestPort };
};

export function assembleTools(config: Config, compute: ComputeClient, sessionId: string, options: AssembleOptions): ToolAssembly {
  const toolResults = createToolResultStore({ dirs: [join(config.dataDir, "tool_results")] });
  const workspace = new NodeWorkspaceFs({ dataRoot: config.dataDir, resourceRoot: config.dataDir });
  /** 工作区对话所属的工作区记录；普通聊天为 undefined。记录或目录没了就抛错，不静默退回普通聊天。 */
  const workspaceOf = async (doc: SourceDoc): Promise<WorkspaceRecord | undefined> => {
    if (doc.scope?.kind !== "workspace") return undefined;
    const record = await options.workspaces?.get(doc.scope.workspaceId);
    if (record === undefined || !isDirectory(record.workdir)) {
      throw new Error(
        say(
          `The workspace for this conversation is not available${record === undefined ? "" : `: ${record.workdir}`}.`,
          `本对话所属的工作区不可用${record === undefined ? "" : `：${record.workdir}`}。`,
        ),
      );
    }
    return record;
  };
  /** 每个目录一个文件系统实例：编辑前必须先读的跟踪状态随之保持。 */
  const workspaceFsCache = new Map<string, WorkspaceFs>();
  /** 文件类工具按调用的会话选文件系统：工作区对话得到挂载了该目录的实例，普通聊天得到无用户目录的那份。 */
  const workspaceFor = async (api: ToolExecutionApi<never>): Promise<WorkspaceFs> => {
    if (options.sources === undefined) return workspace;
    const doc = await options.sources().read(api.conversationId as unknown as number).catch(() => undefined);
    const record = doc === undefined ? undefined : await workspaceOf(doc);
    if (record === undefined) return workspace;
    const key = record.workdir;
    let instance = workspaceFsCache.get(key);
    if (instance === undefined) {
      instance = new NodeWorkspaceFs({
        dataRoot: config.dataDir,
        resourceRoot: config.dataDir,
        userRoot: record.workdir,
        // 写入由权限模式在 `beforeTool` 里把关；文件系统层只负责目录边界与敏感文件过滤。
        userPermission: "read_write",
        metaDir: join(record.workdir, ".zhixi"),
        cacheDir: join(record.workdir, ".baa_cache"),
      });
      workspaceFsCache.set(key, instance);
    }
    return instance;
  };
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
    workspaceFor,
    sessionId,
    ...(options.workflowCatalog === undefined ? {} : { workflows: options.workflowCatalog }),
    docs: docsFor,
    ...(teamDelegate === undefined ? {} : { teamDelegate }),
    // 外溢器与 `read_tool_result` 必须共用同一个 store：否则模型拿不到自己刚外溢的结果
    // （store 同时实现 `ToolResultArtifactSource`，allowlist 就在它内部按会话维护）。
    artifacts: toolResults,
    memoryDirs: { userDir: join(config.dataDir, "memory") },
    skillDirs: { builtinDir: join(config.computeCwd, "skills") },
    fetch: globalThis.fetch,
    ...(options.ingest === undefined
      ? {}
      : {
          ingest: {
            fetchTables: (conversationId, request) => {
              const port = options.ingest!.ingest;
              if (port === undefined) throw new Error("Table ingestion is not wired yet.");
              return port.fetchTables(conversationId, request);
            },
            loadBitable: (conversationId, read, sourceName) => {
              const port = options.ingest!.ingest;
              if (port === undefined) throw new Error("Table ingestion is not wired yet.");
              return port.loadBitable(conversationId, read, sourceName);
            },
          },
        }),
  });
  const computeTools = createComputeTools({ compute });
  const readSources = options.sources;
  const scopedComputeTools =
    readSources === undefined
      ? computeTools
      : withConversationSources(computeTools, async (conversationId) => {
          const doc = await readSources().read(conversationId).catch(() => undefined);
          if (doc === undefined) return undefined;
          const active = doc.sources.filter((source) => source.active);
          const scope = await workspaceOf(doc);
          if (active.length === 0 && scope === undefined) return undefined;
          // 主来源取第一个参与分析的来源；表清单按来源聚合，供 SQL 校验与提示使用。
          const tables: Record<string, string[]> = {};
          for (const source of active) tables[source.id] = [...(source.tables ?? [])];
          return {
            sources: active.map((source) => source.id),
            ...(active.length === 0 ? {} : { primary: active[0]!.id }),
            tables,
            // 工作区对话：compute 据此把导出写进 `<目录>/artifacts/`、把目录加进 SQL 读文件白名单。
            ...(scope === undefined ? {} : { workspaceId: scope.workspaceId, workspaceRoot: scope.workdir }),
          };
        });
  // 图表 HTML 只在单次调用内存在于 worker 里，必须由这里落盘（界面的 web view 读文件）。
  const persisted = withChartPersistence(scopedComputeTools, join(config.dataDir, "outputs", "charts"));
  return { tools: [...appTools, ...persisted], toolResults };
}
