"""Run one business (category-B) tool call against a host that mixes in
``DataToolsMixin`` and ``ExportToolsMixin``.

This is the single place that turns the model-facing tool arguments into mixin
calls and shapes the result the model sees. The old agent loop
(``agent/agent.py``) and the compute worker (``compute/host.py``) both call
``run_business_tool``.

``run_business_tool`` is a generator: it yields UI events (``knowledge_refs``,
``data_refs`` and whatever the host's ``_run_as_job`` yields) and returns a
``ToolOutcome``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Generator

BUSINESS_TOOLS = frozenset({
    "query_knowledge",
    "get_schema",
    "get_table_detail",
    "create_analysis_table",
    "delete_analysis_tables",
    "query_data",
    "run_analysis",
    "generate_chart",
    "profile_data",
    "clean_data",
    "export_excel",
    "export_report",
    "generate_ppt",
    "generate_dashboard",
})


@dataclass
class ToolOutcome:
    text: str
    # data_refs / knowledge_refs: the envelope ``sources`` of the tool result.
    refs: list[dict] = field(default_factory=list)
    # Chart HTML to show after the turn: {"html", "title", "chart_type", "spec"}.
    charts: list[dict] = field(default_factory=list)
    # The envelope ``artifacts`` of the tool result.
    artifacts: list[dict] = field(default_factory=list)


def as_bool_arg(value: Any) -> bool:
    """Coerce tool-call booleans without treating the string 'False' as true."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes"}
    return False


def normalize_chart_call_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """Make chart execution and UI metadata use the same non-empty values."""
    normalized = dict(args or {})
    chart_type = str(normalized.get("chart_type") or "Bar_Chart").strip()
    if not chart_type:
        chart_type = "Bar_Chart"
    title = str(normalized.get("title") or "").strip()
    if not title:
        title = f"数据可视化 · {chart_type.replace('_', ' ')}"
    normalized["chart_type"] = chart_type
    normalized["title"] = title[:120]
    return normalized


def run_business_tool(
    host, name: str, args: dict, *, chart_offset: int = 0,
) -> Generator[dict, None, ToolOutcome]:
    """Execute *name* with already-normalized and validated *args*.

    ``chart_offset`` is the number of charts already produced earlier in the
    turn; profile chart titles are numbered after it.
    """
    if name == "query_knowledge":
        question = args.get("question", "")
        text, refs = host._tool_query_knowledge_with_refs(question=question)
        yield {"type": "knowledge_refs", "refs": refs, "query": question}
        return ToolOutcome(text, refs=refs)
    if name == "get_schema":
        return ToolOutcome(host._tool_get_schema())
    if name == "get_table_detail":
        return ToolOutcome(host._tool_get_table_detail(table_name=args.get("table_name", "")))
    if name == "create_analysis_table":
        text, refs = yield from host._tool_create_analysis_table_with_jobs(
            sql=args.get("sql", ""),
            table_name=args.get("table_name", "analysis_data"),
        )
        yield {"type": "data_refs", "refs": refs}
        return ToolOutcome(text, refs=refs)
    if name == "delete_analysis_tables":
        return ToolOutcome(host._tool_delete_analysis_tables(
            table_names=args.get("table_names", []),
            confirm=as_bool_arg(args.get("confirm", False)),
        ))
    if name == "query_data":
        text, refs = yield from host._tool_query_data_with_jobs(args.get("sql", ""))
        yield {"type": "data_refs", "refs": refs}
        return ToolOutcome(text, refs=refs)
    if name == "run_analysis":
        text = yield from host._tool_run_analysis_with_jobs(
            analysis_name=args.get("analysis_name", ""),
            sql=args.get("sql", ""),
            target_column=args.get("target_column", ""),
            groupby_column=args.get("groupby_column", ""),
            n_deciles=int(args.get("n_deciles", 10)),
            analysis_options=args.get("analysis_options", {}),
        )
        refs = host._data_refs_for_sql(args.get("sql", ""), host.data_source, None)
        yield {"type": "data_refs", "refs": refs}
        return ToolOutcome(text, refs=refs)
    if name == "generate_chart":
        return (yield from _generate_chart(host, args))
    if name == "profile_data":
        result = yield from host._tool_profile_data_with_jobs(
            table_name=args.get("table_name", ""),
            columns=args.get("columns", []),
        )
        charts = [
            {
                "html": html,
                "title": f"数据概况分布图 {chart_offset + index}",
                "chart_type": "profile",
                "spec": {
                    "chart_type": "profile",
                    "table_name": str(args.get("table_name") or ""),
                    "columns": args.get("columns") or [],
                },
            }
            for index, html in enumerate(result.get("charts", []), start=1)
        ]
        return ToolOutcome(result.get("text", "数据概况生成失败。"), charts=charts)
    if name == "clean_data":
        return ToolOutcome((yield from host._tool_clean_data_with_jobs(
            operation=args.get("operation", ""),
            table_name=args.get("table_name", ""),
            columns=args.get("columns"),
            fill_method=args.get("fill_method", "mean"),
            lower_pct=float(args.get("lower_pct", 1)),
            upper_pct=float(args.get("upper_pct", 99)),
            trim_column=args.get("trim_column", ""),
            min_val=args.get("min_val"),
            max_val=args.get("max_val"),
            output_table=args.get("output_table", "cleaned_data"),
        )))
    if name == "export_excel":
        return ToolOutcome((yield from host._tool_export_excel_with_jobs(
            tables=args.get("tables", []),
            filename=args.get("filename", ""),
        )))
    if name == "export_report":
        return ToolOutcome((yield from host._tool_export_report_with_jobs(
            title=args.get("title", "分析报告"),
            sections=args.get("sections", []),
        )))
    if name == "generate_ppt":
        return ToolOutcome((yield from host._tool_generate_ppt_with_jobs(
            title=args.get("title", "Presentation"),
            slides=args.get("slides", []),
            filename=args.get("filename", ""),
        )))
    if name == "generate_dashboard":
        return ToolOutcome((yield from host._tool_generate_dashboard_with_jobs(
            name=args.get("name", "数据看板"),
            widgets=args.get("widgets", []),
            color_scheme=args.get("color_scheme", ""),
        )))
    raise ValueError(f"not a business tool: {name}")


