"""``tool.*`` methods against a real ``python -m compute`` worker.

The parity test replays every category-B tool call recorded by the P0.2
baseline (``baseline/recordings``) on the same fixtures and compares the text
with what the old agent's handler produced. The rest covers the worker-only
behaviour: inline job progress, cancellation, per-source serialization,
multi-source routing and the ingest methods.
"""
import base64
import csv
import importlib.util
import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from compute.tests.test_rpc import REPO, Worker
from compute.tools.dispatch import BUSINESS_TOOLS

BASELINE = REPO / "baseline"
FIXTURES = BASELINE / "fixtures"
RECORDINGS = BASELINE / "recordings"
SESSION_ID = "4f1c2a9e-7b3d-4e8a-9c61-0d2e5f7a8b90"
USER_ID = "local-default"
CANCELLED = -32800
TOOL_TIMEOUT = 300

_spec = importlib.util.spec_from_file_location("run_baseline", BASELINE / "run_baseline.py")
run_baseline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_baseline)

# Confirm fast paths of the old agent (agent/agent.py "Confirm fast-paths"):
# the output tool runs without a model turn and its text is the step's final_text.
FAST_PATHS = {
    "excel_confirm": ("export_excel", lambda o: {
        "tables": o.get("excel_tables") or ["*"], "filename": o.get("excel_filename", "")}),
    "report_confirm": ("export_report", lambda o: {
        "title": o.get("report_title"), "sections": o.get("report_sections") or []}),
    "ppt_confirm": ("generate_ppt", lambda o: {
        "title": o.get("ppt_title"), "slides": o.get("ppt_slides") or [], "filename": ""}),
    "dashboard_confirm": ("generate_dashboard", lambda o: {
        "name": o.get("dashboard_name"), "widgets": o.get("dashboard_widgets") or []}),
}


def handler_output(model_text: str) -> dict:
    """Undo ``agent.tools.results.make_tool_result`` for a recorded tool message.

    The model received ``[TOOL_RESULT] <tool> OK|ERROR: <summary>`` plus a JSON
    envelope ``{"type", "ok", "error", "data", "sources", "artifacts"}``. ``data``
    is the handler output unless the result spilled to a ``tr_*`` artifact (then
    it is only a preview and cannot be compared). Returns ``{"text", "refs"}``
    where ``refs`` is the envelope's ``sources``.
    """
    header, _, payload = model_text.partition("\n")
    if not header.startswith("[TOOL_RESULT] "):
        raise ValueError(f"not a tool envelope: {header[:80]}")
    envelope = json.loads(payload)
    if any(a.get("type") == "tool_result" for a in envelope.get("artifacts", [])):
        raise ValueError("result spilled to a tool-result artifact; data is a preview")
    if not isinstance(envelope.get("data"), str):
        raise ValueError("envelope data is not handler text")
    return {"text": envelope["data"], "refs": envelope.get("sources", [])}


def worker_env(data_root: Path) -> dict:
    env = {
        k: v for k, v in os.environ.items()
        if not k.endswith("_API_KEY") and k not in {
            "RAILWAY_PROJECT_ID", "RAILWAY_VOLUME_MOUNT_PATH", "VERCEL",
            "BAA_DESKTOP_LIFECYCLE", "BAA_RESOURCE_DIR",
        }
    }
    env.update({
        "BAA_DATA_DIR": str(data_root),
        "BAA_SKIP_DEPENDENCY_CHECK": "1",
        "PYTHONHASHSEED": "0",
        "TZ": "UTC",
    })
    return env


_SEED_SCRIPT = """
import json, sys
from Function.Knowledge.knowledge_base import KnowledgeBase
seed = json.load(sys.stdin)
kb = KnowledgeBase(workspace_id="", user_id=sys.argv[1])
for m in seed.get("metrics", []):
    kb.add_metric(**m)
for r in seed.get("rules", []):
    kb.add_rule(**r)
for n in seed.get("notes", []):
    kb.add_note(**n)
kb.close()
"""


