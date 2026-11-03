#!/usr/bin/env python3
"""Scripted OpenAI-compatible model stub for the behavioural baseline (stdlib only).

The stub plays one *scenario* at a time.  A scenario is an ordered list of
assistant turns; every **agent** request (``stream: true`` chat completion)
consumes the next turn.  Non-streaming requests are treated as *auxiliary*
calls (memory extraction, prompt suggestion, compaction, ...) and get a fixed
reply without consuming a turn.  Once the script is exhausted the stub answers
with a fixed fallback text and flags the request ``fallback: true``.

Turn shapes::

    {"tool_calls": [{"name": "query_data", "arguments": {"sql": "SELECT 1"}}]}
    {"text": "final answer"}

Endpoints
  GET  /v1/models                    model list (one model, ``--model``)
  POST /v1/chat/completions          streaming SSE or non-streaming JSON
  POST /_stub/script                 {"scenario": str, "turns": [...], "aux_reply"?: str, "id_prefix"?: str}
                                     tool call ids are "<id_prefix>t<turn>_<k>" (default "call_")
                                     selects the active scenario, resets its turn counter
  GET  /_stub/requests?scenario=X    logged requests of scenario X (full messages)
  GET  /_stub/health                 {"ok": true}

Every incoming completion request is appended as one JSON line to ``--log``:
``{seq, scenario, kind, model, stream, tool_choice, tools, messages, turn_index, fallback}``
where ``tools`` is the list of offered function names in order.

Usage: python baseline/stub_llm.py --port 18080 --log /tmp/stub.jsonl
"""

from __future__ import annotations

import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

FALLBACK_TEXT = "（基线桩：脚本已结束，无更多动作。）"
DEFAULT_AUX_REPLY = "{}"


class StubState:
    def __init__(self, model: str, log_path: str | None) -> None:
        self.model = model
        self.lock = threading.Lock()
        self.scenario = ""
        self.turns: list[dict] = []
        self.aux_reply = DEFAULT_AUX_REPLY
        self.id_prefix = "call_"
        self.next_turn = 0
        self.seq = 0
        self.requests: list[dict] = []
        self.log_fh = open(log_path, "a", encoding="utf-8") if log_path else None

    def set_script(self, scenario: str, turns: list[dict], aux_reply: str | None,
                   id_prefix: str | None = None) -> None:
        with self.lock:
            self.scenario = scenario
            self.turns = list(turns)
            self.aux_reply = DEFAULT_AUX_REPLY if aux_reply is None else aux_reply
            self.id_prefix = id_prefix or "call_"
            self.next_turn = 0

    def take(self, body: dict) -> tuple[dict, dict]:
        """Log the request and return (record, turn)."""
        stream = bool(body.get("stream"))
        tools = [
            ((t or {}).get("function") or {}).get("name", "")
            for t in (body.get("tools") or [])
        ]
        with self.lock:
            self.seq += 1
            record: dict[str, Any] = {
                "seq": self.seq,
                "scenario": self.scenario,
                "kind": "agent" if stream else "aux",
                "model": body.get("model"),
                "stream": stream,
                "tool_choice": body.get("tool_choice"),
                "tools": tools,
                "messages": body.get("messages") or [],
                "turn_index": None,
                "fallback": False,
            }
            if stream:
                idx = self.next_turn
                self.next_turn += 1
                record["turn_index"] = idx
                if idx < len(self.turns):
                    turn = self.turns[idx]
                else:
                    turn = {"text": FALLBACK_TEXT}
                    record["fallback"] = True
            else:
                turn = {"text": self.aux_reply}
            self.requests.append(record)
            if self.log_fh:
                self.log_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                self.log_fh.flush()
        return record, turn

    def requests_for(self, scenario: str | None) -> list[dict]:
        with self.lock:
            return [r for r in self.requests if scenario is None or r["scenario"] == scenario]


