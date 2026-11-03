#!/usr/bin/env python3
"""Record / check the behavioural baseline of the agent service (P0.2).

The comparison point is what the MODEL sees, which does not depend on the
service's HTTP/SSE protocol:

  * the tool-role message content returned after every tool call,
  * the tool names offered on every model request (visible tool list per turn),
  * the ordered tool calls the service actually executed.

The scripted model is ``baseline/stub_llm.py``; scenarios live in
``baseline/scenarios.json``; fixtures in ``baseline/fixtures/``.  Only the
``OldFlaskTarget`` class knows the old Flask HTTP+SSE protocol; a driver for the
new Bun service replaces that class and reuses everything else.

This script only talks HTTP to the service and to the stub; it never imports
project modules.

Usage:
  .venv/bin/python baseline/run_baseline.py            # record -> baseline/recordings/
  .venv/bin/python baseline/run_baseline.py --check    # rerun and diff against recordings
  options: --only a,b  --keep  --python PATH  --verbose
"""

from __future__ import annotations

import argparse
import datetime as dt
import difflib
import functools
import http.client
import http.server
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Iterator

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FIXTURES = HERE / "fixtures"
RECORDINGS = HERE / "recordings"
SCENARIOS = HERE / "scenarios.json"
UPLOAD_FIXTURE = FIXTURES / "baseline.xlsx"
SQLITE_FIXTURE = FIXTURES / "baseline.sqlite"
STUB_MODEL = "baseline-stub-model"
CHAT_TIMEOUT = 900


# ───────────────────────────── process helpers ──────────────────────────────

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http_json(method: str, url: str, body: Any = None, *, raw: bytes | None = None,
              headers: dict | None = None, timeout: float = 120) -> tuple[int, Any]:
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    hdrs = {"Content-Type": "application/json"} if raw is None and body is not None else {}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, payload = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        status, payload = exc.code, exc.read()
    try:
        return status, json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return status, payload.decode("utf-8", "replace")


def wait_http(url: str, timeout: float, proc: subprocess.Popen | None = None) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            raise RuntimeError(f"process exited with {proc.returncode} before {url} was ready")
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status < 500:
                    return
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            pass
        time.sleep(0.3)
    raise TimeoutError(f"{url} not ready after {timeout}s")


