"""针对真实 ``python -m compute`` worker 的 UI 侧 compute 方法（P1.3）。

路由清单：列出旧 ``api/*.py`` 中会操作 pandas、DuckDB、``data/sources`` 或
``Function/`` 的路由，以及各自被什么取代。"TS" 指由 agent 服务的内部 API（P6）
不经 compute 直接完成。其余 blueprint（auth、admin、models、mcp、skills、
commands、hooks、memory、teams、workflows、workflow_runs、jobs、lifecycle、
local_services、forecast、gpu、feishu_bot、business_canvas、desktop、output、
以及 chat 中除 agent 回合与 PNG 导出之外的部分）不做 DataFrame 工作：由 TS 处理，
或在只服务登录、管理、配额、托管模型或 Web 页面之处直接删除。

| 旧路由 | 替代者 |
|---|---|
| POST /api/session/<sid>/upload | ``upload.prepare`` -> ``source.open``（+ ``source.schema``）；保存文件、warehouse 自动保存：TS |
| POST /api/session/<sid>/upload-jobs/<jid>/finalize | 并入 ``upload.prepare``：大工作簿的解析就地运行，其 descriptor 带 ``db_path`` |
| POST /api/session/<sid>/load-sample | 删除：云端演示数据 |
| POST /api/session/<sid>/connect-db | ``source.open {kind: "sql"}``（password 编码、可读的连接错误）；已保存的表单值：TS |
| POST /api/session/<sid>/connect-gsheets | ``source.open {kind: "gsheets"}`` |
| POST /api/session/<sid>/connect-api | ``source.open {kind: "http"}`` |
| POST /api/session/<sid>/connect-feishu | ``source.open {kind: "feishu"}``；列出 Bitable 的表：TS（飞书 OpenAPI） |
| GET /api/datasource-configs, DELETE /api/datasource-configs/<type> | TS：已保存的表单值 |
| GET /api/session/<sid>/sources, POST /api/session/<sid>/sources/<id>/toggle | TS：会话的 source 列表；活动 source 通过 ``context.sources`` 传递 |
| DELETE /api/session/<sid>/sources/<id>, DELETE /api/session/<sid>/datasource | ``source.close`` |
| GET /api/data-warehouses, POST /api/session/<sid>/data-warehouse/save, DELETE /api/data-warehouses/<f> | TS：warehouse 就是一份保存下来的 source descriptor 列表 |
| POST /api/session/<sid>/data-warehouse/load | 对每个保存的 descriptor 调 ``source.open`` |
| POST /api/session/<sid>/load（其数据源部分） | ``source.open`` / ``workspace.sync``；已保存会话路由本身：TS，旧会话文件：P8 |
| GET /api/session/<sid>/preview | 对每个活动 source 调 ``source.preview`` |
| GET /api/session/<sid>/preview-table | ``source.previewTable`` |
| POST /api/session/<sid>/sources/<id>/analysis-tables | ``source.setAnalysisTables`` |
| POST /api/session/<sid>/workspace/mount | ``workspace.sync`` -> ``source.open``；Workspace 身份、权限、绑定：TS |
| POST /api/session/<sid>/workspace/jobs/<jid>/finalize | 并入 ``workspace.sync``：大导入就地运行 |
| POST /api/session/<sid>/workspace/unmount | ``source.close``；其余 TS |
| POST /api/session/<sid>/workspace/checkpoints/<id>/restore | 文件历史：TS；重新导入：``workspace.sync`` |
| 其余 /api/session/<sid>/workspace* 路由 | TS：Workspace 元数据与文件 |
| GET/POST /api/knowledge/categories, PUT/DELETE /api/knowledge/categories/<cid>, POST .../<cid>/toggle | ``knowledge.list/add/update/delete/toggle {kind: "category"}`` |
| /api/knowledge/metrics、/rules、/notes 的 list、add、update、delete、toggle | ``knowledge.list/add/update/delete/toggle {kind: "metric" / "rule" / "note"}`` |
| POST /api/knowledge/parse | ``knowledge.parse`` -> TS 把 prompt 发给用户的模型 -> ``knowledge.extract`` |
| POST /api/knowledge/confirm | ``knowledge.confirm`` |
| GET /api/knowledge/files, DELETE /api/knowledge/files/<f> | ``knowledge.files``、``knowledge.deleteFile`` |
| GET /api/knowledge/search | ``knowledge.search`` |
| POST /api/knowledge/restore, POST /api/knowledge/restore-file | 删除：托管 Web 部署下由浏览器负责的恢复 |
| GET/POST /api/session/<sid>/temp-prompt, POST .../temp-prompt/toggle | TS：按会话的提示词文本及其模型透传 |
| POST /api/system/embed-rebuild | ``knowledge.rebuildEmbeddings``；Skill 向量：TS，连同 skill discovery（P4） |
| GET /api/system/bge-model/status, GET /api/system/embed-mode | ``embed.status`` |
| POST /api/system/bge-model/download | TS 把 ``embed.status`` 的 ``model_files`` 下载到 ``model_dir``，然后 ``embed.reload`` |
| POST /api/system/embed-mode | ``embed.setMode`` |
| GET/PUT /api/system/embed-cloud-config | ``embed.cloudConfig`` / ``embed.setCloudConfig`` |
| POST /api/dashboard/generate | ``tool.generate_dashboard``（P1.2）：该路由原本只是工具的壳 |
| POST /api/dashboard/<id>/refresh, POST /api/dashboard/<id>/widget/<wid>/refresh | ``dashboard.refresh``（只刷一个 widget 时传 ``widget_id``） |
| GET /api/dashboard/<id>/export-html | ``dashboard.exportHtml`` |
| GET/PUT/DELETE /api/dashboard/<id>, GET /api/dashboards | TS：``<data>/outputs/Dashboard`` 下的 JSON 文件 |
| GET /dashboard/<id> | 删除：Web 页面 |
| POST /api/session/<sid>/chat | TS 的 agent 回合：回合 schema 走 ``source.schema``，工具走 ``tool.*``（P1.2） |
| GET /api/chart/<id>/png | ``chart.png`` |
| GET /api/chart/<id>, GET /api/export/<f>, GET /api/session/<sid>/tool-results/<id> | TS：文件服务 |

列统计原本没有自己的路由；由 ``source.tableDetail`` 与 ``tool.profile_data`` 覆盖。
"""
import base64
import csv
import importlib.util
import itertools
import json
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from compute.tests.test_tools import FIXTURES, Client, worker_env

