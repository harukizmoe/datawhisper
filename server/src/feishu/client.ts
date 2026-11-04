/**
 * 飞书开放平台 HTTP 客户端：tenant_access_token、消息发送与群列表。
 *
 * 移植自 `data/feishu_bot_service.py`。错误文案逐字沿用旧实现；响应体一律不外泄（只保留
 * HTTP 状态码与飞书错误码），避免把凭据或内部数据回显到界面/模型。
 *
 * 不缓存 token：旧实现每次发送都现取一次，飞书对换取频率没有限制，这样也省掉过期判断。
 */

import { FeishuBotError, type FeishuConfigStore } from "./config.ts";

export const DEFAULT_API_BASE = "https://open.feishu.cn/open-apis";
export const DEFAULT_DOMAIN = "https://open.feishu.cn";

/** 消息接口的超时（旧实现 `_REQUEST_TIMEOUT = (3.05, 10)` 的连接/读取上限）。 */
const MESSAGE_TIMEOUT_MS = 10_000;

export type FeishuHttpDeps = {
  readonly fetch: typeof fetch;
  /** 开放平台 API 根，默认 `https://open.feishu.cn/open-apis`。 */
  readonly apiBase?: string;
};

export type FeishuChat = { chat_id: string; name: string };

/** 发送目标；省略时用配置里的默认接收对象。 */
export type FeishuTarget = { receiveId: string; receiveIdType: "chat_id" | "open_id" };

export class FeishuClient {
  readonly apiBase: string;
  private readonly config: FeishuConfigStore;
  private readonly fetch: typeof fetch;

  constructor(deps: FeishuHttpDeps & { config: FeishuConfigStore }) {
    this.config = deps.config;
    this.fetch = deps.fetch;
    this.apiBase = deps.apiBase ?? DEFAULT_API_BASE;
  }

  /** 旧 `_tenant_access_token`。 */
  async token(): Promise<string> {
    let credentials: { appId: string; appSecret: string };
    try {
      credentials = await this.config.resolveCredentials();
    } catch (error) {
      throw new FeishuBotError(error instanceof Error ? error.message : String(error));
    }
    const response = await this.request("POST", "/auth/v3/tenant_access_token/internal", {
      body: { app_id: credentials.appId, app_secret: credentials.appSecret },
      // 旧实现用 requests 的 (3.05, 10) 超时，这里同样给 10 秒。
      timeoutMs: MESSAGE_TIMEOUT_MS,
      token: null,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new FeishuBotError(`飞书凭证验证返回 HTTP ${response.status}`);
    }
    const token = response.body?.tenant_access_token;
    if (typeof token !== "string" || token === "") {
      throw new FeishuBotError("飞书未接受 App ID 或 App Secret，请检查应用状态和凭据");
    }
    return token;
  }

  /** 旧 `list_joined_chats`：给界面选择目标群，最多翻 3 页。 */
  async listJoinedChats(): Promise<FeishuChat[]> {
    const token = await this.token();
    const chats: FeishuChat[] = [];
    let pageToken = "";
    for (let page = 0; page < 3; page += 1) {
      const params: Record<string, string> = { page_size: "100" };
      if (pageToken !== "") params.page_token = pageToken;
      const response = await this.request("GET", "/im/v1/chats", {
        params,
        timeoutMs: MESSAGE_TIMEOUT_MS,
        token,
      });
      if (response.status < 200 || response.status >= 300) {
        const code = typeof response.body?.code === "number" ? response.body.code : undefined;
        if (code !== undefined) {
          const hint = CHAT_LIST_ERROR_HINTS[code];
          if (hint !== undefined) throw new FeishuBotError(hint);
          throw new FeishuBotError(
            `飞书群列表请求被拒绝（错误码 ${code}）；请检查机器人能力、群组信息权限和应用发布状态。`,
          );
        }
        throw new FeishuBotError(`飞书群列表接口返回 HTTP ${response.status}`);
      }
      const data = asObject(response.body?.data);
      if (data === undefined) {
        throw new FeishuBotError("飞书拒绝读取群列表，请开通获取群组信息权限并发布应用");
      }
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const chat = asObject(item);
        if (chat === undefined) continue;
        const chatId = typeof chat.chat_id === "string" ? chat.chat_id.trim() : "";
        if (chatId !== "") chats.push({ chat_id: chatId, name: stringOr(chat.name, "未命名群") });
      }
      if (data.has_more !== true) break;
      const next = typeof data.page_token === "string" ? data.page_token : "";
      if (next === "") break;
      pageToken = next;
    }
    return chats;
  }

