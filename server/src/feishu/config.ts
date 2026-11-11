/**
 * 飞书机器人配置：形状、校验与持久化。
 *
 * 移植自 `data/feishu_bot_store.py`（配置形状与默认值）与 `data/feishu_bot_service.py`
 * 的校验文案。与旧实现的差异只有存储位置与凭据后端：
 *
 * - 配置文件是 `<数据目录>/feishu-bot.json`，**不含任何密钥**；App Secret 与事件校验 Token
 *   只以 id 的形式出现在配置里，值存进 `SecretCredentialStore`（系统钥匙串，缺失时回退到
 *   0600 文件），与模型 API key 用同一套机制。
 * - 凭据 id 固定（`feishu:app-secret`、`feishu:event-verification-token`），重新保存时直接覆盖，
 *   不需要记录旧引用再删除，也就不会留下孤儿条目。
 *
 * 环境变量沿用旧实现的语义（`BAA_FEISHU_*`），只用于本机开发/自动化，配置文件优先。
 */

import { say } from "../i18n.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { writePrivateJson } from "../models/credentials.ts";

export class FeishuBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuBotError";
  }
}

export type FeishuInboundTransport = "long_connection" | "webhook";
export type FeishuReceiveIdType = "chat_id" | "open_id";

/** 归一化后的配置（永不含密钥原文）。 */
export type FeishuConfig = {
  readonly enabled: boolean;
  readonly appId: string;
  readonly appSecretRef: string;
  readonly eventVerificationTokenRef: string;
  readonly inboundTransport: FeishuInboundTransport;
  readonly receiveIdType: FeishuReceiveIdType;
  readonly receiveId: string;
  readonly updatedAt: string;
};

/** 磁盘上的形状：与旧 `feishu-bot.json` 一致（下划线命名）。 */
type StoredConfig = {
  enabled?: unknown;
  app_id?: unknown;
  app_secret_ref?: unknown;
  event_verification_token_ref?: unknown;
  inbound_transport?: unknown;
  receive_id_type?: unknown;
  receive_id?: unknown;
  updated_at?: unknown;
};

export const APP_SECRET_ID = "feishu:app-secret";
export const EVENT_TOKEN_ID = "feishu:event-verification-token";

/** 接收对象类型（与旧实现的 `_RECEIVE_ID_TYPES` 相同）。 */
const RECEIVE_ID_TYPES: Readonly<Record<string, true>> = { chat_id: true, open_id: true };

export function validateAppId(value: unknown): string {
  if (typeof value !== "string") throw new FeishuBotError(say("App ID must be text", "App ID 必须是文本"));
  const appId = value.trim();
  if (appId === "" || appId.length > 128 || /\s/.test(appId)) throw new FeishuBotError(say("Enter a valid Feishu App ID", "请填写有效的飞书 App ID"));
  return appId;
}

export function validateReceiveTarget(
  receiveIdType: unknown,
  receiveId: unknown,
): { receiveIdType: FeishuReceiveIdType; receiveId: string } {
  if (typeof receiveIdType !== "string" || RECEIVE_ID_TYPES[receiveIdType] !== true) {
    throw new FeishuBotError(say("Receive ID type only supports chat_id (group chat) or open_id (user)", "接收对象类型仅支持群聊 chat_id 或用户 open_id"));
  }
  if (typeof receiveId !== "string") throw new FeishuBotError(say("Receive ID must be text", "接收对象 ID 必须是文本"));
  const value = receiveId.trim();
  if (value === "" || value.length > 256 || /\s/.test(value)) {
    throw new FeishuBotError(say("Enter a valid target chat_id or user open_id", "请填写有效的目标群 chat_id 或用户 open_id"));
  }
  return { receiveIdType: receiveIdType === "open_id" ? "open_id" : "chat_id", receiveId: value };
}

/** 保存时的输入；`appSecret`/`eventVerificationToken` 省略或空串表示「保持当前值」。 */
export type FeishuConfigInput = {
  readonly enabled: boolean;
  readonly appId: string;
  readonly receiveIdType: FeishuReceiveIdType;
  readonly receiveId: string;
  readonly inboundTransport: FeishuInboundTransport;
  readonly appSecret?: string | null;
  readonly eventVerificationToken?: string | null;
};

/** 界面展示用的掩码：与旧实现的 `_masked_value` 一致（取末 6 位）。 */
export function maskedValue(value: string): string {
  const suffix = value.length > 6 ? value.slice(-6) : value;
  return suffix === "" ? "" : `…${suffix}`;
}

