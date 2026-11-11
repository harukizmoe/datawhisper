import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type Registry, type SessionEnd, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { dataWhisperPrompts } from "./agent/extension.ts";
import { dataWhisperPolicies } from "./agent/policies.ts";
import { harnessSettings } from "./agent/settings.ts";
import { assembleTools } from "./tools/assemble.ts";
import type { TeamDelegationPort } from "./tools/app/types.ts";
import { ComputeClient } from "./compute/client.ts";
import type { Config } from "./config.ts";
import { NO_TURN_STATE, type Conversations, type TurnState, createConversations } from "./conversations/service.ts";
import { SecretCredentialStore } from "./models/credentials.ts";
import {
  createConversationSourceStore,
  createSourceConfigStore,
  turnStateFor,
  type SourceDoc,
  type SourceDocStore,
} from "./ipc/source-store.ts";
import { readBitableRecords } from "./feishu/bitable.ts";
import { feishuService } from "./feishu/service.ts";
import { sourceMethods } from "./ipc/sources.ts";
import { migrateLegacyWorkspaces } from "./ipc/workspace-migrate.ts";
import { createWorkspaceStore, isDirectory, type WorkspaceStore } from "./ipc/workspace-store.ts";
import { renderWorkspaceSection } from "./agent/workspace-section.ts";
import { createPermissionBroker, type PermissionBroker } from "./agent/permission-broker.ts";
import { createPermissionGate } from "./agent/permission-gate.ts";
import { DEFAULT_PERMISSION_MODE } from "./agent/permission-mode.ts";
import { permissionMethods } from "./ipc/permissions.ts";
import { appError } from "./ipc/errors.ts";
import { say } from "./i18n.ts";
import { createJobs, jobsExtension, type Jobs } from "./jobs/service.ts";
import { WorkExecutorRegistry } from "./jobs/work-task.ts";
import { createWorkflows, workflowsExtension, type Workflows } from "./workflows/service.ts";
import { createAgentNodeExecutor } from "./workflows/agent-node.ts";
import { createTeamDelegateService, teamDelegationGuard } from "./teams/delegate.ts";
import { teamMethods } from "./ipc/teams.ts";
import { workflowMethods } from "./ipc/workflows.ts";
import { createWorkflowCatalog, type WorkflowCatalog } from "./workflows/catalog.ts";
import { ModelService } from "./models/service.ts";
import type { SubmitResponse } from "./protocol.ts";
import type { RpcMethod } from "./ipc/rpc.ts";

export type ServiceOptions = {
  registry?: Registry;
  /** 本轮可用的工具（P4 提供；为空表示还没有工具，模型只能纯对话）。 */
  tools?: readonly ToolRegistration[];
  /** 数据源/工作区状态，供每轮的工具暴露与系统提示判定使用；默认从会话的来源文档推导。 */
  turnState?: (conversationId: number) => TurnState | Promise<TurnState>;
  /** 把 API key 保存在 `<dataDir>/credentials.json`，而不是探测操作系统钥匙串（测试用）。 */
  forceFileCredentials?: boolean;
};

export type Service = {
  readonly harness: Harness;
  readonly compute: ComputeClient;
  readonly modelService: ModelService;
  readonly context: Context;
  /** 传输无关的会话业务；IPC 方法表与测试都通过它驱动。 */
  readonly conversations: Conversations;
  /** 长任务（旧 jobs）：每个 job 就是一条 `datawhisper.job` task 的记录。 */
  readonly jobs: Jobs;
  /** 工作流运行：运行 task + 节点子 task，节点由 agent 执行器跑在一轮独立会话里。 */
  readonly workflows: Workflows;
  /** 数据源、工作区与产物（`source.*` / `workspace.*` / `artifact.*`）的 IPC 方法表。 */
  readonly sourceMethods: Record<string, RpcMethod>;
  /** 待用户审批的工具调用（工作区对话的权限模式）；界面经通知与 `permission.*` 方法与它交互。 */
  readonly permissions: PermissionBroker;
  /** 团队的只读视图与委托取消（`teams.*`）。 */
  readonly teamMethods: Record<string, RpcMethod>;
  /** 工作流定义与启动（`workflow.definitions.*`、`workflow.start`）的 IPC 方法表。 */
  readonly workflowMethods: Record<string, RpcMethod>;
  /** 工作流目录：保存的定义与从定义启动运行。 */
  readonly workflowCatalog: WorkflowCatalog;
  /** `conversations.submitTurn` 的便捷入口（测试里常用）。 */
  submitTurn(id: string | number, body: unknown): Promise<SubmitResponse>;
  /** Harness 关闭时落定：`stop()` 之后，或存储失败之后（`kind: "failed"`）。 */
  readonly closed: Promise<SessionEnd>;
  /** 先给所有订阅发 `end`，再关闭 compute 与 Harness。幂等。 */
  stop(): Promise<void>;
};

