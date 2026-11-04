"""UI-side computations (P1.3): what the old Flask routes did with DataFrames
directly, as RPC methods for the agent service's internal API.

Durable sources still open through ``source.open``, so the Bun client keeps
each descriptor and reopens it after a restart: ``upload.prepare`` and
``workspace.sync`` return the descriptor to open. Methods that work on open
sources take the source registry (``(ctx, registry, params)``);
``compute.methods`` binds it.
"""
from __future__ import annotations

import base64
import datetime
import json
import uuid
from pathlib import Path

from data.sources import SQLDataSource
from data.sources.excel import excel_requires_job, parse_excel_job
from data.sources.workspace_persistent import WorkspacePersistentSource
from data.workspace import WorkspaceRuntime, validate_workdir
from infrastructure.paths import content_data_path

from .dashboard import load_dashboard, render_widget, save_dashboard
from .dashboard_html_export import build_export_html, export_filename
from .host import CallChartStore, InlineJobContext, sql_path_authorization
from .rpc import INVALID_PARAMS, Cancelled, MethodContext, RpcError, int_param, str_param
from .sources import SourceRegistry, open_failed, preview_tables
from .workspace import import_workdir_files

UPLOAD_KINDS = {".csv": "csv", ".xlsx": "excel", ".xls": "excel", ".pdf": "pdf"}
PARSED_EXCEL_DIR = content_data_path("uploads", ".parsed_excel")
PREVIEW_ROWS = 100


def upload_prepare(ctx: MethodContext, params: dict) -> dict:
    """``upload.prepare {file_path, name?}``: the source descriptor of an uploaded
    .csv / .xlsx / .xls / .pdf (``name``: its display name, default the file
    name) -> ``{"descriptor"}``, to open with ``source.open``.

    A large workbook (``excel_requires_job``) is parsed here, into a DuckDB file
    under ``<data>/uploads/.parsed_excel`` (the descriptor's ``db_path``), with
    progress per sheet; a cancel removes the file.
    """
    file_path = str_param(params, "file_path")
    name = str_param(params, "name", required=False) or Path(file_path).name
    kind = UPLOAD_KINDS.get(Path(file_path).suffix.lower())
    if kind is None:
        raise RpcError(
            "仅支持 .xlsx / .xls / .csv / .pdf 文件", INVALID_PARAMS,
            data={"kind": "unsupported_format"},
        )
    if not Path(file_path).is_file():
        raise RpcError(f"文件不存在：{file_path}", data={"kind": "file_not_found"})
    descriptor = {"kind": kind, "file_path": file_path, "name": f"PDF {name}" if kind == "pdf" else name}
    if kind == "excel" and excel_requires_job(file_path):
        descriptor["db_path"] = _parse_workbook(ctx, descriptor)
    return {"descriptor": descriptor}


def _parse_workbook(ctx: MethodContext, descriptor: dict) -> str:
    """Parse a large workbook into a DuckDB file of its own; returns its path."""
    PARSED_EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    db_path = PARSED_EXCEL_DIR / f"{uuid.uuid4().hex}.duckdb"
    try:
        parsed = parse_excel_job(InlineJobContext(ctx), descriptor["file_path"], str(db_path), descriptor["name"])
        ctx.check()
    except Cancelled:
        # A parse stopped midway removes its file itself; a finished one does not.
        for path in (db_path, Path(f"{db_path}.wal")):
            path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        raise open_failed(descriptor, exc) from exc
    return parsed["db_path"]


