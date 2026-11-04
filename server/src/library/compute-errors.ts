/**
 * compute 业务错误到 JSON-RPC 错误的统一翻译。
 *
 * `ComputeError.data.kind` 是 Python 侧给界面的细分码；这里只把「目标不存在」映射成
 * `not_found`，其余保留在 `data.computeKind`，参数错误保持 -32602，其它业务失败按应用错误
 * （-32000）返回。worker 崩溃/不可用不在这里翻译：那是内部错误，交给 RPC 的默认分支。
 */
import { ComputeError } from "../compute/client.ts";
import { APP_ERROR, INVALID_PARAMS, RpcError, appError, type RpcErrorData } from "../ipc/errors.ts";

const NOT_FOUND_KINDS: Readonly<Record<string, true>> = {
  not_found: true,
  file_not_found: true,
  dashboard_not_found: true,
  widget_not_found: true,
};

export function computeErrorKind(error: ComputeError): string | undefined {
  const data = error.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const kind = (data as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

export function isComputeMissing(error: unknown): boolean {
  if (!(error instanceof ComputeError)) return false;
  const kind = computeErrorKind(error);
  return kind !== undefined && NOT_FOUND_KINDS[kind] === true;
}

export function translateComputeError(error: unknown): never {
  if (!(error instanceof ComputeError)) throw error;
  const computeKind = computeErrorKind(error);
  if (computeKind !== undefined && NOT_FOUND_KINDS[computeKind] === true) throw appError("not_found", error.message);
  const data: RpcErrorData = { kind: "invalid_input" };
  if (computeKind !== undefined) data.computeKind = computeKind;
  if (error.code === INVALID_PARAMS) throw new RpcError(error.message, INVALID_PARAMS, data);
  throw new RpcError(error.message, APP_ERROR, data);
}