/** 在 `<dataDir>/datawhisper.sqlite` 上打开 Harness，恢复被中断的工作。传输由调用方接上（见 `ipc/attach.ts`）。 */
/** 每次 Harness 解析设置时现算：模型目录会随用户在设置里增删而变。 */
function serviceSettings(modelService: ModelService) {
  const models = modelService.models.getModels().map((model) => ({ provider: model.provider, modelId: model.id }));
  return harnessSettings({
    models,
    contextWindowOf: (ref) => modelService.models.getModel(ref.provider, ref.modelId)?.contextWindow,
  });
}

/** 读会话的来源文档并推导本轮状态；会话不存在或还什么都没挂时就是空状态。 */
async function readTurnState(
  state: SourceDocStore,
  workspaces: WorkspaceStore,
  dataDir: string,
  conversationId: number,
): Promise<TurnState> {
  let doc: SourceDoc;
  try {
    doc = await state.read(conversationId);
  } catch {
    return { ...NO_TURN_STATE };
  }
  const base = turnStateFor(doc);
  if (doc.scope?.kind !== "workspace") return base;
  // 范围是工作区而目录/记录没了：明确报错，不静默退回普通聊天（那样工具集会悄悄变少）。
  const record = await workspaces.get(doc.scope.workspaceId);
  if (record === undefined || !isDirectory(record.workdir)) {
    throw appError(
      "invalid_input",
      say(
        `The workspace for this conversation is not available${record === undefined ? "" : `: ${record.workdir}`}. Restore the folder or start a new chat.`,
        `本对话所属的工作区不可用${record === undefined ? "" : `：${record.workdir}`}。请恢复该文件夹，或新建对话。`,
      ),
    );
  }
  return { ...base, workspaceSection: renderWorkspaceSection(record, dataDir, doc.permissionMode ?? DEFAULT_PERMISSION_MODE) };
}

