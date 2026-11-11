/**
 * 工具结果侧守卫的接线：外溢（`tr_*`）、证据声明（`ec_*`）、错误文本截断。
 *
 * 为什么放在 `afterTool`：pi-durable 的 `outputLimits` 只在内存里截断，完整结果在
 * `afterTool` 时仍然完好；这里落盘后把结果换成“预览 + 指路行”，整段文本远小于默认上限，
 * 不会被框架再截一次。错误结果按旧实现只截到 1500 字符，不落盘。
 */

import { defineExtension, hook, ToolTask, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { EvidenceClaimStore } from "./evidence.ts";
import { classifyToolError, recoverableArtifactLine, truncateErrorText } from "./result-policy.ts";
import type { ToolResultStore } from "./spill.ts";

/** 工具结果里的文本：多个 text 块按换行拼接（旧实现只有一块）。 */
function textOfOutput(output: ToolExecutionResult["output"]): string {
  if (output === undefined) return "";
  return output
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
}

export type ToolResultGuardInput = {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result: ToolExecutionResult;
  readonly store: ToolResultStore;
  readonly evidence?: EvidenceClaimStore;
  readonly sessionId: string;
  readonly workspaceId?: string;
};

/**
 * 结果侧守卫的纯逻辑：可脱离 Harness 直接测试。
 *
 * 返回 `undefined` 表示不用改结果；否则返回替换后的结果（output / details / diagnostics）。
 */
export function applyToolResultGuard(input: ToolResultGuardInput): ToolExecutionResult | undefined {
  const text = textOfOutput(input.result.output);
  if (text === "") return undefined;

  const failed = input.result.isError === true || classifyToolError(text, input.name) !== "";
  if (failed) {
    const truncated = truncateErrorText(text);
    if (truncated === text) return undefined;
    return { ...input.result, output: [{ type: "text", text: truncated }] };
  }

  const outcome = input.store.spill({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    tool: input.name,
    raw: text,
    // 旧实现只对 get_schema 做内容去重。
    deduplicate: input.name === "get_schema",
  });

  const artifacts: JsonValue[] = [];
  let output: ToolExecutionResult["output"];
  if (outcome.persisted && outcome.artifact !== undefined) {
    artifacts.push({ ...outcome.artifact } as JsonValue);
    output = [
      {
        type: "text",
        text: outcome.preview + recoverableArtifactLine(outcome.artifact.artifact_id),
      },
    ];
  }

  const diagnostics = [...(input.result.diagnostics ?? [])];
  const claim = input.evidence?.persist({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    tool: input.name,
    raw: text,
    args: input.args,
    artifacts,
  });
  if (claim !== undefined) {
    artifacts.push({ ...claim } as JsonValue);
    // 旧实现的 envelope 把证据声明放在模型可见的 artifacts 里；这里用诊断承载同一信息，
    // pi-durable 会把诊断渲染进工具结果文本（`<harness>` 块）。
    diagnostics.push({
      severity: "info",
      code: "evidence_claim",
      message: `[EVIDENCE] ${input.name} evidence claim ${claim.claim_id} (result_sha256=${claim.result_sha256})`,
    });
  }

  if (artifacts.length === 0 && output === undefined) return undefined;

  const details =
    input.result.details !== null && typeof input.result.details === "object" && !Array.isArray(input.result.details)
      ? (input.result.details as Record<string, JsonValue>)
      : {};
  return {
    ...input.result,
    ...(output === undefined ? {} : { output }),
    details: { ...details, artifacts: [...(Array.isArray(details.artifacts) ? details.artifacts : []), ...artifacts] },
    ...(diagnostics.length === (input.result.diagnostics ?? []).length ? {} : { diagnostics }),
  };
}

/**
 * 挂到 Harness 的扩展。宿主在装配时注入结果目录与会话身份：
 * 目录约定为 `<dataDir>/tool_results`（旧实现 `outputs/tool_results`）。
 *
 * 同一个 store 必须同时注入 `read_tool_result` 的 `AppToolDeps.artifacts`：外溢在 `spill()` 里登记
 * 本会话 allowlist，读取端只认这份清单，两处各自建 store 会让模型拿到的 `tr_*` 永远读不到。
 */
export function toolResultGuard(options: {
  readonly store: ToolResultStore;
  readonly evidence?: EvidenceClaimStore;
  readonly workspaceId?: string;
}): Extension {
  return defineExtension({
    name: "datawhisper-tool-results",
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result, api) {
          return applyToolResultGuard({
            name: call.name,
            args: call.arguments,
            result,
            store: options.store,
            evidence: options.evidence,
            sessionId: String(api.conversationId),
            workspaceId: options.workspaceId,
          });
        },
      }),
    ],
  });
}
