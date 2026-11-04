/**
 * IPC 方法表（docs/refactor/ui-transport.md 第 3 节）。这里只做参数形状校验与错误翻译，
 * 业务在 `conversations/service.ts` 与 `models/service.ts` 里。
 */
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { ComputeClient } from "../compute/client.ts";
import type { ConversationEvent, Conversations } from "../conversations/service.ts";
import { FeishuBotError } from "../feishu/config.ts";
import type { FeishuService } from "../feishu/service.ts";
import { CUSTOM_PRESETS, type ModelService, type ProviderSettings, SettingsError, parseThinkingLevel } from "../models/service.ts";
import type { Jobs } from "../jobs/service.ts";
import type { Workflows } from "../workflows/service.ts";
import { appError, INVALID_PARAMS, RpcError, invalidParams } from "./errors.ts";
import { libraryMethods } from "./library.ts";
import { orchestrationMethods } from "./orchestration.ts";
import type { MapError, MethodParams, RpcMethod } from "./rpc.ts";

export type MethodDeps = {
  harness: Harness;
  compute: ComputeClient;
  modelService: ModelService;
  conversations: Conversations;
  context: Context;
  /** 推送 `conversation.event` 通知。 */
  publish: (event: ConversationEvent) => void | Promise<void>;
  /**
   * 编排查询面（P5.1 jobs / P5.2 workflows）。由 `service.ts` 创建后传入；
   * 未接线时对应方法不注册（-32601）。
   */
  jobs?: Jobs;
  workflows?: Workflows;
  /** 飞书机器人；省略时 `feishu.*` 方法不注册（进程内测试的轻量装配）。 */
  feishu?: FeishuService;
  /** agent 服务的数据目录（`library.sqlite` 等）；省略时取 `loadConfig()`。 */
  dataDir?: string;
  /** 数据源/工作区/产物方法表（`service.ts` 里连同凭据存储一起装配）；省略时不注册。 */
  sourceMethods?: Record<string, RpcMethod>;
  /** 团队方法表（`teams.*`）；省略时不注册。 */
  teamMethods?: Record<string, RpcMethod>;
};

function idParam(params: MethodParams, key = "id"): string | number {
  const value = params[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value !== "") return value;
  throw invalidParams(`'${key}' must be a conversation id or "root"`);
}

function stringParam(params: MethodParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value;
}

function optionalStringParam(params: MethodParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParams(`'${key}' must be a string`);
  return value;
}

function numberParam(params: MethodParams, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalidParams(`'${key}' must be an integer`);
  return value;
}

function modelRefParam(value: unknown): { provider: string; modelId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidParams("model must be {provider, modelId}");
  const { provider, modelId } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof modelId !== "string") throw invalidParams("model must be {provider, modelId}");
  return { provider, modelId };
}

/** 模型设置的方法：与旧 `/v1/models` 的响应一致，密钥只进不出。 */
export function modelMethods(service: ModelService): Record<string, RpcMethod> {
  const view = async () => ({ ...(await service.view()), builtinProviders: service.builtinIds(), presets: CUSTOM_PRESETS });
  return {
    "models.view": view,

    /** 从端点读模型列表：让能自报元数据的服务（本机网关、Ollama、vLLM）免去手填上下文长度。 */
    "models.discover": (params) => service.discover(stringParam(params, "baseUrl"), optionalStringParam(params, "apiKey")),
    "models.available": async () => ({ models: await service.available() }),
    "models.putProvider": async (params) => {
      const kind = params.kind;
      if (kind !== "builtin" && kind !== "custom") throw invalidParams("provider kind must be builtin or custom");
      await service.putProvider(params as ProviderSettings);
      return view();
    },
    "models.deleteProvider": async (params) => {
      await service.deleteProvider(stringParam(params, "id"));
      return view();
    },
    "models.setKey": async (params) => {
      const apiKey = params.apiKey;
      if (typeof apiKey !== "string") throw invalidParams("apiKey must be a string");
      await service.setApiKey(stringParam(params, "providerId"), apiKey);
      return view();
    },
    "models.clearKey": async (params) => {
      await service.clearApiKey(stringParam(params, "providerId"));
      return view();
    },
    "models.setDefault": async (params) => {
      const model = params.model === null || params.model === undefined ? null : modelRefParam(params.model);
      await service.setDefault(model, parseThinkingLevel(params.thinkingLevel));
      return view();
    },
    "models.test": async (params) => {
      const model = modelRefParam(params.model);
      const draft: { provider?: ProviderSettings; apiKey?: string } = {};
      if (params.provider !== undefined) {
        if (typeof params.provider !== "object" || params.provider === null) throw invalidParams("provider must be an object");
        draft.provider = params.provider as ProviderSettings;
      }
      const apiKey = optionalStringParam(params, "apiKey");
      if (apiKey !== undefined) draft.apiKey = apiKey;
      return service.test(model, draft);
    },
  };
}

