/**
 * 工作流定义与启动的 IPC 方法（运行的查看与取消在 `orchestration.ts`）。
 *
 * - `workflow.definitions.list|get|remove`：数据面板的「工作流」列表；
 * - `workflow.start`：从定义启动一次运行，`conversationId` 决定节点复用哪个会话的数据源。
 *
 * 定义由模型工具创建（见 `tools/app/workflows.ts`），界面不编辑图。
 */

import { appError, INVALID_PARAMS, invalidParams, RpcError } from "./errors.ts";
import type { MethodParams, RpcMethod } from "./rpc.ts";
import type { WorkflowCatalog } from "../workflows/catalog.ts";
import { WorkflowError } from "../workflows/types.ts";

function textParam(params: MethodParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value === "") throw invalidParams(`'${key}' must be a non-empty string`);
  return value;
}

function conversationParam(params: MethodParams): number {
  const value = params.conversationId;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalidParams("'conversationId' must be a positive integer");
  }
  return value;
}

/** `WorkflowError` → 与运行方法一致的 RPC 错误。 */
export function translateWorkflowError<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof WorkflowError) {
      if (error.code === "workflow_resource_not_found") throw appError("not_found", error.message);
      throw new RpcError(error.message, INVALID_PARAMS, { kind: "invalid_input", workflow_code: error.code });
    }
    throw error;
  });
}

export function workflowMethods(catalog: WorkflowCatalog): Record<string, RpcMethod> {
  return {
    "workflow.definitions.list": async () => ({ workflows: await catalog.list() }),
    "workflow.definitions.get": (params) => translateWorkflowError(() => catalog.get(textParam(params, "id"))),
    "workflow.definitions.remove": (params) => translateWorkflowError(() => catalog.remove(textParam(params, "id"))),
    "workflow.start": (params) => {
      const context = params.businessContext;
      if (context !== undefined && typeof context !== "string") throw invalidParams("'businessContext' must be a string");
      return translateWorkflowError(() =>
        catalog.start({
          workflowId: textParam(params, "workflowId"),
          conversationId: conversationParam(params),
          ...(context === undefined ? {} : { businessContext: context }),
        }),
      );
    },
  };
}