def stop_proc(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


class FixtureServer:
    """Serves baseline/fixtures over HTTP (used by the fetch_table scenario)."""

    def __init__(self) -> None:
        handler = functools.partial(_QuietFileHandler, directory=str(FIXTURES))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "FixtureServer":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()


class _QuietFileHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        return


class Stub:
    """Client for baseline/stub_llm.py."""

    def __init__(self, base: str) -> None:
        self.base = base

    def script(self, key: str, turns: list[dict], id_prefix: str) -> None:
        status, _ = http_json("POST", f"{self.base}/_stub/script",
                              {"scenario": key, "turns": turns, "id_prefix": id_prefix})
        if status != 200:
            raise RuntimeError(f"stub script failed: {status}")

    def requests(self, key: str) -> list[dict]:
        status, payload = http_json("GET", f"{self.base}/_stub/requests?scenario={urllib.request.quote(key)}")
        if status != 200:
            raise RuntimeError(f"stub requests failed: {status}")
        return payload


# ─────────────────────── old Flask service (protocol adapter) ───────────────

class OldFlaskTarget:
    """Everything that knows the OLD service's HTTP + SSE protocol.

    A driver for the new service implements the same methods (configure_model,
    seed_knowledge, new_conversation, attach_fixture, attach_database, send)
    against its own API; ``send`` must return the protocol-neutral step result
    ``{"timeline": [...], "final_text": str, "errors": [...]}``.
    """

    def __init__(self, base: str) -> None:
        self.base = base
        self.provider_id = ""

    def configure_model(self, stub_base: str) -> None:
        status, payload = http_json("POST", f"{self.base}/api/models/add", {
            "name": "baseline-stub", "base_url": f"{stub_base}/v1",
            "model_name": STUB_MODEL, "api_key": "sk-baseline-stub",
        })
        if status != 200:
            raise RuntimeError(f"model add failed: {status} {payload}")
        self.provider_id = "custom_baseline-stub"

    def seed_knowledge(self, seed: dict) -> None:
        for kind in ("metrics", "rules", "notes"):
            for item in seed.get(kind, []):
                status, payload = http_json("POST", f"{self.base}/api/knowledge/{kind}", item)
                if status not in (200, 201):
                    raise RuntimeError(f"knowledge seed {kind} failed: {status} {payload}")

    def new_conversation(self) -> str:
        status, payload = http_json("POST", f"{self.base}/api/session/new", {"memory_enabled": False})
        if status != 200:
            raise RuntimeError(f"session create failed: {status} {payload}")
        sid = payload["session_id"]
        status, payload = http_json("POST", f"{self.base}/api/session/{sid}/model",
                                    {"model_id": self.provider_id})
        if status != 200:
            raise RuntimeError(f"session model failed: {status} {payload}")
        return sid

    def attach_fixture(self, sid: str, path: Path) -> None:
        boundary = "----baseline" + uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{path.name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        status, payload = http_json(
            "POST", f"{self.base}/api/session/{sid}/upload", raw=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        if status != 200:
            raise RuntimeError(f"upload failed: {status} {payload}")

    def attach_database(self, sid: str, sqlite_path: Path) -> str:
        """Connect a SQLite file as a SQL source; returns its source id."""
        status, payload = http_json("POST", f"{self.base}/api/session/{sid}/connect-db", {
            "connection_string": f"sqlite:///{sqlite_path}", "name": "baseline_sqlite",
        })
        if status != 200:
            raise RuntimeError(f"connect-db failed: {status} {payload}")
        return payload["source_id"]

    def send(self, sid: str, message: str, options: dict) -> dict:
        body = {"message": message, "memory_enabled": False, "lang": "zh", **options}
        host, port = self.base.split("//", 1)[1].split(":")
        conn = http.client.HTTPConnection(host, int(port), timeout=CHAT_TIMEOUT)
        try:
            conn.request("POST", f"/api/session/{sid}/chat", json.dumps(body).encode("utf-8"),
                         {"Content-Type": "application/json"})
            resp = conn.getresponse()
            if resp.status != 200:
                return {"timeline": [], "final_text": "",
                        "errors": [f"HTTP {resp.status}: {resp.read().decode('utf-8', 'replace')}"]}
            events = [json.loads(line[6:]) for line in _sse_lines(resp)]
        finally:
            conn.close()
        timeline: list[str] = []
        texts: list[str] = []
        errors: list[str] = []
        for ev in events:
            kind = ev.get("type")
            if kind == "tool_start":
                timeline.append(f"start:{ev.get('tool')}")
            elif kind == "tool_end":
                timeline.append(f"end:{ev.get('tool')}")
            elif kind == "text" and ev.get("content"):
                texts.append(ev["content"])
            elif kind == "error":
                errors.append(str(ev.get("message")))
            elif kind == "ask_user":
                texts.append(f"[ask_user] {ev.get('question')}")
        return {"timeline": timeline, "final_text": texts[-1] if texts else "", "errors": errors}


def _sse_lines(resp: http.client.HTTPResponse) -> Iterator[bytes]:
    for raw in resp:
        line = raw.rstrip(b"\r\n")
        if line.startswith(b"data: "):
            yield line


# ───────────────────────────── recording ────────────────────────────────────

_TOOL_HEAD = re.compile(r"^\[TOOL_RESULT\] (\S+) (OK|ERROR)\b")


_INNER_NOT_OK = re.compile(r"^\{\"ok\": false\b")


def classify_tool_output(content: str) -> str:
    """ok | error | blocked | other, from the text the model received.

    ``error`` also covers an OK envelope whose payload is ``{"ok": false, ...}``
    (fetch_table reports fetch failures that way).
    """
    m = _TOOL_HEAD.match(content or "")
    if m:
        if m.group(2) != "OK":
            return "error"
        summary = (content or "")[m.end():].lstrip(": ").split("\n", 1)[0]
        return "error" if _INNER_NOT_OK.match(summary) else "ok"
    if (content or "").startswith("[SYSTEM BLOCK]"):
        return "blocked"
    return "other"


def extract_model_view(requests: list[dict]) -> tuple[list[dict], list[dict]]:
    """(model_requests, tool_results) for one step, from the stub log.

    A tool result is taken from the first agent request in which its
    tool_call_id appears, i.e. exactly what the model saw right after the call
    (later requests may carry compacted/archived copies).
    """
    model_requests: list[dict] = []
    tool_results: list[dict] = []
    seen: set[str] = set()
    for req in requests:
        if req.get("kind") != "agent":
            continue
        model_requests.append({
            "turn_index": req.get("turn_index"),
            "fallback": req.get("fallback"),
            "tool_choice": req.get("tool_choice"),
            "tools": req.get("tools"),
        })
        calls: dict[str, dict] = {}
        for msg in req.get("messages") or []:
            for call in msg.get("tool_calls") or []:
                calls[call.get("id")] = call
            if msg.get("role") != "tool":
                continue
            call_id = msg.get("tool_call_id")
            if call_id in seen:
                continue
            seen.add(call_id)
            call = calls.get(call_id, {})
            fn = call.get("function") or {}
            try:
                arguments = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                arguments = fn.get("arguments")
            content = msg.get("content")
            if isinstance(content, list):  # content parts
                content = "".join(str(p.get("text", "")) for p in content if isinstance(p, dict))
            tool_results.append({
                "tool_call_id": call_id,
                "tool": fn.get("name"),
                "arguments": arguments,
                "status": classify_tool_output(content or ""),
                "content": content,
            })
    return model_requests, tool_results


def substitute(value: Any, mapping: dict[str, str]) -> Any:
    if isinstance(value, str):
        for key, repl in mapping.items():
            value = value.replace(key, repl)
        return value
    if isinstance(value, list):
        return [substitute(v, mapping) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, mapping) for k, v in value.items()}
    return value


def run_scenario(target: OldFlaskTarget, stub: Stub, scenario: dict, subst: dict[str, str],
                 work: Path) -> dict:
    """Run one scenario; returns {sid, literals (volatile value -> placeholder), recording}."""
    name = scenario["name"]
    sid = target.new_conversation()
    setup = scenario.get("setup", {})
    subst = dict(subst)
    literals: dict[str, str] = {}
    if setup.get("upload"):
        target.attach_fixture(sid, UPLOAD_FIXTURE)
    if setup.get("sqlite"):
        # a private copy per scenario: SQL-source writes must never touch the fixture
        db_copy = work / f"{name}.sqlite"
        shutil.copyfile(SQLITE_FIXTURE, db_copy)
        source_id = target.attach_database(sid, db_copy)
        subst["{sqlite_source_id}"] = source_id
        literals[source_id] = "<SQLITE_SOURCE_ID>"
    steps_out = []
    for index, step in enumerate(scenario["steps"]):
        key = f"{name}#{index}"
        stub.script(key, substitute(step.get("script") or [], subst), id_prefix=f"call_s{index}_")
        message = substitute(step["message"], subst)
        options = substitute(step.get("options") or {}, subst)
        result = target.send(sid, message, options)
        model_requests, tool_results = extract_model_view(stub.requests(key))
        steps_out.append({
            "message": message,
            "options": options,
            "model_requests": model_requests,
            "tool_results": tool_results,
            "executed_tools": result["timeline"],
            "final_text": result["final_text"],
            "errors": result["errors"],
        })
    recording = {
        "scenario": name,
        "description": scenario.get("description", ""),
        "covers": scenario.get("covers", []),
        "steps": steps_out,
    }
    recording["status"], recording["coverage"] = assess(scenario, steps_out)
    if scenario.get("blocked_reason"):
        recording["blocked_reason"] = scenario["blocked_reason"]
    return {"sid": sid, "literals": literals, "recording": recording}


def assess(scenario: dict, steps: list[dict]) -> tuple[str, dict]:
    """Per covered tool: ok | error | blocked | not_executed; plus scenario status."""
    coverage: dict[str, list[str]] = {}
    fallback = any(r["fallback"] for s in steps for r in s["model_requests"])
    for tool in scenario.get("covers", []):
        outcomes: list[str] = []
        for step in steps:
            for res in step["tool_results"]:
                if res["tool"] == tool:
                    outcomes.append(res["status"])
            if not step["model_requests"] and f"start:{tool}" in step["executed_tools"]:
                # confirm fast path: no model call, output surfaces as the final text
                outcomes.append("error" if step["errors"] else "ok")
        coverage[tool] = outcomes or ["not_executed"]
    flat = [o for v in coverage.values() for o in v]
    if scenario.get("expected_status") == "blocked":
        status = "blocked"
    elif any(o in ("error", "blocked", "not_executed", "other") for o in flat):
        status = "error"
    else:
        status = "recorded"
    if fallback:
        status += "+script_overrun"
    return status, coverage


# ─────────────────────────── normalization ──────────────────────────────────
#
# Applied to every string of a recording in three passes:
#   1. run-time stamps: ISO / compact timestamps and epoch values whose date is
#      within one day of the run (data timestamps such as ARIMA forecast dates
#      in 2024 are left alone);
#   2. context literals: data root, work dir, repo root, session ids, source
#      ids, fixture server URL, and the run date in several spellings;
#   3. generic patterns (ids, hashes, ports, durations, temp paths).
# Values under keys in VOLATILE_KEYS are replaced wholesale.

VOLATILE_KEYS = {"elapsed_seconds", "created_at", "updated_at", "duration", "duration_ms",
                 "timestamp", "generated_at", "mtime", "size_bytes"}

_ISO_TS = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")
_COMPACT_TS = re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})[_-]?\d{6}(?:\d{1,6})?(?!\d)")
_EPOCH = re.compile(r"(?<![\d.])(\d{10})(\d{3}|\.\d+)?(?![\d.])")

