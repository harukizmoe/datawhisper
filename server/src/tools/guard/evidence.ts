/**
 * 证据声明（`ec_<id>`）：数据类工具成功返回时留一份可审计记录。
 *
 * 移植自 `agent/tools/results.py` 的 `persist_evidence_claim`：只对数据派生工具
 * （`query_data` / `create_analysis_table` / `run_analysis` / `generate_chart`）生成，记录 SQL 哈希、
 * 结果哈希与预览、来源与制品清单，便于事后核对“回答里的数字来自哪次查询”。
 *
 * 旧实现只有生成、没有校验函数；这里补上 `verify`，规则与 `read_tool_result` 的制品校验一致：
 * 声明 id 与文件名一致、会话/工作区元数据匹配、给了原始结果时 `result_sha256` 必须一致。
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { isoSeconds, jsonTextDocument } from "./result-policy.ts";

/** 旧实现里会生成证据声明的工具集合。 */
export const EVIDENCE_CLAIM_TOOLS: ReadonlySet<string> = new Set([
  "query_data",
  "create_analysis_table",
  "run_analysis",
  "generate_chart",
]);

/** 磁盘上的证据声明记录；字段与旧 `persist_evidence_claim` 的 record 一致。 */
export type EvidenceClaimRecord = {
  readonly version: 1;
  readonly claim_id: string;
  readonly session_id: string;
  readonly workspace_id: string;
  readonly tool: string;
  readonly created_at: string;
  readonly sql_hash: string;
  readonly sql: string;
  readonly args: Record<string, JsonValue>;
  readonly result_sha256: string;
  readonly result_preview: string;
  readonly sources: JsonValue[];
  readonly artifacts: JsonValue[];
};

export type EvidenceClaimRef = {
  readonly type: "evidence_claim";
  readonly claim_id: string;
  readonly name: string;
  readonly uri: string;
  readonly sql_hash: string;
  readonly result_sha256: string;
  readonly workspace_id: string;
  readonly session_id: string;
};

export type EvidenceClaimInput = {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly tool: string;
  readonly raw: unknown;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly sources?: readonly JsonValue[];
  readonly artifacts?: readonly JsonValue[];
};

/** 校验结果：失败时 `error` 沿用读取端的中文/英文边界措辞，便于模型区分原因。 */
export type EvidenceClaimVerification =
  | { readonly ok: true; readonly record: EvidenceClaimRecord }
  | { readonly ok: false; readonly error: string };

export type EvidenceClaimStore = {
  persist(input: EvidenceClaimInput): EvidenceClaimRef | undefined;
  verify(
    claimId: string,
    expected: { readonly sessionId: string; readonly workspaceId?: string; readonly raw?: unknown },
  ): EvidenceClaimVerification;
};

export function createEvidenceClaimStore(options: {
  readonly dir: string;
  readonly now?: () => Date;
}): EvidenceClaimStore {
  const now = options.now ?? (() => new Date());

  return {
    persist(input: EvidenceClaimInput): EvidenceClaimRef | undefined {
      // 旧实现：空会话或非数据派生工具直接不生成。
      if (!input.sessionId || !EVIDENCE_CLAIM_TOOLS.has(input.tool)) return undefined;
      const args = { ...(input.args ?? {}) };
      const sql = typeof args.sql === "string" ? args.sql : "";
      const { sql: _omit, ...restArgs } = args;
      const claimId = `ec_${randomUUID().replace(/-/g, "")}`;
      mkdirSync(options.dir, { recursive: true });
      const text = jsonTextDocument(input.raw);
      const record: EvidenceClaimRecord = {
        version: 1,
        claim_id: claimId,
        session_id: input.sessionId,
        workspace_id: input.workspaceId ?? "",
        tool: input.tool,
        created_at: isoSeconds(now()),
        sql_hash: sql ? createHash("sha256").update(sql, "utf8").digest("hex") : "",
        sql: sql.slice(0, 20_000),
        args: restArgs as Record<string, JsonValue>,
        result_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
        result_preview: text.slice(0, 2_000),
        sources: [...(input.sources ?? [])],
        artifacts: [...(input.artifacts ?? [])],
      };
      writeFileSync(join(options.dir, `${claimId}.json`), JSON.stringify(record, null, 2), "utf8");
      return {
        type: "evidence_claim",
        claim_id: claimId,
        name: `${input.tool} evidence claim`,
        uri: `artifact://evidence-claim/${claimId}`,
        sql_hash: record.sql_hash,
        result_sha256: record.result_sha256,
        workspace_id: record.workspace_id,
        session_id: input.sessionId,
      };
    },

    verify(claimId, expected): EvidenceClaimVerification {
      if (!/^ec_[A-Za-z0-9]+$/.test(claimId)) {
        return { ok: false, error: "evidence claim id is invalid" };
      }
      const path = join(options.dir, `${claimId}.json`);
      if (!existsSync(path)) return { ok: false, error: "evidence claim is missing" };
      let record: EvidenceClaimRecord;
      try {
        record = JSON.parse(readFileSync(path, "utf8")) as EvidenceClaimRecord;
      } catch {
        return { ok: false, error: "evidence claim is not readable JSON" };
      }
      if (record.claim_id !== claimId) return { ok: false, error: "evidence claim id mismatch" };
      if (record.session_id !== expected.sessionId) return { ok: false, error: "evidence claim belongs to a different session" };
      const workspaceId = expected.workspaceId ?? "";
      if ((record.workspace_id ?? "") !== workspaceId) {
        return { ok: false, error: "evidence claim belongs to a different workspace" };
      }
      if (record.sql_hash !== "") {
        const sqlDigest = createHash("sha256").update(record.sql, "utf8").digest("hex");
        if (sqlDigest !== record.sql_hash) return { ok: false, error: "evidence claim sql hash mismatch" };
      }
      if (expected.raw !== undefined) {
        const digest = createHash("sha256").update(jsonTextDocument(expected.raw), "utf8").digest("hex");
        if (digest !== record.result_sha256) return { ok: false, error: "evidence claim result hash mismatch" };
      }
      return { ok: true, record };
    },
  };
}