def _tool_calls(turn: dict, turn_index: int, id_prefix: str) -> list[dict]:
    calls = []
    for k, call in enumerate(turn.get("tool_calls") or []):
        args = call.get("arguments", {})
        calls.append({
            "id": call.get("id") or f"{id_prefix}t{turn_index}_{k}",
            "type": "function",
            "function": {
                "name": call["name"],
                "arguments": args if isinstance(args, str) else json.dumps(args, ensure_ascii=False),
            },
        })
    return calls


USAGE = {"prompt_tokens": 1000, "completion_tokens": 10, "total_tokens": 1010}


def make_handler(state: StubState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # quiet
            return

        def _json(self, status: int, payload: Any) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            if url.path in ("/v1/models", "/models"):
                self._json(200, {"object": "list", "data": [
                    {"id": state.model, "object": "model", "created": 0, "owned_by": "baseline-stub"},
                ]})
            elif url.path == "/_stub/health":
                self._json(200, {"ok": True})
            elif url.path == "/_stub/requests":
                scenario = (parse_qs(url.query).get("scenario") or [None])[0]
                self._json(200, state.requests_for(scenario))
            else:
                self._json(404, {"error": {"message": f"unknown path {url.path}"}})

        def do_POST(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            try:
                body = self._body()
            except (ValueError, UnicodeDecodeError) as exc:
                self._json(400, {"error": {"message": f"invalid JSON: {exc}"}})
                return
            if url.path == "/_stub/script":
                state.set_script(str(body.get("scenario") or ""), body.get("turns") or [],
                                 body.get("aux_reply"), body.get("id_prefix"))
                self._json(200, {"ok": True})
                return
            if url.path not in ("/v1/chat/completions", "/chat/completions"):
                self._json(404, {"error": {"message": f"unknown path {url.path}"}})
                return
            record, turn = state.take(body)
            model = body.get("model") or state.model
            turn_index = record["turn_index"] or 0
            calls = _tool_calls(turn, turn_index, state.id_prefix)
            text = turn.get("text")
            if record["stream"]:
                self._stream(model, record["seq"], calls, text,
                             bool((body.get("stream_options") or {}).get("include_usage")))
            else:
                message: dict[str, Any] = {"role": "assistant", "content": text if not calls else None}
                if calls:
                    message["tool_calls"] = calls
                self._json(200, {
                    "id": f"chatcmpl-stub-{record['seq']}",
                    "object": "chat.completion",
                    "created": 0,
                    "model": model,
                    "choices": [{"index": 0, "message": message,
                                 "finish_reason": "tool_calls" if calls else "stop"}],
                    "usage": USAGE,
                })

        def _stream(self, model: str, seq: int, calls: list[dict], text: str | None,
                    include_usage: bool) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            base = {"id": f"chatcmpl-stub-{seq}", "object": "chat.completion.chunk",
                    "created": 0, "model": model}

            def emit(choices: list[dict], **extra: Any) -> None:
                frame = dict(base, choices=choices, **extra)
                self.wfile.write(b"data: " + json.dumps(frame, ensure_ascii=False).encode("utf-8") + b"\n\n")
                self.wfile.flush()

            emit([{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}])
            if calls:
                for k, call in enumerate(calls):
                    emit([{"index": 0, "delta": {"tool_calls": [{
                        "index": k, "id": call["id"], "type": "function",
                        "function": {"name": call["function"]["name"], "arguments": ""},
                    }]}, "finish_reason": None}])
                    emit([{"index": 0, "delta": {"tool_calls": [{
                        "index": k, "function": {"arguments": call["function"]["arguments"]},
                    }]}, "finish_reason": None}])
                finish = "tool_calls"
            else:
                content = text or ""
                step = 16
                for start in range(0, len(content), step):
                    emit([{"index": 0, "delta": {"content": content[start:start + step]}, "finish_reason": None}])
                finish = "stop"
            emit([{"index": 0, "delta": {}, "finish_reason": finish}])
            if include_usage:
                emit([], usage=USAGE)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18080)
    ap.add_argument("--model", default="baseline-stub-model")
    ap.add_argument("--log", default=None, help="append every request as JSONL here")
    args = ap.parse_args()
    state = StubState(args.model, args.log)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(state))
    server.daemon_threads = True
    print(f"stub_llm listening on http://{args.host}:{server.server_port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
