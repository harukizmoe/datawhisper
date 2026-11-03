"""Run the business tool mixins inside the compute worker.

``run_tool`` builds a ``ToolHost`` (the attributes ``DataToolsMixin`` and
``ExportToolsMixin`` read) from the request ``context``, leases the active
sources for the whole call, drives ``compute.tools.dispatch.run_business_tool``
and packs the outcome into the ``tool.*`` RPC result.

Context (all optional except where noted)::

    {"sources": [source_id, ...],   # active sources, in order (src1__, src2__, ...)
     "primary": source_id,          # default sources[0]
     "tables": {source_id: [table, ...]},  # SQL analysis-table selection
     "user_id": str, "workspace_id": str, "session_id": str,
     "lang": "zh" | "en", "color_scheme": str,
     "chart_ids": [chart_id, ...],  # session charts, for export_report
     "chart_dir": str}              # where <chart_id>.html of those charts live

Long work runs inline: the mixins' job paths (taken iff the old thresholds trip)
report progress as ``progress`` notifications and stop with CANCELLED when the
caller cancels.
"""
from __future__ import annotations

import base64
import binascii
import logging
import re
import uuid
from pathlib import Path
from typing import Any

from agent.validate import normalize_report_outline_args, validate_tool_args
from data.sources._utils import is_write_sql
from data.workspace import workspace_manager

from .rpc import INVALID_PARAMS, Cancelled, MethodContext, RpcError
from .sources import Lease, SourceRegistry, _close, combined_schema
from .tools.data import DataToolsMixin
from .tools.dispatch import normalize_chart_call_args, run_business_tool
from .tools.export import ExportToolsMixin

log = logging.getLogger(__name__)

_CHART_ID = re.compile(r"^[\w-]{1,80}$")


class _InlineJobs:
    """Stands in for the old per-session JobRunner: its presence makes the
    mixins take their job path whenever a threshold trips."""


_INLINE_JOBS = _InlineJobs()


class _InlineJobContext:
    """The ``JobContext`` surface the mixin workers use, bound to the request."""

    def __init__(self, rpc: MethodContext):
        self._rpc = rpc

    def set_progress(self, pct: int, message: str = "") -> None:
        self._rpc.progress(pct, message)

    def is_canceled(self) -> bool:
        return self._rpc.cancelled

    def check_canceled(self) -> None:
        self._rpc.check()


class _CallChartStore:
    """Chart store seen by one call: session charts are read from
    ``chart_dir/<id>.html``; charts written by the call are captured and
    returned to the caller, which persists them."""

    def __init__(self, chart_dir: str):
        self._dir = Path(chart_dir) if chart_dir else None
        self.written: dict[str, str] = {}

    def _path(self, cid: str) -> Path | None:
        if self._dir is None or not _CHART_ID.match(str(cid)):
            return None
        return self._dir / f"{cid}.html"

    def __contains__(self, cid: str) -> bool:
        if cid in self.written:
            return True
        path = self._path(cid)
        return path is not None and path.is_file()

    def __getitem__(self, cid: str) -> str:
        if cid in self.written:
            return self.written[cid]
        path = self._path(cid)
        if path is None or not path.is_file():
            raise KeyError(cid)
        return path.read_text(encoding="utf-8")

    def __setitem__(self, cid: str, html: str) -> None:
        self.written[cid] = html


class ToolHost(DataToolsMixin, ExportToolsMixin):
    def __init__(self, rpc: MethodContext, lease: Lease, primary: str | None, context: dict):
        self._rpc = rpc
        self._lease = lease
        self._all_sources = list(lease.sources)
        self.data_source = lease.source(primary) if primary else None
        self._schema_cache_value: str | None = None
        self.tables_touched = False
        self._chart_store = _CallChartStore(_opt_str(context, "chart_dir"))
        self._session_chart_ids = _opt_str_list(context, "chart_ids")
        self.ppt_color_scheme = _opt_str(context, "color_scheme") or "mckinsey"
        self._session_id = _opt_str(context, "session_id")
        self._workspace_id = _opt_str(context, "workspace_id")
        self._user_id = _opt_str(context, "user_id").strip()[:200]
        self._ui_lang = "en" if context.get("lang") == "en" else "zh"
        self._knowledge_allowed_this_turn = True
        self._job_runner = _INLINE_JOBS
        self.files: list[str] = []
        self.dashboard_id = ""

    # The combined schema and merged source come from the leased view, built
    # only when a tool asks for them.
    @property
    def _combined_schema(self) -> str:
        return self._lease.view().combined_schema() if self._all_sources else ""

    @property
    def _merged_source(self):
        return self._lease.view().merged_source() if len(self._all_sources) >= 2 else None

    # Every mixin path that writes or drops a table resets the schema cache.
    @property
    def _schema_cache(self) -> str | None:
        return self._schema_cache_value

    @_schema_cache.setter
    def _schema_cache(self, value: str | None) -> None:
        if value is None:
            self.tables_touched = True
        self._schema_cache_value = value

    def _tt(self, zh: str, en: str) -> str:
        return en if self._ui_lang == "en" else zh

    def _workspace_runtime(self):
        if not self._workspace_id:
            return None
        return workspace_manager.get_by_workspace(self._workspace_id)

    def _workspace_path_authorization(self):
        return workspace_manager.path_authorization(self._workspace_id)

    def _run_as_job(self, fn, job_type: str, label: str = ""):
        """Run a mixin job worker inline; same status dict as the old bridge."""
        yield from ()
        try:
            result = fn(_InlineJobContext(self._rpc))
        except Cancelled:
            raise
        except Exception as exc:
            if self._rpc.cancelled:
                raise Cancelled() from exc
            log.exception("[job %s] %s failed", job_type, label)
            return {"status": "failed", "error": f"{type(exc).__name__}: {exc}"}
        self._rpc.check()
        return {"status": "succeeded", "result": result}

    def _register_export_artifact(self, path: Path, *, artifact_type: str) -> str:
        self.files.append(str(path))
        return super()._register_export_artifact(path, artifact_type=artifact_type)

    def _format_dashboard_result(self, name: str, widgets: list, data: dict) -> str:
        from api.dashboard import _dashboard_path

        self.dashboard_id = str(data.get("dashboard_id") or "")
        if self.dashboard_id:
            self.files.append(_dashboard_path(self.dashboard_id))
        return super()._format_dashboard_result(name, widgets, data)


