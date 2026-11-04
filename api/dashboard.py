# -*- coding: utf-8 -*-
"""Blueprint: dashboard CRUD + refresh endpoints."""
import json
import logging
import os
import datetime

from flask import Blueprint, request, jsonify, render_template, abort
from compute.dashboard import (
    DASHBOARD_DIR, build_dashboard, dashboard_path, load_dashboard, render_widget, save_dashboard,
)
from infrastructure.paths import is_cloud_managed_runtime

log = logging.getLogger(__name__)

bp = Blueprint("dashboard", __name__)


def _load_dashboard(dashboard_id: str) -> dict:
    dashboard = load_dashboard(dashboard_id)
    if dashboard is None:
        abort(404, description=f"Dashboard '{dashboard_id}' not found")
    if is_cloud_managed_runtime():
        from .auth import current_user

        user = current_user()
        owner_uid = str(dashboard.get("owner_uid") or "")
        if not user or not owner_uid or owner_uid != str(user["id"]):
            abort(404, description=f"Dashboard '{dashboard_id}' not found")
    return dashboard


# ── Page route ────────────────────────────────────────────────────────────────

@bp.get("/dashboard/<dashboard_id>")
def dashboard_page(dashboard_id: str):
    _load_dashboard(dashboard_id)
    return render_template("dashboard.html", dashboard_id=dashboard_id)


# ── API: create ───────────────────────────────────────────────────────────────

@bp.post("/api/dashboard/generate")
def create_dashboard():
    from .state import check_session_ownership, session_manager, chart_store
    body = request.get_json(force=True)
    sid = body.get("session_id", "")
    name = body.get("name", "Dashboard")
    widgets_spec = body.get("widgets", [])
    color_scheme = body.get("color_scheme", "mckinsey")

    allowed, _ = check_session_ownership(sid)
    if not allowed:
        return jsonify({"error": "无权访问此会话", "code": "forbidden"}), 403
    sess = session_manager.get(sid)
    if sess is None:
        return jsonify({"error": "Session not found"}), 404
    data_source = sess.data_source
    from data.workspace import workspace_manager
    current_workspace_id = workspace_manager.workspace_id_for_session(sid) or ""
    requested_workspace_id = str(body.get("workspace_id") or "")
    if requested_workspace_id and requested_workspace_id != current_workspace_id:
        return jsonify({"error": "Workspace changed before dashboard generation"}), 409
    workspace_authorization = workspace_manager.path_authorization(current_workspace_id)

    return jsonify(build_dashboard(
        data_source,
        chart_store,
        session_id=sid,
        workspace_id=current_workspace_id,
        name=name,
        widgets_spec=widgets_spec,
        color_scheme=color_scheme,
        workspace_authorization=workspace_authorization,
    ))


# ── API: get ──────────────────────────────────────────────────────────────────

@bp.get("/api/dashboard/<dashboard_id>")
def get_dashboard(dashboard_id: str):
    return jsonify(_load_dashboard(dashboard_id))


# ── API: list ─────────────────────────────────────────────────────────────────

@bp.get("/api/dashboards")
def list_dashboards():
    os.makedirs(DASHBOARD_DIR, exist_ok=True)
    results = []
    for fname in sorted(os.listdir(DASHBOARD_DIR), reverse=True):
        if not fname.endswith(".json"):
            continue
        fpath = os.path.join(DASHBOARD_DIR, fname)
        try:
            with open(fpath, encoding="utf-8") as f:
                d = json.load(f)
            if is_cloud_managed_runtime():
                from .auth import current_user

                user = current_user()
                if not user or str(d.get("owner_uid") or "") != str(user["id"]):
                    continue
            results.append({
                "id": d.get("id", fname[:-5]),
                "name": d.get("name", fname[:-5]),
                "created_at": d.get("created_at", ""),
                "widget_count": len(d.get("widgets", [])),
            })
        except Exception as e:
            log.debug("[dashboard] failed to load dashboard %s: %s", fname, e)
            continue
    return jsonify(results)


# ── API: update layout ────────────────────────────────────────────────────────

@bp.put("/api/dashboard/<dashboard_id>")
def update_dashboard(dashboard_id: str):
    body = request.get_json(force=True)
    dashboard = _load_dashboard(dashboard_id)

    grid_updates = {w["id"]: w["grid"] for w in body.get("widgets", []) if "id" in w and "grid" in w}
    if grid_updates:
        for widget in dashboard["widgets"]:
            if widget["id"] in grid_updates:
                widget["grid"] = grid_updates[widget["id"]]

    if "name" in body:
        dashboard["name"] = body["name"]

    if "container_width" in body:
        dashboard["container_width"] = body["container_width"]

    dashboard["updated_at"] = datetime.datetime.now().isoformat()
    save_dashboard(dashboard, dashboard_id)
    return jsonify({"ok": True})


