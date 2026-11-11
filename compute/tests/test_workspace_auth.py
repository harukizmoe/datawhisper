"""SQL 文件读取授权：工作区根目录由请求给出，Python 不保存挂载状态。"""
import tempfile
import unittest
from pathlib import Path

from compute.host import sql_path_authorization


class SqlPathAuthorizationTest(unittest.TestCase):
    def test_no_workspace_uses_default_roots(self):
        self.assertIsNone(sql_path_authorization("", ""))

    def test_workspace_id_without_root_fails_closed(self):
        authorization = sql_path_authorization("ws1", "")
        self.assertEqual(authorization.allowed_roots, ())

    def test_root_grants_workdir_and_internal_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            workdir = Path(tmp).resolve()
            roots = sql_path_authorization("ws1", str(workdir)).allowed_roots
            self.assertEqual(roots[0], workdir)
            for name in ("artifacts", ".baa_cache", ".zhixi"):
                self.assertIn(workdir / name, roots)


if __name__ == "__main__":
    unittest.main()