def source_preview(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.preview {source_id}``: table metadata for the data preview, no rows
    -> ``{"source_id", "source_name", "requires_table_selection", "tables": [{"name",
    "columns", "total_rows", "source_id", "source_name", "selectable_for_analysis",
    "selected_for_analysis"}]}``. Remote SQL tables report ``total_rows`` null."""
    source_id = str_param(params, "source_id")
    with registry.use(source_id) as source:
        return {
            "source_id": source_id,
            "source_name": getattr(source, "name", ""),
            "requires_table_selection": isinstance(source, SQLDataSource),
            "tables": preview_tables(source_id, source),
        }


def source_preview_table(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.previewTable {source_id, table}``: the first 100 rows of one table
    -> ``{"name", "columns", "rows", "total_rows"}``, cells as strings."""
    table = str_param(params, "table")
    with registry.use(str_param(params, "source_id")) as source:
        preview = source.get_preview_table(table, max_rows=PREVIEW_ROWS)
    if preview.get("error"):
        raise RpcError(str(preview["error"]), data={"kind": "preview_failed", "table": table})
    return preview


def source_set_analysis_tables(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.setAnalysisTables {source_id, tables}``: the tables of a SQL source
    the agent may analyse (catalog tables, at most 20) -> ``{"source_id", "tables"}``.
    The caller keeps the selection (descriptor ``analysis_tables``, request
    ``context.tables``); every ``tool.*`` call re-applies ``context.tables``."""
    source_id = str_param(params, "source_id")
    tables = params.get("tables")
    if not isinstance(tables, list):
        raise RpcError("'tables' must be a list", INVALID_PARAMS)
    with registry.lease([source_id]) as lease:
        source = lease.source(source_id)
        if not isinstance(source, SQLDataSource):
            raise RpcError(
                "only SQL data sources support table selection", INVALID_PARAMS,
                data={"kind": "not_sql_source"},
            )
        try:
            selected = source.set_analysis_tables(tables)
        except ValueError as exc:
            raise RpcError(str(exc), INVALID_PARAMS, data={"kind": "invalid_tables"}) from exc
        lease.invalidate()
    return {"source_id": source_id, "tables": selected}


def dashboard_refresh(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``dashboard.refresh {dashboard_id, source_id, workspace_id?, widget_id?}``:
    re-run the widgets' SQL (all, or only ``widget_id``) on ``source_id`` and
    render them again.

    Saves the dashboard and returns ``{"dashboard_id", "widgets": [{"id",
    "chart_id", "error"}], "kpi_widgets": [{"id", "kpi_value", "kpi_sub",
    "kpi_trend", "error"}], "charts": [{"id", "html"}]}``; the caller stores the
    new charts. Progress follows the widgets; a cancel stops before the next
    widget and leaves the dashboard file unchanged.
    """
    dashboard_id = str_param(params, "dashboard_id")
    source_id = str_param(params, "source_id")
    workspace_id = str_param(params, "workspace_id", required=False)
    widget_id = str_param(params, "widget_id", required=False)
    dashboard = _dashboard(dashboard_id)
    dashboard_workspace_id = str(dashboard.get("workspace_id") or "")
    if dashboard_workspace_id and dashboard_workspace_id != workspace_id:
        raise RpcError("Dashboard belongs to a different Workspace", data={"kind": "workspace_mismatch"})
    widgets = dashboard.get("widgets", [])
    if widget_id:
        widgets = [widget for widget in widgets if widget.get("id") == widget_id]
        if not widgets:
            raise RpcError(f"Widget '{widget_id}' not found", data={"kind": "widget_not_found"})
    authorization = sql_path_authorization(workspace_id)
    color_scheme = dashboard.get("color_scheme", "mckinsey")
    charts: dict[str, str] = {}
    chart_results, kpi_results = [], []
    with registry.use(source_id) as source:
        for index, widget in enumerate(widgets, start=1):
            ctx.check()
            result = render_widget(source, charts, color_scheme, widget, authorization)
            (kpi_results if widget.get("chart_type") == "KPI_Card" else chart_results).append(result)
            ctx.progress(round(index * 100 / len(widgets)), f"已刷新组件 {index}/{len(widgets)}")
    ctx.check()
    if not widget_id:
        dashboard["refreshed_at"] = datetime.datetime.now().isoformat()
    save_dashboard(dashboard, dashboard_id)
    return {
        "dashboard_id": dashboard_id,
        "widgets": chart_results,
        "kpi_widgets": kpi_results,
        "charts": [{"id": chart_id, "html": html} for chart_id, html in charts.items()],
    }


def dashboard_export_html(ctx: MethodContext, params: dict) -> dict:
    """``dashboard.exportHtml {dashboard_id, chart_dir}`` -> ``{"filename", "html"}``:
    the dashboard as one self-contained page, charts read from
    ``chart_dir/<chart_id>.html``."""
    dashboard = _dashboard(str_param(params, "dashboard_id"))
    html = build_export_html(dashboard, CallChartStore(str_param(params, "chart_dir")))
    return {"filename": export_filename(dashboard), "html": html}


def _dashboard(dashboard_id: str) -> dict:
    dashboard = load_dashboard(dashboard_id)
    if dashboard is None:
        raise RpcError(f"Dashboard '{dashboard_id}' not found", data={"kind": "dashboard_not_found"})
    return dashboard


def chart_png(ctx: MethodContext, params: dict) -> dict:
    """``chart.png {chart_dir, chart_id, width?, height?, scale?=2}``: render a stored
    Plotly chart to PNG -> ``{"png_base64", "width", "height", "scale"}``.

    Size: ``width``/``height`` when given, else the ``size`` preset recorded in
    ``<chart_id>.spec.json``, else 1280x720; ``scale`` is clamped to 1-3. Needs
    the optional kaleido package (error kind ``kaleido_missing``); charts that
    are not Plotly fail with kind ``unsupported``.
    """
    from charts import theme

    chart_dir = str_param(params, "chart_dir")
    chart_id = str_param(params, "chart_id")
    store = CallChartStore(chart_dir)
    if chart_id not in store:
        raise RpcError(f"Chart '{chart_id}' not found", data={"kind": "chart_not_found"})
    width = int_param(params, "width", 0)
    height = int_param(params, "height", 0)
    if not width or not height:
        preset = theme.SIZE_PRESETS.get(_chart_size_preset(chart_dir, chart_id))
        if preset:
            width = width or preset["width"]
            height = height or preset["height"]
    width = width or 1280
    height = height or 720
    scale = min(max(int_param(params, "scale", 2) or 2, 1), 3)
    try:
        png = theme.render_png_bytes(store[chart_id], width=width, height=height, scale=scale)
    except ImportError as exc:
        raise RpcError(str(exc), data={"kind": "kaleido_missing"}) from exc
    except ValueError as exc:
        raise RpcError(str(exc), data={"kind": "unsupported"}) from exc
    return {
        "png_base64": base64.b64encode(png).decode("ascii"),
        "width": width,
        "height": height,
        "scale": scale,
    }


def _chart_size_preset(chart_dir: str, chart_id: str) -> str:
    """The ``size`` preset in the chart's spec sidecar, "" without one."""
    try:
        spec = json.loads((Path(chart_dir) / f"{chart_id}.spec.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(spec.get("size") or "").strip().lower() if isinstance(spec, dict) else ""


def workspace_sync(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``workspace.sync {workspace_id, workdir, source_id?, name?}``: import the new or
    changed data files of a mounted Workspace into its persistent DuckDB
    (``<workdir>/.zhixi/workspace.duckdb``); files whose sha256 did not change
    are reused.

    With ``source_id`` open (the Workspace database, opened from an earlier
    sync's descriptor) the import runs on that source and drops its cached
    schema; otherwise the database is opened just for the import, and the
    caller then opens the returned ``descriptor`` with ``source.open``. Large
    workbooks and CSVs import as inline jobs with progress; a cancel stops at
    the next file, keeping the files imported before it. Returns
    ``{"descriptor", "tables", "added": [{"source_name", "tables"}], "errors",
    "skipped", "reused"}``.
    """
    workspace_id = str_param(params, "workspace_id")
    source_id = str_param(params, "source_id", required=False)
    ok, message, workdir = validate_workdir(str_param(params, "workdir"))
    if not ok:
        raise RpcError(message, INVALID_PARAMS, data={"kind": "invalid_workdir"})
    runtime = WorkspaceRuntime(workspace_id=workspace_id, workdir=workdir)
    name = str_param(params, "name", required=False) or f"📁 {workdir.name}"
    descriptor = {"kind": "workspace_persistent", "db_path": str(runtime.db_path), "name": name}

    def run_job(_job_type: str, _label: str, worker):
        return worker(InlineJobContext(ctx))

    if source_id in registry.ids():
        with registry.lease([source_id]) as lease:
            source = lease.source(source_id)
            if not isinstance(source, WorkspacePersistentSource) or source._db_path != runtime.db_path:
                raise RpcError(f"data source {source_id} is not this Workspace's database", INVALID_PARAMS)
            # One writer lock per database: the open source's.
            runtime.db_lock = source._db_lock
            try:
                imported = import_workdir_files(runtime, source, run_job, ctx.check)
            finally:
                lease.invalidate()
            tables = source.list_tables()
    else:
        try:
            source = WorkspacePersistentSource(str(runtime.db_path), name, db_lock=runtime.db_lock)
        except Exception as exc:
            raise open_failed(descriptor, exc) from exc
        try:
            imported = import_workdir_files(runtime, source, run_job, ctx.check)
            tables = source.list_tables()
        finally:
            source.close()
    return {"descriptor": descriptor, "tables": tables, **imported}