  /**
   * 发送纯文本（旧 `send_text`）。
   *
   * 目标显式给出时用它（会话已绑定自己的群），否则用配置里的默认接收对象。
   */
  async sendText(text: string, target?: FeishuTarget): Promise<void> {
    const message = text.trim();
    if (message === "") throw new FeishuBotError("发送内容不能为空");
    if (message.length > 4000) throw new FeishuBotError("飞书机器人单条测试消息不能超过 4000 个字符");
    const resolved = this.resolveTarget(target);
    const token = await this.token();
    await this.postMessage(token, resolved, {
      receive_id: resolved.receiveId,
      msg_type: "text",
      content: JSON.stringify({ text: message }),
    });
  }

  /**
   * 发送 Markdown（旧 `send_markdown`）：飞书的 `text` 消息原样显示 Markdown 源码，
   * 卡片里的 `markdown` 元素才会渲染标题、粗体、列表与代码块。
   */
  async sendMarkdown(text: string, target?: FeishuTarget): Promise<void> {
    const message = text.trim();
    if (message === "") throw new FeishuBotError("发送内容不能为空");
    const resolved = this.resolveTarget(target);
    const token = await this.token();
    for (const chunk of splitMarkdown(message)) {
      await this.postMessage(token, resolved, {
        receive_id: resolved.receiveId,
        msg_type: "interactive",
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: "markdown", content: chunk }],
        }),
      });
    }
  }

  /** 旧 `send_test_message`：设置页的「发送测试消息」。 */
  async sendTestMessage(): Promise<void> {
    await this.sendText("智析 Agent 已成功连接飞书应用机器人。后续分析结果将可同步至此群。");
  }

  /** 低层请求：返回状态码与已解析的 JSON（解析失败时为 undefined），由调用方各自翻译错误。 */
  async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    options: { params?: Record<string, string>; body?: unknown; timeoutMs?: number; token?: string | null } = {},
  ): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
    // `token: null` = 不带鉴权头（换取 tenant_access_token 本身）。
    const token = options.token === undefined ? await this.token() : options.token;
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? MESSAGE_TIMEOUT_MS),
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch {
      throw new FeishuBotError("无法连接飞书开放平台，请检查网络");
    }
    let body: Record<string, unknown> | undefined;
    try {
      body = asObject(await response.json());
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  /** 旧 `_post_message`：飞书在 HTTP 200 里也可能返回非 0 的 `code`。 */
  private async postMessage(token: string, target: FeishuTarget, payload: Record<string, unknown>): Promise<void> {
    let response: { status: number; body: Record<string, unknown> | undefined };
    try {
      response = await this.request("POST", "/im/v1/messages", {
        params: { receive_id_type: target.receiveIdType },
        body: payload,
        timeoutMs: MESSAGE_TIMEOUT_MS,
        token,
      });
    } catch (error) {
      throw new FeishuBotError(error instanceof Error ? error.message : String(error));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FeishuBotError(`飞书机器人消息接口返回 HTTP ${response.status}`);
    }
    const code = response.body?.code;
    if (typeof code === "number" && code !== 0) {
      throw new FeishuBotError("飞书拒绝了该消息，请检查机器人是否已加入目标群以及应用权限");
    }
  }

  private resolveTarget(target: FeishuTarget | undefined): FeishuTarget {
    if (target !== undefined) return target;
    const config = this.config.load();
    if (config.receiveId === "") throw new FeishuBotError("请先从群列表中选择一个目标群");
    return { receiveId: config.receiveId, receiveIdType: config.receiveIdType };
  }
}

/** 旧 `_CHAT_LIST_ERROR_HINTS`：群列表接口的已知错误码。 */
const CHAT_LIST_ERROR_HINTS: Readonly<Record<number, string>> = {
  99991672:
    "飞书返回 99991672：缺少群组读取权限。请在开放平台的权限管理中申请 " +
    "“获取群组信息”（im:chat:readonly）或“获取与更新群组信息”（im:chat），然后发布新版本。",
  232001: "飞书返回 232001：群列表请求参数无效，请刷新后重试。",
  232004: "飞书返回 232004：App ID 不存在，请检查应用凭据。",
  232025: "飞书返回 232025：请在飞书开放平台为应用开启“机器人”能力，并发布新版本。",
  232034: "飞书返回 232034：应用在当前企业未启用，请在管理后台安装或启用该应用。",
};

/**
 * 卡片 Markdown 元素约 4000 字符上限，按行边界切分，避免把列表或代码块切成两半
 * （旧 `_split_markdown` 的 `_CARD_CHUNK_LIMIT = 3600`）。
 */
const CARD_CHUNK_LIMIT = 3600;

export function splitMarkdown(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining !== "") {
    if (remaining.length <= CARD_CHUNK_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", CARD_CHUNK_LIMIT - 1);
    if (cut < Math.floor(CARD_CHUNK_LIMIT / 2)) cut = CARD_CHUNK_LIMIT;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  return chunks;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}
