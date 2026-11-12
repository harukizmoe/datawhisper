#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HTTPAPIDataSource — JSON/CSV REST endpoint → DataFrame → DuckDB."""
import io
import logging
from typing import List, Tuple

import pandas as pd
import requests

from ._utils import (
    _clean_identifier, _dedup_columns, _list_tables, _new_conn,
    _preview_table_dict, _query, _register, _table_schema_str,
)
from compute.i18n import say

from .base import DataSource

log = logging.getLogger(__name__)


def _flatten_json(data) -> pd.DataFrame:
    """Best-effort conversion of a JSON API response to a DataFrame."""
    if isinstance(data, list):
        return pd.json_normalize(data)
    if isinstance(data, dict):
        for v in data.values():
            if isinstance(v, list) and v:
                return pd.json_normalize(v)
        return pd.json_normalize([data])
    raise ValueError(f"Cannot convert JSON type {type(data).__name__} to DataFrame.")


class HTTPAPIDataSource(DataSource):
    """Fetch data from an HTTP REST endpoint and load into DuckDB in-memory."""

    def __init__(self, url: str, auth_type: str = "none", auth_value: str = "",
                 display_name: str = ""):
        self._url = url
        self._auth_type = auth_type
        self._auth_value = auth_value
        self.name = display_name or url
        self._conn = _new_conn()
        self._table = "api_data"
        self._load()

    def _build_headers(self) -> dict:
        headers: dict = {"Accept": "application/json, text/csv"}
        if self._auth_type == "bearer":
            headers["Authorization"] = f"Bearer {self._auth_value}"
        elif self._auth_type == "api_key":
            headers["X-API-Key"] = self._auth_value
        return headers

    def _load(self):
        resp = requests.get(self._url, headers=self._build_headers(), timeout=30)
        resp.raise_for_status()
        content_type = resp.headers.get("Content-Type", "")
        text = resp.text.strip()
        if "csv" in content_type or (not text.startswith(("{", "["))):
            try:
                df = pd.read_csv(io.StringIO(resp.text))
            except Exception:
                df = _flatten_json(resp.json())
        else:
            df = _flatten_json(resp.json())
        if df.empty:
            raise ValueError(say("The API response is empty after parsing; no data to load.", "API 响应解析后为空，无法加载数据。"))
        df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
        df = df.dropna(how="all")
        _register(self._conn, self._table, df)

    def get_schema(self) -> str:
        # Include every table (raw + analysis tables created at runtime).
        parts: List[str] = []
        for table in (self.list_tables() or [self._table]):
            rows = self._conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            parts.append(_table_schema_str(self._conn, table, rows))
        return "\n\n".join(parts)

    def list_tables(self) -> List[str]:
        return _list_tables(self._conn)

    def execute_query(self, sql: str) -> Tuple[pd.DataFrame, str]:
        return _query(self._conn, sql)

    def create_analysis_table(self, sql: str, table_name: str = "analysis_data", _df=None) -> str:
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
        return _table_schema_str(self._conn, table_name, rows)

    def get_preview(self) -> List[dict]:
        try:
            cols = [r[0] for r in self._conn.execute(f'DESCRIBE "{self._table}"').fetchall()]
            total = self._conn.execute(f'SELECT COUNT(*) FROM "{self._table}"').fetchone()[0]
            return [{"name": self._table, "columns": cols, "total_rows": total}]
        except Exception:
            return []

    def get_preview_table(self, table_name: str, max_rows: int = 100) -> dict:
        return _preview_table_dict(self._conn, table_name, table_name, max_rows)
