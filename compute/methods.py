"""RPC method table of the compute worker."""
from __future__ import annotations

import os
from typing import Any, Callable

from . import host, knowledge, ui
from .rpc import INVALID_PARAMS, MethodContext, RpcError, str_param
from .sources import SourceRegistry
from .tools.dispatch import BUSINESS_TOOLS

_sources = SourceRegistry()


def ping(ctx: MethodContext, params: dict) -> dict:
    return {"pid": os.getpid()}


def source_open(ctx: MethodContext, params: dict) -> dict:
    source_id = str_param(params, "source_id")
    descriptor = params.get("descriptor")
    if not isinstance(descriptor, dict):
        raise RpcError("'descriptor' must be an object", INVALID_PARAMS)
    source = _sources.open(source_id, descriptor)
    return {"source_id": source_id, "name": source.name, "tables": source.list_tables()}


def source_close(ctx: MethodContext, params: dict) -> dict:
    return {"closed": _sources.close(str_param(params, "source_id"))}


def source_list(ctx: MethodContext, params: dict) -> dict:
    return {"source_ids": _sources.ids()}


def source_tables(ctx: MethodContext, params: dict) -> dict:
    with _sources.use(str_param(params, "source_id")) as source:
        return {"tables": source.list_tables()}


def source_schema(ctx: MethodContext, params: dict) -> dict:
    with _sources.use(str_param(params, "source_id")) as source:
        return {"schema": source.get_schema()}


def source_table_detail(ctx: MethodContext, params: dict) -> dict:
    table = str_param(params, "table")
    with _sources.use(str_param(params, "source_id")) as source:
        if table not in source.list_tables():
            return {"found": False}
        detail = getattr(source, "get_table_detail", None)
        if detail is None:
            return {"found": True, "detail": None}
        return {"found": True, "detail": detail(table)}


def source_query(ctx: MethodContext, params: dict) -> dict:
    sql = str_param(params, "sql")
    with _sources.use(str_param(params, "source_id")) as source:
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


def _tool_method(name: str):
    def method(ctx: MethodContext, params: dict) -> dict:
        return host.run_tool(ctx, _sources, name, params)

    method.__name__ = f"tool_{name}"
    return method


def _with_sources(fn: Callable[[MethodContext, SourceRegistry, dict], Any]):
    """A method of *fn*, which works on open sources, bound to the worker's registry."""
    def method(ctx: MethodContext, params: dict) -> Any:
        return fn(ctx, _sources, params)

    method.__name__ = fn.__name__
    return method


METHODS: dict[str, Any] = {
    "ping": ping,
    "source.open": source_open,
    "source.close": source_close,
    "source.list": source_list,
    "source.tables": source_tables,
    "source.schema": source_schema,
    "source.tableDetail": source_table_detail,
    "source.query": source_query,
    "source.preview": _with_sources(ui.source_preview),
    "source.previewTable": _with_sources(ui.source_preview_table),
    "source.setAnalysisTables": _with_sources(ui.source_set_analysis_tables),
    "upload.prepare": ui.upload_prepare,
    "workspace.sync": _with_sources(ui.workspace_sync),
    "dashboard.refresh": _with_sources(ui.dashboard_refresh),
    "dashboard.exportHtml": ui.dashboard_export_html,
    "chart.png": ui.chart_png,
    "knowledge.list": knowledge.knowledge_list,
    "knowledge.add": knowledge.knowledge_add,
    "knowledge.update": knowledge.knowledge_update,
    "knowledge.toggle": knowledge.knowledge_toggle,
    "knowledge.delete": knowledge.knowledge_delete,
    "knowledge.search": knowledge.knowledge_search,
    "knowledge.parse": knowledge.knowledge_parse,
    "knowledge.extract": knowledge.knowledge_extract,
    "knowledge.confirm": knowledge.knowledge_confirm,
    "knowledge.files": knowledge.knowledge_files,
    "knowledge.deleteFile": knowledge.knowledge_delete_file,
    "knowledge.rebuildEmbeddings": knowledge.knowledge_rebuild_embeddings,
    "embed.status": knowledge.embed_status,
    "embed.setMode": knowledge.embed_set_mode,
    "embed.cloudConfig": knowledge.embed_cloud_config,
    "embed.setCloudConfig": knowledge.embed_set_cloud_config,
    "embed.reload": knowledge.embed_reload,
    **{f"tool.{name}": _tool_method(name) for name in sorted(BUSINESS_TOOLS)},
    "tool.fetch_table_parse": _with_sources(host.run_fetch_table_parse),
    "tool.load_feishu_bitable": _with_sources(host.run_load_feishu_bitable),
}
