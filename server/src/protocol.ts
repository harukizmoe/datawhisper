/**
 * Wire types of the UI protocol between the desktop app (Go, `desktop/internal/api`) and this service.
 * docs/refactor/ui-protocol.md is the specification; keep both in step.
 */
import type { Op } from "@earendil-works/chord/delta";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";

/** `event: snapshot`: the first event of every subscription; `view` is `conversation.watch()`'s value. */
export type SnapshotEvent = { seq: 0; view: ConversationView };
/** `event: ops`: Chord delta ops turning the view at `seq - 1` into the view at `seq`. */
export type OpsEvent = { seq: number; ops: readonly Op[] };
/** `event: end`: the watch ended (service shutting down, storage failure). The client resubscribes. */
export type EndEvent = { kind: "stopped" | "aborted" | "ended" | "listener_error" | "failed" };

export type SubmitRequest = {
  /** Client-chosen idempotency key, unique per conversation: a retry with the same key returns the same submission. */
  requestId: string;
  text: string;
  /** What input does while a run is busy: `steer` joins the current run, `followUp` (default) starts the next run. */
  whenBusy?: "steer" | "followUp";
};
export type SubmitResponse = {
  submissionId: number;
  /** pi-durable `SubmissionRecord.status`. */
  status: "queued" | "placed" | "done" | "unanswered";
};

export type ConversationSummary = {
  id: number;
  /** The reserved root conversation (also addressable as `root`). */
  root: boolean;
  /** Fork source, when this conversation was forked from another. */
  parent?: { conversationId: number; at: number };
  /** Newest entry visible from the conversation; null while it has none. */
  lastEntryId: number | null;
  /** Epoch ms of the newest entry's message (pi-ai `timestamp`); null when it has none. */
  updatedAt: number | null;
};
export type ConversationListResponse = { conversations: ConversationSummary[] };
/** `POST /v1/conversations` body (optional): without `model`, the settings' default model (`/v1/models`) is used. */
export type CreateConversationRequest = { model?: ModelRef; thinkingLevel?: ModelThinkingLevel };
export type CreateConversationResponse = { id: number };

/** `PUT /v1/conversations/:id/model`: switch model and thinking level; applies from the next model request. */
export type SetModelRequest = { model: ModelRef; thinkingLevel: ModelThinkingLevel | null };
/** The conversation's resolved agent model; `thinkingLevel` is the effective level (pi-durable default when unset). */
export type AgentModelResponse = { model: ModelRef | null; thinkingLevel: ModelThinkingLevel };

export type ErrorResponse = { error: string };
