# -*- coding: utf-8 -*-
"""Dashboard HTML export: build a self-contained HTML file from a dashboard dict.

Usage:
    from api.dashboard_html_export import build_export_html
    html = build_export_html(dashboard, chart_store)
"""
from __future__ import annotations

import datetime
import html as _html_lib
import logging

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Color scheme brand colors (matches existing COLOR_SCHEMES in api/)
# ---------------------------------------------------------------------------
_SCHEME_COLORS: dict[str, dict] = {
    "mckinsey": {"primary": "#002060", "accent": "#0070C0", "bg": "#F0F4FA"},
    "bcg":      {"primary": "#00843D", "accent": "#009B3A", "bg": "#F0FAF4"},
    "bain":     {"primary": "#CC0000", "accent": "#E63946", "bg": "#FFF0F0"},
    "ey":       {"primary": "#FFE600", "accent": "#2E2E38", "bg": "#FFFDE7"},
}
_DEFAULT_SCHEME = "mckinsey"


def _scheme_css_vars(color_scheme: str) -> str:
    c = _SCHEME_COLORS.get(color_scheme, _SCHEME_COLORS[_DEFAULT_SCHEME])
    return (
        f"--primary:{c['primary']};"
        f"--accent:{c['accent']};"
        f"--bg:{c['bg']};"
    )


