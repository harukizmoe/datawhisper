"""RPC method table of the compute worker."""
from __future__ import annotations

import os
from typing import Any

from .rpc import MethodContext, RpcError, INVALID_PARAMS
from .sources import SourceRegistry

_sources = SourceRegistry()


def _str(params: dict, key: str, required: bool = True) -> str:
    value = params.get(key, "")
    if not isinstance(value, str) or (required and not value):
        raise RpcError(f"'{key}' must be a non-empty string", INVALID_PARAMS)
    return value


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def ping(ctx: MethodContext, params: dict) -> dict:
    return {"pid": os.getpid()}


def source_open(ctx: MethodContext, params: dict) -> dict:
    source_id = _str(params, "source_id")
    descriptor = params.get("descriptor")
    if not isinstance(descriptor, dict):
        raise RpcError("'descriptor' must be an object", INVALID_PARAMS)
    source = _sources.open(source_id, descriptor)
    return {"source_id": source_id, "name": source.name, "tables": source.list_tables()}


def source_close(ctx: MethodContext, params: dict) -> dict:
    return {"closed": _sources.close(_str(params, "source_id"))}


def source_list(ctx: MethodContext, params: dict) -> dict:
    return {"source_ids": _sources.ids()}


def source_tables(ctx: MethodContext, params: dict) -> dict:
    with _sources.use(_str(params, "source_id")) as source:
        return {"tables": source.list_tables()}


def source_schema(ctx: MethodContext, params: dict) -> dict:
    with _sources.use(_str(params, "source_id")) as source:
        return {"schema": source.get_schema()}


def source_table_detail(ctx: MethodContext, params: dict) -> dict:
    table = _str(params, "table")
    with _sources.use(_str(params, "source_id")) as source:
        if table not in source.list_tables():
            return {"found": False}
        detail = getattr(source, "get_table_detail", None)
        if detail is None:
            return {"found": True, "detail": None}
        return {"found": True, "detail": detail(table)}


def source_query(ctx: MethodContext, params: dict) -> dict:
    sql = _str(params, "sql")
    with _sources.use(_str(params, "source_id")) as source:
        df, error = source.execute_query(sql)
        if error:
            return {"ok": False, "error": error}
        return {
            "ok": True,
            "text": source.format_result(df),
            "rows": len(df),
            "columns": [str(c) for c in df.columns],
            "source_name": source.name,
        }


def profile_run(ctx: MethodContext, params: dict) -> dict:
    from Function.Clean.data_profile import profile

    table = _str(params, "table")
    columns = params.get("columns") or None
    if columns is not None and not (isinstance(columns, list) and all(isinstance(c, str) for c in columns)):
        raise RpcError("'columns' must be a list of strings", INVALID_PARAMS)
    with _sources.use(_str(params, "source_id")) as source:
        ctx.progress(10, "正在读取数据")
        df, error = source.execute_query(f"SELECT * FROM {_quote_ident(table)}")
    if error or df is None or df.empty:
        raise RpcError(f"读取表 '{table}' 失败：{error or '表为空'}", data={"kind": "table_read_failed"})
    ctx.check()
    ctx.progress(40, "正在计算字段统计")
    text, charts = profile(df, columns)
    ctx.check()
    ctx.progress(100, "数据概况生成完成")
    return {
        "text": f"### 数据概况 · `{table}`\n\n" + text,
        "charts": charts,
        "input_rows": len(df),
        "input_columns": len(df.columns),
    }


METHODS: dict[str, Any] = {
    "ping": ping,
    "source.open": source_open,
    "source.close": source_close,
    "source.list": source_list,
    "source.tables": source_tables,
    "source.schema": source_schema,
    "source.tableDetail": source_table_detail,
    "source.query": source_query,
    "profile.run": profile_run,
}