def parse_context(params: dict) -> tuple[dict, dict]:
    context = params.get("context") or {}
    args = params.get("args") or {}
    if not isinstance(context, dict):
        raise RpcError("'context' must be an object", INVALID_PARAMS)
    if not isinstance(args, dict):
        raise RpcError("'args' must be an object", INVALID_PARAMS)
    return context, args


def active_sources(context: dict) -> tuple[list[str], str | None]:
    """(ordered active source ids, primary id)."""
    sources = context.get("sources") or []
    if not isinstance(sources, list) or not all(isinstance(s, str) and s for s in sources):
        raise RpcError("'context.sources' must be a list of source ids", INVALID_PARAMS)
    sources = list(dict.fromkeys(sources))
    primary = context.get("primary") or (sources[0] if sources else None)
    if primary is not None and primary not in sources:
        raise RpcError("'context.primary' must be one of 'context.sources'", INVALID_PARAMS)
    return sources, primary


def prepare_args(name: str, args: dict, workspace_id: str) -> dict:
    """Normalize and validate model args exactly as the old agent loop did
    before dispatch; a rejection carries the old ``[ARG ERROR]`` tool text."""
    if name == "generate_chart":
        args = normalize_chart_call_args(args)
    elif name == "export_report":
        args = normalize_report_outline_args(args)
    authorization = workspace_manager.path_authorization(workspace_id)
    # A fixed but unavailable Workspace must fail closed instead of silently
    # falling back to global uploads/Information.
    allowed_roots = [] if workspace_id and authorization is None else None
    error = validate_tool_args(
        name, args, allowed_roots=allowed_roots, workspace_authorization=authorization,
    )
    if error:
        raise RpcError(error, data={"kind": "arg_validation", "text": f"[ARG ERROR] {error}"})
    return args


def apply_table_selection(lease: Lease, tables: Any) -> None:
    """Apply the SQL analysis-table selection (as the old ``/chat`` data
    context did) and refuse to run while an active SQL source has none."""
    from data.sources.sql import SQLDataSource

    if tables is None:
        tables = {}
    if not isinstance(tables, dict):
        raise RpcError("'context.tables' must map source ids to table lists", INVALID_PARAMS)
    missing = []
    for source_id in lease.ids:
        src = lease.source(source_id)
        if not isinstance(src, SQLDataSource):
            continue
        requested = tables.get(source_id)
        if requested:
            try:
                catalog = src.list_catalog_tables() or src.list_tables()
            except Exception:
                catalog = []
            valid = [str(t).strip() for t in requested if str(t).strip() in catalog][:20]
            if valid and set(valid) != set(src.get_analysis_tables()):
                src.set_analysis_tables(valid)
                lease.invalidate([source_id])
        if not src.get_analysis_tables():
            missing.append({"source_id": source_id, "source_name": getattr(src, "name", "SQL 数据库")})
    if missing:
        raise RpcError(
            "请先为 SQL 数据源选择分析表",
            data={"kind": "sql_table_selection_required", "sources": missing},
        )


def drive(gen, rpc: MethodContext, events: list[dict]):
    """Run a tool generator to completion, forwarding each yielded event."""
    try:
        while True:
            event = next(gen)
            events.append(event)
            rpc.event(event)
    except StopIteration as stop:
        return stop.value