/**
 * 飞书机器人方法。
 *
 * 旧 HTTP 接口把「启用/选群」与「会话绑定」拆成两个路由（`api/feishu_bot.py`）；这里保持同样的语义，
 * 但把绑定读侧合并进 `feishu.status`（带 `conversationId` 时附上 `link`），少一个方法。
 * 参数错误按 -32602 返回（旧实现回 400），`FeishuBotError` 的文案原样保留。
 */
export function feishuMethods(feishu: FeishuService, harness: Harness, context: Context): Record<string, RpcMethod> {
  const linkedConversation = async (params: MethodParams) => {
    const id = numberParam(params, "conversationId");
    const conversation = await harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw appError("not_found", `conversation not found: ${id}`);
    return id;
  };
  return {
    "feishu.status": async (params) => {
      if (params.conversationId === undefined) return feishu.status();
      return feishu.status(await linkedConversation(params));
    },
    /** 参数校验与旧 `PUT /api/feishu-bot` 一致；保存后长连接按新配置重连。 */
    "feishu.setConfig": (params) => feishu.setConfig(params),
    "feishu.chats": () => feishu.chats(),
    "feishu.test": () => feishu.test(),
    "feishu.linkConversation": async (params) => feishu.linkConversation(await linkedConversation(params), params),
    "feishu.unlinkConversation": async (params) =>
      feishu.linkConversation(await linkedConversation(params), { enabled: false }),
  };
}

export function createMethods(deps: MethodDeps): Record<string, RpcMethod> {
  const { harness, compute, modelService, conversations, context, publish, jobs, workflows, feishu } = deps;
  return {
    ...modelMethods(modelService),
    ...orchestrationMethods({ jobs, workflows }),
    ...(feishu === undefined ? {} : feishuMethods(feishu, harness, context)),
    ...(deps.sourceMethods ?? {}),
    ...(deps.teamMethods ?? {}),
    // 会话库/知识库/记忆/技能/hooks/仪表盘：compute 侧的数据根必须与这里一致，
    // 因此共用 `dataDir`（service.ts 给 compute 子进程设的 `BAA_DATA_DIR` 也是它）。
    ...libraryMethods({ harness, context, conversations, compute, dataDir: deps.dataDir }),

    async health() {
      const inspection = await harness.inspect(context);
      return {
        ok: true,
        scheduling: inspection.scheduling,
        tasks: inspection.tasks.length,
        submissions: inspection.submissions.length,
        computePid: compute.pid ?? null,
      };
    },

    "conversation.list": () => conversations.list(),

    "conversation.create": (params) => conversations.create(params),

    async "conversation.submit"(params) {
      const id = idParam(params);
      const body: Record<string, unknown> = { requestId: params.requestId, text: params.text };
      const command = optionalStringParam(params, "command");
      if (command !== undefined) body.command = command;
      if (params.whenBusy !== undefined) body.whenBusy = params.whenBusy;
      return conversations.submitTurn(id, body);
    },

    "conversation.abort": (params) => conversations.abort(idParam(params)),

    "conversation.setModel": (params) =>
      conversations.setModel(idParam(params), { model: params.model as { provider: string; modelId: string }, thinkingLevel: params.thinkingLevel }),

    "conversation.subscribe": (params) => conversations.subscribe(idParam(params), publish),

    "conversation.unsubscribe": (params) => conversations.unsubscribe(numberParam(params, "subscriptionId")),

    /**
     * 用量：整库汇总供设置页/统计面板使用；单个会话的明细在订阅视图的 `docs["pi.usage"]` 里，
     * 这里不再重复一份（同一份数据两个来源迟早会不一致）。
     */
    "usage.summary": () => harness.usage(context),
  };
}

/**
 * `SettingsError` 是「参数不合法」（-32602），细分放在 `data.kind`；`FeishuBotError` 是用户能改的配置问题
 * （旧 HTTP 实现回 400），同样按参数不合法返回；其余交给内部错误分支。
 */
export const mapSettingsError: MapError = (error) => {
  if (error instanceof SettingsError) return { code: INVALID_PARAMS, message: error.message, data: { kind: error.kind } };
  if (error instanceof FeishuBotError) {
    return { code: INVALID_PARAMS, message: error.message, data: { kind: "invalid_input" } };
  }
  if (error instanceof RpcError) return { code: error.code, message: error.message, data: error.data };
  return undefined;
};
