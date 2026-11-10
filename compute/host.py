"""在 compute worker 内运行业务工具 mixin。

``run_tool`` 会依据请求的 ``context`` 构造一个 ``ToolHost``（即
``DataToolsMixin`` 与 ``ExportToolsMixin`` 读取的那些属性），为整次调用租用
活动 source，驱动 ``compute.tools.dispatch.run_business_tool``，并把结果打包
成 ``tool.*`` 的 RPC 返回值。

Context（除注明外均可选）：::

    {"sources": [source_id, ...],   # 活动 source，按顺序（src1__、src2__、...）
     "primary": source_id,          # 默认 sources[0]
     "tables": {source_id: [table, ...]},  # SQL 分析表选择
     "user_id": str, "workspace_id": str, "session_id": str,
     "lang": "zh" | "en", "color_scheme": str,
     "chart_ids": [chart_id, ...],  # 会话图表，供 export_report 使用
     "chart_dir": str}              # 这些图表的 <chart_id>.html 所在目录

耗时工作就地同步执行：mixin 的 job 路径（仅当旧的阈值被触发时才走）以
``progress`` 通知报告进度，并在调用方取消时以 CANCELLED 终止。
"""
from __future__ import annotations

import base64
import binascii
import logging
import re
import uuid
from pathlib import Path
from typing import Any

from data.sources._utils import is_write_sql
from data.workspace import WorkspacePathAuthorization, workspace_manager

from .dashboard import dashboard_path
from .i18n import say
from .rpc import INVALID_PARAMS, Cancelled, MethodContext, RpcError, str_param
from .sources import Lease, SourceRegistry, _close, combined_schema
from .tools.data import DataToolsMixin
from .tools.dispatch import normalize_chart_call_args, run_business_tool
from .tools.export import ExportToolsMixin
from .validate import normalize_report_outline_args, validate_tool_args

log = logging.getLogger(__name__)

_CHART_ID = re.compile(r"^[\w-]{1,80}$")


class _InlineJobs:
    """代替旧的按会话 JobRunner：它的存在会让 mixin 在阈值触发时走 job 路径。"""


_INLINE_JOBS = _InlineJobs()


class InlineJobContext:
    """job worker 使用的 ``JobContext`` 接口面，绑定到本次请求。内联 job 没有
    自己的 Workspace runtime（``runtime``）。"""

    runtime = None

    def __init__(self, rpc: MethodContext):
        self._rpc = rpc

    def set_progress(self, pct: int, message: str = "") -> None:
        self._rpc.progress(pct, message)

    def is_canceled(self) -> bool:
        return self._rpc.cancelled

    def check_canceled(self) -> None:
        self._rpc.check()


class CallChartStore:
    """单次调用看到的图表存储：会话图表从 ``chart_dir/<id>.html`` 读取；本次
    调用写入的图表被捕获并返回给调用方，由调用方负责持久化。"""

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
        self._chart_store = CallChartStore(_opt_str(context, "chart_dir"))
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

    # 合并后的 schema 与合并 source 来自租用的视图，只在工具需要时才构建。
    @property
    def _combined_schema(self) -> str:
        return self._lease.view().combined_schema() if self._all_sources else ""

    @property
    def _merged_source(self):
        return self._lease.view().merged_source() if len(self._all_sources) >= 2 else None

    # 任何写入或删除表的 mixin 路径都会重置 schema 缓存。
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
        return sql_path_authorization(self._workspace_id)

    def _run_as_job(self, fn, job_type: str, label: str = ""):
        """就地执行 mixin 的 job worker；状态字典与旧桥接层一致。"""
        yield from ()
        try:
            result = fn(InlineJobContext(self._rpc))
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
        self.dashboard_id = str(data.get("dashboard_id") or "")
        if self.dashboard_id:
            self.files.append(dashboard_path(self.dashboard_id))
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
    """返回（按顺序的活动 source id 列表, primary id）。"""
    sources = context.get("sources") or []
    if not isinstance(sources, list) or not all(isinstance(s, str) and s for s in sources):
        raise RpcError("'context.sources' must be a list of source ids", INVALID_PARAMS)
    sources = list(dict.fromkeys(sources))
    primary = context.get("primary") or (sources[0] if sources else None)
    if primary is not None and primary not in sources:
        raise RpcError("'context.primary' must be one of 'context.sources'", INVALID_PARAMS)
    return sources, primary


