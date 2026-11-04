"""把抓取到的网表 / 飞书多维表格记录转成新的数据源，并生成模型看到的工具
文案（``fetch_table``、``browser_extract_tables``、``load_feishu_bitable``）。

网络与凭证部分（带 SSRF 检查的 fetch、飞书 OpenAPI）由调用方负责；这些辅助函数
只做解析、构建 DuckDB 支撑的 source 以及格式化结果。旧 agent 循环与 compute
worker 共用。
"""
from __future__ import annotations

import json
from typing import Any

NO_TABLES_TEXT = json.dumps({
    "ok": False,
    "error_code": "FETCH-001",
    "message": (
        "未发现可用表格（少于 2 行或 2 列的表已被过滤）。"
        "若是 JavaScript 渲染页面，请先 browser_navigate 打开页面，"
        "再调用 browser_extract_tables。"
    ),
}, ensure_ascii=False)

NO_GRIDS_TEXT = json.dumps({
    "ok": False,
    "error_code": "FETCH-001",
    "message": (
        "链接内容中未检测到表格。若是 JavaScript 渲染页面，"
        "请先 browser_navigate 打开页面，再调用 browser_extract_tables。"
    ),
}, ensure_ascii=False)


def fetch_error_text(code: str, message: str) -> str:
    return json.dumps({"ok": False, "error_code": code, "message": message}, ensure_ascii=False)


def extracted_source(grids: list, source_name: str, origin_label: str):
    """为提取出的 grids 返回 ``(source, tables, meta)``；归一化后没有任何可用表时
    ``source`` 为 None（此时用 ``NO_TABLES_TEXT`` 应答）。"""
    from data.sources.extracted import ExtractedTableDataSource
    from data.table_extract import normalize_grids

    tables, meta = normalize_grids(grids)
    if not tables:
        return None, tables, meta
    return ExtractedTableDataSource(source_name or origin_label, tables), tables, meta


def extracted_source_text(source_id: str, source, tables: dict, meta: dict, schema: str) -> str:
    previews = []
    for entry in meta.get("tables", []):
        frame = tables.get(entry.get("name"))
        if frame is None:
            continue
        sample = [
            ["" if v is None or v != v else str(v) for v in row]
            for row in frame.head(3).to_numpy().tolist()
        ]
        previews.append({
            "name": entry.get("name"),
            "rows": entry.get("rows"),
            "cols": entry.get("cols"),
            "truncated": bool(entry.get("truncated")),
            "columns": [str(c) for c in frame.columns],
            "sample_rows": sample,
        })
    return json.dumps({
        "ok": True,
        "message": "表格已接入当前对话，可直接用 SQL 查询与分析。",
        "source_id": source_id,
        "source_name": source.name,
        "tables": previews,
        "dropped_tables": meta.get("dropped", 0),
        "schema": schema,
    }, ensure_ascii=False)


def bitable_source(read_result: dict[str, Any], source_name: str):
    """为 ``data.feishu_bitable_service.read_bitable_records`` 返回的记录给出
    ``(source, 显示名)``。"""
    from data.sources.feishu_bitable import FeishuBitableDataSource

    name = str(source_name or "").strip() or f"飞书多维表格 {read_result['table_id']}"
    return FeishuBitableDataSource(read_result["records"], name, read_result["table_id"]), name


def bitable_loaded_text(source_id: str, source_name: str, schema: str, read_result: dict) -> str:
    return json.dumps({
        "ok": True,
        "message": "飞书多维表格已作为 SQL 数据源接入当前对话；现在可直接查询、分析、制图或生成报告。",
        "source_id": source_id,
        "source_name": source_name,
        "schema": schema,
        **{key: value for key, value in read_result.items() if key != "records"},
    }, ensure_ascii=False)