GENERIC_RULES: list[tuple[str, re.Pattern, str]] = [
    ("uuid", re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<UUID>"),
    ("tool-result id", re.compile(r"\btr_[0-9a-f]{16,64}\b"), "tr_<ID>"),
    ("evidence-claim id", re.compile(r"\bec_[0-9a-f]{16,64}\b"), "ec_<ID>"),
    ("sha256", re.compile(r"\b[0-9a-f]{64}\b"), "<SHA256>"),
    ("hex id 12-40", re.compile(r"(?<![0-9a-zA-Z])[0-9a-f]{12,40}(?![0-9a-zA-Z])"), "<HEX>"),
    ("loopback port", re.compile(r"\b(127\.0\.0\.1|localhost):\d{2,5}\b"), r"\1:<PORT>"),
    ("duration text", re.compile(r"(耗时|用时|elapsed)[:：\s]*\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒)", re.I), r"\1 <DUR>"),
    ("run-time suffix", re.compile(r"<TODAY>[_-]?\d{4,6}(?!\d)"), "<TODAY>_<HHMMSS>"),
    ("tmp path", re.compile(r"/tmp/[^\s\"'`)\]}>,;]+"), "<TMP_PATH>"),
]


class Normalizer:
    def __init__(self, data_root: Path, sids: list[str], extra_literals: dict[str, str]) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        self.now_epoch = now.timestamp()
        base_days = {now.date(), dt.date.today()}
        self.run_dates = {d + dt.timedelta(days=k) for d in base_days for k in (-1, 0, 1)}
        literals: dict[str, str] = {}
        for root in {str(data_root), str(data_root.resolve())}:
            literals[root] = "<DATA_ROOT>"
        literals[str(REPO)] = "<REPO>"
        for sid in sids:
            literals[sid] = "<SID>"
            literals[sid[:8]] = "<SID8>"
        for day in self.run_dates:
            literals[day.isoformat()] = "<TODAY>"
            literals[day.strftime("%Y%m%d")] = "<TODAY>"
            literals[f"{day.year}年{day.month}月{day.day}日"] = "<TODAY>"
            literals[f"{day.year}年{day.month:02d}月{day.day:02d}日"] = "<TODAY>"
        literals.update(extra_literals)
        # longest first so a root path wins over its prefixes
        self.literals = sorted(literals.items(), key=lambda kv: -len(kv[0]))

    def _is_run_date(self, y: str, m: str, d: str) -> bool:
        try:
            return dt.date(int(y), int(m), int(d)) in self.run_dates
        except ValueError:
            return False

    def _ts(self, match: re.Match) -> str:
        return "<TS>" if self._is_run_date(*match.group(1, 2, 3)) else match.group(0)

    def _epoch(self, match: re.Match) -> str:
        seconds = int(match.group(1))
        return "<EPOCH>" if abs(seconds - self.now_epoch) < 2 * 86400 else match.group(0)

    def text(self, s: str) -> str:
        s = _ISO_TS.sub(self._ts, s)
        s = _COMPACT_TS.sub(self._ts, s)
        s = _EPOCH.sub(self._epoch, s)
        for lit, repl in self.literals:
            if lit:
                s = s.replace(lit, repl)
        for _name, pattern, repl in GENERIC_RULES:
            s = pattern.sub(repl, s)
        return s

    def __call__(self, value: Any, key: str | None = None) -> Any:
        if key in VOLATILE_KEYS and value is not None:
            return "<VOLATILE>"
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self(v) for v in value]
        if isinstance(value, dict):
            return {k: self(v, k) for k, v in value.items()}
        return value