def _generate_chart(host, args: dict):
    refs = host._data_refs_for_sql(args.get("sql", ""), host.data_source, None)
    chart = yield from host._tool_generate_chart_with_jobs(
        chart_type=args.get("chart_type", "Bar_Chart"),
        sql=args.get("sql", ""),
        field_mapping=args.get("field_mapping", {}),
        title=args.get("title", ""),
        highlight=args.get("highlight", ""),
        size=args.get("size", ""),
        color_scheme=args.get("color_scheme", ""),
    )
    if "html" not in chart:
        return ToolOutcome(f"Chart failed: {chart.get('error', 'unknown')}", refs=refs)
    # spec 边车：记录可复现的完整生成参数。宿主落盘 {cid}.spec.json，供 PNG
    # 导出取默认尺寸、图表迭代与审计复现使用
    spec = {
        "chart_type": str(args.get("chart_type") or ""),
        "sql": str(args.get("sql") or ""),
        "field_mapping": args.get("field_mapping") or {},
        "title": str(args.get("title") or ""),
        "highlight": str(args.get("highlight") or ""),
        "size": str(args.get("size") or "chat"),
        "color_scheme": str(chart.get("color_scheme") or "mckinsey"),
        "rows": chart.get("rows"),
    }
    text = (
        f"Chart generated: {args['title']} "
        f"({args['chart_type']}). "
        "It is displayed to the user."
    )
    # QC 警告回传：LLM 可据此自我修正（top-N 聚合、过滤 NULL、重命名重复系列）
    # 并重新 generate_chart
    if chart.get("warnings"):
        text += " QC warnings (fix with a new generate_chart call if meaningful): " + "; ".join(
            str(w) for w in chart["warnings"]
        )
    yield {"type": "data_refs", "refs": refs}
    return ToolOutcome(
        text,
        refs=refs,
        charts=[{
            "html": chart["html"],
            "title": args["title"],
            "chart_type": args["chart_type"],
            "spec": spec,
        }],
        artifacts=[{"type": "chart", "name": args["title"], "chart_type": args["chart_type"]}],
    )
