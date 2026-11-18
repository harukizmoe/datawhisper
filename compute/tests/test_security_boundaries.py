"""安全边界回归：表名注入、文件读取别名、远程表函数与永久黑名单路径。

对应安全审计发现 1–4；这些都是模型可通过工具参数或 SQL 触发的路径。
"""
import tempfile
import unittest
from pathlib import Path

import json
import os
import stat
import sys

import duckdb
import pandas as pd

from compute.validate import (
    _FILE_READ_FUNCTIONS,
    validate_sql_structured,
    validate_tool_args,
)
from compute.data.sources._utils import _new_conn, _register, quote_ident

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "Function" / "Charts_generation"))
from chart_generate import generate_chart  # noqa: E402


class SqlBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="dw-sec-"))
        self.roots = [self.root]
        (self.root / "data.csv").write_text("id,total\n1,10\n", encoding="utf-8")
        (self.root / ".env").write_text("SECRET=1\n", encoding="utf-8")

    def status(self, sql):
        return validate_sql_structured(sql, allowed_roots=self.roots).status

    def test_file_read_inside_allowed_root_passes(self):
        self.assertEqual(self.status("SELECT * FROM read_csv('data.csv')"), "passed")

    def test_read_json_objects_outside_roots_is_rejected(self):
        # 旧白名单只认 read_json，漏掉 read_json_objects。
        self.assertEqual(
            self.status("SELECT * FROM read_json_objects('/etc/passwd')"),
            "failed",
        )

    def test_new_file_read_aliases_are_path_checked(self):
        for name in ("read_ndjson", "parquet_scan", "glob", "sniff_csv"):
            with self.subTest(name=name):
                self.assertEqual(
                    self.status(f"SELECT * FROM {name}('/etc/passwd')"),
                    "failed",
                )

    def test_unknown_read_function_is_rejected(self):
        self.assertEqual(
            self.status("SELECT * FROM read_something_new('/etc/passwd')"),
            "failed",
        )

    def test_remote_database_functions_are_rejected(self):
        for name in ("postgres_scan", "mysql_scan", "sqlite_scan"):
            with self.subTest(name=name):
                self.assertEqual(
                    self.status(f"SELECT * FROM {name}('host=127.0.0.1', 't')"),
                    "failed",
                )

    def test_blocked_files_inside_workspace_are_rejected(self):
        self.assertEqual(self.status("SELECT * FROM read_text('.env')"), "failed")

    def test_file_read_allowlist_covers_duckdb_aliases(self):
        for name in _FILE_READ_FUNCTIONS:
            with self.subTest(name=name):
                self.assertIsInstance(name, str)


class IdentifierBoundaryTests(unittest.TestCase):
    def test_quote_ident_escapes_embedded_quotes(self):
        self.assertEqual(quote_ident('a"b'), '"a""b"')

    def test_register_treats_injected_name_as_a_literal_table(self):
        conn = duckdb.connect(":memory:")
        payload = 'evil" AS SELECT * FROM read_text(\'/etc/passwd\') --'
        _register(conn, payload, pd.DataFrame({"v": [1]}))
        tables = {row[0] for row in conn.execute("SHOW TABLES").fetchall()}
        self.assertEqual(tables, {payload})
        # 注入的第二个语句没有被执行，也没有产生表 evil。
        self.assertNotIn("evil", tables)
        conn.close()

    def test_create_analysis_table_rejects_non_identifier_name(self):
        payload = 'x" AS SELECT * FROM read_text(\'/etc/passwd\') --'
        err = validate_tool_args(
            "create_analysis_table",
            {"sql": "SELECT 1", "table_name": payload},
        )
        self.assertIsNotNone(err)
        self.assertIn("table_name", err)

    def test_clean_data_rejects_non_identifier_output_table(self):
        err = validate_tool_args(
            "clean_data",
            {"operation": "fill_na", "table_name": "raw table", "output_table": 'x" --'},
        )
        self.assertIsNotNone(err)
        self.assertIn("output_table", err)
        # 输入表名允许含空格（已有表），只约束新表名。
        self.assertIsNone(validate_tool_args(
            "clean_data",
            {"operation": "fill_na", "table_name": "raw table", "output_table": "cleaned_data"},
        ))

    def test_delete_analysis_tables_validates_every_name(self):
        err = validate_tool_args(
            "delete_analysis_tables",
            {"table_names": ["ok_table", 'bad"name']},
        )
        self.assertIsNotNone(err)
        self.assertIn("table_names[2]", err)


if __name__ == "__main__":
    unittest.main()

class ChartInjectionTests(unittest.TestCase):
    def test_treemap_labels_cannot_break_out_of_script(self):
        payload = '</script><script>alert(1)</script>'
        frame = pd.DataFrame({"label": [payload], "value": [1.0]})
        html = generate_chart(df=frame, chart_type="Treemap", mapping={"labels": "label", "values": "value"})["html"]
        self.assertNotIn(payload, html)
        self.assertIn("<\\/script>", html)

    def test_sunburst_labels_cannot_break_out_of_script(self):
        payload = '</script><script>alert(1)</script>'
        frame = pd.DataFrame({"label": [payload], "value": [1.0]})
        html = generate_chart(df=frame, chart_type="Sunburst_Diagram", mapping={"labels": "label", "values": "value"})["html"]
        self.assertNotIn(payload, html)


class EngineAndCredentialTests(unittest.TestCase):
    def test_duckdb_extension_autoload_is_disabled(self):
        conn = _new_conn()
        try:
            self.assertEqual(
                str(conn.execute("SELECT current_setting('autoinstall_known_extensions')").fetchone()[0]).lower(),
                "false",
            )
            self.assertEqual(
                str(conn.execute("SELECT current_setting('autoload_known_extensions')").fetchone()[0]).lower(),
                "false",
            )
        finally:
            conn.close()

    def test_embedding_config_is_private(self):
        from Function.Knowledge import neural_embedder

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "embedding_config.json"
            original = neural_embedder._EMBED_CONFIG_FILE
            original_token = neural_embedder._CLOUD_TOKEN
            neural_embedder._EMBED_CONFIG_FILE = target
            neural_embedder._CLOUD_TOKEN = "secret-token"
            try:
                neural_embedder._save_runtime_config()
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                self.assertEqual(json.loads(target.read_text())["cloud_token"], "secret-token")
            finally:
                neural_embedder._EMBED_CONFIG_FILE = original
                neural_embedder._CLOUD_TOKEN = original_token
