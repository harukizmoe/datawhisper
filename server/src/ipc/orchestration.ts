/**
 * 编排（jobs / workflows）的 IPC 查询面。
 *
 * 只做参数形状校验与错误翻译，业务在 `jobs/service.ts` 与 `workflows/service.ts`。
 * 与现有方法保持一致：
 * - 参数不对 → -32602，`data.kind = "invalid_input"`；
 * - 记录不存在 → -32000，`data.kind = "not_found"`；
 * - 工作流图的业务错误保留旧 `WorkflowErrorCode`，放在 `data.workflow_code`。
 *
 * 未接线时（`createMethods` 没有传入 jobs/workflows）这些方法不注册，
 * 客户端收到 -32601，与「服务还没提供该能力」一致。
 */

import { appError, INVALID_PARAMS, invalidParams, RpcError } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import type { JobStatus, Jobs } from "../jobs/service.ts";
import { WorkflowError } from "../workflows/types.ts";
import type { JsonValue } from "@earendil-works/chord";
import type { ApprovalDecision, WorkflowListQuery, WorkflowRunStatus } from "../workflows/types.ts";
import type { Workflows } from "../workflows/service.ts";

const JOB_STATUSES: Readonly<Record<string, true>> = {
  queued: true,
  running: true,
  canceling: true,
  succeeded: true,
  failed: true,
  canceled: true,
};

const RUN_STATUSES: Readonly<Record<string, true>> = {
  running: true,
  waiting_approval: true,
  paused: true,
  canceling: true,
  canceled: true,
  succeeded: true,
  failed: true,
};

function positiveId(params: MethodParams, key = "id"): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams(`'${key}' must be a positive integer id`);
  }
  return value;
}

function optionalId(params: MethodParams, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams(`'${key}' must be a positive integer`);
  }
  return value;
}

function optionalText(params: MethodParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidParams(`'${key}' must be a string`);
  return value;
}

function optionalLimit(params: MethodParams): number | undefined {
  const value = params.limit;
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 500) {
    throw invalidParams("'limit' must be an integer between 1 and 500");
  }
  return value;
}

const APPROVAL_DECISIONS: Readonly<Record<string, true>> = {
  approve: true,
  approve_with_changes: true,
  reject_and_retry: true,
  reject_and_stop: true,
};

function optionalStatus<T extends string>(params: MethodParams, key: string, allowed: Readonly<Record<string, true>>): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || allowed[value] !== true) {
    throw invalidParams(`'${key}' must be one of ${Object.keys(allowed).join(", ")}`);
  }
  // 已经按 allowed 校验过，剩下的只是把 string 收窄到字面量联合。
  return value as T;
}

function optionalBoolean(params: MethodParams, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidParams(`'${key}' must be a boolean`);
  return value;
}

/** `WorkflowError` → 与现有方法一致的 RPC 错误；其余异常原样交给分发器。 */
function translate<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof WorkflowError) {
      if (error.code === "workflow_resource_not_found") throw appError("not_found", error.message);
      throw new RpcError(error.message, INVALID_PARAMS, { kind: "invalid_input", workflow_code: error.code });
    }
    throw error;
  });
}

export type OrchestrationDeps = {
  jobs?: Jobs;
  workflows?: Workflows;
};

export function orchestrationMethods({ jobs, workflows }: OrchestrationDeps): Record<string, RpcMethod> {
  const methods: Record<string, RpcMethod> = {};
  if (jobs !== undefined) {
    methods["jobs.list"] = async (params) =>
      jobs.list({
        conversationId: optionalId(params, "conversationId"),
        type: optionalText(params, "type"),
        status: optionalStatus<JobStatus>(params, "status", JOB_STATUSES),
        activeOnly: optionalBoolean(params, "activeOnly"),
        limit: optionalLimit(params),
      });
    methods["jobs.get"] = (params) => jobs.get(positiveId(params));
    methods["jobs.cancel"] = (params) => jobs.cancel(positiveId(params));
  }
  if (workflows !== undefined) {
    methods["workflow.runs.list"] = async (params) => {
      const query: WorkflowListQuery = {
        conversationId: optionalId(params, "conversationId"),
        status: optionalStatus<WorkflowRunStatus>(params, "status", RUN_STATUSES),
        limit: optionalLimit(params),
      };
      return workflows.list(query);
    };
    methods["workflow.runs.get"] = (params) => translate(() => workflows.get(positiveId(params)));
    methods["workflow.runs.cancel"] = (params) => translate(() => workflows.cancel(positiveId(params)));
    methods["workflow.runs.retry"] = (params) =>
      translate(() => workflows.retry({ runId: positiveId(params), nodeRunId: positiveId(params, "nodeRunId") }));
    methods["workflow.runs.approve"] = (params) => {
      const approvalId = params.approvalId;
      if (typeof approvalId !== "string" || approvalId === "") throw invalidParams("'approvalId' must be a non-empty string");
      const decision = optionalStatus<ApprovalDecision>(params, "decision", APPROVAL_DECISIONS);
      if (decision === undefined) throw invalidParams(`'decision' must be one of ${Object.keys(APPROVAL_DECISIONS).join(", ")}`);
      const changes = params.changes;
      if (changes !== undefined && (typeof changes !== "object" || changes === null || Array.isArray(changes))) {
        throw invalidParams("'changes' must be an object");
      }
      return translate(() =>
        workflows.decide({
          runId: positiveId(params),
          approvalId,
          decision,
          comment: optionalText(params, "comment") ?? "",
          ...(changes === undefined ? {} : { changes: changes as Record<string, JsonValue> }),
        }),
      );
    };
  }
  return methods;
}