# ── API: delete ───────────────────────────────────────────────────────────────

@bp.delete("/api/dashboard/<dashboard_id>")
def delete_dashboard(dashboard_id: str):
    _load_dashboard(dashboard_id)
    path = dashboard_path(dashboard_id)
    if not os.path.isfile(path):
        abort(404)
    os.remove(path)
    return jsonify({"ok": True})


# ── API: refresh all widgets ───────────────────────────────────────────────────

@bp.post("/api/dashboard/<dashboard_id>/refresh")
def refresh_dashboard(dashboard_id: str):
    from .state import check_session_ownership, session_manager, chart_store
    body = request.get_json(force=True)
    sid = body.get("session_id", "")

    allowed, _ = check_session_ownership(sid)
    if not allowed:
        return jsonify({"error": "无权访问此会话", "code": "forbidden"}), 403

    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "Session not found — please open the dashboard from an active chat session"}), 404

    data_source = sess.data_source
    if not data_source:
        return jsonify({"error": "No data source connected in the session. Upload data first."}), 400

    dashboard = _load_dashboard(dashboard_id)
    from data.workspace import workspace_manager
    current_workspace_id = workspace_manager.workspace_id_for_session(sid) or ""
    dashboard_workspace_id = str(dashboard.get("workspace_id") or "")
    if dashboard_workspace_id and dashboard_workspace_id != current_workspace_id:
        return jsonify({"error": "Dashboard belongs to a different Workspace"}), 409
    workspace_authorization = workspace_manager.path_authorization(current_workspace_id)
    color_scheme = dashboard.get("color_scheme", "mckinsey")

    widget_results = []
    kpi_results = []
    for widget in dashboard["widgets"]:
        result = render_widget(data_source, chart_store, color_scheme, widget, workspace_authorization)
        (kpi_results if widget.get("chart_type") == "KPI_Card" else widget_results).append(result)

    dashboard["refreshed_at"] = datetime.datetime.now().isoformat()
    save_dashboard(dashboard, dashboard_id)

    return jsonify({"ok": True, "widgets": widget_results, "kpi_widgets": kpi_results})


# ── API: refresh single widget ─────────────────────────────────────────────────

@bp.post("/api/dashboard/<dashboard_id>/widget/<widget_id>/refresh")
def refresh_widget(dashboard_id: str, widget_id: str):
    from .state import check_session_ownership, session_manager, chart_store
    body = request.get_json(force=True)
    sid = body.get("session_id", "")

    allowed, _ = check_session_ownership(sid)
    if not allowed:
        return jsonify({"error": "无权访问此会话", "code": "forbidden"}), 403

    sess = session_manager.get(sid)
    if not sess:
        return jsonify({"error": "Session not found"}), 404

    data_source = sess.data_source
    if not data_source:
        return jsonify({"error": "No data source connected"}), 400

    dashboard = _load_dashboard(dashboard_id)
    from data.workspace import workspace_manager
    current_workspace_id = workspace_manager.workspace_id_for_session(sid) or ""
    dashboard_workspace_id = str(dashboard.get("workspace_id") or "")
    if dashboard_workspace_id and dashboard_workspace_id != current_workspace_id:
        return jsonify({"error": "Dashboard belongs to a different Workspace"}), 409
    workspace_authorization = workspace_manager.path_authorization(current_workspace_id)
    widget = next((w for w in dashboard["widgets"] if w["id"] == widget_id), None)
    if not widget:
        return jsonify({"error": f"Widget '{widget_id}' not found"}), 404

    color_scheme = dashboard.get("color_scheme", "mckinsey")
    result = render_widget(data_source, chart_store, color_scheme, widget, workspace_authorization)
    save_dashboard(dashboard, dashboard_id)
    return jsonify({"ok": True, **result})


# -- API: export HTML ----------------------------------------------------------

@bp.get("/api/dashboard/<dashboard_id>/export-html")
def export_html(dashboard_id: str):
    from .state import chart_store
    from compute.dashboard_html_export import build_export_html, export_filename
    from flask import Response

    dashboard = _load_dashboard(dashboard_id)
    html = build_export_html(dashboard, chart_store)
    return Response(
        html,
        mimetype="text/html",
        headers={"Content-Disposition": f'attachment; filename="{export_filename(dashboard)}"'},
    )
