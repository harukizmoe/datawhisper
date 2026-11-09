"""``source.test``：试连一次并立即关闭，不登记 source；失败时给出可读原因。"""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from compute.methods import METHODS, _sources
from compute.rpc import RpcError
from compute.sources import friendly_conn_error, restore_source


class SourceTestMethod(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / "demo.db"
        con = sqlite3.connect(self.db)
        con.execute("create table sales(region text)")
        con.execute("create view v as select * from sales")
        con.commit()
        con.close()

    def test_reports_catalog_and_server_without_registering_a_source(self) -> None:
        before = list(_sources.ids())
        result = METHODS["source.test"](None, {"descriptor": {"kind": "sql", "connection_string": f"sqlite:///{self.db}"}})
        self.assertEqual(result["tables"], 2)  # 表和视图都算目录里的表
        self.assertTrue(result["server"].startswith("SQLite "))
        self.assertEqual(result["name"], "demo.db")
        self.assertEqual(list(_sources.ids()), before)

    def test_failure_is_an_open_failed_error_with_a_readable_reason(self) -> None:
        with self.assertRaises(RpcError) as caught:
            METHODS["source.test"](None, {"descriptor": {"kind": "sql", "connection_string": "sqlite:////nonexistent/dir/x.db"}})
        self.assertEqual(caught.exception.data["kind"], "open_failed")
        self.assertIn("无法打开数据库文件", str(caught.exception))


class RestoreSelection(unittest.TestCase):
    def test_saved_tables_that_no_longer_exist_do_not_block_opening(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "demo.db"
            con = sqlite3.connect(db)
            con.execute("create table sales(region text)")
            con.commit()
            con.close()
            descriptor = {"kind": "sql", "connection_string": f"sqlite:///{db}"}
            source = restore_source({**descriptor, "analysis_tables": ["sales", "dropped"]})
            self.addCleanup(source.close)
            self.assertEqual(source.get_analysis_tables(), ["sales"])
            gone = restore_source({**descriptor, "analysis_tables": ["dropped"]})
            self.addCleanup(gone.close)
            self.assertEqual(gone.get_analysis_tables(), [])


class DatabaseErrorWording(unittest.TestCase):
    def test_common_failures_name_what_to_check(self) -> None:
        cases = {
            'FATAL:  password authentication failed for user "demo"': "用户名或密码",
            'FATAL:  database "nope" does not exist': "数据库名",
            "connection to server at \"h\" (1.2.3.4), port 5432 failed: Connection refused": "主机和端口",
            "(2003, \"Can't connect to MySQL server on 'h'\")": "主机和端口",
            "no pg_hba.conf entry for host": "pg_hba.conf",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertIn(expected, friendly_conn_error(RuntimeError(raw), "数据库"))


if __name__ == "__main__":
    unittest.main()