def run_tool(rpc: MethodContext, registry: SourceRegistry, name: str, params: dict) -> dict:
    context, args = parse_context(params)
    sources, primary = active_sources(context)
    args = prepare_args(name, args, _opt_str(context, "workspace_id"))
    rpc.check()
    events: list[dict] = []
    with registry.lease(sources) as lease:
        apply_table_selection(lease, context.get("tables"))
        host = ToolHost(rpc, lease, primary, context)
        try:
            outcome = drive(run_business_tool(host, name, args), rpc, events)
        except (Cancelled, RpcError):
            raise
        except Exception as exc:
            log.exception("[tool] %s failed", name)
            raise RpcError(
                str(exc),
                data={"kind": "tool_error", "text": f"工具执行错误 [{name}]: {exc}"},
            ) from exc
        tables_changed = host.tables_touched or (
            name == "query_data" and is_write_sql(str(args.get("sql") or ""))
        )
        if tables_changed:
            lease.invalidate()
    charts = [{"id": uuid.uuid4().hex, **item} for item in outcome.charts]
    charts.extend({"id": cid, "html": html} for cid, html in host._chart_store.written.items())
    result: dict[str, Any] = {
        "text": outcome.text,
        "refs": outcome.refs,
        "artifacts": outcome.artifacts,
        "charts": charts,
        "events": events,
        "tables_changed": tables_changed,
        "files": host.files,
    }
    if host.dashboard_id:
        result["dashboard_id"] = host.dashboard_id
    return result


def run_fetch_table_parse(rpc: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``fetch_table`` after the caller fetched the URL: parse the body into
    tables and register them as source ``params.source_id``."""
    from data.table_extract import MAX_FETCH_BYTES, TableExtractError, parse_body

    from .tools.ingest import (
        NO_GRIDS_TEXT, NO_TABLES_TEXT, extracted_source, extracted_source_text, fetch_error_text,
    )

    context, args = parse_context(params)
    sources, _primary = active_sources(context)
    source_id = _required_str(params, "source_id")
    content_type = params.get("content_type") or ""
    if not isinstance(content_type, str):
        raise RpcError("'content_type' must be a string", INVALID_PARAMS)
    try:
        raw = base64.b64decode(_required_str(params, "body_base64"), validate=True)
    except binascii.Error as exc:
        raise RpcError(f"'body_base64' is not valid base64: {exc}", INVALID_PARAMS) from exc
    url = str(args.get("url") or "").strip()
    if len(raw) > MAX_FETCH_BYTES:
        return _ingest_result(fetch_error_text("FETCH-002", f"内容超过 {MAX_FETCH_BYTES} 字节上限"))
    try:
        grids = parse_body(raw, url, content_type)
    except TableExtractError as exc:
        return _ingest_result(fetch_error_text(exc.code, exc.message))
    if not grids:
        return _ingest_result(NO_GRIDS_TEXT)
    rpc.check()
    source, tables, meta = extracted_source(grids, str(args.get("source_name") or "").strip(), url)
    if source is None:
        return _ingest_result(NO_TABLES_TEXT)
    schema = _add_source(registry, sources, source_id, source)
    return _ingest_result(extracted_source_text(source_id, source, tables, meta, schema), source_id)


def run_load_feishu_bitable(rpc: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``load_feishu_bitable`` after the caller read the records over the
    Feishu OpenAPI: register them as source ``params.source_id``."""
    from .tools.ingest import bitable_loaded_text, bitable_source

    context, args = parse_context(params)
    sources, _primary = active_sources(context)
    source_id = _required_str(params, "source_id")
    read_result = params.get("records")
    if (
        not isinstance(read_result, dict)
        or not isinstance(read_result.get("records"), list)
        or not isinstance(read_result.get("table_id"), str)
    ):
        raise RpcError(
            "'records' must be the read result {table_id, records: [...], ...}", INVALID_PARAMS,
        )
    source, source_name = bitable_source(read_result, args.get("source_name"))
    schema = _add_source(registry, sources, source_id, source)
    return _ingest_result(bitable_loaded_text(source_id, source_name, schema, read_result), source_id)


def _add_source(registry: SourceRegistry, sources: list[str], source_id: str, source) -> str:
    """Register *source* and return the combined schema of the active sources
    plus the new one (the view the old agent switched to mid-turn)."""
    with registry.lease(sources) as lease:
        try:
            registry.add(source_id, source)
        except RpcError:
            _close(source)
            raise
        return combined_schema([*lease.sources, source])


def _ingest_result(text: str, source_id: str | None = None) -> dict:
    result: dict[str, Any] = {
        "text": text, "refs": [], "artifacts": [], "charts": [], "events": [],
        "tables_changed": source_id is not None, "files": [],
    }
    if source_id is not None:
        result["source_id"] = source_id
    return result


def _required_str(params: dict, key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise RpcError(f"'{key}' must be a non-empty string", INVALID_PARAMS)
    return value


def _opt_str(context: dict, key: str) -> str:
    value = context.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise RpcError(f"'context.{key}' must be a string", INVALID_PARAMS)
    return value


def _opt_str_list(context: dict, key: str) -> list[str]:
    value = context.get(key) or []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise RpcError(f"'context.{key}' must be a list of strings", INVALID_PARAMS)
    return value