# ---------------------------------------------------------------------------
# CSS
# ---------------------------------------------------------------------------
_BASE_CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: #1a1a2e;
  min-height: 100vh;
}
.page-header {
  background: var(--primary);
  color: #fff;
  padding: 18px 32px 14px;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
}
.page-header h1 { font-size: 1.35rem; font-weight: 700; letter-spacing: .02em; }
.page-header .meta { font-size: .78rem; opacity: .75; text-align: right; }
.kpi-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  padding: 20px 28px 8px;
}
.kpi-card {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 6px rgba(0,0,0,.10);
  padding: 18px 22px 14px;
  min-width: 160px;
  flex: 1 1 160px;
  max-width: 280px;
  border-top: 4px solid var(--accent);
}
.kpi-card .kpi-title { font-size: .78rem; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
.kpi-card .kpi-value { font-size: 2rem; font-weight: 700; color: var(--primary); line-height: 1.1; }
.kpi-card .kpi-sub   { font-size: .82rem; color: #888; margin-top: 4px; }
.kpi-card .kpi-trend { font-size: .82rem; margin-top: 4px; font-weight: 600; }
.kpi-card .kpi-trend.up   { color: #16a34a; }
.kpi-card .kpi-trend.down { color: #dc2626; }
.chart-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 14px;
  padding: 14px 28px 28px;
}
.chart-widget {
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 6px rgba(0,0,0,.09);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.chart-widget .widget-title {
  padding: 10px 14px 6px;
  font-size: .85rem;
  font-weight: 600;
  color: var(--primary);
  border-bottom: 1px solid #eee;
  flex-shrink: 0;
}
.chart-widget .widget-body {
  flex: 1;
  overflow: hidden;
}
.chart-widget .widget-body iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
.chart-widget .widget-error {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 120px;
  color: #999;
  font-size: .82rem;
  padding: 16px;
  text-align: center;
}
.page-footer {
  text-align: center;
  padding: 18px;
  font-size: .75rem;
  color: #aaa;
  border-top: 1px solid #e5e7eb;
  background: #fff;
  margin-top: 8px;
}
@media (max-width: 768px) {
  .chart-grid { grid-template-columns: 1fr !important; }
  .chart-widget { grid-column: 1 / -1 !important; grid-row: auto !important; }
  .kpi-strip { padding: 14px 14px 4px; }
  .chart-grid { padding: 8px 14px 18px; }
}
"""


# ---------------------------------------------------------------------------
# KPI card HTML
# ---------------------------------------------------------------------------
def _kpi_card_html(widget: dict) -> str:
    title = _html_lib.escape(widget.get("title", ""))
    value = _html_lib.escape(str(widget.get("kpi_value", "—")))
    sub   = _html_lib.escape(str(widget.get("kpi_sub", "") or ""))
    raw_trend = widget.get("kpi_trend")

    trend_html = ""
    if raw_trend is not None:
        try:
            pct = float(raw_trend)
            sign = "+" if pct >= 0 else ""
            cls  = "up" if pct >= 0 else "down"
            arrow = "\u25b2" if pct >= 0 else "\u25bc"
            trend_html = (
                f'<div class="kpi-trend {cls}">{arrow} {sign}{pct:.1f}%</div>'
            )
        except (TypeError, ValueError):
            trend_html = f'<div class="kpi-trend">{_html_lib.escape(str(raw_trend))}</div>'

    sub_html = f'<div class="kpi-sub">{sub}</div>' if sub else ""
    return (
        f'<div class="kpi-card">'
        f'<div class="kpi-title">{title}</div>'
        f'<div class="kpi-value">{value}</div>'
        f'{sub_html}'
        f'{trend_html}'
        f'</div>'
    )


# ---------------------------------------------------------------------------
# Chart widget HTML (uses srcdoc for self-containment)
# ---------------------------------------------------------------------------
def _chart_widget_html(widget: dict, chart_store: dict, min_height_px: int = 320) -> str:
    title = _html_lib.escape(widget.get("title", ""))
    chart_id = widget.get("chart_id", "")
    error = widget.get("error")
    grid = widget.get("grid", {})

    # grid-column / grid-row from grid spec
    gx = int(grid.get("x", 0)) + 1
    gw = int(grid.get("w", 6))
    gy = int(grid.get("y", 0)) + 1
    gh = int(grid.get("h", 4))
    height_px = max(min_height_px, gh * 80)

    style = (
        f"grid-column:{gx}/span {gw};"
        f"grid-row:{gy}/span {gh};"
        f"min-height:{height_px}px;"
    )

    if error or not chart_id or chart_id not in chart_store:
        msg = _html_lib.escape(str(error or "Chart data unavailable"))
        body = f'<div class="widget-error">{msg}</div>'
    else:
        raw_html = chart_store[chart_id]
        # escape for srcdoc attribute: & -> &amp; " -> &quot;
        srcdoc = raw_html.replace("&", "&amp;").replace('"', "&quot;")
        body = (
            f'<div class="widget-body" style="height:{height_px - 40}px">'
            f'<iframe srcdoc="{srcdoc}" sandbox="allow-scripts"></iframe>'
            f'</div>'
        )

    return (
        f'<div class="chart-widget" style="{style}">'
        f'<div class="widget-title">{title}</div>'
        f'{body}'
        f'</div>'
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def build_export_html(dashboard: dict, chart_store: dict) -> str:
    """Return a self-contained HTML string for the given dashboard.

    Args:
        dashboard: dict loaded from the dashboard JSON file.
        chart_store: dict mapping chart_id -> full HTML string (in-memory store).

    Returns:
        A single HTML string that can be saved as a .html file and opened offline.
    """
    name = dashboard.get("name", "Dashboard")
    color_scheme = dashboard.get("color_scheme", _DEFAULT_SCHEME)
    created_at = dashboard.get("created_at", "")
    export_ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    # format created_at nicely
    try:
        dt = datetime.datetime.fromisoformat(created_at)
        created_str = dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        created_str = created_at or export_ts

    css_vars = _scheme_css_vars(color_scheme)
    widgets = dashboard.get("widgets", [])

    kpi_widgets   = [w for w in widgets if w.get("chart_type") == "KPI_Card"]
    chart_widgets = [w for w in widgets if w.get("chart_type") != "KPI_Card"]

    # KPI strip
    kpi_html = ""
    if kpi_widgets:
        cards = "\n".join(_kpi_card_html(w) for w in kpi_widgets)
        kpi_html = f'<section class="kpi-strip">\n{cards}\n</section>'

    # chart grid
    chart_html = ""
    if chart_widgets:
        items = "\n".join(
            _chart_widget_html(w, chart_store) for w in chart_widgets
        )
        chart_html = f'<section class="chart-grid">\n{items}\n</section>'

    escaped_name = _html_lib.escape(name)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{escaped_name}</title>
<style>
:root {{ {css_vars} }}
{_BASE_CSS}
</style>
</head>
<body>
<header class="page-header">
  <h1>{escaped_name}</h1>
  <div class="meta">
    <div>\u6570\u636e\u622a\u6b62\uff1a{_html_lib.escape(created_str)}</div>
    <div>\u5bfc\u51fa\u65f6\u95f4\uff1a{_html_lib.escape(export_ts)}</div>
  </div>
</header>
{kpi_html}
{chart_html}
<footer class="page-footer">
  \u7531\u667a\u6790 Agent \u751f\u6210 &nbsp;&middot;&nbsp; {_html_lib.escape(export_ts)}
</footer>
</body>
</html>"""
