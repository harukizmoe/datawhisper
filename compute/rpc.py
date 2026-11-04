"""基于 stdio 的换行分隔 JSON-RPC 2.0。

Bun 服务端拉起该 worker 并掌握其生命周期。分帧方式：stdin 上每行一个 UTF-8
JSON 对象（请求、通知），协议流上同样如此（响应、通知）。协议流是进程原始的
stdout；启动时把文件描述符 1 重定向到 stderr，因此 Python 或 C 扩展里的 print
永远不会污染它。

Worker -> 服务端 通知：
    {"method": "progress", "params": {"id": <request id>, "progress": 0-100, "message": str}}
    {"method": "event",    "params": {"id": <request id>, "event": {...}}}
服务端 -> Worker 通知：
    {"method": "$/cancel", "params": {"id": <request id>}}
请求 ``shutdown`` 会应答、停止读取，并让进行中的请求跑完。
非有限浮点数（NaN、±Infinity）以 null 发送：它们不是合法 JSON。

请求在线程池上并发执行，可能乱序应答。依赖另一个请求的请求（例如
``source.open`` 之后的查询）必须等前一个应答之后再发送。请求 id 在
进行中的请求之间必须唯一；重复的 id 会以 INVALID_REQUEST 拒绝。
"""
from __future__ import annotations

import io
import json
import logging
import math
import os
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TextIO

log = logging.getLogger(__name__)

# JSON-RPC 错误码。-32000.. 为应用自定义区间。
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
CANCELLED = -32800
APP_ERROR = -32000


class Cancelled(Exception):
    """调用方取消请求后，由 MethodContext.check() 抛出。"""


class RpcError(Exception):
    def __init__(self, message: str, code: int = APP_ERROR, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


def str_param(params: dict, key: str, required: bool = True) -> str:
    """以字符串形式返回 ``params[key]``；可选键缺失时读作 ""。"""
    value = params.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value):
        raise RpcError(f"'{key}' must be a {'non-empty ' if required else ''}string", INVALID_PARAMS)
    return value


def int_param(params: dict, key: str, default: int | None = None) -> int:
    """以整数形式返回 ``params[key]``；给出 ``default`` 时用它代替缺失的键。"""
    value = params.get(key)
    if value is None and default is not None:
        return default
    if not isinstance(value, int) or isinstance(value, bool):
        raise RpcError(f"'{key}' must be an integer", INVALID_PARAMS)
    return value


class MethodContext:
    """传给每个方法的单请求句柄。"""

    def __init__(self, server: "Server", request_id: Any):
        self._server = server
        self.request_id = request_id
        self._cancelled = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def check(self) -> None:
        if self._cancelled.is_set():
            raise Cancelled()

    def progress(self, progress: float | None = None, message: str = "") -> None:
        params: dict[str, Any] = {"id": self.request_id, "message": message}
        if progress is not None:
            params["progress"] = progress
        self._server.notify("progress", params)

    def event(self, event: dict) -> None:
        self._server.notify("event", {"id": self.request_id, "event": event})


Method = Callable[[MethodContext, dict], Any]


class Server:
    def __init__(self, methods: dict[str, Method], stdin: TextIO, stdout: TextIO, workers: int = 4):
        self._methods = methods
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="compute")
        self._inflight: dict[Any, MethodContext] = {}
        self._inflight_lock = threading.Lock()

    def _send(self, message: dict) -> None:
        line = _dumps(message)
        with self._write_lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()

    def notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond_error(self, request_id: Any, code: int, message: str, data: Any = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._send({"jsonrpc": "2.0", "id": request_id, "error": error})

    def serve(self) -> None:
        for raw in self._stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                self._respond_error(None, PARSE_ERROR, f"parse error: {exc}")
                continue
            if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
                self._respond_error(message.get("id") if isinstance(message, dict) else None, INVALID_REQUEST, "invalid request")
                continue
            method = message["method"]
            params = message.get("params", {})
            if "id" not in message:
                self._handle_notification(method, params)
                continue
            request_id = message["id"]
            if method == "shutdown":
                self._send({"jsonrpc": "2.0", "id": request_id, "result": None})
                break
            handler = self._methods.get(method)
            if handler is None:
                self._respond_error(request_id, METHOD_NOT_FOUND, f"unknown method: {method}")
                continue
            if not isinstance(params, dict):
                self._respond_error(request_id, INVALID_PARAMS, "params must be an object")
                continue
            ctx = MethodContext(self, request_id)
            with self._inflight_lock:
                duplicate = request_id in self._inflight
                if not duplicate:
                    self._inflight[request_id] = ctx
            if duplicate:
                self._respond_error(request_id, INVALID_REQUEST, f"request id already in flight: {request_id}")
                continue
            self._pool.submit(self._run, handler, ctx, params)
        self._pool.shutdown(wait=True, cancel_futures=False)

    def _handle_notification(self, method: str, params: Any) -> None:
        if method == "$/cancel" and isinstance(params, dict):
            with self._inflight_lock:
                ctx = self._inflight.get(params.get("id"))
            if ctx is not None:
                ctx._cancelled.set()

    def _run(self, handler: Method, ctx: MethodContext, params: dict) -> None:
        try:
            result = handler(ctx, params)
            response = {"jsonrpc": "2.0", "id": ctx.request_id, "result": result}
        except Cancelled:
            response = _error(ctx.request_id, CANCELLED, "cancelled")
        except RpcError as exc:
            response = _error(ctx.request_id, exc.code, str(exc), exc.data)
        except Exception as exc:  # noqa: BLE001 - 每个失败都必须传回调用方
            log.error("method failed: %s", traceback.format_exc())
            response = _error(ctx.request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
        # 先移出进行中表再应答：调用方在收到应答后复用同一 id 时，
        # 不应被当成重复 id 拒绝。
        with self._inflight_lock:
            self._inflight.pop(ctx.request_id, None)
        try:
            self._send(response)
        except (TypeError, ValueError) as exc:
            self._send(_error(ctx.request_id, INTERNAL_ERROR, f"result not serializable: {exc}"))


def _error(request_id: Any, code: int, message: str, data: Any = None) -> dict:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def _json_default(value: Any) -> Any:
    # numpy/pandas 标量与时间戳会从 DataFrame 代码里漏出来。
    for attr in ("item", "isoformat"):
        fn = getattr(value, attr, None)
        if callable(fn):
            return fn()
    return str(value)


def _finite(value: Any) -> Any:
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def _dumps(message: dict) -> str:
    try:
        return json.dumps(message, ensure_ascii=False, allow_nan=False, default=_json_default)
    except ValueError:
        # 罕见路径：某处有非有限浮点数（numpy 标量会先经 _json_default 转换，
        # 所以先往返一次让它们变成 Python float 再处理）。
        plain = json.loads(json.dumps(message, ensure_ascii=False, default=_json_default))
        return json.dumps(_finite(plain), ensure_ascii=False, allow_nan=False)


def run(methods: dict[str, Method]) -> None:
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    protocol_out = io.open(protocol_fd, "w", encoding="utf-8", newline="\n")
    protocol_in = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline="\n")
    Server(methods, protocol_in, protocol_out).serve()
