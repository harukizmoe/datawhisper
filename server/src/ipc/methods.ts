/**
 * IPC 方法表（docs/refactor/ui-transport.md 第 3 节）。这里只做参数形状校验与错误翻译，
 * 业务在 `conversations/service.ts` 与 `models/service.ts` 里。
 */
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { ComputeClient } from "../compute/client.ts";
import type { ConversationEvent, Conversations } from "../conversations/service.ts";
import { CUSTOM_PRESETS, type ModelService, type ProviderSettings, SettingsError, parseThinkingLevel } from "../models/service.ts";
import { INVALID_PARAMS, RpcError, invalidParams } from "./errors.ts";
import type { MapError, MethodParams, RpcMethod } from "./rpc.ts";

export type MethodDeps = {
  harness: Harness;
  compute: ComputeClient;
  modelService: ModelService;
  conversations: Conversations;
  context: Context;
  /** 推送 `conversation.event` 通知。 */
  publish: (event: ConversationEvent) => void | Promise<void>;
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

export function createMethods(deps: MethodDeps): Record<string, RpcMethod> {
  const { harness, compute, modelService, conversations, context, publish } = deps;
  return {
    ...modelMethods(modelService),

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

/** `SettingsError` 是「参数不合法」（-32602），细分放在 `data.kind`；其余交给内部错误分支。 */
export const mapSettingsError: MapError = (error) => {
  if (error instanceof SettingsError) return { code: INVALID_PARAMS, message: error.message, data: { kind: error.kind } };
  if (error instanceof RpcError) return { code: error.code, message: error.message, data: error.data };
  return undefined;
};
