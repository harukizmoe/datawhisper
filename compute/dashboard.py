# -*- coding: utf-8 -*-
"""Dashboards: build from widget specs, re-run widget SQL, persist as JSON.

A dashboard is ``<data>/outputs/Dashboard/<id>.json``. Every widget's SQL runs
against one data source; chart widgets render into the given chart store
(``store[chart_id] = html``), KPI cards keep their value fields inline.
Shared by the ``generate_dashboard`` tool, the ``dashboard.*`` RPC methods and
the old Flask routes.
"""
import datetime
import json
import logging
import os
import re
import uuid

from infrastructure.paths import content_data_path

from .validate import validate_tool_args

log = logging.getLogger(__name__)

DASHBOARD_DIR = str(content_data_path("outputs", "Dashboard"))

_SCHEMA_VERSION = 2


def dashboard_path(dashboard_id: str) -> str:
    safe = re.sub(r'[^\w\-]', '_', dashboard_id)
    return os.path.join(DASHBOARD_DIR, f"{safe}.json")


def load_dashboard(dashboard_id: str) -> dict | None:
    path = dashboard_path(dashboard_id)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_dashboard(data: dict, dashboard_id: str) -> None:
    os.makedirs(DASHBOARD_DIR, exist_ok=True)
    with open(dashboard_path(dashboard_id), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


_CHART_TYPE_ALIASES = {
    "Scatter_Chart": "Scatter_Plot",
    "Heatmap_Chart": "Heatmap",
    "Donut_Chart": "Pie_Chart",
    "Table_Chart": "Bar_Chart",
    "Grouped_Bar": "Grouped_Bar_Chart",
    "Stacked_Bar": "Stacked_Bar_Chart",
}


def _sql_guard(sql: str, workspace_authorization=None) -> str | None:
    return validate_tool_args(
        "query_data", {"sql": sql},
        workspace_authorization=workspace_authorization,
    )


def _render_kpi_from_df(df, error: str | None = None) -> dict:
    """Return KPI_Card value fields from an already-fetched DataFrame."""
    if error:
        return {"kpi_value": "—", "kpi_sub": "", "kpi_trend": None, "error": error}
    try:
        if df is None or df.empty or len(df.columns) == 0:
            return {"kpi_value": "—", "kpi_sub": "", "kpi_trend": None, "error": "No rows returned"}
        row = df.iloc[0]
        kpi_value = row.iloc[0]
        try:
            fv = float(kpi_value)
            if abs(fv) >= 1e8:
                kpi_value = f"{fv/1e8:.2f} 亿"
            elif abs(fv) >= 1e4:
                kpi_value = f"{fv/1e4:.1f} 万"
            elif fv == int(fv):
                kpi_value = str(int(fv))
            else:
                kpi_value = f"{fv:.2f}"
        except (TypeError, ValueError):
            kpi_value = str(kpi_value)
        kpi_sub = str(row.iloc[1]) if len(row) > 1 else ""
        kpi_trend = None
        if len(row) > 2:
            try:
                kpi_trend = round(float(row.iloc[2]), 1)
            except (TypeError, ValueError):
                pass
        return {"kpi_value": kpi_value, "kpi_sub": kpi_sub, "kpi_trend": kpi_trend, "error": None}
    except Exception as exc:
        log.warning("[dashboard] KPI render error: %s", exc)
        return {"kpi_value": "—", "kpi_sub": "", "kpi_trend": None, "error": str(exc)}


def _render_widget_from_df(
    chart_store, color_scheme: str, spec: dict, df, error: str | None = None,
) -> tuple[str | None, str | None]:
    """Generate chart HTML from an already-fetched DataFrame."""
    if error:
        return None, error
    try:
        from chart_generate import generate_chart as _gen
        if df is None or df.empty:
            return None, "Query returned no rows"

        opts = {}
        if spec.get("title"):
            opts["title"] = spec["title"]
        opts.update(spec.get("options", {}))

        result = _gen(
            df=df,
            chart_type=_CHART_TYPE_ALIASES.get(spec.get("chart_type", "Bar_Chart"), spec.get("chart_type", "Bar_Chart")),
            mapping=spec.get("field_mapping", {}),
            options=opts,
            color_scheme=color_scheme,
        )
        if "error" in result:
            return None, result["error"]

        chart_id = str(uuid.uuid4())
        chart_store[chart_id] = result["html"]
        return chart_id, None

    except Exception as exc:
        log.warning("[dashboard] widget render error: %s", exc)
        return None, str(exc)


def prefetch_dashboard_widget_data(
    data_source, widgets_spec: list, workspace_authorization=None,
) -> list[dict]:
    """Fetch widget SQL results on the caller thread before any worker rendering."""
    prefetched = []
    for spec in widgets_spec:
        sql = spec.get("sql", "")
        error = ""
        df = None
        if not sql or not data_source:
            error = "No SQL defined" if not sql else "No data source"
        else:
            guard_error = _sql_guard(sql, workspace_authorization)
            if guard_error:
                error = guard_error
            else:
                try:
                    df, err = data_source.execute_query(sql)
                    if err:
                        error = f"SQL error: {err}"
                except Exception as exc:
                    log.warning("[dashboard] widget SQL error: %s", exc)
                    error = str(exc)
        prefetched.append({"spec": spec, "df": df, "error": error or None})
    return prefetched


def render_widget(
    data_source, chart_store, color_scheme: str, widget: dict, workspace_authorization=None,
) -> dict:
    """Re-run one widget's SQL and render it in place. Returns the widget id with
    its refreshed fields: ``kpi_*``/``error`` for KPI cards, else ``chart_id``/``error``."""
    item = prefetch_dashboard_widget_data(data_source, [widget], workspace_authorization)[0]
    if widget.get("chart_type") == "KPI_Card":
        kpi = _render_kpi_from_df(item["df"], item["error"])
        widget.update(kpi)
        return {"id": widget["id"], **kpi}
    chart_id, error = _render_widget_from_df(
        chart_store, color_scheme, widget, item["df"], item["error"],
    )
    widget["chart_id"] = chart_id
    widget["error"] = error
    return {"id": widget["id"], "chart_id": chart_id, "error": error}


def build_dashboard(
    data_source, chart_store, *, session_id: str, workspace_id: str,
    name: str, widgets_spec: list, color_scheme: str,
    workspace_authorization=None,
) -> dict:
    """Build a dashboard from an already-leased data-source snapshot."""
    prefetched = prefetch_dashboard_widget_data(
        data_source, widgets_spec, workspace_authorization,
    )
    return build_dashboard_from_prefetched_widgets(
        chart_store,
        session_id=session_id,
        workspace_id=workspace_id,
        name=name,
        widget_inputs=prefetched,
        color_scheme=color_scheme,
    )


def build_dashboard_from_prefetched_widgets(
    chart_store, *, session_id: str, workspace_id: str, name: str,
    widget_inputs: list, color_scheme: str, owner_uid: str = "",
) -> dict:
    """Build dashboard JSON from caller-thread SQL results."""
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_name = re.sub(r'[^\w\-]', '_', name)
    dashboard_id = f"{safe_name}_{ts}"

    built_widgets = []
    for item in widget_inputs:
        spec = item.get("spec", {})
        df = item.get("df")
        error = item.get("error")
        widget_id = spec.get("id") or str(uuid.uuid4())[:8]
        chart_type = spec.get("chart_type", "Bar_Chart")
        base = {
            "id": widget_id,
            "title": spec.get("title", ""),
            "chart_type": chart_type,
            "sql": spec.get("sql", ""),
            "field_mapping": spec.get("field_mapping", {}),
            "options": spec.get("options", {}),
            "grid": spec.get("grid", {"x": 0, "y": 0, "w": 6, "h": 4}),
        }
        if chart_type == "KPI_Card":
            base.update(_render_kpi_from_df(df, error))
        else:
            chart_id, error = _render_widget_from_df(
                chart_store, color_scheme, spec, df, error,
            )
            base["chart_id"] = chart_id
            base["error"] = error
        built_widgets.append(base)

    dashboard = {
        "_schema_version": _SCHEMA_VERSION,
        "id": dashboard_id,
        "name": name,
        "created_at": datetime.datetime.now().isoformat(),
        "color_scheme": color_scheme,
        "session_id": session_id,
        "workspace_id": workspace_id,
        "owner_uid": owner_uid,
        "widgets": built_widgets,
    }
    save_dashboard(dashboard, dashboard_id)
    return {"dashboard_id": dashboard_id, "url": f"/dashboard/{dashboard_id}"}
