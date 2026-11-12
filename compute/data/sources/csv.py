#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CSVDataSource — single-file .csv loader (DuckDB read_csv_auto with pandas fallback)."""
import logging
from typing import List, Tuple

import pandas as pd

from ._utils import (
    _clean_identifier, _dedup_columns, _list_tables, _new_conn,
    _preview_table_dict, _query, _register, _table_schema_str,
)
from .base import DataSource

log = logging.getLogger(__name__)


class CSVDataSource(DataSource):
    """Load a single CSV file into a DuckDB in-memory DB."""

    def __init__(self, file_path: str, filename: str):
        self.name = filename
        self.file_path = file_path
        self._conn = _new_conn()
        table = _clean_identifier(filename.rsplit(".", 1)[0]) or "data"
        self._table = table

        # DuckDB can read CSV directly — fastest path for large files
        try:
            self._conn.execute(
                f"CREATE OR REPLACE TABLE \"{table}\" AS "
                f"SELECT * FROM read_csv_auto('{file_path}', header=true, "
                f"null_padding=true, ignore_errors=true, "
                f"nullstr=['', 'null', 'NULL', 'Null', 'nan', 'NaN', 'N/A', 'n/a'])"
            )
            # Rename columns to cleaned identifiers
            cols_raw = [r[0] for r in self._conn.execute(f'DESCRIBE "{table}"').fetchall()]
            cleaned = _dedup_columns([_clean_identifier(c) for c in cols_raw])
            for old, new in zip(cols_raw, cleaned):
                if old != new:
                    self._conn.execute(
                        f'ALTER TABLE "{table}" RENAME COLUMN "{old}" TO "{new}"'
                    )
            log.info("[CSVDS] loaded %r via read_csv_auto", file_path)
        except Exception as e:
            log.warning("[CSVDS] read_csv_auto failed (%s), falling back to pandas", e)
            df = pd.read_csv(
                file_path,
                encoding="utf-8-sig",
                na_values=["", "null", "NULL", "Null", "nan", "NaN", "N/A", "n/a"],
                keep_default_na=True,
            )
            df.columns = _dedup_columns([_clean_identifier(c) for c in df.columns])
            df = df.dropna(how="all")
            _register(self._conn, table, df)

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
