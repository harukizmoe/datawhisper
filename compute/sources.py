"""Data sources held open by the compute worker.

Sources are stateful (in-memory DuckDB with runtime analysis tables), so the
worker keeps them open by id. Node owns the descriptors and reopens them after
a worker restart; in-memory derived tables do not survive a restart, persistent
workspace tables do.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from data.feishu_bitable_service import read_bitable_records
from data.sources import (
    CSVDataSource,
    DataSource,
    ExcelDataSource,
    FeishuBitableDataSource,
    GoogleSheetsDataSource,
    HTTPAPIDataSource,
    SQLDataSource,
)
from data.sources.workspace_persistent import WorkspacePersistentSource

from .rpc import RpcError


def restore_source(info: dict) -> DataSource:
    """Build a source from its persisted descriptor."""
    kind = str(info.get("kind") or "")
    name = str(info.get("name") or "").strip()
    if kind == "csv":
        file_path = str(info.get("file_path") or "")
        if not Path(file_path).is_file():
            raise FileNotFoundError(file_path or "CSV 文件不存在")
        return CSVDataSource(file_path, name or Path(file_path).name)
    if kind == "excel":
        file_path = str(info.get("file_path") or "")
        if not Path(file_path).is_file():
            raise FileNotFoundError(file_path or "Excel 文件不存在")
        db_path = str(info.get("db_path") or "")
        if db_path and Path(db_path).is_file():
            return ExcelDataSource.from_database(file_path, name or Path(file_path).name, db_path)
        return ExcelDataSource(file_path, name or Path(file_path).name)
    if kind == "sql":
        conn = str(info.get("connection_string") or "")
        if not conn:
            raise ValueError("SQL 连接字符串为空")
        source = SQLDataSource(conn, name)
        tables = info.get("analysis_tables") or []
        if tables:
            source.set_analysis_tables([str(item) for item in tables])
        return source
    if kind == "gsheets":
        creds = info.get("creds_dict")
        spreadsheet = str(info.get("spreadsheet") or "")
        if not isinstance(creds, dict) or not spreadsheet:
            raise ValueError("Google Sheets 凭证或表格地址为空")
        return GoogleSheetsDataSource(creds, spreadsheet, name)
    if kind == "http":
        url = str(info.get("url") or "")
        if not url:
            raise ValueError("API URL 为空")
        return HTTPAPIDataSource(
            url,
            str(info.get("auth_type") or "none"),
            str(info.get("auth_value") or ""),
            name,
        )
    if kind == "feishu":
        app_token = str(info.get("app_token") or "")
        table_id = str(info.get("table_id") or "")
        if not app_token or not table_id:
            raise ValueError("飞书多维表格 app_token 或 table_id 为空")
        result = read_bitable_records(bitable=app_token, table_id=table_id)
        source = FeishuBitableDataSource(result["records"], name or "飞书多维表格")
        source._feishu_app_token = app_token
        source._feishu_table_id = table_id
        return source
    if kind == "workspace_persistent":
        db_path = str(info.get("db_path") or "")
        if not Path(db_path).is_file():
            raise FileNotFoundError(db_path or "工作目录 DuckDB 不存在")
        return WorkspacePersistentSource(db_path, name or "工作目录")
    raise ValueError(f"不支持的数据源类型：{kind or 'unknown'}")


class _Entry:
    __slots__ = ("source", "lock")

    def __init__(self, source: DataSource):
        self.source = source
        # DuckDB connections are not safe for concurrent use; serialize per source.
        self.lock = threading.Lock()


class SourceRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._lock = threading.Lock()

    def open(self, source_id: str, descriptor: dict) -> DataSource:
        source = restore_source(descriptor)
        with self._lock:
            previous = self._entries.pop(source_id, None)
            self._entries[source_id] = _Entry(source)
        if previous is not None:
            _close(previous.source)
        return source

    def close(self, source_id: str) -> bool:
        with self._lock:
            entry = self._entries.pop(source_id, None)
        if entry is None:
            return False
        with entry.lock:
            _close(entry.source)
        return True

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._entries)

    @contextmanager
    def use(self, source_id: str) -> Iterator[DataSource]:
        with self._lock:
            entry = self._entries.get(source_id)
        if entry is None:
            raise RpcError(f"data source not open: {source_id}", data={"kind": "source_not_open"})
        with entry.lock:
            yield entry.source


def _close(source: DataSource) -> None:
    close = getattr(source, "close", None)
    if callable(close):
        close()
        return
    conn = getattr(source, "_conn", None)
    if conn is not None:
        conn.close()
