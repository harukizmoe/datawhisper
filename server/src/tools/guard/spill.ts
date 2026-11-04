/**
 * 超长工具结果的外溢（`tr_<id>` 制品）。
 *
 * pi-durable 自带的 `outputLimits` 只在内存里截断输出（`OutputBuffer` + `truncated` 诊断），
 * 不会把完整内容落盘（见 `pi-durable/dist/harness/tool.js` 的 `boundContent`）。因此外溢必须在
 * 工具外壳层完成：完整文本按旧格式写成 `<dir>/<artifact_id>.json`，模型只拿到预览 + 指路行。
 * 预览已经小于 pi-durable 的默认上限（2000 行 / 50KB），不会再被它截第二遍。
 *
 * 文件格式与 `agent/tools/results.py` 的 `persist_large_tool_result` 逐字段一致，
 * 读取复用 A 类的 `createDirectoryArtifactSource` 约定（按 `sha256` 校验）。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDirectoryArtifactSource,
  type ToolResultArtifactRef,
  type ToolResultArtifactSource,
} from "../app/artifacts.ts";
import {
  isoSeconds,
  jsonTextDocument,
  previewText,
  toolResultPolicy,
  type ToolResultPolicy,
} from "./result-policy.ts";

/** 旧实现的 allowlist 只保留最近 20 条（`_remember_turn_tool_result_artifacts` 的 `limit=20`）。 */
export const TOOL_RESULT_ALLOWLIST_LIMIT = 20;

/** 磁盘上的制品记录，字段与旧 `persist_large_tool_result` 的 record 一致。 */
export type ToolResultArtifactRecord = {
  readonly version: 1;
  readonly artifact_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly tool: string;
  readonly created_at: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly content_type: string;
  readonly data: string;
};

export type SpillInput = {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly tool: string;
  /** 工具的原始结果：字符串原样保存，其他值按 JSON 渲染。 */
  readonly raw: unknown;
  readonly policy?: ToolResultPolicy;
  /** 旧实现只对 `get_schema` 去重：同一份内容复用同一个制品 id。 */
  readonly deduplicate?: boolean;
};

export type SpillOutcome = {
  readonly persisted: boolean;
  /** 模型看到的文本：未落盘时是原文，落盘时是旧实现的预览（不含指路行）。 */
  readonly preview: string;
  readonly artifact?: ToolResultArtifactRef & { readonly size_bytes: number; readonly uri: string; readonly name: string };
  readonly originalChars: number;
  readonly previewChars: number;
};

export type ToolResultStore = ToolResultArtifactSource & {
  /** 落盘并在会话 allowlist 里登记；返回模型可见的预览。 */
  spill(input: SpillInput): SpillOutcome;
  /** 把外部已有的制品（例如会话里持久化的清单）纳入本会话 allowlist。 */
  allow(ref: ToolResultArtifactRef): void;
  /** 本会话当前允许读取的制品清单（最近 20 条）。 */
  allowlist(sessionId: string): readonly ToolResultArtifactRef[];
};

export function createToolResultStore(options: {
  /** 目录列表：第一个用于写入，其余用于读取（会话缓存目录在前、全局目录在后）。 */
  readonly dirs: readonly string[];
  readonly now?: () => Date;
  readonly allowlistLimit?: number;
}): ToolResultStore {
  if (options.dirs.length === 0) throw new Error("tool result store needs at least one directory");
  const writeDir = options.dirs[0]!;
  const now = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.trunc(options.allowlistLimit ?? TOOL_RESULT_ALLOWLIST_LIMIT));
  const reader = createDirectoryArtifactSource({ dirs: options.dirs, allowed: [] });
  const refs: ToolResultArtifactRef[] = [];

  const remember = (ref: ToolResultArtifactRef): void => {
    const index = refs.findIndex((item) => item.artifact_id === ref.artifact_id);
    if (index >= 0) refs.splice(index, 1);
    refs.push({ ...ref });
    if (refs.length > limit) refs.splice(0, refs.length - limit);
  };

  const allowedRefs = (sessionId: string): ToolResultArtifactRef[] =>
    refs.filter((ref) => !ref.session_id || ref.session_id === sessionId);

  return {
    allowed: allowedRefs,
    load: (artifactId: string) => reader.load(artifactId),

    allow(ref: ToolResultArtifactRef): void {
      remember(ref);
    },

    allowlist: allowedRefs,

    spill(input: SpillInput): SpillOutcome {
      const text = jsonTextDocument(input.raw);
      const policy = input.policy ?? toolResultPolicy(input.tool);
      const threshold = Math.max(1, Math.trunc(policy.persistThreshold));
      if (text.length <= threshold) {
        return {
          persisted: false,
          preview: text,
          originalChars: text.length,
          previewChars: text.length,
        };
      }

      const digest = createHash("sha256").update(text, "utf8").digest("hex");
      const artifactId = input.deduplicate ? `tr_${digest.slice(0, 32)}` : `tr_${randomUUID().replace(/-/g, "")}`;
      const sessionId = input.sessionId;
      const workspaceId = input.workspaceId ?? "";
      mkdirSync(writeDir, { recursive: true });
      const target = join(writeDir, `${artifactId}.json`);
      const record: ToolResultArtifactRecord = {
        version: 1,
        artifact_id: artifactId,
        session_id: sessionId,
        workspace_id: workspaceId,
        tool: input.tool,
        created_at: isoSeconds(now()),
        size_bytes: Buffer.byteLength(text, "utf8"),
        sha256: digest,
        content_type: "text/plain; charset=utf-8",
        data: text,
      };
      if (!existsSync(target)) {
        // 先写临时文件再改名：读端看不到写了一半的记录。
        const temp = join(writeDir, `.${artifactId}.${process.pid}.${randomUUID()}.tmp`);
        writeFileSync(temp, JSON.stringify(record), "utf8");
        renameSync(temp, target);
      }
      const artifact = {
        type: "tool_result" as const,
        artifact_id: artifactId,
        name: `${input.tool} 完整结果`,
        uri: `artifact://tool-result/${artifactId}`,
        url: `/api/session/${sessionId}/tool-results/${artifactId}`,
        size_bytes: record.size_bytes,
        sha256: digest,
        workspace_id: workspaceId,
        session_id: sessionId,
      };
      remember({
        artifact_id: artifactId,
        session_id: sessionId,
        workspace_id: workspaceId,
        sha256: digest,
        tool: input.tool,
      });
      return {
        persisted: true,
        preview: previewText(text, { maxChars: policy.previewChars, maxLines: policy.previewLines }),
        artifact,
        originalChars: text.length,
        previewChars: Math.min(text.length, policy.previewChars),
      };
    },
  };
}
