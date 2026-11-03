"""Newline-delimited JSON-RPC 2.0 over stdio.

The Bun server spawns the worker and owns its lifetime. Framing: one UTF-8 JSON
object per line on stdin (requests, notifications) and on the protocol stream
(responses, notifications). The protocol stream is the process's original
stdout; file descriptor 1 is redirected to stderr at startup so prints from
Python or C extensions can never corrupt it.

Worker -> server notifications:
    {"method": "progress", "params": {"id": <request id>, "progress": 0-100, "message": str}}
    {"method": "event",    "params": {"id": <request id>, "event": {...}}}
Server -> worker notifications:
    {"method": "$/cancel", "params": {"id": <request id>}}
Request ``shutdown`` answers, stops reading and lets in-flight requests finish.
Non-finite floats (NaN, ±Infinity) are sent as null: they are not JSON.

Requests run concurrently on a thread pool and may answer out of order. A
request that depends on another (e.g. a query after ``source.open``) must be
sent only after the earlier one has answered. Request ids must be unique among
in-flight requests; a duplicate is rejected with INVALID_REQUEST.
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

# JSON-RPC error codes. -32000.. are application defined.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
CANCELLED = -32800
APP_ERROR = -32000


class Cancelled(Exception):
    """Raised by MethodContext.check() after the caller cancelled the request."""


class RpcError(Exception):
    def __init__(self, message: str, code: int = APP_ERROR, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class MethodContext:
    """Per-request handle passed to every method."""

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
        except Exception as exc:  # noqa: BLE001 - every failure must reach the caller
            log.error("method failed: %s", traceback.format_exc())
            response = _error(ctx.request_id, INTERNAL_ERROR, f"{type(exc).__name__}: {exc}")
        # Leave the in-flight table before answering: a caller that reuses the id
        # after the response must not be rejected as a duplicate.
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
    # numpy/pandas scalars and timestamps leak out of DataFrame code.
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
        # Rare path: a non-finite float somewhere (numpy scalars convert through
        # _json_default first, so round-trip once to reach them as Python floats).
        plain = json.loads(json.dumps(message, ensure_ascii=False, default=_json_default))
        return json.dumps(_finite(plain), ensure_ascii=False, allow_nan=False)


def run(methods: dict[str, Method]) -> None:
    protocol_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    protocol_out = io.open(protocol_fd, "w", encoding="utf-8", newline="\n")
    protocol_in = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", newline="\n")
    Server(methods, protocol_in, protocol_out).serve()
