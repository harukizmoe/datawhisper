/**
 * 桌面应用（Go，`desktop/internal/api`）与本服务之间 UI 协议的**载荷**类型。
 * 传输见 docs/refactor/ui-transport.md（stdin/stdout 上的 JSONL JSON-RPC 2.0），语义见 docs/refactor/ui-protocol.md。
 */
import type { Op } from "@earendil-works/chord/delta";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";

/** `conversation.event` 的 `snapshot`：每个订阅的第一条；`view` 即 `conversation.watch()` 的返回值。 */
export type SnapshotEvent = { seq: 0; view: ConversationView };
/** `conversation.event` 的 `ops`：把 `seq - 1` 时的视图变为 `seq` 时视图的 Chord delta ops。 */
export type OpsEvent = { seq: number; ops: readonly Op[] };
/** `conversation.event` 的 `end`：watch 已结束（退订、服务关闭、存储失败）。客户端会重新订阅。 */
export type EndEvent = { kind: "stopped" | "aborted" | "ended" | "listener_error" | "failed" };

export type SubmitRequest = {
  /** 客户端选定的幂等键，在每个会话内唯一：用同一键重试会返回同一个 submission。 */
  requestId: string;
  text: string;
  /** 斜杠命令名（不含 `/`）；给出时本轮按命令执行，并解锁该命令的输出类工具。 */
  command?: string;
  /** 有运行在进行时输入如何处理：`steer` 并入当前运行，`followUp`（默认）开始下一次运行。 */
  whenBusy?: "steer" | "followUp";
};
export type SubmitResponse = {
  submissionId: number;
  /** pi-durable 的 `SubmissionRecord.status`。 */
  status: "queued" | "placed" | "done" | "unanswered";
};

export type ConversationSummary = {
  id: number;
  /** 保留的根会话（也可用 `root` 寻址）。 */
  root: boolean;
  /** 分叉来源，当该会话由另一会话分叉而来时存在。 */
  parent?: { conversationId: number; at: number };
  /** 会话中可见的最新 entry；还没有 entry 时为 null。 */
  lastEntryId: number | null;
  /** 最新 entry 消息的时间戳，epoch 毫秒（pi-ai 的 `timestamp`）；没有时为 null。 */
  updatedAt: number | null;
};
export type ConversationListResponse = { conversations: ConversationSummary[] };
/** `conversation.create` 的参数（可选）：未给 `model` 时使用设置中的默认模型（`models.view`）。 */
export type CreateConversationRequest = { model?: ModelRef; thinkingLevel?: ModelThinkingLevel };
export type CreateConversationResponse = { id: number };

/** `conversation.setModel`：切换模型与思考等级；从下一次模型请求起生效。 */
export type SetModelRequest = { model: ModelRef; thinkingLevel: ModelThinkingLevel | null };
/** 该会话解析后的 agent 模型；`thinkingLevel` 是实际生效的等级（未设置时取 pi-durable 默认值）。 */
export type AgentModelResponse = { model: ModelRef | null; thinkingLevel: ModelThinkingLevel };