export class FeishuConfigStore {
  private config: FeishuConfig;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private readonly credentials: CredentialStore,
    private readonly env: Readonly<Record<string, string | undefined>>,
    config: FeishuConfig,
  ) {
    this.config = config;
  }

  static async open(
    dataDir: string,
    credentials: CredentialStore,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<FeishuConfigStore> {
    const filePath = join(dataDir, "feishu-bot.json");
    return new FeishuConfigStore(filePath, credentials, env, await readConfig(filePath, env));
  }

  /** 当前配置快照（不含密钥）。 */
  load(): FeishuConfig {
    return { ...this.config };
  }

  /** 是否保存过 App Secret（配置文件或环境变量）。 */
  hasSecret(): boolean {
    return this.config.appSecretRef !== "" || (this.env.BAA_FEISHU_APP_SECRET ?? "").trim() !== "";
  }

  hasEventVerificationToken(): boolean {
    return (
      this.config.eventVerificationTokenRef !== "" ||
      (this.env.BAA_FEISHU_EVENT_VERIFICATION_TOKEN ?? "").trim() !== ""
    );
  }

  /** 旧 `_configured_credentials`：App ID 与 App Secret，缺失时抛用户可读错误。 */
  async resolveCredentials(): Promise<{ appId: string; appSecret: string }> {
    let appId: string;
    try {
      appId = validateAppId(this.config.appId);
    } catch {
      throw new FeishuBotError(say("Save the Feishu App ID first", "请先保存飞书 App ID"));
    }
    const envSecret = (this.env.BAA_FEISHU_APP_SECRET ?? "").trim();
    if (envSecret !== "") return { appId, appSecret: envSecret };
    if (this.config.appSecretRef === "") throw new FeishuBotError(say("Save the Feishu App Secret first", "请先保存飞书 App Secret"));
    try {
      const credential = await this.credentials.read(this.config.appSecretRef);
      const secret = credential?.type === "api_key" ? (credential.key ?? "") : "";
      if (secret === "") throw new Error(say("The credential is empty", "凭据为空"));
      return { appId, appSecret: secret };
    } catch (error) {
      throw new FeishuBotError(say(`Cannot read the Feishu App Secret: ${error instanceof Error ? error.message : String(error)}`, `无法读取飞书 App Secret：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** 旧的 `event_verification_token()`：只在 Webhook 校验需要时读取。 */
  async resolveEventVerificationToken(): Promise<string> {
    const envToken = (this.env.BAA_FEISHU_EVENT_VERIFICATION_TOKEN ?? "").trim();
    if (envToken !== "") return envToken;
    if (this.config.eventVerificationTokenRef === "") {
      throw new FeishuBotError(say("Save the event verification token in the Feishu bot settings first", "请先在飞书机器人设置中保存事件校验 Token"));
    }
    try {
      const credential = await this.credentials.read(this.config.eventVerificationTokenRef);
      const token = credential?.type === "api_key" ? (credential.key ?? "") : "";
      if (token === "") throw new Error(say("The credential is empty", "凭据为空"));
      return token;
    } catch (error) {
      throw new FeishuBotError(say(`Cannot read the Feishu event verification token: ${error instanceof Error ? error.message : String(error)}`, `无法读取飞书事件校验 Token：${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * 保存配置。写操作排队执行：界面连点两下保存不会交错覆盖。
   *
   * `appSecret` 为 undefined/null/空串时保持当前密钥（与旧实现一致：界面不需要读回密钥就能改开关）。
   */
  async save(input: FeishuConfigInput): Promise<FeishuConfig> {
    return this.serialize(async () => {
      const appSecret = (input.appSecret ?? "").trim();
      if (appSecret !== "") {
        await this.credentials.modify(APP_SECRET_ID, async () => ({ type: "api_key", key: appSecret }));
      }
      const eventToken = (input.eventVerificationToken ?? "").trim();
      if (eventToken !== "") {
        await this.credentials.modify(EVENT_TOKEN_ID, async () => ({ type: "api_key", key: eventToken }));
      }
      // 空串表示保持：引用是否保留要看「这次写进去的」或「之前就有的」。
      const hasAppSecret = appSecret !== "" || this.hasSecret();
      const hasEventToken = eventToken !== "" || this.hasEventVerificationToken();
      const next: FeishuConfig = {
        enabled: input.enabled,
        appId: input.appId,
        appSecretRef: hasAppSecret ? APP_SECRET_ID : "",
        eventVerificationTokenRef: hasEventToken ? EVENT_TOKEN_ID : "",
        inboundTransport: input.inboundTransport === "webhook" ? "webhook" : "long_connection",
        receiveIdType: input.receiveIdType,
        receiveId: input.receiveId,
        updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
      };
      await writePrivateJson(this.filePath, {
        enabled: next.enabled,
        app_id: next.appId,
        app_secret_ref: next.appSecretRef,
        event_verification_token_ref: next.eventVerificationTokenRef,
        inbound_transport: next.inboundTransport,
        receive_id_type: next.receiveIdType,
        receive_id: next.receiveId,
        updated_at: next.updatedAt,
      });
      this.config = next;
      return { ...next };
    });
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

async function readConfig(
  filePath: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<FeishuConfig> {
  let raw: StoredConfig = {};
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) raw = parsed as StoredConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const envEnabled = ["1", "true", "yes"].includes((env.BAA_FEISHU_ENABLED ?? "").toLowerCase());
  const transport = raw.inbound_transport ?? env.BAA_FEISHU_INBOUND_TRANSPORT;
  const receiveIdType = String(raw.receive_id_type ?? env.BAA_FEISHU_RECEIVE_ID_TYPE ?? "chat_id");
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : envEnabled,
    appId: String(raw.app_id || env.BAA_FEISHU_APP_ID || ""),
    appSecretRef: String(raw.app_secret_ref ?? ""),
    eventVerificationTokenRef: String(raw.event_verification_token_ref ?? ""),
    inboundTransport: transport === "webhook" ? "webhook" : "long_connection",
    receiveIdType: receiveIdType === "open_id" ? "open_id" : "chat_id",
    receiveId: String(raw.receive_id || env.BAA_FEISHU_RECEIVE_ID || ""),
    updatedAt: String(raw.updated_at ?? ""),
  };
}