CANCELLED = -32800
INVALID_PARAMS = -32602
SALES_ROWS = 200
BAR_SQL = "SELECT region, ROUND(SUM(revenue), 2) AS revenue FROM sales GROUP BY region ORDER BY region"


class UiTestBase(unittest.TestCase):
    """每个测试类一个 worker，并带一份自己的数据目录。"""

    worker_env_extra: dict = {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="dw-compute-ui-"))
        cls.data_root = cls.tmp / "data"
        cls.data_root.mkdir()
        env = {k: v for k, v in worker_env(cls.data_root).items() if not k.startswith("BAA_CLOUD_EMBED_")}
        # Hash embedding：没有模型文件，也不联网。
        env.update({"BAA_EMBED_MODE": "hash", **cls.worker_env_extra})
        cls.client = Client(env, cls.tmp / "worker.log")
        cls._ids = itertools.count(1)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def result(self, method: str, params: dict) -> dict:
        return self.client.result(method, params)

    def error(self, method: str, params: dict) -> dict:
        resp = self.client.call(method, params)
        self.assertIn("error", resp, f"{method} succeeded: {resp.get('result')}")
        return resp["error"]

    def assert_error(self, method: str, params: dict, kind: str | None = None, code: int | None = None) -> dict:
        error = self.error(method, params)
        if code is not None:
            self.assertEqual(error["code"], code, error)
        if kind is not None:
            self.assertEqual((error.get("data") or {}).get("kind"), kind, error)
        return error

    def fresh_dir(self) -> Path:
        return Path(tempfile.mkdtemp(dir=self.tmp))

    def fixture_copy(self, name: str, as_name: str | None = None) -> Path:
        path = self.fresh_dir() / (as_name or name)
        shutil.copyfile(FIXTURES / name, path)
        return path

    def open_source(self, descriptor: dict) -> tuple[str, list[str]]:
        source_id = f"s{next(self._ids)}"
        opened = self.result("source.open", {"source_id": source_id, "descriptor": descriptor})
        return source_id, opened["tables"]

    def count(self, source_id: str, table: str) -> int:
        result = self.result("source.query", {"source_id": source_id, "sql": f'SELECT COUNT(*) AS n FROM "{table}"'})
        self.assertTrue(result["ok"], result)
        return int(result["text"].split()[-1])

    def cancel_after_first_progress(self, method: str, params: dict) -> dict:
        """发送请求，一旦它报告进度就取消；返回应答。"""
        rid = self.client.send(method, params)
        deadline = time.monotonic() + 60
        while not self.client.notes(rid, "progress"):
            msg = self.client.worker.next(max(0.1, deadline - time.monotonic()))
            self.client.seen.append(msg)
            self.assertNotEqual(msg.get("id"), rid, f"finished before cancel: {msg}")
        self.client.worker.send({"jsonrpc": "2.0", "method": "$/cancel", "params": {"id": rid}})
        return self.client.wait(rid)


def write_workbook(path: Path, sheets: int, rows: int) -> None:
    import xlsxwriter

    workbook = xlsxwriter.Workbook(str(path), {"constant_memory": True})
    for index in range(1, sheets + 1):
        sheet = workbook.add_worksheet(f"part{index}")
        sheet.write_row(0, 0, ["id", "amount", "name", "bucket"])
        for row in range(1, rows + 1):
            sheet.write_row(row, 0, [row, row * 1.5, f"name{row % 97}", row % 7])
    workbook.close()


