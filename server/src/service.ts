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
import { ModelService } from "./models/service.ts";
import type { SubmitResponse } from "./protocol.ts";

export type ServiceOptions = {
  registry?: Registry;
  /** 本轮可用的工具（P4 提供；为空表示还没有工具，模型只能纯对话）。 */
  tools?: readonly ToolRegistration[];
  /** 数据源/工作区状态，供每轮的工具暴露与系统提示判定使用。 */
  turnState?: () => TurnState;
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

export async function startService(config: Config, options: ServiceOptions = {}): Promise<Service> {
  const context = BACKGROUND_CONTEXT;
  mkdirSync(config.dataDir, { recursive: true });

  const modelService = await ModelService.open(config.dataDir, { forceFileCredentials: options.forceFileCredentials });

  // compute 与工具集要在注册表之前就绪：注册表要装工具，策略扩展要用同一个外溢 store。
  const compute = new ComputeClient({
    python: config.python,
    cwd: config.computeCwd,
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


  const conversations = createConversations({
    harness,
    modelService,
    context,
    tools: options.tools ?? [],
    turnState: options.turnState,
  });

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