export async function startService(config: Config, options: ServiceOptions = {}): Promise<Service> {
  const context = BACKGROUND_CONTEXT;
  mkdirSync(config.dataDir, { recursive: true });

  const modelService = await ModelService.open(config.dataDir, { forceFileCredentials: options.forceFileCredentials });

  // compute 与工具集要在注册表之前就绪：注册表要装工具，策略扩展要用同一个外溢 store。
  const compute = new ComputeClient({
    python: config.python,
    cwd: config.computeCwd,
    // Python 侧的数据根（`infrastructure/paths.py::data_root`）必须与 Bun 的 `dataDir` 相同：
    // 否则仪表盘、图表、上传文件会写进仓库目录而不是应用数据目录。
    env: { BAA_DATA_DIR: config.dataDir },
    onStderr: (line) => console.error(`[compute] ${line}`),
  });
  // 生产工具集：A 类纯 TS + B 类 compute 外壳。测试可以用 `options.tools` 覆盖（桩工具）。
  // 团队委托端口：工具集先装配、委托服务后建（它需要会话服务），这里留一个迟绑定转发器。
  const delegationPort: { current?: TeamDelegationPort } = {};
  const workflowPort: { current?: WorkflowCatalog } = {};
  // `harness` 在下面才创建；工具只在执行期用到它（那时一定就绪）。
  let harness!: Harness;
  // 工作区注册表是全局的文件存储，不依赖会话服务：工具装配与来源方法共用这一份。
  const workspaceStore = createWorkspaceStore({ dataDir: config.dataDir });
  const assembled =
    options.tools === undefined
      ? assembleTools(config, compute, "local", {
          harness: () => harness,
          context,
          teamDelegation: delegationPort,
          workflowCatalog: workflowPort,
          // 来源文档同样是执行期才需要（会话服务建好之后）。
          sources: () => sourceState,
          workspaces: workspaceStore,
        })
      : undefined;
  const tools = options.tools ?? assembled!.tools;
  // 工作区对话的权限闸门：来源文档要等会话服务建好，所以用迟绑定的取值函数。
  const permissions = createPermissionBroker();
  const permissionGate = createPermissionGate({ state: () => sourceState, broker: permissions });

  const registry = options.registry ?? createRegistry();
  // 系统提示扩展常驻；工具必须真的装进注册表，否则 `configure({ modelTools })` 只是在空集合里筛选。
  registry.install(dataWhisperPrompts());
  // 输出侧策略（工具守卫、数字溯源、文本形式工具调用、外溢与证据声明）与提示同在一个注册表上。
  registry.install(dataWhisperPolicies({ permissions: permissionGate, ...(assembled === undefined ? {} : { toolResults: assembled.toolResults }) }));
  if (tools.length > 0) {
    registry.install(defineExtension({ name: "datawhisper-tools", tools }));
  }
  harness = await Harness.open(
    await openNodeSqliteStorage(join(config.dataDir, "datawhisper.sqlite")),
    {
      models: modelService.models,
      registry,
      identity: { attribution: null },
      // 压缩与 prompt cache 策略按当前可用模型动态计算：模型增删后下一次解析即生效（settings 是 getter）。
      settings: () => serviceSettings(modelService),
      // stdout 只走协议，诊断一律 stderr。
      onReport: (report) => console.error(`[harness] ${report.kind}`, report),
    },
    context,
  );
  harness.resume();

  // 数据来源：会话级来源/工作区文档 + 数据源配置（密钥只进不出）。
  const sourceState = createConversationSourceStore({ harness, context });
  const sourceCredentials = await SecretCredentialStore.open(
    join(config.dataDir, "datasource-credentials.json"),
    join(config.dataDir, "datasource-credentials.index.json"),
    { forceFile: options.forceFileCredentials },
  );
  // 飞书凭据和网络都归 server：来源打开时由这里读好记录再交给 compute（Python 不碰飞书）。
  // 实例按数据目录单例且「先创建者的选项生效」，所以要等到第一次真正读取时才取，
  // 不能在装配期抢先创建（那会吞掉 attachIpc / 测试传入的日志与端点选项）。
  const sourceApis = sourceMethods({
    compute,
    state: sourceState,
    configs: createSourceConfigStore({ dataDir: config.dataDir, credentials: sourceCredentials }),
    workspaces: workspaceStore,
    // `conversations` 在下面才创建；只在调用时用到，那时一定就绪。
    conversationIds: async () => (await conversations.list()).conversations.map((item) => item.id),
    feishuRecords: async (appToken, tableId) =>
      readBitableRecords((await feishuService({ dataDir: config.dataDir }).connections()).client, { bitable: appToken, tableId }),
    uploadsDir: join(config.dataDir, "uploads"),
    outputsDir: join(config.dataDir, "outputs"),
    projectRoot: config.projectRoot,
  });
  const permissionApi = permissionMethods({ broker: permissions, state: sourceState });

  const workExecutors = new WorkExecutorRegistry();
  const jobs = createJobs({ harness, context, executors: workExecutors });
  const conversations = createConversations({
    harness,
    modelService,
    context,
    // 暴露层在这一份全量工具上做过滤；`turnState` 决定数据源/工作区/团队相关的门是否打开。
    tools,
    turnState: options.turnState ?? ((conversationId) => readTurnState(sourceState, workspaceStore, config.dataDir, conversationId)),
    workflowsAvailable: true,
  });
  // 旧版每个对话各存一份工作区记录；先迁成全局注册表 + 对话 scope，之后才对外服务。幂等。
  try {
    const migrated = await migrateLegacyWorkspaces({
      state: sourceState,
      workspaces: workspaceStore,
      conversationIds: (await conversations.list()).conversations.map((item) => item.id),
    });
    if (migrated > 0) console.error(`[workspace] migrated ${migrated} conversation(s) to the global workspace registry`);
  } catch (error) {
    console.error("[workspace] legacy workspace migration failed", error);
  }

  // 工作流：节点跑在独立会话里；扩展装进同一个 registry，下一次调度即可见（必须在 `resume()` 之后装，
  // 否则恢复的运行看不到 task 定义）。
  const workflows = createWorkflows({
    harness,
    context,
    executeNode: createAgentNodeExecutor({ harness, context, conversations, sources: sourceState }),
  });
  const catalog = createWorkflowCatalog({ dir: join(config.dataDir, "workflows"), workflows });
  workflowPort.current = catalog;
  const workflowApi = workflowMethods(catalog);
  // 团队委托：工具在子会话里真正跑一轮；守卫拦下子会话越权使用分配外的工具。
  const delegation = createTeamDelegateService({ harness, context, conversations });
  delegationPort.current = delegation;
  const teams = teamMethods({ harness, context, delegation });
  registry.install(teamDelegationGuard());
  registry.install(jobsExtension(jobs));
  registry.install(workflowsExtension(workflows));

  let harnessClosed = false;
  const closed = harness.closed.then((end) => {
    harnessClosed = true;
    return end;
  });
  let stopping: Promise<void> | undefined;
  return {
    harness,
    compute,
    modelService,
    context,
    jobs,
    workflows,
    sourceMethods: { ...sourceApis, ...permissionApi },
    permissions,
    teamMethods: teams,
    workflowMethods: workflowApi,
    workflowCatalog: catalog,
    conversations,
    submitTurn: (id, body) => conversations.submitTurn(id, body),
    closed,
    stop() {
      stopping ??= (async () => {
        // 订阅的 `end` 必须在退出前写完，否则客户端只能靠“管道断了”推知。
        await conversations.close();
        await compute.close();
        if (!harnessClosed) await harness.close(context);
      })();
      return stopping;
    },
  };
}
