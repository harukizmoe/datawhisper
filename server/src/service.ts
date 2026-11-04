import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness, type Registry, type SessionEnd, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { dataWhisperPrompts } from "./agent/extension.ts";
import { dataWhisperPolicies } from "./agent/policies.ts";
import { harnessSettings } from "./agent/settings.ts";
import { assembleTools } from "./tools/assemble.ts";
import { ComputeClient } from "./compute/client.ts";
import type { Config } from "./config.ts";
import { type Conversations, type TurnState, createConversations } from "./conversations/service.ts";
import { SecretCredentialStore } from "./models/credentials.ts";
import {
  createConversationSourceStore,
  createSourceConfigStore,
  turnStateFor,
  type SourceDocStore,
} from "./ipc/source-store.ts";
import { DEFAULT_PROJECT_ROOT, sourceMethods } from "./ipc/sources.ts";
import { createJobs, jobsExtension, type Jobs } from "./jobs/service.ts";
import { WorkExecutorRegistry } from "./jobs/work-task.ts";
import { createWorkflows, workflowsExtension, type Workflows } from "./workflows/service.ts";
import { createAgentNodeExecutor } from "./workflows/agent-node.ts";
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
async function readTurnState(state: SourceDocStore, conversationId: number): Promise<TurnState> {
  try {
    return turnStateFor(await state.read(conversationId));
  } catch {
    return { hasDataSource: false, sourceCount: 0, hasWorkspace: false, hasUnnamedColumns: false, teamsEnabled: false };
  }
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
  const assembled = options.tools === undefined ? assembleTools(config, compute, "local") : undefined;
  const tools = options.tools ?? assembled!.tools;

  const registry = options.registry ?? createRegistry();
  // 系统提示扩展常驻；工具必须真的装进注册表，否则 `configure({ modelTools })` 只是在空集合里筛选。
  registry.install(dataWhisperPrompts());
  // 输出侧策略（工具守卫、数字溯源、文本形式工具调用、外溢与证据声明）与提示同在一个注册表上。
  registry.install(dataWhisperPolicies(assembled === undefined ? {} : { toolResults: assembled.toolResults }));
  if (tools.length > 0) {
    registry.install(defineExtension({ name: "datawhisper-tools", tools }));
  }
  const harness = await Harness.open(
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
  const sourceApis = sourceMethods({
    compute,
    state: sourceState,
    configs: createSourceConfigStore({ dataDir: config.dataDir, credentials: sourceCredentials }),
    uploadsDir: join(config.dataDir, "uploads"),
    outputsDir: join(config.dataDir, "outputs"),
    projectRoot: DEFAULT_PROJECT_ROOT,
  });

  const workExecutors = new WorkExecutorRegistry();
  const jobs = createJobs({ harness, context, executors: workExecutors });
  const conversations = createConversations({
    harness,
    modelService,
    context,
    // 暴露层在这一份全量工具上做过滤；`turnState` 决定数据源/工作区/团队相关的门是否打开。
    tools,
    turnState: options.turnState ?? ((conversationId) => readTurnState(sourceState, conversationId)),
  });

  // 工作流：节点跑在独立会话里；扩展装进同一个 registry，下一次调度即可见（必须在 `resume()` 之后装，
  // 否则恢复的运行看不到 task 定义）。
  const workflows = createWorkflows({
    harness,
    context,
    executeNode: createAgentNodeExecutor({ harness, context, conversations }),
  });
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
    sourceMethods: sourceApis,
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