def write_csv(path: Path, rows: int) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["id", "region", "amount"])
        writer.writerows((i, f"r{i % 5}", i * 2) for i in range(rows))


class UploadTest(UiTestBase):
    # baseline.xlsx（18 KB）仍走直接路径，而生成的工作簿不会。
    worker_env_extra = {"BAA_EXCEL_JOB_THRESHOLD": "100000"}
    SHEETS, ROWS = 4, 15_000

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.big = cls.tmp / "big.xlsx"
        write_workbook(cls.big, cls.SHEETS, cls.ROWS)

    def parsed_files(self) -> set[str]:
        folder = self.data_root / "uploads" / ".parsed_excel"
        return {p.name for p in folder.iterdir()} if folder.is_dir() else set()

    def test_csv_and_small_workbook(self):
        path = self.fixture_copy("sales.csv")
        descriptor = self.result("upload.prepare", {"file_path": str(path)})["descriptor"]
        self.assertEqual(descriptor, {"kind": "csv", "file_path": str(path), "name": "sales.csv"})
        source_id, tables = self.open_source(descriptor)
        self.assertEqual(tables, ["sales"])
        self.assertEqual(self.count(source_id, "sales"), SALES_ROWS)

        path = self.fixture_copy("baseline.xlsx", "销售.xlsx")
        rid = self.client.send("upload.prepare", {"file_path": str(path), "name": "二季度.xlsx"})
        descriptor = self.client.wait(rid)["result"]["descriptor"]
        self.assertEqual(descriptor, {"kind": "excel", "file_path": str(path), "name": "二季度.xlsx"})
        self.assertEqual(self.client.notes(rid, "progress"), [])
        _source_id, tables = self.open_source(descriptor)
        self.assertEqual(sorted(tables), ["sales", "stores"])

    def test_pdf(self):
        import io

        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, ax = plt.subplots(figsize=(6, 3))
        ax.axis("off")
        ax.table(cellText=[["region", "revenue"], ["East", "100"], ["West", "200"], ["North", "300"]], loc="center")
        buf = io.BytesIO()
        fig.savefig(buf, format="pdf")
        plt.close(fig)
        path = self.fresh_dir() / "report.pdf"
        path.write_bytes(buf.getvalue())

        descriptor = self.result("upload.prepare", {"file_path": str(path)})["descriptor"]
        self.assertEqual(descriptor, {"kind": "pdf", "file_path": str(path), "name": "PDF report.pdf"})
        source_id, tables = self.open_source(descriptor)
        self.assertEqual(len(tables), 1)
        self.assertEqual(self.count(source_id, tables[0]), 3)

    def test_large_workbook_is_parsed_with_progress(self):
        before = self.parsed_files()
        rid = self.client.send("upload.prepare", {"file_path": str(self.big), "name": "big.xlsx"})
        resp = self.client.wait(rid)
        self.assertIn("result", resp, resp.get("error"))
        descriptor = resp["result"]["descriptor"]
        db_path = Path(descriptor["db_path"])
        self.assertEqual(db_path.parent, self.data_root / "uploads" / ".parsed_excel")
        self.assertEqual(self.parsed_files() - before, {db_path.name})
        progress = [n["progress"] for n in self.client.notes(rid, "progress")]
        self.assertEqual((progress[0], progress[-1]), (2, 100))
        self.assertGreater(len(progress), self.SHEETS)
        source_id, tables = self.open_source(descriptor)
        self.assertEqual(sorted(tables), [f"part{i}" for i in range(1, self.SHEETS + 1)])
        self.assertEqual(self.count(source_id, "part3"), self.ROWS)

    def test_cancel_large_workbook_parse(self):
        before = self.parsed_files()
        resp = self.cancel_after_first_progress("upload.prepare", {"file_path": str(self.big)})
        self.assertEqual(resp.get("error", {}).get("code"), CANCELLED, resp)
        self.assertEqual(self.parsed_files(), before)

    def test_errors(self):
        text = self.fresh_dir() / "notes.txt"
        text.write_text("a,b\n1,2\n", encoding="utf-8")
        self.assert_error("upload.prepare", {"file_path": str(text)}, "unsupported_format", INVALID_PARAMS)
        self.assert_error("upload.prepare", {"file_path": str(self.tmp / "missing.csv")}, "file_not_found")
        self.assert_error("upload.prepare", {}, code=INVALID_PARAMS)
        # 打开失败时会说明失败原因。
        error = self.assert_error("source.open", {"source_id": "bad", "descriptor": {
            "kind": "csv", "file_path": str(self.tmp / "gone.csv")}}, "open_failed")
        self.assertIn("FileNotFoundError", error["data"]["error"])
        error = self.assert_error("source.open", {"source_id": "bad", "descriptor": {
            "kind": "sql", "connection_string": f"sqlite:///{self.tmp}/no/such/dir/x.db"}}, "open_failed")
        self.assertIn("Cannot open the database file", error["message"])
        self.assert_error("source.open", {"source_id": "bad", "descriptor": {
            "kind": "http", "url": "https://example.test/data", "auth_type": "cookie"}}, "open_failed")
        # 飞书记录由 server 读好后随 descriptor 传入；缺失时不会回头去联网读取。
        self.assert_error("source.open", {"source_id": "bad", "descriptor": {
            "kind": "feishu", "app_token": "bas", "table_id": "tbl"}}, "open_failed")
        source_id, tables = self.open_source({"kind": "feishu", "app_token": "bas", "table_id": "tbl", "records": [
            {"region": "East", "amount": "10", "_feishu_record_id": "rec1"},
            {"region": "West", "amount": "5", "_feishu_record_id": "rec2"}]})
        self.assertEqual(self.count(source_id, tables[0]), 2)


