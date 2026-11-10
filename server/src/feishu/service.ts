/**
 * 飞书机器人的业务服务：配置、连接生命周期、群列表、测试消息、群 ↔ 会话绑定。
 *
 * 一个数据目录只应该有一个实例（配置、绑定、幂等账本都是单写者）：连接与工具都通过
 * {@link feishuService} 拿到同一个对象，避免两个进程内实例互相覆盖 JSON 文件。
 *
 * 长连接状态的去处：`feishu.status` 是快照方法，同时服务把每次状态变化作为 `feishu.status`
 * 通知推给界面（与 `conversation.event` 同一套通知机制）。选推送而不是轮询，是因为状态变化由
 * 网络事件驱动、频率低，轮询既延迟又浪费；重连后客户端只要再调一次 `feishu.status` 就能对齐。
 */

import { say } from "../i18n.ts";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { SecretCredentialStore } from "../models/credentials.ts";
import { DEFAULT_DOMAIN, FeishuClient, type FeishuChat } from "./client.ts";
import {
  FeishuBotError,
  FeishuConfigStore,
  maskedValue,
  validateAppId,
  validateReceiveTarget,
  type FeishuInboundTransport,
} from "./config.ts";
import { FeishuLongConnection } from "./long-connection.ts";
import { FeishuLinkStore } from "./links.ts";
import { FeishuWriteLedger } from "./ledger.ts";
import { dispatchInboundEvent, type FeishuInboundDeps } from "./inbound.ts";
import { createTransport, type FeishuTransport } from "./transport.ts";

/** `feishu.status` 的载荷：配置摘要 + 连接状态；永不含密钥。 */
export type FeishuStatus = {
  enabled: boolean;
  configured: boolean;
  appId: string;
  appIdMasked: string;
  appSecretConfigured: boolean;
  eventVerificationTokenConfigured: boolean;
  inboundTransport: FeishuInboundTransport;
  receiveIdType: string;
  receiveId: string;
  receiveIdMasked: string;
  updatedAt: string;
  /** `idle`/`starting`/`connected`/`reconnecting`/`error`/`paused`/`disabled`/`not_configured`/`webhook`。 */
  inboundStatus: string;
  /** 状态短代码（不含响应体与凭据）；`connected` 时为空串。 */
  inboundError: string;
  /** 该会话当前的绑定（请求里带了 `conversationId` 时）。 */
  link?: { chatId: string; chatName: string } | null;
};

/** 旧 `_conversation_payload`：某个会话的绑定状态。 */
export type FeishuLinkState = {
  configured: boolean;
  applicationEnabled: boolean;
  connected: boolean;
  chatId: string;
  chatName: string;
};

export type FeishuServiceOptions = {
  readonly dataDir: string;
  /** 测试注入：替换 fetch / 传输层 / 凭据后端探测。 */
  readonly fetch?: typeof fetch;
  readonly transport?: FeishuTransport;
  /** 端点发现的域名根（默认 `https://open.feishu.cn`）；测试指向本地假服务。 */
  readonly domain?: string;
  /** 开放平台 API 根（默认 `https://open.feishu.cn/open-apis`）；测试指向本地假服务。 */
  readonly apiBase?: string;
  readonly forceFileCredentials?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string, error?: unknown) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

type Runtime = {
  readonly conversations: FeishuInboundDeps["conversations"];
  readonly harness: Pick<Harness, "submission" | "conversation">;
  readonly context: Context;
};

export class FeishuService {
  private readonly options: FeishuServiceOptions;
  private ready: Promise<void> | undefined;
  private configStore: FeishuConfigStore | undefined;
  private linkStore: FeishuLinkStore | undefined;
  private writeLedger: FeishuWriteLedger | undefined;
  private client: FeishuClient | undefined;
  private connection: FeishuLongConnection | undefined;
  private runtime: Runtime | undefined;
  private statusListeners = new Set<(status: FeishuStatus) => void>();