# ─────────────────────────────── main ───────────────────────────────────────

def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def start_services(work: Path, python: str, verbose: bool) -> tuple[subprocess.Popen, subprocess.Popen, str, str]:
    stub_port, app_port = free_port(), free_port()
    stub_log = open(work / "stub.out", "w")
    stub = subprocess.Popen(
        [sys.executable, str(HERE / "stub_llm.py"), "--port", str(stub_port),
         "--model", STUB_MODEL, "--log", str(work / "stub_requests.jsonl")],
        stdout=stub_log, stderr=subprocess.STDOUT,
    )
    stub_base = f"http://127.0.0.1:{stub_port}"
    wait_http(f"{stub_base}/_stub/health", 20, stub)
    env = dict(os.environ)
    for k in ("RAILWAY_PROJECT_ID", "RAILWAY_VOLUME_MOUNT_PATH", "VERCEL", "BAA_DESKTOP_LIFECYCLE",
              "BAA_RESOURCE_DIR", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ATLASCLOUD_API_KEY",
              "MINIMAX_API_KEY"):
        env.pop(k, None)
    env.update({
        "BAA_DATA_DIR": str(work / "data"),      # isolated data root: never the user's data
        "BAA_SKIP_DEPENDENCY_CHECK": "1",       # no pip, no .deps_installed stamp in the repo
        "PORT": str(app_port),
        "BAA_HOST": "127.0.0.1",
        "PYTHONHASHSEED": "0",
        "TZ": "UTC",
    })
    app_log = open(work / "app.log", "w")
    app = subprocess.Popen([python, "app.py"], cwd=str(REPO), env=env,
                           stdout=None if verbose else app_log, stderr=subprocess.STDOUT)
    app_base = f"http://127.0.0.1:{app_port}"
    try:
        wait_http(f"{app_base}/api/health", 180, app)
    except Exception:
        stop_proc(app)
        stop_proc(stub)
        raise
    return stub, app, stub_base, app_base