def sql_path_authorization(workspace_id: str) -> WorkspacePathAuthorization | None:
    """*workspace_id* 下某次调用的 SQL 文件读取能力：挂载 Workspace 的根目录；
    没有 Workspace 时为 None（即默认根目录）。固定但不存在的 Workspace 必须
    失败关闭，而不是悄悄回退到全局 uploads/Information，因此它拿到的根目录为空。"""
    authorization = workspace_manager.path_authorization(workspace_id)
    if workspace_id and authorization is None:
        return WorkspacePathAuthorization(workspace_id=workspace_id, allowed_roots=(), metadata_revision=0)
    return authorization


def prepare_args(name: str, args: dict, workspace_id: str) -> dict:
    """完全按旧 agent 循环在 dispatch 之前的方式规范化并校验模型参数；被拒时
    携带旧的 ``[ARG ERROR]`` 工具文案。"""
    if name == "generate_chart":
        args = normalize_chart_call_args(args)
    elif name == "export_report":
        args = normalize_report_outline_args(args)
    error = validate_tool_args(name, args, workspace_authorization=sql_path_authorization(workspace_id))
    if error:
        raise RpcError(error, data={"kind": "arg_validation", "text": f"[ARG ERROR] {error}"})
    return args


def apply_table_selection(lease: Lease, tables: Any) -> None:
    """应用 SQL 分析表选择（与旧的 ``/chat`` 数据上下文做法一致）；当某个活动
    SQL source 尚未选择分析表时拒绝运行。"""
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
            missing.append({"source_id": source_id, "source_name": getattr(src, "name", say("SQL database", "SQL 数据库"))})
    if missing:
        raise RpcError(
            say(
                "This SQL source has no analysis tables selected yet, so nothing in it is visible right now. "
                "Tell the user: in the Data panel on the right, click \"Tables\" (Choose tables) on this source's card, "
                "tick the tables to analyze and save, then ask again. Do not suggest uploading a file and do not make up data.",
                "SQL 数据源还没有选择分析表，所以现在看不到里面任何内容。"
                "请告诉用户：在右侧「数据」面板里，点这个数据源卡片上的「选择数据表」（Choose tables），"
                "勾选要分析的表并保存，然后重新提问。不要建议用户上传文件，也不要编造数据。",
            ),
            data={"kind": "sql_table_selection_required", "sources": missing},
        )


def drive(gen, rpc: MethodContext, events: list[dict]):
    """把工具生成器跑到结束，并转发它产出的每个事件。"""
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
                data={"kind": "tool_error", "text": say(f"Tool execution error [{name}]: {exc}", f"工具执行错误 [{name}]: {exc}")},
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
    """``fetch_table`` 在调用方取回 URL 之后的阶段：把 body 解析成表，并注册为
    source ``params.source_id``。"""
    from data.table_extract import MAX_FETCH_BYTES, TableExtractError, parse_body

    from .tools.ingest import (
        no_grids_text, no_tables_text, extracted_source, extracted_source_text, fetch_error_text,
    )

    context, args = parse_context(params)
    sources, _primary = active_sources(context)
    source_id = str_param(params, "source_id")
    content_type = params.get("content_type") or ""
    if not isinstance(content_type, str):
        raise RpcError("'content_type' must be a string", INVALID_PARAMS)
    try:
        raw = base64.b64decode(str_param(params, "body_base64"), validate=True)
    except binascii.Error as exc:
        raise RpcError(f"'body_base64' is not valid base64: {exc}", INVALID_PARAMS) from exc
    url = str(args.get("url") or "").strip()
    if len(raw) > MAX_FETCH_BYTES:
        return _ingest_result(fetch_error_text("FETCH-002", say(f"Content exceeds the {MAX_FETCH_BYTES}-byte limit", f"内容超过 {MAX_FETCH_BYTES} 字节上限")))
    try:
        grids = parse_body(raw, url, content_type)
    except TableExtractError as exc:
        return _ingest_result(fetch_error_text(exc.code, exc.message))
    if not grids:
        return _ingest_result(no_grids_text())
    rpc.check()
    source, tables, meta = extracted_source(grids, str(args.get("source_name") or "").strip(), url)
    if source is None:
        return _ingest_result(no_tables_text())
    schema = _add_source(registry, sources, source_id, source)
    return _ingest_result(extracted_source_text(source_id, source, tables, meta, schema), source_id)


def run_load_feishu_bitable(rpc: MethodContext, registry: SourceRegistry, params: dict) -> dict:
    """``load_feishu_bitable`` 在调用方通过 Feishu OpenAPI 读取记录之后的阶段：
    把它们注册为 source ``params.source_id``。"""
    from .tools.ingest import bitable_loaded_text, bitable_source

    context, args = parse_context(params)
    sources, _primary = active_sources(context)
    source_id = str_param(params, "source_id")
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
    """注册 *source*，并返回活动 source 加上新 source 之后的合并 schema
    （即旧 agent 在回合中途切换到的视图）。"""
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
