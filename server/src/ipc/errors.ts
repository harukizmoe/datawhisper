/** JSON-RPC 2.0 错误码与错误类型；-32000 起为应用自定义区间（与 compute/rpc.py 相同）。 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const APP_ERROR = -32000;

/** 业务错误的细分，放在 `error.data.kind`；取值与旧 HTTP 版本的 `{"error": …}` 一一对应。 */
export type ErrorKind = "invalid_input" | "not_found" | "no_model" | "model_unavailable" | "unknown_model" | "unsupported_thinking_level";

export type RpcErrorData = { kind: ErrorKind; [key: string]: unknown };

/** 一条线上记录：请求、响应或通知。 */
export type RpcRecord = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number = APP_ERROR,
    readonly data?: RpcErrorData,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** 参数形状不对：缺字段、类型不对、取值不在允许范围内。 */
export function invalidParams(message: string): RpcError {
  return new RpcError(message, INVALID_PARAMS, { kind: "invalid_input" });
}

/** 业务状态不允许这次调用（会话不存在、没有模型……）。 */
export function appError(kind: ErrorKind, message: string): RpcError {
  return new RpcError(message, APP_ERROR, { kind });
}