class Client:
    """JSON-RPC client over a worker; keeps every notification in arrival order."""

    def __init__(self, env: dict, log_path: Path):
        self._log = open(log_path, "w")
        self.worker = Worker("compute", env=env, stderr=self._log)
        self._ids = itertools.count(1)
        self.seen: list[dict] = []
        self._responses: dict = {}

    def send(self, method: str, params: dict) -> int:
        rid = next(self._ids)
        self.worker.request(rid, method, params)
        return rid

    def wait(self, rid: int, timeout: float = TOOL_TIMEOUT) -> dict:
        deadline = time.monotonic() + timeout
        while rid not in self._responses:
            msg = self.worker.next(max(0.1, deadline - time.monotonic()))
            self.seen.append(msg)
            if "method" not in msg:
                self._responses[msg.get("id")] = msg
        return self._responses.pop(rid)

    def call(self, method: str, params: dict, timeout: float = TOOL_TIMEOUT) -> dict:
        return self.wait(self.send(method, params), timeout)

    def result(self, method: str, params: dict) -> dict:
        resp = self.call(method, params)
        if "error" in resp:
            raise AssertionError(f"{method} failed: {resp['error']}")
        return resp["result"]

    def notes(self, rid: int, kind: str) -> list[dict]:
        return [m["params"] for m in self.seen if m.get("method") == kind and m["params"]["id"] == rid]

    def close(self):
        self.worker.close()
        self._log.close()


class ToolsTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="dw-compute-tools-"))
        cls.data_root = cls.tmp / "data"
        cls.data_root.mkdir()
        cls.env = worker_env(cls.data_root)
        cls.client = Client(cls.env, cls.tmp / "worker.log")
        cls._source_ids = itertools.count(1)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def open_source(self, descriptor: dict) -> tuple[str, list[str]]:
        source_id = f"s{next(self._source_ids)}"
        opened = self.client.result("source.open", {"source_id": source_id, "descriptor": descriptor})
        return source_id, opened["tables"]

    def open_xlsx(self) -> str:
        # Uploads keep their file name as the source name ("baseline.xlsx").
        folder = Path(tempfile.mkdtemp(dir=self.tmp))
        path = folder / "baseline.xlsx"
        shutil.copyfile(FIXTURES / "baseline.xlsx", path)
        return self.open_source({"kind": "excel", "file_path": str(path), "name": "baseline.xlsx"})[0]

    def open_sqlite(self) -> str:
        path = Path(tempfile.mkdtemp(dir=self.tmp)) / "baseline.sqlite"
        shutil.copyfile(FIXTURES / "baseline.sqlite", path)
        # connect-db name used by the baseline driver
        return self.open_source({
            "kind": "sql", "connection_string": f"sqlite:///{path}", "name": "baseline_sqlite",
        })[0]

    def open_csv(self, name: str, rows: list[dict]) -> tuple[str, str]:
        path = Path(tempfile.mkdtemp(dir=self.tmp)) / f"{name}.csv"
        with open(path, "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
        source_id, tables = self.open_source({"kind": "csv", "file_path": str(path), "name": path.name})
        return source_id, tables[0]

    def context(self, *sources: str, **extra) -> dict:
        return {"sources": list(sources), "user_id": USER_ID, "session_id": SESSION_ID,
                "lang": "zh", **extra}


class BaselineParityTest(ToolsTestBase):
    """Every recorded category-B call, replayed through ``tool.*``."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        seed = json.loads((BASELINE / "scenarios.json").read_text(encoding="utf-8"))["knowledge_seed"]
        subprocess.run(
            [sys.executable, "-c", _SEED_SCRIPT, USER_ID], input=json.dumps(seed), text=True,
            cwd=REPO, env=cls.env, check=True, capture_output=True,
        )
        cls.normalize = run_baseline.Normalizer(cls.data_root, [SESSION_ID], {})

    def test_recorded_calls_match(self):
        compared = {name: 0 for name in BUSINESS_TOOLS}
        for path in sorted(RECORDINGS.glob("*.json")):
            if path.name.startswith("_"):
                continue
            recording = json.loads(path.read_text(encoding="utf-8"))
            if recording.get("status") == "blocked":
                continue
            calls = list(self._calls(recording))
            if not calls:
                continue
            with self.subTest(scenario=recording["scenario"]):
                self._replay(recording, calls, compared)
        missing = sorted(name for name, count in compared.items() if count == 0)
        self.assertEqual(missing, [], "tools with no recorded call compared")

    @staticmethod
    def _calls(recording: dict):
        """(tool, args, expected {text, refs?}) in recorded order."""
        for step in recording["steps"]:
            for item in step["tool_results"]:
                if item["tool"] in BUSINESS_TOOLS:
                    yield item["tool"], item["arguments"], handler_output(item["content"])
            action = (step.get("options") or {}).get("internal_action")
            if action in FAST_PATHS:
                tool, build = FAST_PATHS[action]
                yield tool, build(step["options"]), {"text": step["final_text"]}

    def _replay(self, recording: dict, calls: list, compared: dict) -> None:
        first = recording["steps"][0]
        tables = (first.get("options") or {}).get("data_context", {}).get("tables")
        if tables:  # SQL scenario: selection made in the data preview
            source_id = self.open_sqlite()
            context = self.context(source_id, tables={source_id: [t["table"] for t in tables]})
        else:
            context = self.context(self.open_xlsx())
        for index, (tool, args, expected) in enumerate(calls):
            result = self.client.result(f"tool.{tool}", {"context": context, "args": args})
            label = f"{recording['scenario']} call {index} {tool}"
            self.assertEqual(self.normalize(result["text"]), expected["text"], label)
            if "refs" in expected:
                self.assertEqual(self.normalize(result["refs"]), expected["refs"], label)
            for produced in result["files"]:
                self.assertTrue(Path(produced).is_file(), f"{label}: {produced}")
            if tool in {"export_excel", "export_report", "generate_ppt", "generate_dashboard"}:
                self.assertTrue(result["files"], f"{label}: no file reported")
            if tool == "generate_chart":
                self.assertEqual(len(result["charts"]), 1)
                self.assertIn("<html", result["charts"][0]["html"].lower())
            if tool == "generate_dashboard":
                self.assertEqual(len(result["charts"]), len(args["widgets"]))
            compared[tool] += 1


def _daily_rows(count: int) -> list[dict]:
    import math

    rows = []
    for i in range(count):
        day = time.strftime("%Y-%m-%d", time.gmtime(1_577_836_800 + i * 86_400))
        value = 1000 + 3 * i + 120 * math.sin(i / 7) + (i * 37 % 23)
        rows.append({"day": day, "store": f"S{i % 5}", "value": round(value, 2), "units": i % 17})
    return rows


class WorkerBehaviourTest(ToolsTestBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.big_id, cls.big_table = None, None

    def _big(self) -> tuple[str, str]:
        # >= the profile/clean/chart job threshold (50k rows)
        if self.big_id is None:
            type(self).big_id, type(self).big_table = self.open_csv("big", _daily_rows(50_000))
        return self.big_id, self.big_table

    def test_job_path_reports_progress(self):
        source_id, table = self._big()
        rid = self.client.send("tool.profile_data", {
            "context": self.context(source_id), "args": {"table_name": table}})
        resp = self.client.wait(rid)
        self.assertIn("result", resp, resp.get("error"))
        self.assertTrue(resp["result"]["text"].startswith(f"### 数据概况 · `{table}`"))
        progress = [n["progress"] for n in self.client.notes(rid, "progress")]
        self.assertEqual(progress, [10, 40, 100])
        self.assertTrue(resp["result"]["charts"])

    def test_small_input_takes_no_job_path(self):
        source_id = self.open_xlsx()
        rid = self.client.send("tool.profile_data", {
            "context": self.context(source_id), "args": {"table_name": "sales"}})
        self.assertIn("result", self.client.wait(rid))
        self.assertEqual(self.client.notes(rid, "progress"), [])

    def test_cancel_time_series_analysis(self):
        source_id, table = self.open_csv("series", _daily_rows(1_500))
        rid = self.client.send("tool.run_analysis", {
            "context": self.context(source_id),
            "args": {
                "analysis_name": "Time_Series_ARIMA",
                "sql": f'SELECT day, value FROM "{table}" ORDER BY day',
                "target_column": "value", "groupby_column": "day", "n_deciles": 7,
            },
        })
        deadline = time.monotonic() + 60
        while not self.client.notes(rid, "progress"):
            msg = self.client.worker.next(max(0.1, deadline - time.monotonic()))
            self.client.seen.append(msg)
            self.assertNotEqual(msg.get("id"), rid, f"finished before cancel: {msg}")
        self.client.worker.send({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": rid}})
        resp = self.client.wait(rid)
        self.assertEqual(resp.get("error", {}).get("code"), CANCELLED, resp)
        # the source is usable again afterwards
        after = self.client.result("tool.query_data", {
            "context": self.context(source_id), "args": {"sql": f'SELECT COUNT(*) AS n FROM "{table}"'}})
        self.assertIn("1500", after["text"])

    def test_calls_on_one_source_serialize(self):
        source_id, table = self._big()
        params = {"context": self.context(source_id), "args": {"table_name": table}}
        first = self.client.send("tool.profile_data", params)
        second = self.client.send("tool.profile_data", params)
        for rid in (first, second):
            self.assertIn("result", self.client.wait(rid))
        order = [
            m["params"]["id"] for m in self.client.seen
            if m.get("method") == "progress" and m["params"]["id"] in (first, second)
        ]
        self.assertEqual(len(order), 6)
        # all progress of one call precedes all progress of the other
        self.assertIn(order, ([first] * 3 + [second] * 3, [second] * 3 + [first] * 3))

    def test_multi_source_prefixes(self):
        one, two = self.open_xlsx(), self.open_xlsx()
        context = self.context(one, two)
        schema = self.client.result("tool.get_schema", {"context": context, "args": {}})["text"]
        self.assertIn("Table: src1__sales", schema)
        self.assertIn("Table: src2__stores", schema)
        single = self.client.result("tool.query_data", {"context": context, "args": {
            "sql": "SELECT COUNT(*) AS n FROM src2__sales"}})
        self.assertIn("200", single["text"])
        self.assertEqual(single["refs"][0]["source"], "baseline.xlsx")
        cross = self.client.result("tool.query_data", {"context": context, "args": {
            "sql": "SELECT COUNT(*) AS n FROM src1__sales s "
                   "JOIN src2__stores t ON s.store_id = t.store_id"}})
        self.assertNotIn("SQL Error", cross["text"])
        self.assertIn("200", cross["text"])

    def test_created_table_invalidates_cached_schema(self):
        one, two = self.open_xlsx(), self.open_xlsx()
        context = self.context(one, two)
        before = self.client.result("tool.get_schema", {"context": context, "args": {}})["text"]
        self.assertNotIn("region_totals", before)
        created = self.client.result("tool.create_analysis_table", {"context": context, "args": {
            "sql": "SELECT region, SUM(revenue) AS revenue FROM src1__sales GROUP BY region",
            "table_name": "region_totals"}})
        self.assertTrue(created["tables_changed"])
        after = self.client.result("tool.get_schema", {"context": context, "args": {}})["text"]
        self.assertIn("region_totals", after)

    def test_rejected_args_carry_old_tool_text(self):
        resp = self.client.call("tool.query_data", {
            "context": self.context(self.open_xlsx()),
            "args": {"sql": "SELECT * FROM read_csv('/etc/passwd')"}})
        data = resp["error"]["data"]
        self.assertEqual(data["kind"], "arg_validation")
        self.assertTrue(data["text"].startswith("[ARG ERROR] 'query_data' SQL validation failed"))

    def test_sql_source_requires_table_selection(self):
        resp = self.client.call("tool.get_schema", {"context": self.context(self.open_sqlite()), "args": {}})
        self.assertEqual(resp["error"]["data"]["kind"], "sql_table_selection_required")

    def test_unopened_source(self):
        resp = self.client.call("tool.get_schema", {"context": self.context("missing"), "args": {}})
        self.assertEqual(resp["error"]["data"], {"kind": "source_not_open"})

    def test_fetch_table_parse_registers_source(self):
        base = self.open_xlsx()
        body = base64.b64encode((FIXTURES / "stores.html").read_bytes()).decode()
        result = self.client.result("tool.fetch_table_parse", {
            "context": self.context(base), "source_id": "web1", "content_type": "text/html",
            "body_base64": body, "args": {"url": "https://example.com/stores.html", "source_name": "stores_web"}})
        payload = json.loads(result["text"])
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["source_id"], "web1")
        self.assertIn("=== 数据源 2: stores_web ===", payload["schema"])
        table = payload["tables"][0]["name"]
        rows = self.client.result("tool.query_data", {"context": self.context("web1"), "args": {
            "sql": f'SELECT COUNT(*) AS n FROM "{table}"'}})
        self.assertNotIn("SQL Error", rows["text"])
        empty = self.client.result("tool.fetch_table_parse", {
            "context": self.context(), "source_id": "web2", "content_type": "text/html",
            "body_base64": base64.b64encode(b"<html><p>none</p></html>").decode(), "args": {"url": "https://x.test/"}})
        self.assertFalse(json.loads(empty["text"])["ok"])
        self.assertNotIn("source_id", empty)

    def test_load_feishu_bitable_registers_source(self):
        read = {
            "app_token": "bascnX", "table_id": "tblX", "url": "https://example.feishu.cn/base/bascnX",
            "records": [{"_feishu_record_id": f"rec{i}", "region": "East", "amount": str(i * 10)}
                        for i in range(5)],
            "record_count": 5, "limited": False,
        }
        result = self.client.result("tool.load_feishu_bitable", {
            "context": self.context(), "source_id": "fs1", "records": read,
            "args": {"bitable": read["url"], "source_name": "feishu_fixture"}})
        payload = json.loads(result["text"])
        self.assertEqual(
            (payload["ok"], payload["source_id"], payload["source_name"], payload["record_count"]),
            (True, "fs1", "feishu_fixture", 5),
        )
        self.assertNotIn("records", payload)
        total = self.client.result("tool.query_data", {"context": self.context("fs1"), "args": {
            "sql": "SELECT SUM(amount) AS total FROM tblX"}})
        self.assertIn("100", total["text"])


if __name__ == "__main__":
    unittest.main()
