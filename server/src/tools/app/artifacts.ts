/**
 * `read_tool_result`：读取外溢的完整工具结果（`tr_<id>`）。
 *
 * P4.4 之前还没有“写外溢文件”的宿主实现；本模块按旧格式读取：
 * `<dir>/<artifact_id>.json`，记录形如
 * `{version, artifact_id, session_id, workspace_id, tool, created_at, size_bytes,
 *   sha256, content_type, data}`。读取时重新计算 `data` 的 SHA-256 并与记录比对。
 *
 * 授权与旧实现一致：artifact 必须在本会话的 allowlist 内，workspace/session
 * 元数据必须匹配，查询模式最多 5 段、4000 字符。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { AppToolError, errorResult, makeAppTool, okResult, type AppTool, type AppToolDeps } from "../types.ts";

export const TOOL_RESULT_READ_MAX_CHARS = 4_000;

export type ToolResultArtifactRef = {
  artifact_id: string;
  session_id?: string;
  workspace_id?: string;
  sha256?: string;
  tool?: string;
};

export type ToolResultArtifactRecord = {
  artifact_id: string;
  session_id?: string;
  workspace_id?: string;
  tool?: string;
  sha256?: string;
  data: string;
};

export type ToolResultArtifactSource = {
  allowed(sessionId: string): readonly ToolResultArtifactRef[] | Promise<readonly ToolResultArtifactRef[]>;
  load(artifactId: string): Promise<ToolResultArtifactRecord | undefined>;
};

/**
 * 目录读取端：供 P4.4 写入侧与测试使用。`allowed` 是本次会话的 artifact 清单，
 * 生产宿主应把它替换成 session store 里持久化的最近 20 条。
 */
export function createDirectoryArtifactSource(options: {
  readonly dirs: readonly string[];
  readonly allowed: readonly ToolResultArtifactRef[];
}): ToolResultArtifactSource {
  return {
    allowed(sessionId: string): readonly ToolResultArtifactRef[] {
      return options.allowed.filter((ref) => !ref.session_id || ref.session_id === sessionId);
    },
    async load(artifactId: string): Promise<ToolResultArtifactRecord | undefined> {
      if (!artifactId.startsWith("tr_") || !/^[A-Za-z0-9]+$/.test(artifactId.slice(3))) return undefined;
      for (const dir of options.dirs) {
        let raw: string;
        try {
          raw = readFileSync(join(dir, `${artifactId}.json`), "utf8");
        } catch {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        const data = typeof record.data === "string" ? record.data : "";
        const digest = createHash("sha256").update(data, "utf8").digest("hex");
        if (record.artifact_id !== artifactId || record.sha256 !== digest) continue;
        return {
          artifact_id: artifactId,
          session_id: typeof record.session_id === "string" ? record.session_id : undefined,
          workspace_id: typeof record.workspace_id === "string" ? record.workspace_id : undefined,
          tool: typeof record.tool === "string" ? record.tool : undefined,
          sha256: digest,
          data,
        };
      }
      return undefined;
    },
  };
}

function check<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new AppToolError(message);
  return value;
}

export function createArtifactTool(deps: AppToolDeps): AppTool[] {
  const source = deps.artifacts;
  return [
    makeAppTool<{ artifact_id: string; offset?: number; limit?: number; query?: string }>({
      name: "read_tool_result",
      description:
        "Read a recoverable tool-result Artifact that belongs to this session. Use query for matching snippets or offset/limit for bounded character pagination. Never guess missing Artifact content.",
      parameters: {
        type: "object",
        properties: {
          artifact_id: { type: "string", description: "Opaque tr_... id from a prior tool result." },
          offset: { type: "integer", minimum: 0, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 4000, default: 4000 },
          query: { type: "string", description: "Optional case-insensitive text to find with bounded context." },
        },
        required: ["artifact_id"],
      },
      replay: "safe",
      async execute(args) {
        const artifactId = String(args.artifact_id ?? "");
        try {
          if (!deps.sessionId) throw new AppToolError("active session is required");
          if (source === undefined) throw new AppToolError("artifact is not available in this session");
          const refs = await source.allowed(deps.sessionId);
          const artifact = check(
            refs.find((ref) => ref.artifact_id === artifactId),
            "artifact is not available in this session",
          );
          const expectedWorkspace = artifact.workspace_id ?? "";
          if (expectedWorkspace && expectedWorkspace !== (deps.workspaceId ?? "")) {
            throw new AppToolError("artifact belongs to a different workspace");
          }
          const record = check(
            await source.load(artifactId),
            "artifact is missing or failed SHA-256 verification",
          );
          if ((record.workspace_id ?? "") !== expectedWorkspace) {
            throw new AppToolError("artifact workspace metadata mismatch");
          }
          if (artifact.session_id && artifact.session_id !== record.session_id) {
            throw new AppToolError("artifact session metadata mismatch");
          }
          if (artifact.sha256 && artifact.sha256 !== record.sha256) {
            throw new AppToolError("artifact SHA-256 metadata mismatch");
          }
          const text = record.data;
          const boundedLimit = Math.max(1, Math.min(TOOL_RESULT_READ_MAX_CHARS, Math.trunc(args.limit ?? 4000) || 4000));
          const cleanQuery = String(args.query ?? "").trim();
          let result: Record<string, JsonValue>;
          if (cleanQuery) {
            const lower = text.toLowerCase();
            const needle = cleanQuery.toLowerCase();
            const positions: number[] = [];
            let cursor = 0;
            while (positions.length < 5) {
              const found = lower.indexOf(needle, cursor);
              if (found < 0) break;
              positions.push(found);
              cursor = found + Math.max(1, needle.length);
            }
            let content = "";
            if (positions.length > 0) {
              const perMatch = Math.max(120, Math.floor(boundedLimit / positions.length));
              const snippets: string[] = [];
              for (const position of positions) {
                const start = Math.max(0, position - Math.floor(perMatch / 3));
                const end = Math.min(text.length, start + perMatch);
                snippets.push(`[match at char ${position}]\n${text.slice(start, end)}`);
              }
              content = snippets.join("\n\n").slice(0, boundedLimit);
            }
            result = {
              artifact_id: artifactId,
              tool: record.tool ?? "",
              sha256: record.sha256 ?? "",
              query: cleanQuery,
              match_count: positions.length,
              total_chars: text.length,
              returned_chars: content.length,
              content,
            };
          } else {
            const boundedOffset = Math.max(0, Math.min(text.length, Math.trunc(args.offset ?? 0) || 0));
            const content = text.slice(boundedOffset, boundedOffset + boundedLimit);
            const nextOffset = boundedOffset + content.length;
            result = {
              artifact_id: artifactId,
              tool: record.tool ?? "",
              sha256: record.sha256 ?? "",
              offset: boundedOffset,
              limit: boundedLimit,
              total_chars: text.length,
              returned_chars: content.length,
              next_offset: nextOffset < text.length ? nextOffset : null,
              content,
            };
          }
          return okResult("read_tool_result", JSON.stringify(result), {
            tool: "read_tool_result",
            ...(result as Record<string, JsonValue>),
          });
        } catch (error) {
          return errorResult("read_tool_result", error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
}