  constructor(options: FeishuServiceOptions) {
    this.options = options;
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? ((text, reason) => console.error(text, reason)))(message, error);
  }

  /** 懒初始化：只读配置不需要钥匙串探测，`start()` 在禁用时几乎零成本。 */
  private initialize(): Promise<void> {
    this.ready ??= (async () => {
      const dataDir = this.options.dataDir;
      const credentials = await SecretCredentialStore.open(
        resolve(dataDir, "feishu-credentials.json"),
        resolve(dataDir, "feishu-credentials.index.json"),
        { forceFile: this.options.forceFileCredentials },
      );
      const env = this.options.env ?? process.env;
      this.configStore = await FeishuConfigStore.open(dataDir, credentials, env);
      this.linkStore = await FeishuLinkStore.open(resolve(dataDir, "feishu-links.json"));
      this.writeLedger = await FeishuWriteLedger.open(resolve(dataDir, "feishu-writes.json"));
      this.client = new FeishuClient({
        config: this.configStore,
        fetch: this.options.fetch ?? globalThis.fetch,
        ...(this.options.apiBase === undefined ? {} : { apiBase: this.options.apiBase }),
      });
      this.connection = new FeishuLongConnection({
        transport:
          this.options.transport ??
          createTransport({ fetch: this.options.fetch ?? globalThis.fetch, domain: this.options.domain ?? DEFAULT_DOMAIN }),
        credentials: async () => {
          try {
            return await this.configStore!.resolveCredentials();
          } catch {
            return undefined;
          }
        },
        onEvent: (payload) => this.receiveEvent(payload),
        onState: () => this.publishStatusChange(),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
        log: (message, error) => this.log(message, error),
      });
    })();
    return this.ready;
  }

  /** 挂上入站回合需要的会话服务；没有它时长连接仍会连，但群消息不会被处理。 */
  attachRuntime(runtime: Runtime): void {
    this.runtime = runtime;
  }

  async status(conversationId?: number): Promise<FeishuStatus> {
    await this.initialize();
    const config = this.configStore!.load();
    const state = this.connection!.status();
    const appSecretConfigured = this.configStore!.hasSecret();
    const configured = config.appId !== "" && appSecretConfigured && config.receiveId !== "";
    let inboundStatus = state.status as string;
    let inboundError = state.error;
    if (config.inboundTransport === "webhook") {
      inboundStatus = "webhook";
      inboundError = "";
    } else if (!config.enabled) {
      inboundStatus = "disabled";
      inboundError = "";
    } else if (!configured) {
      inboundStatus = "not_configured";
      inboundError = "";
    }
    const status: FeishuStatus = {
      enabled: config.enabled,
      configured,
      appId: config.appId,
      appIdMasked: maskedValue(config.appId),
      appSecretConfigured,
      eventVerificationTokenConfigured: this.configStore!.hasEventVerificationToken(),
      inboundTransport: config.inboundTransport,
      receiveIdType: config.receiveIdType,
      receiveId: config.receiveId,
      receiveIdMasked: maskedValue(config.receiveId),
      updatedAt: config.updatedAt,
      inboundStatus,
      inboundError,
    };
    if (conversationId !== undefined) {
      const found = this.linkStore!.findByConversation(conversationId);
      status.link = found === undefined ? null : { chatId: found.chatId, chatName: found.link.name };
    }
    return status;
  }

  /** 旧 `PUT /api/feishu-bot`：校验 → 保存 → 让长连接按新配置重连。返回新状态。 */
  async setConfig(input: unknown): Promise<FeishuStatus> {
    await this.initialize();
    const payload = asObject(input);
    if (payload === undefined) throw new FeishuBotError(say("Request body must be a JSON object", "请求体必须是 JSON 对象"));
    const config = this.configStore!.load();

    const enabled = payload.enabled ?? config.enabled;
    if (typeof enabled !== "boolean") throw new FeishuBotError(say("enabled must be a boolean", "enabled 必须是布尔值"));
    const appSecret = optionalText(payload.app_secret, say("App Secret must be text", "App Secret 必须是文本"));
    const verificationToken = optionalText(payload.event_verification_token, say("Event verification token must be text", "事件校验 Token 必须是文本"));
    const inboundTransport = payload.inbound_transport ?? config.inboundTransport;
    if (inboundTransport !== "long_connection" && inboundTransport !== "webhook") {
      throw new FeishuBotError(say("Inbound mode only supports long connection or Webhook", "入站方式仅支持长连接或 Webhook"));
    }
    const appId = validateAppId(payload.app_id ?? "");
    const requestedType = payload.receive_id_type ?? config.receiveIdType;
    const requestedId = payload.receive_id ?? "";
    const emptyId =
      requestedId === null || requestedId === "" || (typeof requestedId === "string" && requestedId.trim() === "");
    let receiveIdType: "chat_id" | "open_id";
    let receiveId: string;
    if (!emptyId) {
      const target = validateReceiveTarget(requestedType, requestedId);
      receiveIdType = target.receiveIdType;
      receiveId = target.receiveId;
    } else if (requestedType !== "chat_id") {
      throw new FeishuBotError(say("Receive ID type must be chat_id when no target chat is selected", "未选择目标群时，接收对象类型必须为 chat_id"));
    } else {
      receiveIdType = "chat_id";
      receiveId = "";
    }

    try {
      await this.configStore!.save({
        enabled,
        appId,
        receiveIdType,
        receiveId,
        inboundTransport,
        appSecret,
        eventVerificationToken: verificationToken,
      });
    } catch (error) {
      throw new FeishuBotError(
        say(`Cannot save the Feishu bot configuration: ${error instanceof Error ? error.message : String(error)}`, `无法保存飞书机器人配置：${error instanceof Error ? error.message : String(error)}`),
      );
    }
    await this.applyConnection();
    return this.status();
  }

  /** 旧 `GET /api/feishu-bot/chats`。 */
  async chats(): Promise<FeishuChat[]> {
    await this.initialize();
    return this.client!.listJoinedChats();
  }

  /** 旧 `POST /api/feishu-bot/test`。 */
  async test(): Promise<{ ok: true; message: string }> {
    await this.initialize();
    await this.client!.sendTestMessage();
    return { ok: true, message: say("Test message sent to the Feishu chat.", "测试消息已发送到飞书群。") };
  }

  /**
   * 旧 `PUT /api/session/<sid>/feishu-bot`：把会话绑定到机器人可见的某个群。
   *
   * `enabled: false` 解绑并清空；`enabled: true` 时目标群必须出现在当前机器人的群列表里，
   * 否则说明机器人被移出了群或权限变了，要求刷新后重选。
   */
  async linkConversation(conversationId: number, input: unknown): Promise<FeishuLinkState> {
    await this.initialize();
    const payload = asObject(input);
    if (payload === undefined || typeof payload.enabled !== "boolean") {
      throw new FeishuBotError(say("enabled must be a boolean", "enabled 必须是布尔值"));
    }
    if (!payload.enabled) {
      await this.linkStore!.unlinkConversation(conversationId);
      return this.linkState(conversationId);
    }
    const status = await this.status();
    if (!status.enabled || !status.configured) {
      throw new FeishuBotError(say("Enable sending and select a target chat in “App Settings → Feishu Bot” first.", "请先在“应用设置 → 飞书机器人”启用发送并选择目标群。"));
    }
    const chats = await this.chats();
    const requestedChatId = String(payload.chat_id ?? status.receiveId).trim();
    const selected = chats.find((chat) => chat.chat_id === requestedChatId);
    if (selected === undefined) {
      throw new FeishuBotError(say("The target chat is not visible to this bot; refresh the chat list and select again.", "目标群不在当前机器人可见范围内，请刷新群列表后重新选择。"));
    }
    await this.linkStore!.link(selected.chat_id, {
      conversationId,
      name: selected.name.slice(0, 120),
      updatedAt: new Date().toISOString(),
    });
    return this.linkState(conversationId);
  }

  /** 某个会话的绑定状态（旧 `_conversation_payload`）。 */
  private async linkState(conversationId: number): Promise<FeishuLinkState> {
    await this.initialize();
    const status = await this.status(conversationId);
    return {
      configured: status.configured,
      applicationEnabled: status.enabled,
      connected: status.link != null,
      chatId: status.link?.chatId ?? "",
      chatName: status.link?.chatName ?? "",
    };
  }

  /** 按当前配置启动或停掉长连接；禁用、Webhook 或凭据缺失时停在 `paused`。 */
  async start(): Promise<void> {
    await this.initialize();
    try {
      await this.applyConnection();
    } catch (error) {
      this.log("[feishu] 长连接启动失败", error);
    }
  }

  async stop(): Promise<void> {
    if (this.ready === undefined) return;
    await this.ready;
    await this.connection?.stop();
  }

  onStatusChange(listener: (status: FeishuStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 工具侧端口：首次调用时才初始化配置、凭据与账本。 */
  async connections(): Promise<{ client: FeishuClient; ledger: FeishuWriteLedger }> {
    await this.initialize();
    return { client: this.client!, ledger: this.writeLedger! };
  }

  private async applyConnection(): Promise<void> {
    const config = this.configStore!.load();
    const enabled = config.enabled && config.inboundTransport === "long_connection" && this.runtime !== undefined;
    if (!enabled) {
      await this.connection!.stop();
      return;
    }
    const hasCredentials = await this.configStore!
      .resolveCredentials()
      .then(() => true)
      .catch(() => false);
    if (!hasCredentials) {
      await this.connection!.stop();
      return;
    }
    await this.connection!.replace();
  }

  /** 连接状态变化 → 重新读一次完整状态并推给界面。 */
  private publishStatusChange(): void {
    if (this.statusListeners.size === 0) return;
    void this.status()
      .then((status) => {
        for (const listener of this.statusListeners) {
          try {
            listener(status);
          } catch (error) {
            this.log("[feishu] 状态订阅者抛错", error);
          }
        }
      })
      .catch((error: unknown) => this.log("[feishu] 状态计算失败", error));
  }

  /** 长连接收到事件：校验开关与传输方式后交给入站处理（后台执行，不阻塞帧回执）。 */
  private receiveEvent(payload: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(payload);
    } catch (error) {
      this.log("[feishu] 丢弃无法解析的事件", error);
      return;
    }
    const config = this.configStore?.load();
    const runtime = this.runtime;
    if (config === undefined || !config.enabled || config.inboundTransport !== "long_connection") return;
    if (runtime === undefined || this.client === undefined || this.linkStore === undefined || this.writeLedger === undefined) {
      this.log("[feishu] 入站运行时尚未挂载，忽略事件");
      return;
    }
    if (config.appId === "" || config.receiveId === "" || !this.configStore!.hasSecret()) return;
    const root = asObject(envelope);
    const header = asObject(root?.header);
    const event = root?.event ?? root;
    const eventId = typeof header?.event_id === "string" ? header.event_id : "";
    void dispatchInboundEvent(
      {
        conversations: runtime.conversations,
        harness: runtime.harness,
        context: runtime.context,
        client: this.client,
        links: this.linkStore,
        ledger: this.writeLedger,
        log: (message, error) => this.log(message, error),
      },
      event,
      eventId,
    );
  }
}

const services = new Map<string, FeishuService>();

/**
 * 未显式注入时的默认实例：数据目录取 `config.ts` 的默认值（与桌面应用启动服务时同一个环境变量契约）。
 * 工具装配点（`createAppTools`）用它兜底，避免因装配文件被其他任务占用而漏接工具。
 */
export function defaultFeishuService(): FeishuService {
  return feishuService({ dataDir: loadConfig().dataDir });
}

/** 同一个数据目录只保留一个实例（配置/绑定/账本都是单写者）。 */
export function feishuService(options: FeishuServiceOptions | string): FeishuService {
  const normalized = typeof options === "string" ? { dataDir: options } : options;
  const key = resolve(normalized.dataDir);
  let service = services.get(key);
  if (service === undefined) {
    service = new FeishuService({ ...normalized, dataDir: key });
    services.set(key, service);
  }
  return service;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 可选文本参数：null/undefined 表示「不改」，其它类型报错。 */
function optionalText(value: unknown, message: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new FeishuBotError(message);
  return value.trim() === "" ? null : value;
}

