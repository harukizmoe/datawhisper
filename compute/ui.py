"""UI 侧计算（P1.3）：旧 Flask 路由直接对 DataFrame 做的事，改为以 RPC 方法
提供给 agent 服务的内部 API。

持久化 source 仍然通过 ``source.open`` 打开，因此 Bun 客户端会保存每个
descriptor，并在重启后重新打开：``upload.prepare`` 与 ``workspace.sync`` 返回
的就是待打开的 descriptor。作用于已打开 source 的方法接收 source registry
（``(ctx, registry, params)``）；由 ``compute.methods`` 完成绑定。
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
    """``upload.prepare {file_path, name?}``：上传的 .csv / .xlsx / .xls / .pdf 的
    source descriptor（``name``：其显示名，默认取文件名）
    -> ``{"descriptor"}``，供 ``source.open`` 打开。

    大工作簿（``excel_requires_job``）在这里就被解析到 ``<data>/uploads/.parsed_excel``
    下的 DuckDB 文件（descriptor 的 ``db_path``），逐 sheet 报告进度；取消会删掉该文件。
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
    """把大工作簿解析成独立的 DuckDB 文件；返回其路径。"""
    PARSED_EXCEL_DIR.mkdir(parents=True, exist_ok=True)
    db_path = PARSED_EXCEL_DIR / f"{uuid.uuid4().hex}.duckdb"
    try:
        parsed = parse_excel_job(InlineJobContext(ctx), descriptor["file_path"], str(db_path), descriptor["name"])
        ctx.check()
    except Cancelled:
        # 中途停止的解析会自己删掉文件；已完成的解析不会。
        for path in (db_path, Path(f"{db_path}.wal")):
            path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        raise open_failed(descriptor, exc) from exc
    return parsed["db_path"]


def source_preview(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.preview {source_id}``：数据预览用的表元信息，不含行数据
    -> ``{"source_id", "source_name", "requires_table_selection", "tables": [{"name",
    "columns", "total_rows", "source_id", "source_name", "selectable_for_analysis",
    "selected_for_analysis"}]}``。远程 SQL 表的 ``total_rows`` 报告为 null。"""
    source_id = str_param(params, "source_id")
    with registry.use(source_id) as source:
        return {
            "source_id": source_id,
            "source_name": getattr(source, "name", ""),
            "requires_table_selection": isinstance(source, SQLDataSource),
            "tables": preview_tables(source_id, source),
        }


def source_preview_table(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.previewTable {source_id, table}``：某张表的前 100 行
    -> ``{"name", "columns", "rows", "total_rows"}``，单元格以字符串表示。"""
    table = str_param(params, "table")
    with registry.use(str_param(params, "source_id")) as source:
        preview = source.get_preview_table(table, max_rows=PREVIEW_ROWS)
    if preview.get("error"):
        raise RpcError(str(preview["error"]), data={"kind": "preview_failed", "table": table})
    return preview


def source_set_analysis_tables(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``source.setAnalysisTables {source_id, tables}``：agent 可分析的 SQL source
    表（catalog 表，至多 20 张）-> ``{"source_id", "tables"}``。
    选择由调用方保存（descriptor 的 ``analysis_tables``、请求的
    ``context.tables``）；每次 ``tool.*`` 调用都会重新应用 ``context.tables``。"""
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
    """``dashboard.refresh {dashboard_id, source_id, workspace_id?, widget_id?}``：
    在 ``source_id`` 上重跑各 widget 的 SQL（全部，或仅 ``widget_id``）并重新渲染。

    保存 dashboard 并返回 ``{"dashboard_id", "widgets": [{"id",
    "chart_id", "error"}], "kpi_widgets": [{"id", "kpi_value", "kpi_sub",
    "kpi_trend", "error"}], "charts": [{"id", "html"}]}``；新图表由调用方存储。
    进度随 widget 推进；取消在下一个 widget 之前生效，dashboard 文件保持不变。
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
    """``dashboard.exportHtml {dashboard_id, chart_dir}`` -> ``{"filename", "html"}``：
    把 dashboard 导出成单个自包含页面，图表从 ``chart_dir/<chart_id>.html`` 读取。"""
    dashboard = _dashboard(str_param(params, "dashboard_id"))
    html = build_export_html(dashboard, CallChartStore(str_param(params, "chart_dir")))
    return {"filename": export_filename(dashboard), "html": html}


def _dashboard(dashboard_id: str) -> dict:
    dashboard = load_dashboard(dashboard_id)
    if dashboard is None:
        raise RpcError(f"Dashboard '{dashboard_id}' not found", data={"kind": "dashboard_not_found"})
    return dashboard


def chart_png(ctx: MethodContext, params: dict) -> dict:
    """``chart.png {chart_dir, chart_id, width?, height?, scale?=2}``：把已存储的
    Plotly 图表渲染成 PNG -> ``{"png_base64", "width", "height", "scale"}``。

    尺寸：给出 ``width``/``height`` 时用它们，否则用 ``<chart_id>.spec.json`` 记录的
    ``size`` 预设，再否则 1280x720；``scale`` 被限制在 1-3。需要可选的 kaleido 包
    （错误 kind ``kaleido_missing``）；非 Plotly 图表以 kind ``unsupported`` 失败。
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
    """图表 spec sidecar 中的 ``size`` 预设，没有则为 ""。"""
    try:
        spec = json.loads((Path(chart_dir) / f"{chart_id}.spec.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    return str(spec.get("size") or "").strip().lower() if isinstance(spec, dict) else ""


def workspace_sync(ctx: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``workspace.sync {workspace_id, workdir, source_id?, name?}``：把挂载的
    Workspace 中新增或有变化的数据文件导入其持久化 DuckDB
    （``<workdir>/.zhixi/workspace.duckdb``）；sha256 未变的文件直接复用。

    若以 ``source_id`` 打开（即该 Workspace 数据库，由更早一次 sync 的 descriptor
    打开），导入就在该 source 上进行，并丢弃其缓存的 schema；否则只为导入而打开
    数据库，调用方随后用 ``source.open`` 打开返回的 ``descriptor``。大工作簿与 CSV
    以内联 job 导入并报告进度；取消在下一个文件处停止，保留此前已导入的文件。返回
    ``{"descriptor", "tables", "added": [{"source_name", "tables"}], "errors",
    "skipped", "reused"}``。
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
            # 每个数据库一个写锁：用已打开 source 的那个。
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