def run_all(args: argparse.Namespace) -> dict[str, dict]:
    spec = json.loads(SCENARIOS.read_text(encoding="utf-8"))
    scenarios = spec["scenarios"]
    if args.only:
        wanted = set(args.only.split(","))
        unknown = wanted - {s["name"] for s in scenarios}
        if unknown:
            raise SystemExit(f"unknown scenarios: {sorted(unknown)}")
        scenarios = [s for s in scenarios if s["name"] in wanted]
    work = Path(tempfile.mkdtemp(prefix="dw-baseline-"))
    print(f"[baseline] work dir {work}", flush=True)
    stub_proc = app_proc = None
    results: dict[str, dict] = {}
    try:
        with FixtureServer() as fixtures:
            stub_proc, app_proc, stub_base, app_base = start_services(work, args.python, args.verbose)
            print(f"[baseline] stub {stub_base}  app {app_base}  fixtures {fixtures.base}", flush=True)
            target = OldFlaskTarget(app_base)
            target.configure_model(stub_base)
            target.seed_knowledge(spec.get("knowledge_seed") or {})
            stub = Stub(stub_base)
            subst = {"{fixture_base}": fixtures.base}
            sids: list[str] = []
            literals: dict[str, str] = {str(work): "<WORK>", fixtures.base: "http://127.0.0.1:<PORT>"}
            raw: dict[str, dict] = {}
            for scenario in scenarios:
                t0 = time.monotonic()
                out = run_scenario(target, stub, scenario, subst, work)
                sids.append(out["sid"])
                literals.update(out["literals"])
                raw[scenario["name"]] = out["recording"]
                print(f"[baseline] {scenario['name']:<22} {out['recording']['status']:<10} "
                      f"{time.monotonic() - t0:5.1f}s  {out['recording']['coverage']}", flush=True)
            norm = Normalizer(work / "data", sids, literals)
            for name, rec in raw.items():
                results[name] = norm(rec)
    finally:
        stop_proc(app_proc)
        stop_proc(stub_proc)
        if args.keep:
            print(f"[baseline] kept {work}", flush=True)
        else:
            shutil.rmtree(work, ignore_errors=True)
    return results