class PreviewTest(UiTestBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        xlsx = cls.tmp / "baseline.xlsx"
        shutil.copyfile(FIXTURES / "baseline.xlsx", xlsx)
        sqlite = cls.tmp / "baseline.sqlite"
        shutil.copyfile(FIXTURES / "baseline.sqlite", sqlite)
        for source_id, descriptor in (
            ("xlsx", {"kind": "excel", "file_path": str(xlsx), "name": "baseline.xlsx"}),
            ("sql", {"kind": "sql", "connection_string": f"sqlite:///{sqlite}", "name": "baseline_sqlite"}),
        ):
            cls.client.result("source.open", {"source_id": source_id, "descriptor": descriptor})

    def test_preview_of_a_file_source(self):
        preview = self.result("source.preview", {"source_id": "xlsx"})
        self.assertEqual(
            (preview["source_id"], preview["source_name"], preview["requires_table_selection"]),
            ("xlsx", "baseline.xlsx", False),
        )
        tables = {t["name"]: t for t in preview["tables"]}
        self.assertEqual(sorted(tables), ["sales", "stores"])
        self.assertEqual(tables["sales"]["total_rows"], SALES_ROWS)
        self.assertIn("region", tables["sales"]["columns"])
        self.assertTrue(all(
            (t["source_id"], t["source_name"], t["selectable_for_analysis"], t["selected_for_analysis"])
            == ("xlsx", "baseline.xlsx", False, False) for t in tables.values()))

    def test_preview_table(self):
        rows = self.result("source.previewTable", {"source_id": "xlsx", "table": "sales"})
        self.assertEqual((rows["name"], rows["total_rows"], len(rows["rows"])), ("sales", SALES_ROWS, 100))
        self.assertIn("region", rows["columns"])
        self.assertTrue(all(isinstance(cell, str) for cell in rows["rows"][0]))
        self.assert_error("source.previewTable", {"source_id": "xlsx", "table": "nope"}, "preview_failed")
        self.assert_error("source.previewTable", {"source_id": "missing", "table": "sales"}, "source_not_open")
        self.assert_error("source.preview", {"source_id": "missing"}, "source_not_open")

    def test_sql_analysis_tables(self):
        preview = self.result("source.preview", {"source_id": "sql"})
        self.assertTrue(preview["requires_table_selection"])
        self.assertEqual({t["name"] for t in preview["tables"]}, {"sales", "stores"})
        self.assertTrue(all(t["selectable_for_analysis"] and not t["selected_for_analysis"] for t in preview["tables"]))

        selected = self.result("source.setAnalysisTables", {"source_id": "sql", "tables": ["stores", "stores"]})
        self.assertEqual(selected, {"source_id": "sql", "tables": ["stores"]})
        flags = {t["name"]: t["selected_for_analysis"] for t in self.result("source.preview", {"source_id": "sql"})["tables"]}
        self.assertEqual(flags, {"sales": False, "stores": True})
        self.assertIn("stores", self.result("source.schema", {"source_id": "sql"})["schema"])

        self.assert_error("source.setAnalysisTables", {"source_id": "sql", "tables": ["nope"]}, "invalid_tables", INVALID_PARAMS)
        self.assert_error("source.setAnalysisTables", {"source_id": "xlsx", "tables": ["sales"]}, "not_sql_source", INVALID_PARAMS)
        self.assert_error("source.setAnalysisTables", {"source_id": "sql", "tables": "sales"}, code=INVALID_PARAMS)


class DashboardTest(UiTestBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        xlsx = cls.tmp / "baseline.xlsx"
        shutil.copyfile(FIXTURES / "baseline.xlsx", xlsx)
        cls.client.result("source.open", {"source_id": "s", "descriptor": {
            "kind": "excel", "file_path": str(xlsx), "name": "baseline.xlsx"}})
        cls.chart_dir = cls.tmp / "charts"
        cls.chart_dir.mkdir()
        cls.dashboard_id = cls.generate("销售看板", "")
        cls.other_workspace_dashboard_id = cls.generate("工作区看板", "ws-1")

    @classmethod
    def generate(cls, name: str, workspace_id: str) -> str:
        result = cls.client.result("tool.generate_dashboard", {
            "context": {"sources": ["s"], "session_id": "ui-test", "workspace_id": workspace_id},
            "args": {"name": name, "widgets": [
                {"id": "bar", "title": "各区域销售额", "chart_type": "Bar_Chart",
                 "field_mapping": {"x": "region", "y": "revenue"}, "sql": BAR_SQL},
                {"id": "kpi", "title": "订单数", "chart_type": "KPI_Card", "sql": "SELECT COUNT(*) AS n FROM sales"},
            ]},
        })
        cls.store(result["charts"])
        return result["dashboard_id"]

    @classmethod
    def store(cls, charts: list[dict]) -> None:
        """agent 服务对结果中的图表所做的事。"""
        for chart in charts:
            (cls.chart_dir / f"{chart['id']}.html").write_text(chart["html"], encoding="utf-8")

    def saved(self, dashboard_id: str) -> dict:
        path = self.data_root / "outputs" / "Dashboard" / f"{dashboard_id}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_refresh_all_widgets(self):
        rid = self.client.send("dashboard.refresh", {"dashboard_id": self.dashboard_id, "source_id": "s"})
        resp = self.client.wait(rid)
        self.assertIn("result", resp, resp.get("error"))
        result = resp["result"]
        [bar] = result["widgets"]
        [kpi] = result["kpi_widgets"]
        self.assertEqual((bar["id"], bar["error"]), ("bar", None))
        self.assertEqual((kpi["id"], kpi["kpi_value"], kpi["error"]), ("kpi", "200", None))
        self.assertEqual([chart["id"] for chart in result["charts"]], [bar["chart_id"]])
        self.store(result["charts"])
        self.assertIn("plotly", result["charts"][0]["html"].lower())
        self.assertEqual([n["progress"] for n in self.client.notes(rid, "progress")], [50, 100])
        saved = self.saved(self.dashboard_id)
        self.assertIn("refreshed_at", saved)
        self.assertEqual({w["id"]: w.get("chart_id") for w in saved["widgets"]}["bar"], bar["chart_id"])

    def test_refresh_one_widget(self):
        result = self.result("dashboard.refresh", {
            "dashboard_id": self.other_workspace_dashboard_id, "source_id": "s",
            "workspace_id": "ws-1", "widget_id": "kpi"})
        self.assertEqual((result["widgets"], result["charts"]), ([], []))
        self.assertEqual([w["kpi_value"] for w in result["kpi_widgets"]], ["200"])

    def test_refresh_errors(self):
        params = {"dashboard_id": self.dashboard_id, "source_id": "s"}
        self.assert_error("dashboard.refresh", {**params, "dashboard_id": "nope"}, "dashboard_not_found")
        self.assert_error("dashboard.refresh", {**params, "widget_id": "nope"}, "widget_not_found")
        self.assert_error("dashboard.refresh", {**params, "source_id": "missing"}, "source_not_open")
        self.assert_error("dashboard.refresh", {**params, "dashboard_id": self.other_workspace_dashboard_id},
                          "workspace_mismatch")

    def test_export_html(self):
        exported = self.result("dashboard.exportHtml", {"dashboard_id": self.dashboard_id, "chart_dir": str(self.chart_dir)})
        self.assertEqual(exported["filename"], "销售看板.html")
        html = exported["html"]
        self.assertTrue(html.startswith("<!DOCTYPE html>"))
        self.assertIn("<iframe srcdoc=", html)
        self.assertNotIn("Chart data unavailable", html)
        self.assertIn("订单数", html)
        self.assert_error("dashboard.exportHtml", {"dashboard_id": "nope", "chart_dir": str(self.chart_dir)},
                          "dashboard_not_found")

    def test_chart_png(self):
        bar_chart = self.saved(self.dashboard_id)["widgets"][0]["chart_id"]
        (self.chart_dir / f"{bar_chart}.spec.json").write_text('{"size": "square"}', encoding="utf-8")
        params = {"chart_dir": str(self.chart_dir), "chart_id": bar_chart}
        if importlib.util.find_spec("kaleido") is None:
            self.assert_error("chart.png", params, "kaleido_missing")
        else:
            png = self.result("chart.png", params)
            self.assertEqual((png["width"], png["height"], png["scale"]), (800, 800, 2))
            self.assertTrue(base64.b64decode(png["png_base64"]).startswith(b"\x89PNG"))
        (self.chart_dir / "map.html").write_text("<html><body><div id='map'></div></body></html>", encoding="utf-8")
        self.assert_error("chart.png", {"chart_dir": str(self.chart_dir), "chart_id": "map"}, "unsupported")
        self.assert_error("chart.png", {"chart_dir": str(self.chart_dir), "chart_id": "nope"}, "chart_not_found")


class WorkspaceSyncTest(UiTestBase):
    # 超过 5 KB 的 CSV 通过内联 job 导入，更小的直接导入。
    worker_env_extra = {"BAA_CSV_JOB_THRESHOLD": "5000"}

    def workdir(self) -> Path:
        path = self.fresh_dir() / "项目"
        path.mkdir()
        return path

    def test_sync_with_paths_imports_only_the_selected_files(self):
        workdir = self.workdir()
        shutil.copyfile(FIXTURES / "sales.csv", workdir / "orders.csv")
        shutil.copyfile(FIXTURES / "stores.csv", workdir / "shops.csv")
        (workdir / "sub").mkdir()
        shutil.copyfile(FIXTURES / "stores.csv", workdir / "sub" / "nested.csv")
        params = {"workspace_id": "ws-2", "workdir": str(workdir)}
        # 只导入其中一个文件：另一个文件即便在目录里也不该出现。
        first = self.result("workspace.sync", {**params, "paths": ["orders.csv"]})
        self.assertEqual([a["source_name"] for a in first["added"]], ["orders.csv"])
        self.assertEqual(sorted(first["tables"]), ["orders"])

        # 子目录用相对路径；不可导入的文件与越界路径各自报错，不影响其余文件。
        second = self.result("workspace.sync", {**params, "source_id": None, "paths": ["sub/nested.csv", "..", "notes.md"]})
        self.assertEqual([a["source_name"] for a in second["added"]], ["sub/nested.csv"])
        self.assertEqual(sorted(second["tables"]), ["orders", "sub_nested"])
        self.assertEqual(len(second["errors"]), 2)

    def test_sync_imports_new_and_changed_files(self):
        workdir = self.workdir()
        shutil.copyfile(FIXTURES / "sales.csv", workdir / "orders.csv")  # 13 KB：走 job 路径
        shutil.copyfile(FIXTURES / "stores.csv", workdir / "shops.csv")
        shutil.copyfile(FIXTURES / "baseline.xlsx", workdir / "baseline.xlsx")
        params = {"workspace_id": "ws-1", "workdir": str(workdir)}
        rid = self.client.send("workspace.sync", params)
        resp = self.client.wait(rid)
        self.assertIn("result", resp, resp.get("error"))
        first = resp["result"]
        db_path = workdir.resolve() / ".zhixi" / "workspace.duckdb"
        self.assertEqual(first["descriptor"], {"kind": "workspace_persistent", "db_path": str(db_path), "name": "项目"})
        self.assertEqual({a["source_name"]: a["tables"] for a in first["added"]}, {
            "baseline.xlsx": ["sales", "stores"], "orders.csv": ["orders"], "shops.csv": ["shops"]})
        self.assertEqual((first["errors"], first["reused"]), ([], 0))
        self.assertEqual(sorted(first["tables"]), ["orders", "sales", "shops", "stores"])
        self.assertEqual(self.client.notes(rid, "progress")[-1]["progress"], 100)

        source_id, tables = self.open_source(first["descriptor"])
        self.assertEqual(sorted(tables), sorted(first["tables"]))
        self.assertEqual(self.count(source_id, "orders"), SALES_ROWS)

        again = self.result("workspace.sync", {**params, "source_id": source_id})
        self.assertEqual((again["added"], again["reused"]), ([], 3))

        with open(workdir / "shops.csv", "a", encoding="utf-8") as fh:
            fh.write("S99,新店,East,2026,100\n")
        before = self.count(source_id, "shops")
        changed = self.result("workspace.sync", {**params, "source_id": source_id})
        self.assertEqual(([a["source_name"] for a in changed["added"]], changed["reused"]), (["shops.csv"], 2))
        self.assertEqual(self.count(source_id, "shops"), before + 1)

    def test_cancel_keeps_files_imported_before(self):
        workdir = self.workdir()
        write_csv(workdir / "a_small.csv", 20)
        write_csv(workdir / "big.csv", 200_000)
        params = {"workspace_id": "ws-2", "workdir": str(workdir)}
        resp = self.cancel_after_first_progress("workspace.sync", params)
        self.assertEqual(resp.get("error", {}).get("code"), CANCELLED, resp)
        retry = self.result("workspace.sync", params)
        self.assertEqual((retry["reused"], [a["source_name"] for a in retry["added"]]), (1, ["big.csv"]))
        source_id, _tables = self.open_source(retry["descriptor"])
        self.assertEqual(self.count(source_id, "big"), 200_000)

    def test_errors(self):
        self.assert_error("workspace.sync", {"workspace_id": "ws-3", "workdir": str(self.tmp / "missing")},
                          "invalid_workdir", INVALID_PARAMS)
        xlsx = self.fixture_copy("baseline.xlsx")
        source_id, _tables = self.open_source({"kind": "excel", "file_path": str(xlsx), "name": "baseline.xlsx"})
        error = self.error("workspace.sync", {"workspace_id": "ws-3", "workdir": str(self.workdir()), "source_id": source_id})
        self.assertEqual(error["code"], INVALID_PARAMS, error)


class KnowledgeTest(UiTestBase):
    def knowledge_dir(self) -> Path:
        return self.data_root / "uploads" / "knowledge"

    def test_records(self):
        categories = self.result("knowledge.list", {"kind": "category"})["items"]
        self.assertEqual(categories[0]["id"], 1)
        category = self.result("knowledge.add", {"kind": "category", "record": {"name": "零售"}})
        renamed = self.result("knowledge.update", {"kind": "category", "id": category["id"], "fields": {"name": "零售业务"}})
        self.assertEqual(renamed["name"], "零售业务")

        metric = self.result("knowledge.add", {"kind": "metric", "record": {
            "name": "GMV", "alias": "成交额", "definition": "下单金额合计", "category_id": category["id"]}})
        self.assertEqual(
            [m["name"] for m in self.result("knowledge.list", {"kind": "metric", "category_id": category["id"]})["items"]],
            ["GMV"])
        self.assertNotIn("GMV", [m["name"] for m in self.result("knowledge.list", {"kind": "metric"})["items"]])
        updated = self.result("knowledge.update", {"kind": "metric", "id": metric["id"], "fields": {"definition": "含税下单金额"}})
        self.assertEqual(updated["definition"], "含税下单金额")
        self.assertEqual(self.result("knowledge.toggle", {"kind": "metric", "id": metric["id"]})["enabled"], 0)
        self.assertNotIn("GMV", [m["name"] for m in self.result("knowledge.search", {"q": "GMV"})["metrics"]])
        self.assertEqual(self.result("knowledge.toggle", {"kind": "metric", "id": metric["id"]})["enabled"], 1)
        self.assertIn("GMV", [m["name"] for m in self.result("knowledge.search", {"q": "GMV"})["metrics"]])
        self.assertEqual(self.result("knowledge.search", {"q": " "}),
                         {"metrics": [], "rules": [], "notes": [], "documents": []})

        rule = self.result("knowledge.add", {"kind": "rule", "record": {"rule_id": "gmv_positive", "description": "GMV 不为负"}})
        note = self.result("knowledge.add", {"kind": "note", "record": {"topic": "大促", "content": "双十一单独统计"}})
        self.assertEqual((rule["severity"], note["category_id"]), ("warning", 1))
        self.assertEqual(self.result("knowledge.delete", {"kind": "rule", "id": rule["id"]}), {"deleted": True})
        deleted = self.result("knowledge.delete", {"kind": "category", "id": category["id"]})
        self.assertEqual(deleted["counts"]["metrics"], 1)
        self.assert_error("knowledge.toggle", {"kind": "metric", "id": metric["id"]}, "not_found")

    def test_record_errors(self):
        self.assert_error("knowledge.list", {"kind": "table"}, code=INVALID_PARAMS)
        self.assert_error("knowledge.add", {"kind": "category", "record": {"name": " "}}, code=INVALID_PARAMS)
        self.assert_error("knowledge.add", {"kind": "metric", "record": "GMV"}, code=INVALID_PARAMS)
        self.assert_error("knowledge.update", {"kind": "metric", "id": 999, "fields": {"name": "x"}}, "not_found")
        self.assert_error("knowledge.toggle", {"kind": "note", "id": 999}, "not_found")
        self.assert_error("knowledge.delete", {"kind": "category", "id": 999}, "not_found")
        self.assert_error("knowledge.toggle", {"kind": "note", "id": "1"}, code=INVALID_PARAMS)

    def test_parse_extract_confirm(self):
        import pandas as pd

        path = self.fresh_dir() / "upload.xlsx"
        with pd.ExcelWriter(path) as writer:
            pd.DataFrame({"名称": ["客单价"], "别名": ["AOV"], "定义": ["GMV / 订单数"]}).to_excel(
                writer, sheet_name="指标", index=False)
            pd.DataFrame({"备忘": ["退货率按自然月统计", "大促期间口径另行约定"]}).to_excel(
                writer, sheet_name="背景", index=False)
        parsed = self.result("knowledge.parse", {"file_path": str(path), "name": "口径.xlsx"})
        self.assertEqual(parsed["format"], "mixed")
        self.assertTrue(parsed["filename"].endswith("_口径.xlsx"), parsed["filename"])
        self.assertTrue((self.knowledge_dir() / parsed["filename"]).is_file())
        self.assertEqual([(r["table"], r["name"], r["alias"]) for r in parsed["preview"]], [("metrics", "客单价", "AOV")])
        [prompt] = parsed["prompts"]
        self.assertIn("退货率按自然月统计", prompt)

        reply = json.dumps({
            "metrics": [{"name": "复购率", "definition": "90 天内再次下单的用户占比"}],
            "business_rules": [],
            "context_notes": [{"topic": "退货率口径", "content": "退货率按自然月统计", "tags": "退货"}],
        }, ensure_ascii=False)
        records = self.result("knowledge.extract", {"replies": [f"```json\n{reply}\n```", reply]})["records"]
        self.assertEqual([(r["table"], r.get("name") or r.get("topic")) for r in records],
                         [("metrics", "复购率"), ("context_notes", "退货率口径")])

        rid = self.client.send("knowledge.confirm", {"records": parsed["preview"] + records, "filename": parsed["filename"]})
        resp = self.client.wait(rid)
        self.assertIn("result", resp, resp.get("error"))
        self.assertEqual(resp["result"]["inserted"], {"metrics": 2, "rules": 0, "notes": 1})
        self.assertGreater(resp["result"]["rag"]["chunks"], 0)
        self.assertEqual(self.client.notes(rid, "progress")[-1]["progress"], 100)
        self.assertLessEqual({"客单价", "复购率"}, {m["name"] for m in self.result("knowledge.list", {"kind": "metric"})["items"]})

        files = self.result("knowledge.files", {})["files"]
        self.assertIn(parsed["filename"], [f["filename"] for f in files])
        removed = self.result("knowledge.deleteFile", {"filename": parsed["filename"]})
        self.assertTrue(removed["deleted"])
        self.assertGreater(removed["chunks"], 0)
        self.assertNotIn(parsed["filename"], [f["filename"] for f in self.result("knowledge.files", {})["files"]])

    def test_parse_docx(self):
        from docx import Document

        path = self.fresh_dir() / "定义.docx"
        document = Document()
        document.add_paragraph("复购率：90 天内再次下单的用户占比")
        document.save(path)
        parsed = self.result("knowledge.parse", {"file_path": str(path)})
        self.assertEqual((parsed["format"], parsed["preview"]), ("unstructured", []))
        self.assertIn("复购率", parsed["prompts"][0])
        self.result("knowledge.deleteFile", {"filename": parsed["filename"]})

    def test_parse_and_confirm_errors(self):
        csv_path = self.fixture_copy("sales.csv")
        self.assert_error("knowledge.parse", {"file_path": str(csv_path)}, "unsupported_format", INVALID_PARAMS)
        self.assert_error("knowledge.parse", {"file_path": str(self.tmp / "missing.docx")}, "file_not_found")
        broken = self.fresh_dir() / "broken.xlsx"
        broken.write_text("not a workbook", encoding="utf-8")
        before = self.result("knowledge.files", {})["files"]
        self.assert_error("knowledge.parse", {"file_path": str(broken)}, "parse_failed")
        self.assertEqual(self.result("knowledge.files", {})["files"], before)
        self.assert_error("knowledge.extract", {"replies": "{}"}, code=INVALID_PARAMS)
        self.assert_error("knowledge.confirm", {}, code=INVALID_PARAMS)
        self.assert_error("knowledge.confirm", {"records": ["GMV"]}, code=INVALID_PARAMS)
        self.assert_error("knowledge.deleteFile", {"filename": "../knowledge.db"}, "file_not_found")

    def test_rebuild_embeddings(self):
        result = self.result("knowledge.rebuildEmbeddings", {})
        self.assertEqual(set(result), {"rebuilt", "document_chunks", "structured_records"})


class EmbedTest(UiTestBase):
    def test_status_and_mode(self):
        status = self.result("embed.status", {})
        self.assertEqual((status["mode"], status["active"]), ("hash", "hash"))
        self.assertEqual(status["model_repo"], "BAAI/bge-small-zh-v1.5")
        self.assertIn("tokenizer.json", status["model_files"])
        self.assertIsInstance(status["installed"], bool)
        self.assertEqual(self.result("embed.setMode", {"mode": "LOCAL"})["mode"], "local")
        self.assertEqual(self.result("embed.setMode", {"mode": "hash"})["active"], "hash")
        self.assert_error("embed.setMode", {"mode": "gpu"}, code=INVALID_PARAMS)
        reloaded = self.result("embed.reload", {})
        self.assertEqual(set(reloaded), {"neural_active", "init_error"})

    def test_cloud_config(self):
        self.assertEqual(set(self.result("embed.cloudConfig", {})), {"url", "model", "token_configured"})
        stored = self.result("embed.setCloudConfig", {"url": "https://embed.example.test/", "model": "bge-m3"})
        self.assertEqual(stored, {"url": "https://embed.example.test", "model": "bge-m3",
                                  "token_configured": False, "test": None})
        saved = json.loads((self.data_root / "config" / "embedding_config.json").read_text(encoding="utf-8"))
        self.assertEqual((saved["cloud_url"], saved["cloud_model"]), ("https://embed.example.test", "bge-m3"))
        self.assert_error("embed.setCloudConfig", {"url": "ftp://embed.example.test", "model": "bge-m3"},
                          code=INVALID_PARAMS)
        # 测试需要 token；没有 token 时不会发送任何内容。
        self.assert_error("embed.setCloudConfig", {"url": "https://embed.example.test", "model": "bge-m3", "test": True},
                          code=INVALID_PARAMS)


if __name__ == "__main__":
    unittest.main()
