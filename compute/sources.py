"""Data sources held open by the compute worker.

Sources are stateful (in-memory DuckDB with runtime analysis tables), so the
worker keeps them open by id. Node owns the descriptors and reopens them after
a worker restart; in-memory derived tables do not survive a restart, persistent
workspace tables do.

A tool call leases an ordered set of sources (``SourceRegistry.lease``): it
holds every source's lock for the whole call and sees a cached ``SourceView``
(combined schema + cross-source ``MergedDataSource``) for that id tuple.
"""
from __future__ import annotations

import logging
import re
import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator, Sequence

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

from .rpc import INVALID_PARAMS, RpcError

log = logging.getLogger(__name__)


def combined_schema(sources: Sequence[DataSource]) -> str:
    """Merged schema of the active sources, in order.

    When multiple sources are active and any two share the same table name,
    each table is prefixed with ``src{N}__`` (1-based) so that the LLM can
    unambiguously reference it.  Single-source behaviour is unchanged.

    The prefix is understood by ``DataToolsMixin._route_query``, which strips
    it before passing the SQL to the individual DataSource.
    """
    if not sources:
        return ""
    if len(sources) == 1:
        return sources[0].get_schema()

    # Collect all table names across sources to detect collisions.
    all_table_names: list[str] = []
    for src in sources:
        try:
            all_table_names.extend(src.list_tables())
        except Exception:
            pass
    collision = len(all_table_names) != len(set(all_table_names))

    parts = []
    for idx, src in enumerate(sources, start=1):
        raw_schema = src.get_schema()
        if collision:
            # Prefix every "Table: <name>" line with src{N}__ so the LLM
            # (and the router) can tell tables apart across sources.
            raw_schema = re.sub(
                r"Table:\s+(\S+)",
                lambda m, idx=idx: f"Table: src{idx}__{m.group(1)}",
                raw_schema,
            )
            note = (
                f"  [NOTE: prefix all table names with src{idx}__ when writing SQL, "
                f"e.g. SELECT * FROM \"src{idx}__<table_name>\"]"
            )
        else:
            note = ""
        header = f"=== 数据源 {idx}: {getattr(src, 'name', '未命名')} ==="
        parts.append(f"{header}{note}\n{raw_schema}")
    return "\n\n".join(parts)


def build_merged_source(sources: Sequence[DataSource]):
    """A MergedDataSource (one DuckDB connection over all sources, tables
    registered as ``src{N}__<table>``) for cross-source SQL; None when fewer
    than two sources are given or construction fails."""
    if len(sources) < 2:
        return None
    try:
        from data.merged_source import MergedDataSource
        return MergedDataSource(list(sources))
    except Exception as exc:
        log.warning("[sources] MergedDataSource build failed: %s", exc)
        return None


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


class SourceView:
    """Combined schema and merged source of one ordered set of sources.

    Both are built lazily and only used while the owner holds every source's
    lock, so building needs no extra locking.
    """

    def __init__(self, sources: Sequence[DataSource]):
        self.sources = list(sources)
        self._schema: str | None = None
        self._merged = None
        self._merged_built = False

    def combined_schema(self) -> str:
        if self._schema is None:
            self._schema = combined_schema(self.sources)
        return self._schema

    def merged_source(self):
        if not self._merged_built:
            self._merged = build_merged_source(self.sources)
            self._merged_built = True
        return self._merged

    def close(self) -> None:
        if self._merged is not None:
            _close(self._merged)
            self._merged = None


class Lease:
    """The sources of one call, all locked, in the caller's order."""

    def __init__(self, registry: "SourceRegistry", ids: tuple[str, ...], sources: dict[str, DataSource]):
        self._registry = registry
        self.ids = ids
        self._by_id = sources
        self.sources = [sources[sid] for sid in ids]

    def source(self, source_id: str) -> DataSource:
        return self._by_id[source_id]

    def view(self) -> SourceView:
        return self._registry._view(self.ids, self.sources)

    def invalidate(self, source_ids: Sequence[str] | None = None) -> None:
        """Drop cached views that include any of *source_ids* (default: all
        leased sources) after their tables changed. Every user of such a view
        holds the lock of the changed source, which this lease holds, so the
        merged sources can be closed right away."""
        for view in self._registry._drop_views(set(source_ids if source_ids is not None else self.ids)):
            view.close()


class SourceRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._views: dict[tuple[str, ...], SourceView] = {}
        self._lock = threading.Lock()

    def open(self, source_id: str, descriptor: dict) -> DataSource:
        source = restore_source(descriptor)
        self._install(source_id, source)
        return source

    def add(self, source_id: str, source: DataSource) -> None:
        """Register an already-built source (e.g. extracted web tables) under a
        new id. Built in memory, it cannot be reopened from a descriptor."""
        with self._lock:
            if source_id in self._entries:
                raise RpcError(f"data source already open: {source_id}", INVALID_PARAMS)
            self._entries[source_id] = _Entry(source)

    def _install(self, source_id: str, source: DataSource) -> None:
        with self._lock:
            previous = self._entries.get(source_id)
            self._entries[source_id] = _Entry(source)
            stale = self._drop_views_locked({source_id})
        if previous is not None:
            # Wait for calls still using the old source before closing it.
            with previous.lock:
                _close(previous.source)
                for view in stale:
                    view.close()

    def close(self, source_id: str) -> bool:
        with self._lock:
            entry = self._entries.pop(source_id, None)
            stale = self._drop_views_locked({source_id})
        if entry is None:
            return False
        with entry.lock:
            _close(entry.source)
            for view in stale:
                view.close()
        return True

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._entries)

    @contextmanager
    def lease(self, source_ids: Sequence[str]) -> Iterator[Lease]:
        """Lock the given sources (in sorted id order, so concurrent leases
        cannot deadlock) for the duration of the block."""
        ids = tuple(dict.fromkeys(source_ids))
        while True:
            with self._lock:
                entries = {sid: self._entries.get(sid) for sid in ids}
            missing = [sid for sid, entry in entries.items() if entry is None]
            if missing:
                raise RpcError(
                    f"data source not open: {', '.join(missing)}",
                    data={"kind": "source_not_open"},
                )
            with ExitStack() as stack:
                for sid in sorted(ids):
                    stack.enter_context(entries[sid].lock)
                with self._lock:
                    replaced = any(self._entries.get(sid) is not entries[sid] for sid in ids)
                if replaced:
                    continue  # reopened or closed while we waited; resolve again
                yield Lease(self, ids, {sid: entry.source for sid, entry in entries.items()})
                return

    @contextmanager
    def use(self, source_id: str) -> Iterator[DataSource]:
        with self.lease([source_id]) as lease:
            yield lease.source(source_id)

    def _view(self, ids: tuple[str, ...], sources: list[DataSource]) -> SourceView:
        with self._lock:
            view = self._views.get(ids)
            if view is None:
                view = self._views[ids] = SourceView(sources)
            return view

    def _drop_views(self, source_ids: set[str]) -> list[SourceView]:
        with self._lock:
            return self._drop_views_locked(source_ids)

    def _drop_views_locked(self, source_ids: set[str]) -> list[SourceView]:
        stale = [key for key in self._views if source_ids.intersection(key)]
        return [self._views.pop(key) for key in stale]


def _close(source) -> None:
    close = getattr(source, "close", None)
    if callable(close):
        close()
        return
    invalidate = getattr(source, "invalidate", None)
    if callable(invalidate):
        invalidate()
        return
    conn = getattr(source, "_conn", None)
    if conn is not None:
        conn.close()