def summary_of(results: dict[str, dict]) -> dict:
    return {
        name: {"status": rec["status"], "coverage": rec["coverage"],
               **({"blocked_reason": rec["blocked_reason"]} if "blocked_reason" in rec else {})}
        for name, rec in results.items()
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="rerun and diff against baseline/recordings")
    ap.add_argument("--only", default="", help="comma-separated scenario names")
    ap.add_argument("--keep", action="store_true", help="keep the temp work dir (logs, data root)")
    ap.add_argument("--python", default=str(REPO / ".venv" / "bin" / "python"),
                    help="interpreter for the old app")
    ap.add_argument("--verbose", action="store_true", help="stream the app log to stdout")
    args = ap.parse_args()

    results = run_all(args)
    if args.check:
        failed = []
        for name, rec in results.items():
            path = RECORDINGS / f"{name}.json"
            if not path.exists():
                failed.append(name)
                print(f"[check] {name}: no recording at {path}")
                continue
            expected = path.read_text(encoding="utf-8")
            actual = dumps(rec)
            if expected != actual:
                failed.append(name)
                diff = difflib.unified_diff(expected.splitlines(), actual.splitlines(),
                                            f"recordings/{name}.json", f"rerun/{name}.json", lineterm="", n=2)
                print("\n".join(diff))
        if failed:
            print(f"[check] FAILED: {len(failed)}/{len(results)} differ: {', '.join(failed)}")
            return 1
        print(f"[check] OK: {len(results)} scenarios match recordings")
        return 0

    RECORDINGS.mkdir(parents=True, exist_ok=True)
    for name, rec in results.items():
        (RECORDINGS / f"{name}.json").write_text(dumps(rec), encoding="utf-8")
    if not args.only:
        (RECORDINGS / "_summary.json").write_text(dumps(summary_of(results)), encoding="utf-8")
    print(f"[baseline] wrote {len(results)} recordings to {RECORDINGS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
