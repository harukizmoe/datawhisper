#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MergedDataSource — 多数据源虚拟合并层。

当多个活跃数据源存在同名表（列名相同、表名相同）时，单一数据源无法
支持跨源 JOIN / UNION。本模块在一个新的 DuckDB 连接中，将所有活跃数
据源的表以 ``src{N}__<tablename>`` 的带前缀格式注册，使得 LLM 可以写出
跨源 SQL，且所有执行都在同一个 DuckDB 引擎内完成。

使用方式
--------
由 ``data/session.py`` 的 ``ChatSession.get_merged_source()`` 按需创建
并缓存；``agent/tools_data.py`` 中的 ``_route_query`` 检测到 SQL 含
``src{N}__`` 前缀时自动切换到该对象执行。

生命周期
--------
- 每次数据源列表变化（add / remove / toggle）都应调用 ``invalidate()``，
  下次查询时会重建合并连接。
- 单数据源时永远不需要此对象（``session.py`` 保证不创建）。
"""
import logging
import threading
from typing import Dict, List, Optional, Tuple

import pandas as pd

from compute.i18n import say

from .sources._utils import (
    _new_conn,
    _table_schema_str,
    _query,
    _register,
)
from .sources.base import DataSource

log = logging.getLogger(__name__)


class MergedDataSource(DataSource):
    """虚拟合并数据源：将 N 个 DataSource 的表以 src{N}__ 前缀注册到同一
    个 DuckDB 连接，支持跨源 JOIN / UNION。

    Parameters
    ----------
    sources : list of DataSource
        已激活的数据源列表，顺序决定前缀编号（1-based）。
    """

    def __init__(self, sources: List[DataSource]):
        if len(sources) < 2:
            raise ValueError(say("MergedDataSource requires at least 2 data sources", "MergedDataSource 至少需要 2 个数据源"))

        self.name = "merged"
        self._sources = sources
        self._conn = _new_conn()
        self._lock = threading.Lock()

        # 已注册的带前缀表名 → (src_index, bare_table_name)
        self._prefix_map: Dict[str, Tuple[int, str]] = {}
        # 分析/派生表（写入合并连接）
        self._analysis_tables: List[str] = []

        self._build()

    # ── 内部构建 ──────────────────────────────────────────────────────────────

    def _build(self) -> None:
        """将所有数据源的表以带前缀名注册到合并连接。

        对于 SQLDataSource：只注册已缓存到 DuckDB 的表 + 分析表。
        未缓存的大表不在合并连接中（仍走各自数据源）。

        对于 ExcelDataSource / CSVDataSource：直接从各自连接查全量数据
        后重新注册到合并连接（DataFrame 零拷贝路径）。
        """
        for idx, src in enumerate(self._sources, start=1):
            prefix = f"src{idx}__"
            try:
                bare_tables = src.list_tables()
            except Exception as exc:
                log.warning("[MergedDS] list_tables failed for src%d (%s): %s", idx, src.name, exc)
                bare_tables = []

            for bare in bare_tables:
                prefixed = f"{prefix}{bare}"
                try:
                    df, err = src.execute_query(f'SELECT * FROM "{bare}"')
                    if err or df is None or df.empty:
                        log.debug("[MergedDS] src%d table %r empty/error, skipping: %s",
                                  idx, bare, err)
                        continue
                    _register(self._conn, prefixed, df)
                    self._prefix_map[prefixed] = (idx, bare)
                    log.info("[MergedDS] registered src%d::%r → %r  rows=%d",
                             idx, bare, prefixed, len(df))
                except Exception as exc:
                    log.warning("[MergedDS] failed to register src%d::%r: %s", idx, bare, exc)

    # ── DataSource interface ──────────────────────────────────────────────────

    def get_schema(self) -> str:
        """返回合并连接中所有带前缀表的 schema，按数据源分组展示。"""
        parts: List[str] = []

        # 按数据源分组
        src_sections: Dict[int, List[str]] = {i: [] for i in range(1, len(self._sources) + 1)}
        for prefixed, (idx, _) in self._prefix_map.items():
            src_sections[idx].append(prefixed)
        # 分析表单独一组
        analysis_section: List[str] = list(self._analysis_tables)

        for idx, src in enumerate(self._sources, start=1):
            table_parts: List[str] = []
            for prefixed in sorted(src_sections.get(idx, [])):
                try:
                    rows = self._conn.execute(
                        f'SELECT COUNT(*) FROM "{prefixed}"'
                    ).fetchone()[0]
                    table_parts.append(_table_schema_str(self._conn, prefixed, rows))
                except Exception:
                    table_parts.append(f"Table: {prefixed}  (unavailable)")
            if table_parts:
                header = (
                    say(f"=== Data source {idx}: {getattr(src, 'name', 'Unnamed')} ===\n", f"=== 数据源 {idx}: {getattr(src, 'name', '未命名')} ===\n")
                    + f"  [NOTE: use prefix src{idx}__ for all table names, "
                    f"e.g. SELECT * FROM \"src{idx}__<table_name>\"]"
                )
                parts.append(header + "\n" + "\n\n".join(table_parts))

        for tbl in analysis_section:
            try:
                rows = self._conn.execute(f'SELECT COUNT(*) FROM "{tbl}"').fetchone()[0]
                parts.append(_table_schema_str(self._conn, tbl, rows))
            except Exception:
                pass

        return "\n\n".join(parts) if parts else "No tables in merged source."

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        """在合并连接上执行 SQL。SQL 中的表名应使用 src{N}__ 前缀。"""
        with self._lock:
            return _query(self._conn, sql)

    def create_analysis_table(self, sql: str, table_name: str = "analysis_data",
                              _df=None) -> str:
        """在合并连接中创建派生/分析表，供后续查询使用。"""
        with self._lock:
            if _df is not None:
                _register(self._conn, table_name, _df)
                rows = len(_df)
            else:
                try:
                    self._conn.execute(
                        f'CREATE OR REPLACE TABLE "{table_name}" AS ({sql})'
                    )
                    rows = self._conn.execute(
                        f'SELECT COUNT(*) FROM "{table_name}"'
                    ).fetchone()[0]
                except Exception as exc:
                    return f"Error building analysis table: {exc}"

            if table_name not in self._analysis_tables:
                self._analysis_tables.append(table_name)
            return _table_schema_str(self._conn, table_name, rows)

    def list_tables(self) -> List[str]:
        """返回合并连接中所有可查询的表名（含前缀 + 分析表）。"""
        return list(self._prefix_map.keys()) + list(self._analysis_tables)

    def get_preview(self) -> List[dict]:
        result: List[dict] = []
        for prefixed in sorted(self._prefix_map.keys()):
            try:
                cols  = [r[0] for r in self._conn.execute(f'DESCRIBE "{prefixed}"').fetchall()]
                total = self._conn.execute(
                    f'SELECT COUNT(*) FROM "{prefixed}"'
                ).fetchone()[0]
                result.append({"name": prefixed, "columns": cols, "total_rows": total})
            except Exception:
                continue
        return result

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        from .sources._utils import _preview_table_dict
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)

    # ── 辅助方法 ──────────────────────────────────────────────────────────────

    def has_table(self, prefixed_name: str) -> bool:
        """判断合并连接中是否存在某个带前缀的表。"""
        return prefixed_name in self._prefix_map or prefixed_name in self._analysis_tables

    def src_count(self) -> int:
        return len(self._sources)

    def invalidate(self) -> None:
        """关闭合并连接（数据源变化时调用），下次使用时由 session 重建。"""
        try:
            self._conn.close()
        except Exception:
            pass
        log.info("[MergedDS] invalidated")
