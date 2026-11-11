# -*- coding: utf-8 -*-
"""Mixin：面向导出的工具（Excel、Word 报告、PPT、Dashboard）。"""
import datetime
import copy
import logging
log = logging.getLogger(__name__)
import os
import re
import uuid
from pathlib import Path
from ..i18n import say
from ..validate import normalize_report_outline_args, validate_tool_args
from infrastructure.artifact_lifecycle import register_artifact
from infrastructure.paths import content_data_path, resource_root

REPORT_JOB_SECTION_THRESHOLD = 6
REPORT_JOB_CHART_THRESHOLD = 3
DASHBOARD_JOB_WIDGET_THRESHOLD = 4
DASHBOARD_JOB_ROW_THRESHOLD = 50_000
EXCEL_JOB_BYTES_THRESHOLD = 5 * 1024 * 1024  # 5MB —— 与 registry 的 excel_bytes_gt_5mb 一致
PPT_JOB_SLIDES_THRESHOLD = 5  # 与 registry 的 ppt_slides_gt_5 一致


class ExportToolsMixin:
    """这里的所有方法都依赖 self.data_source、self._chart_store、
    self._session_chart_ids、self.ppt_color_scheme —— 由宿主
    （``agent.agent.BusinessAgent`` 或 ``compute.host.ToolHost``）设置。"""

    # ── A5：导出目录解析 ───────────────────────────────────────────────────────

    def _get_export_dir(self) -> str:
        """返回导出文件应该写入的目录。

        A5 起：
          - 工作目录已挂载 → 写到 runtime.artifacts_dir（= workdir/artifacts/），
            产出物跟随用户项目，方便管理。
          - 未挂载 → 写到 content_data_root/outputs/exports/；源码模式仍是项目根。

        返回绝对路径字符串。目录会被 mkdir 创建（artifacts_dir 在挂载时已创建，
        outputs/exports 在这里 makedirs）。
        """
        # 延迟导入避免循环依赖
        try:
            runtime = self._workspace_runtime()
            if runtime is not None:
                return str(runtime.artifacts_dir)
        except Exception as e:
            log.warning("[export] workspace runtime unavailable: %s", e)
            pass
        # 默认：统一运行数据根下的 outputs/exports
        export_dir = str(content_data_path("outputs", "exports"))
        os.makedirs(export_dir, exist_ok=True)
        return export_dir

    def _build_download_url(self, filename: str) -> str:
        """构建下载链接，带上 session_id 让路由能从 artifacts_dir 找文件。"""
        sid = getattr(self, "_session_id", "") or ""
        if sid:
            workspace_id = getattr(self, "_workspace_id", "") or ""
            suffix = f"&workspace_id={workspace_id}" if workspace_id else ""
            return f"/api/export/{filename}?sid={sid}{suffix}"
        return f"/api/export/{filename}"

    def _register_export_artifact(self, path: Path, *, artifact_type: str) -> str:
        runtime = self._workspace_runtime()
        return register_artifact(
            path,
            artifact_type=artifact_type,
            session_id=getattr(self, "_session_id", ""),
            workspace_id=getattr(self, "_workspace_id", ""),
            workspace_root=runtime.workdir if runtime is not None else None,
        )

    # ── Excel 导出 ─────────────────────────────────────────────────────────────

    def _excel_safe_name(self, filename: str) -> str:
        import re as _re
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        if not filename:
            filename = f"export_{ts}"
        safe_base = _re.sub(r'[^\w\-.]', '_', filename)
        safe_base = _re.sub(r'_+', '_', safe_base).strip('_') or "export"
        if not safe_base.lower().endswith(".xlsx"):
            safe_base = safe_base + ".xlsx"
        return safe_base

    def _render_excel_export(self, tables: list, filename: str) -> str:
        """同步渲染路径。*tables* 必须已解析为具体真实表名构成的列表。"""
        from Function.Output.excel_export import export_to_excel

        safe_name = self._excel_safe_name(filename)
        export_dir = self._get_export_dir()
        os.makedirs(export_dir, exist_ok=True)
        filepath = os.path.join(export_dir, safe_name)

        try:
            _, skipped = export_to_excel(self.data_source, tables, filepath)
        except Exception as exc:
            log.warning("[export] excel export failed: %s", exc)
            return say(f"❌ Export failed: {exc}", f"❌ 导出失败：{exc}")

        self._register_export_artifact(Path(filepath), artifact_type="export")
        download_url = self._build_download_url(safe_name)
        warning = ""
        if skipped:
            skipped_desc = ", ".join(t for t, _ in skipped)
            warning = say(
                f"\n\n⚠️ {len(skipped)} table(s) failed to write and were skipped: {skipped_desc}",
                f"\n\n⚠️ 以下 {len(skipped)} 张表写入失败，已跳过：{skipped_desc}",
            )
        return say(
            f"✅ Excel file generated with {len(tables)} table(s): {', '.join(tables)}.{warning}\n\n"
            f"[📥 Click to download {safe_name}]({download_url})",
            f"✅ Excel 文件已生成，共 {len(tables)} 张表：{', '.join(tables)}。{warning}\n\n"
            f"[📥 点击下载 {safe_name}]({download_url})",
        )

    def _tool_export_excel(self, tables: list, filename: str = "") -> str:
        if not tables or tables == ["*"]:
            tables = self._discover_all_tables()
            if not tables:
                return say("❌ No tables available in the data source. Upload data or run an analysis first.",
                           "❌ 数据源中没有可用的表格，请先上传数据或运行分析。")
        return self._render_excel_export(tables, filename)

    def _tool_export_excel_with_jobs(self, tables: list, filename: str = ""):
        """带 JobRunner 路由的 Excel 导出。先在请求线程预取 DataFrame 快照
        （DataSource 连接绝不跨线程），当估算的序列化大小超过
        EXCEL_JOB_BYTES_THRESHOLD 时，把快照交给 worker 做 openpyxl 写入。
        """
        if not tables or tables == ["*"]:
            tables = self._discover_all_tables()
            if not tables:
                return say("❌ No tables available in the data source. Upload data or run an analysis first.",
                           "❌ 数据源中没有可用的表格，请先上传数据或运行分析。")

        # 在请求线程预取。
        from Function.Output.excel_export import prefetch_excel_frames
        try:
            frames = prefetch_excel_frames(self.data_source, tables)
        except Exception as exc:
            log.warning("[export] excel prefetch failed: %s", exc)
            return say(f"❌ Export failed: {exc}", f"❌ 导出失败：{exc}")
        if not frames:
            return say("❌ No table data to export. Check that the table names are correct and the data is not empty.",
                       "❌ 没有可导出的表格数据，请确认表名正确且数据不为空。")

        # 估算序列化大小（字节）：行 × 列 × ~8 字节 的启发式。
        est_bytes = 0
        for _t, df in frames:
            try:
                est_bytes += int(df.shape[0] * df.shape[1] * 8)
            except Exception:
                pass

        should_job = (
            self._job_runner is not None and est_bytes > EXCEL_JOB_BYTES_THRESHOLD
        )
        if not should_job:
            # 小导出：直接用预取好的 frame 同步写入。
            from Function.Output.excel_export import write_excel_from_frames
            safe_name = self._excel_safe_name(filename)
            export_dir = self._get_export_dir()
            os.makedirs(export_dir, exist_ok=True)
            filepath = os.path.join(export_dir, safe_name)
            try:
                _, skipped = write_excel_from_frames(frames, filepath)
            except Exception as exc:
                log.warning("[export] excel export failed: %s", exc)
                return say(f"❌ Export failed: {exc}", f"❌ 导出失败：{exc}")
            self._register_export_artifact(Path(filepath), artifact_type="export")
            download_url = self._build_download_url(safe_name)
            warning = ""
            if skipped:
                skipped_desc = ", ".join(t for t, _ in skipped)
                warning = say(
                    f"\n\n⚠️ {len(skipped)} table(s) failed to write and were skipped: {skipped_desc}",
                    f"\n\n⚠️ 以下 {len(skipped)} 张表写入失败，已跳过：{skipped_desc}",
                )
            return say(
                f"✅ Excel file generated with {len(frames)} table(s): "
                f"{', '.join(t for t, _ in frames)}.{warning}\n\n"
                f"[📥 Click to download {safe_name}]({download_url})",
                f"✅ Excel 文件已生成，共 {len(frames)} 张表："
                f"{', '.join(t for t, _ in frames)}。{warning}\n\n"
                f"[📥 点击下载 {safe_name}]({download_url})",
            )

        # 大导出：深拷贝快照，交给 worker 写入。
        snapshot = [(t, df.copy(deep=True)) for t, df in frames]
        tables_snapshot = list(tables)
        filename_snapshot = str(filename or "")
        result_holder = {}

        def _worker(ctx):
            from Function.Output.excel_export import write_excel_from_frames
            ctx.set_progress(5, say("Preparing table data", "正在整理表格数据"))
            ctx.check_canceled()
            ctx.set_progress(40, say("Writing Excel file", "正在写入 Excel 文件"))
            safe_name = self._excel_safe_name(filename_snapshot)
            export_dir = self._get_export_dir()
            os.makedirs(export_dir, exist_ok=True)
            filepath = os.path.join(export_dir, safe_name)
            _, skipped = write_excel_from_frames(snapshot, filepath)
            ctx.check_canceled()
            ctx.set_progress(90, say("Publishing Excel file", "正在发布 Excel 文件"))
            self._register_export_artifact(Path(filepath), artifact_type="export")
            download_url = self._build_download_url(safe_name)
            warning = ""
            if skipped:
                skipped_desc = ", ".join(t for t, _ in skipped)
                warning = say(
                    f"\n\n⚠️ {len(skipped)} table(s) failed to write and were skipped: {skipped_desc}",
                    f"\n\n⚠️ 以下 {len(skipped)} 张表写入失败，已跳过：{skipped_desc}",
                )
            result_holder["text"] = say(
                f"✅ Excel file generated with {len(snapshot)} table(s): "
                f"{', '.join(t for t, _ in snapshot)}.{warning}\n\n"
                f"[📥 Click to download {safe_name}]({download_url})",
                f"✅ Excel 文件已生成，共 {len(snapshot)} 张表："
                f"{', '.join(t for t, _ in snapshot)}。{warning}\n\n"
                f"[📥 点击下载 {safe_name}]({download_url})",
            )
            ctx.set_progress(100, say("Excel export complete", "Excel 导出完成"))
            return {
                "tables": len(snapshot),
                "estimated_bytes": est_bytes,
                "skipped": len(skipped),
            }

        job = yield from self._run_as_job(
            _worker,
            job_type="excel_export",
            label=f"Excel · {len(tables_snapshot)} tables",
        )
        if job.get("status") == "canceled":
            return say("Excel export canceled.", "Excel 导出已取消。")
        if job.get("status") != "succeeded":
            return say(f"❌ Export failed: {job.get('error') or 'background job failed'}",
                       f"❌ 导出失败：{job.get('error') or 'background job failed'}")
        return result_holder.get("text", say("❌ Export failed: background result unavailable.", "❌ 导出失败：后台结果不可用。"))

    def _tool_propose_excel_export(
        self, tables: list, filename: str = "", summary: str = ""
    ) -> dict:
        if tables == ["*"] or tables == ["all"]:
            label = say("All available tables (raw data + analysis results)", "全部可用表格（原始数据 + 分析结果）")
            table_list = tables
        else:
            label = say(", ", "、").join(tables) if tables else say("(not specified)", "（未指定）")
            table_list = tables
        markdown = say(
            f"**Export target:** {label}\n\n"
            f"**File name:** {filename or '(auto-generated)'}.xlsx\n\n",
            f"**导出目标：** {label}\n\n"
            f"**文件名：** {filename or '（自动生成）'}.xlsx\n\n",
        )
        if summary:
            markdown += say(f"**Notes:** {summary}\n", f"**说明：** {summary}\n")
        # 先在数据源中核对指定表名，让不存在的表在导出 job 运行前就暴露
        # （否则缺失的表会在 excel_export 中被静默跳过，用户直到文件为空才发现）。
        if table_list not in (["*"], ["all"]) and self.data_source is not None:
            available = set(self._discover_all_tables())
            missing = [t for t in table_list if t not in available]
            if missing:
                markdown += say(f"**⚠️ Tables that do not exist:** {', '.join(missing)}\n",
                                f"**⚠️ 不存在的表：** {', '.join(missing)}\n")
        return {"tables": table_list, "filename": filename, "summary": summary, "markdown": markdown}

    # ── Word 报告 ──────────────────────────────────────────────────────────────

    def _report_chart_htmls(self) -> list:
        return [
            self._chart_store[cid]
            for cid in self._session_chart_ids
            if cid in self._chart_store
        ]

    def _render_report_export(self, title: str, sections: list, chart_htmls: list) -> str:
        from Function.Output.report_export import export_to_report, _title_slug

        normalized = normalize_report_outline_args({"title": title, "sections": sections})
        validation_error = validate_tool_args("export_report", normalized)
        if validation_error:
            raise ValueError(validation_error)
        title = normalized["title"]
        sections = normalized["sections"]

        # 文件名带上（slug 化后的）报告标题，让用户能按标题找到
        # "上周的收入分析报告"，而不必从一堆 `report_<ts>.docx` 时间戳里猜。
        # 与 PPT（_ppt_safe_name）和 Excel（_excel_safe_name）保持一致。
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        slug = _title_slug(title)
        export_dir = self._get_export_dir()
        os.makedirs(export_dir, exist_ok=True)
        filepath = os.path.join(export_dir, f"{slug}_{ts}.docx")

        _result_path, download_name = export_to_report(
            title, sections, filepath, chart_htmls=chart_htmls
        )

        n_charts = len(chart_htmls)
        chart_note = say(f" (including {n_charts} chart(s))", f"（含 {n_charts} 张图表）") if n_charts else ""
        self._register_export_artifact(Path(_result_path), artifact_type="report")
        download_url = self._build_download_url(download_name)
        return say(
            f"✅ Report generated with {len(sections)} section(s){chart_note}.\n\n"
            f"[📥 Click to download {download_name}]({download_url})",
            f"✅ 报告已生成，共 {len(sections)} 个章节{chart_note}。\n\n"
            f"[📥 点击下载 {download_name}]({download_url})",
        )

    def _tool_export_report(self, title: str, sections: list) -> str:
        if not sections:
            return say("❌ The report is empty. Provide at least one section.", "❌ 报告内容为空，请提供至少一个章节。")

        try:
            return self._render_report_export(title, sections, self._report_chart_htmls())
        except Exception as exc:
            log.warning("[export] report generation failed: %s", exc)
            return say(f"❌ Report generation failed: {exc}", f"❌ 报告生成失败：{exc}")

    def _tool_export_report_with_jobs(self, title: str, sections: list):
        if not sections:
            return say("❌ The report is empty. Provide at least one section.", "❌ 报告内容为空，请提供至少一个章节。")

        chart_htmls = self._report_chart_htmls()
        should_job = (
            self._job_runner is not None
            and (
                len(sections) > REPORT_JOB_SECTION_THRESHOLD
                or len(chart_htmls) > REPORT_JOB_CHART_THRESHOLD
            )
        )
        if not should_job:
            try:
                return self._render_report_export(title, sections, chart_htmls)
            except Exception as exc:
                log.warning("[export] report generation failed: %s", exc)
                return say(f"❌ Report generation failed: {exc}", f"❌ 报告生成失败：{exc}")

        title_snapshot = str(title or say("Analysis Report", "分析报告"))
        sections_snapshot = copy.deepcopy(sections)
        chart_htmls_snapshot = list(chart_htmls)
        result_holder = {}

        def _worker(ctx):
            ctx.set_progress(5, say("Preparing report material", "正在整理报告素材"))
            ctx.check_canceled()
            ctx.set_progress(35, say("Generating Word report", "正在生成 Word 报告"))
            result = self._render_report_export(
                title_snapshot, sections_snapshot, chart_htmls_snapshot
            )
            ctx.check_canceled()
            ctx.set_progress(90, say("Publishing report file", "正在发布报告文件"))
            result_holder["text"] = result
            ctx.set_progress(100, say("Report generation complete", "报告生成完成"))
            return {
                "title": title_snapshot,
                "sections": len(sections_snapshot),
                "charts": len(chart_htmls_snapshot),
            }

        job = yield from self._run_as_job(
            _worker,
            job_type="report_export",
            label=f"{title_snapshot} · {len(sections_snapshot)} sections",
        )
        if job.get("status") == "canceled":
            return say("Report generation canceled.", "报告生成已取消。")
        if job.get("status") != "succeeded":
            return say(f"❌ Report generation failed: {job.get('error') or 'background job failed'}",
                       f"❌ 报告生成失败：{job.get('error') or 'background job failed'}")
        return result_holder.get("text", say("❌ Report generation failed: background result unavailable.", "❌ 报告生成失败：后台结果不可用。"))

    def _tool_propose_report_outline(self, title: str, sections: list) -> dict:
        normalized = normalize_report_outline_args({"title": title, "sections": sections})
        validation_error = validate_tool_args("propose_report_outline", normalized)
        if validation_error:
            raise ValueError(validation_error)
        title = normalized["title"]
        sections = normalized["sections"]
        rows = [say("| # | Section title |\n|---|---------|", "| # | 章节标题 |\n|---|---------|")]
        for i, sec in enumerate(sections, 1):
            heading = sec.get("heading", f"Section {i}") if isinstance(sec, dict) else str(sec)
            rows.append(f"| {i} | {heading} |")
        markdown = (
            say(f"**{title}** ({len(sections)} section(s))\n\n", f"**{title}**（共 {len(sections)} 个章节）\n\n") + "\n".join(rows)
        )
        return {"title": title, "sections": sections, "markdown": markdown}

    # ── PPT 导出 ───────────────────────────────────────────────────────────────

    def _tool_set_ppt_color_scheme(self, scheme: str) -> str:
        from charts.color_schemes import COLOR_SCHEMES, get_scheme_description
        scheme = scheme.lower().strip()
        if scheme not in COLOR_SCHEMES:
            available = ", ".join(COLOR_SCHEMES.keys())
            return say(f"Unknown color scheme '{scheme}'. Available schemes: {available}",
                       f"未知配色方案 '{scheme}'。可用方案：{available}")
        self.ppt_color_scheme = scheme
        info = COLOR_SCHEMES[scheme]
        desc = get_scheme_description(scheme)
        return say(
            f"✅ Color scheme switched to \"{info['name']}\" ({desc}); later charts and PPTs will use it.",
            f"✅ 配色已切换为「{info['name']}」（{desc}），后续图表和 PPT 均使用此配色。",
        )

    def _tool_propose_ppt_outline(self, title: str, slides: list) -> dict:
        # 双语布局标签 —— 按 conventions §B 使用 _tt(zh, en)
        _LAYOUT_LABELS = {
            "cover":              ("封面", "Cover"),
            "toc":                ("目录", "Table of Contents"),
            "section_divider":    ("章节分割", "Section Divider"),
            "closing":            ("结束页", "Closing"),
            "big_number":        ("大数字", "Big Number"),
            "two_stat":           ("双数字对比", "Two-Stat Compare"),
            "metric_cards":       ("指标卡片", "Metric Cards"),
            "data_table":         ("数据表格", "Data Table"),
            "table_insight":      ("洞察表格", "Insight Table"),
            "executive_summary":  ("执行摘要", "Executive Summary"),
            "two_column_text":    ("双栏文本", "Two-Column Text"),
            "action_items":       ("行动项", "Action Items"),
            "donut":              ("环形图", "Donut Chart"),
            "grouped_bar":        ("分组柱状图", "Grouped Bar"),
            "stacked_bar":        ("堆叠柱状图", "Stacked Bar"),
            "timeline":           ("时间轴", "Timeline"),
        }
        rows = [say("| # | Layout | Content summary |\n|---|------|---------|", "| # | 布局 | 内容摘要 |\n|---|------|---------|")]
        for i, s in enumerate(slides, 1):
            layout = s.get("layout", "")
            p = s.get("params", {})
            zh, en = _LAYOUT_LABELS.get(layout, (layout, layout))
            label = self._tt(zh, en)
            title_str = str(p.get("title", ""))
            extra = (
                p.get("subtitle") or p.get("message") or
                p.get("section_label") or p.get("headline") or ""
            )
            summary = f"{title_str} · {extra}" if extra else title_str
            rows.append(f"| {i} | {label} | {summary} |")
        markdown = say(f"**{title}** ({len(slides)} slide(s))\n\n", f"**{title}**（共 {len(slides)} 张）\n\n") + "\n".join(rows)
        return {"title": title, "slides": slides, "markdown": markdown}

    def _ppt_safe_name(self, title: str, filename: str) -> str:
        """由 *filename* 或 *title* 生成安全的 .pptx 文件名。"""
        raw_base = filename or title or "ppt_export"
        safe_base = re.sub(r'[^\w\-.]', '_', raw_base)
        safe_base = re.sub(r'_+', '_', safe_base).strip('_') or "ppt_export"
        # 不区分大小写地去掉后缀（比手写 [:-5] 更干净）
        if safe_base.lower().endswith(".pptx"):
            safe_base = safe_base[:-len(".pptx")]
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{safe_base}_{ts}.pptx"

    def _render_ppt(self, title: str, slides: list, filename: str, scheme: str,
                    on_slide_done=None):
        """构建 PPT 并返回 ``(filepath, download_name, failed_slides)``。

        完全在调用它的那个线程上运行 —— MckEngine 持有一个 python-pptx 的
        Presentation，而它不是线程安全的，所以引擎的整个生命周期（实例化 → 渲染
        幻灯片 → 保存 → 清理）必须在同一线程上完成。要路由到 worker 的调用方应
        传入不可变快照（深拷贝的 slides、scheme 字符串、filename），让 worker 来
        调用这个方法。

        ``on_slide_done(i, total)`` 是可选回调，每张幻灯片渲染成功后调用 ——
        JobRunner worker 用它报告到幻灯片粒度的进度（35% → 85% 区间），并以
        幻灯片粒度而不是每份 deck 一次地轮询取消。

        单张幻灯片在渲染期抛出的异常会**降级成占位的 section_divider 幻灯片**，
        而不是中止整份 deck —— 用户拿到的是一份标注了失败页的文档，而非零产出。
        ``failed_slides`` 列出每个降级幻灯片的 ``(index, layout, error_msg)``，
        供调用方给出警告。schema 错误（不支持的布局）仍然立即抛出，因为此时
        还没有开始渲染。
        """
        _PROJ_ROOT = str(resource_root())

        try:
            from PPT import MckEngine
            from PPT.constants import (
                NAVY, ACCENT_BLUE, ACCENT_GREEN, ACCENT_ORANGE, ACCENT_RED,
                WHITE, BLACK, DARK_GRAY, MED_GRAY, LINE_GRAY, BG_GRAY,
                LIGHT_BLUE, LIGHT_GREEN, LIGHT_ORANGE, LIGHT_RED,
            )
        except ImportError as exc:
            raise ImportError(
                say(f"Failed to load the PPT module (check that python-pptx and lxml are installed): {exc}",
                    f"PPT 模块加载失败（请确认已安装 python-pptx 和 lxml）：{exc}")
            ) from exc

        COLOR_MAP = {
            "NAVY": NAVY, "ACCENT_BLUE": ACCENT_BLUE, "ACCENT_GREEN": ACCENT_GREEN,
            "ACCENT_ORANGE": ACCENT_ORANGE, "ACCENT_RED": ACCENT_RED,
            "WHITE": WHITE, "BLACK": BLACK, "DARK_GRAY": DARK_GRAY,
            "MED_GRAY": MED_GRAY, "LINE_GRAY": LINE_GRAY, "BG_GRAY": BG_GRAY,
            "LIGHT_BLUE": LIGHT_BLUE, "LIGHT_GREEN": LIGHT_GREEN,
            "LIGHT_ORANGE": LIGHT_ORANGE, "LIGHT_RED": LIGHT_RED,
        }

        from pptx.dml.color import RGBColor as _RGBColor
        from charts.color_schemes import get_colors_list, get_color_scheme

        def _hex_to_rgb(h: str) -> "_RGBColor":
            h = h.strip().lstrip("#")
            if len(h) == 3:
                h = "".join(c * 2 for c in h)
            return _RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))

        _scheme_info = get_color_scheme(scheme)
        _scheme_hex_list = get_colors_list(scheme)
        _FALLBACK_COLORS = [_hex_to_rgb(h) for h in _scheme_hex_list]

        for role in ("primary", "secondary", "accent", "positive", "negative", "neutral"):
            if role in _scheme_info:
                COLOR_MAP[role.upper()] = _hex_to_rgb(_scheme_info[role])

        def _resolve(v):
            if isinstance(v, str):
                key = v.strip().upper()
                if key in COLOR_MAP:
                    return COLOR_MAP[key]
                s = v.strip()
                if s.startswith("#"):
                    hex_clean = s[1:]
                    if len(hex_clean) in (3, 6) and all(c in "0123456789abcdefABCDEF" for c in hex_clean):
                        if len(hex_clean) == 3:
                            hex_clean = "".join(c * 2 for c in hex_clean)
                        return _RGBColor(int(hex_clean[0:2], 16), int(hex_clean[2:4], 16), int(hex_clean[4:6], 16))
            if isinstance(v, list):
                return [_resolve(item) for item in v]
            if isinstance(v, dict):
                return {k: _resolve(val) for k, val in v.items()}
            return v

        def _ensure_rgb(v, fallback):
            if isinstance(v, _RGBColor):
                return v
            resolved = _resolve(v) if isinstance(v, str) else v
            return resolved if isinstance(resolved, _RGBColor) else fallback

        def _normalize_series(series_raw):
            result = []
            for idx, item in enumerate(series_raw):
                fb = _FALLBACK_COLORS[idx % len(_FALLBACK_COLORS)]
                if isinstance(item, str):
                    result.append((item, fb))
                elif isinstance(item, dict):
                    name = str(item.get("name", f"Series {idx+1}"))
                    color = _ensure_rgb(item.get("color", fb), fb)
                    result.append((name, color))
                elif isinstance(item, (list, tuple)) and len(item) >= 1:
                    name = str(item[0])
                    color = _ensure_rgb(item[1], fb) if len(item) > 1 else fb
                    result.append((name, color))
                else:
                    result.append((str(item), fb))
            return result

        def _normalize_cards(cards_raw):
            result = []
            letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            for idx, item in enumerate(cards_raw):
                fb_accent = _FALLBACK_COLORS[idx % len(_FALLBACK_COLORS)]
                from PPT.constants import BG_GRAY as _BG
                if isinstance(item, dict):
                    letter = str(item.get("letter", letters[idx % len(letters)]))
                    ctitle = str(item.get("card_title", item.get("title", f"Card {idx+1}")))
                    desc = item.get("description", item.get("desc", ""))
                    if isinstance(desc, list):
                        desc = "\n".join(str(d) for d in desc)
                    else:
                        desc = str(desc)
                    raw_accent = item.get("accent_color", item.get("accent", None))
                    raw_light = item.get("light_bg", item.get("light", None))
                    accent = _ensure_rgb(raw_accent, fb_accent) if raw_accent else fb_accent
                    light = _ensure_rgb(raw_light, _BG) if raw_light else _BG
                    result.append((letter, ctitle, desc, accent, light))
                elif isinstance(item, (list, tuple)):
                    lst = list(item)
                    while len(lst) < 3:
                        lst.append("")
                    letter, ctitle, desc = str(lst[0]), str(lst[1]), lst[2]
                    if isinstance(desc, list):
                        desc = "\n".join(str(d) for d in desc)
                    else:
                        desc = str(desc)
                    if len(lst) >= 5:
                        accent = _ensure_rgb(lst[3], fb_accent)
                        light = _ensure_rgb(lst[4], _BG)
                        result.append((letter, ctitle, desc, accent, light))
                    else:
                        result.append((letter, ctitle, desc))
                else:
                    result.append((str(idx + 1), str(item), ""))
            return result

        total = len(slides)
        # 解析模板路径：PPT 模块旁的 PPT_template/<scheme>.pptx
        _ppt_module_dir = os.path.join(_PROJ_ROOT, "Function", "Output", "PPT")
        _template_path = os.path.join(_ppt_module_dir, "PPT_template", f"{scheme}.pptx")
        template = _template_path if os.path.isfile(_template_path) else None
        eng = MckEngine(total_slides=total, template=template)
        failed_slides = []  # 降级幻灯片：(index, layout, error_msg)

        _SUPPORTED = {
            "cover", "toc", "section_divider", "closing",
            "big_number", "two_stat", "metric_cards", "data_table",
            "table_insight", "executive_summary", "two_column_text", "action_items",
            "donut", "grouped_bar", "stacked_bar", "timeline",
        }

        for i, spec in enumerate(slides, 1):
            layout = spec.get("layout", "")
            if layout not in _SUPPORTED:
                raise ValueError(
                    say(f"Slide {i} uses an unsupported layout '{layout}'. "
                        f"Supported layouts: {', '.join(sorted(_SUPPORTED))}",
                        f"第 {i} 张幻灯片使用了不支持的布局 '{layout}'。"
                        f"支持的布局：{', '.join(sorted(_SUPPORTED))}")
                )
            params = _resolve(spec.get("params", {}))
            if layout in ("grouped_bar", "stacked_bar") and "series" in params:
                params["series"] = _normalize_series(params["series"])
            if layout in ("grouped_bar", "stacked_bar") and "data" in params:
                cats_key = "categories" if layout == "grouped_bar" else "periods"
                cats = params.get(cats_key, [])
                ser = params.get("series", [])
                raw_data = params["data"]
                n_cats, n_ser = len(cats), len(ser)
                if raw_data and n_cats and n_ser:
                    if len(raw_data) == n_ser and (not raw_data or len(raw_data[0]) == n_cats) and n_ser != n_cats:
                        raw_data = list(map(list, zip(*raw_data)))
                    while len(raw_data) < n_cats:
                        raw_data.append([0] * n_ser)
                    for row_idx in range(len(raw_data)):
                        row = raw_data[row_idx]
                        if not isinstance(row, list):
                            raw_data[row_idx] = [0] * n_ser
                        else:
                            while len(row) < n_ser:
                                row.append(0)
                            raw_data[row_idx] = [float(v) if not isinstance(v, (int, float)) else v for v in row]
                    params["data"] = raw_data
            if layout == "metric_cards" and "cards" in params:
                params["cards"] = _normalize_cards(params["cards"])
            if layout == "table_insight" and "insights" not in params:
                params["insights"] = ["—"]
            if layout == "executive_summary":
                params.setdefault("headline", "")
                params.setdefault("items", [])
            if layout == "action_items" and "actions" not in params:
                params["actions"] = []
            if layout == "two_column_text" and "columns" not in params:
                params["columns"] = []
            method = getattr(eng, layout)
            try:
                method(**params)
            except Exception as exc:
                log.warning("[export] slide %d (%s) render failed: %s", i, layout, exc)
                # 降级为占位幻灯片，而不是中止整份 deck。
                # 用户拿到的是一份 15 页、其中 1 页标注失败的文档，
                # 而不是零产出 + 一条错误字符串。
                err_msg = str(exc)
                try:
                    eng.section_divider(
                        section_label=say(f"Slide {i}", f"第 {i} 页"),
                        title=say("Render failed", "渲染失败"),
                        subtitle=err_msg[:200],
                    )
                except Exception as ph_exc:
                    log.error("[export] placeholder slide also failed: %s", ph_exc)
                failed_slides.append((i, layout, err_msg))
            if on_slide_done is not None:
                try:
                    on_slide_done(i, total)
                except Exception:
                    pass

        safe_name = self._ppt_safe_name(title, filename)
        export_dir = self._get_export_dir()
        os.makedirs(export_dir, exist_ok=True)
        filepath = os.path.join(export_dir, safe_name)
        eng.save(filepath)
        return filepath, safe_name, failed_slides

    def _tool_generate_ppt(self, title: str, slides: list, filename: str = "") -> str:
        scheme = getattr(self, "ppt_color_scheme", "mckinsey")
        try:
            filepath, safe_name, failed_slides = self._render_ppt(
                title, slides, filename, scheme,
            )
        except ImportError as exc:
            return say(f"❌ {exc}\n\nRun: `pip install python-pptx lxml`", f"❌ {exc}\n\n运行：`pip install python-pptx lxml`")
        except (ValueError, RuntimeError) as exc:
            return f"❌ {exc}"
        except Exception as exc:
            log.warning("[export] PPT generation failed: %s", exc)
            return say(f"❌ PPT generation failed: {exc}", f"❌ PPT 生成失败：{exc}")

        self._register_export_artifact(Path(filepath), artifact_type="export")
        download_url = self._build_download_url(safe_name)
        warning = ""
        if failed_slides:
            failed_desc = ", ".join(
                say(f"slide {idx} ({layout})", f"第 {idx} 页({layout})") for idx, layout, _ in failed_slides
            )
            warning = say(
                f"\n\n⚠️ {len(failed_slides)} slide(s) failed to render "
                f"and were replaced with placeholders; please check manually: {failed_desc}",
                f"\n\n⚠️ 以下 {len(failed_slides)} 张幻灯片渲染失败，"
                f"已用占位页替代，请手动检查：{failed_desc}",
            )
        return say(
            f"✅ PowerPoint presentation generated with **{len(slides)}** slide(s).{warning}\n\n"
            f"[📥 Click to download {safe_name}]({download_url})",
            f"✅ PowerPoint 演示文稿已生成，共 **{len(slides)}** 张幻灯片。{warning}\n\n"
            f"[📥 点击下载 {safe_name}]({download_url})",
        )

    def _tool_generate_ppt_with_jobs(self, title: str, slides: list, filename: str = ""):
        """带 JobRunner 路由的 PPT 生成。幻灯片数超过
        PPT_JOB_SLIDES_THRESHOLD 的 deck 在 worker 线程上运行。

        线程安全（M4）：python-pptx 的 ``Presentation`` 不是线程安全的，
        因此 *整个* MckEngine 生命周期（实例化 → 渲染 → 保存 → 清理）都在
        worker 内完成。请求线程只深拷贝不可变的 slide 规格并解析 scheme 字符串；
        它绝不触碰引擎或模板 IO。
        """
        scheme = getattr(self, "ppt_color_scheme", "mckinsey")
        total = len(slides)
        should_job = (
            self._job_runner is not None and total > PPT_JOB_SLIDES_THRESHOLD
        )
        if not should_job:
            return self._tool_generate_ppt(title, slides, filename)

        # 给 worker 的不可变快照 —— 没有活对象跨线程。
        title_snapshot = str(title or say("Presentation", "演示文稿"))
        slides_snapshot = copy.deepcopy(slides)
        filename_snapshot = str(filename or "")
        scheme_snapshot = str(scheme)
        result_holder = {}

        def _worker(ctx):
            ctx.set_progress(5, say("Initializing PPT engine", "正在初始化 PPT 引擎"))
            ctx.check_canceled()
            ctx.set_progress(35, say("Rendering slides", "正在渲染幻灯片"))

            # 幻灯片粒度的进度回调：35% → 85% 区间，每渲染一张 tick 一次。
            # 也让 worker 能在幻灯片之间轮询取消，而不是每份 deck 一次。
            def _on_slide_done(i, total):
                pct = 35 + int(50 * i / total) if total else 35
                ctx.set_progress(pct, say(f"Rendered {i}/{total}", f"已渲染 {i}/{total} 张"))
                ctx.check_canceled()

            filepath, safe_name, failed_slides = self._render_ppt(
                title_snapshot, slides_snapshot, filename_snapshot, scheme_snapshot,
                on_slide_done=_on_slide_done,
            )
            ctx.set_progress(90, say("Publishing PPT file", "正在发布 PPT 文件"))
            self._register_export_artifact(Path(filepath), artifact_type="export")
            download_url = self._build_download_url(safe_name)
            warning = ""
            if failed_slides:
                failed_desc = ", ".join(
                    say(f"slide {idx} ({layout})", f"第 {idx} 页({layout})") for idx, layout, _ in failed_slides
                )
                warning = say(
                    f"\n\n⚠️ {len(failed_slides)} slide(s) failed to render "
                    f"and were replaced with placeholders; please check manually: {failed_desc}",
                    f"\n\n⚠️ 以下 {len(failed_slides)} 张幻灯片渲染失败，"
                    f"已用占位页替代，请手动检查：{failed_desc}",
                )
            result_holder["text"] = say(
                f"✅ PowerPoint presentation generated with "
                f"**{len(slides_snapshot)}** slide(s).{warning}\n\n"
                f"[📥 Click to download {safe_name}]({download_url})",
                f"✅ PowerPoint 演示文稿已生成，"
                f"共 **{len(slides_snapshot)}** 张幻灯片。{warning}\n\n"
                f"[📥 点击下载 {safe_name}]({download_url})",
            )
            ctx.set_progress(100, say("PPT generation complete", "PPT 生成完成"))
            return {
                "slides": len(slides_snapshot),
                "scheme": scheme_snapshot,
                "failed_slides": len(failed_slides),
            }

        job = yield from self._run_as_job(
            _worker,
            job_type="ppt_generation",
            label=f"{title_snapshot} · {total} slides",
        )
        if job.get("status") == "canceled":
            return say("PPT generation canceled.", "PPT 生成已取消。")
        if job.get("status") != "succeeded":
            return say(f"❌ PPT generation failed: {job.get('error') or 'background job failed'}",
                       f"❌ PPT 生成失败：{job.get('error') or 'background job failed'}")
        return result_holder.get("text", say("❌ PPT generation failed: background result unavailable.", "❌ PPT 生成失败：后台结果不可用。"))

    # ── 看板（Dashboard）────────────────────────────────────────────────────────

    def _tool_propose_dashboard_outline(self, name: str, widgets: list) -> dict:
        rows = [say("| # | Title | Chart type | Key fields |", "| # | 标题 | 图表类型 | 核心字段 |"), "|---|------|---------|---------|"]
        for i, w in enumerate(widgets, 1):
            title = w.get("title", say(f"Chart {i}", f"图表 {i}"))
            chart_type = w.get("chart_type", "Bar_Chart")
            fm = w.get("field_mapping", {})
            fields = ", ".join(f"{k}={v}" for k, v in fm.items()) if fm else "—"
            rows.append(f"| {i} | {title} | {chart_type} | {fields} |")
        markdown = say(f"**{name}** ({len(widgets)} widget(s))\n\n", f"**{name}**（共 {len(widgets)} 个组件）\n\n") + "\n".join(rows)
        return {"name": name, "widgets": widgets, "markdown": markdown}

    def _tool_generate_dashboard(
        self,
        name: str,
        widgets: list,
        color_scheme: str = "",
    ) -> str:
        color_scheme = color_scheme or getattr(self, "ppt_color_scheme", "mckinsey")
        try:
            from ..dashboard import build_dashboard
            data = build_dashboard(
                self.data_source,
                self._chart_store,
                session_id=self._session_id,
                workspace_id=self._workspace_id,
                name=name,
                widgets_spec=widgets,
                color_scheme=color_scheme,
                workspace_authorization=self._workspace_path_authorization(),
            )
        except Exception as exc:
            log.warning("[export] dashboard generation failed: %s", exc)
            return say(f"❌ Dashboard generation failed: {exc}", f"❌ 看板生成失败：{exc}")

        dashboard_id = data.get("dashboard_id", "")
        url = data.get("url", f"/dashboard/{dashboard_id}")
        sid = self._session_id
        if sid:
            url = f"{url}?sid={sid}"
        export_url = f"/api/dashboard/{dashboard_id}/export-html"
        return say(
            f"✅ Dashboard \"{name}\" generated with **{len(widgets)}** chart widget(s).\n\n"
            f"[📊 Open dashboard]({url})  [📥 Download HTML]({export_url})",
            f"✅ 看板「{name}」已生成，包含 **{len(widgets)}** 个图表组件。\n\n"
            f"[📊 打开看板]({url})  [📥 下载 HTML]({export_url})",
        )

    def _format_dashboard_result(self, name: str, widgets: list, data: dict) -> str:
        dashboard_id = data.get("dashboard_id", "")
        url = data.get("url", f"/dashboard/{dashboard_id}")
        sid = self._session_id
        if sid:
            url = f"{url}?sid={sid}"
        export_url = f"/api/dashboard/{dashboard_id}/export-html"
        return say(
            f"✅ Dashboard \"{name}\" generated with **{len(widgets)}** chart widget(s).\n\n"
            f"[📊 Open dashboard]({url})  [📥 Download HTML]({export_url})",
            f"✅ 看板「{name}」已生成，包含 **{len(widgets)}** 个图表组件。\n\n"
            f"[📊 打开看板]({url})  [📥 下载 HTML]({export_url})",
        )

    def _tool_generate_dashboard_with_jobs(
        self,
        name: str,
        widgets: list,
        color_scheme: str = "",
    ):
        color_scheme = color_scheme or getattr(self, "ppt_color_scheme", "mckinsey")
        try:
            from ..dashboard import (
                build_dashboard_from_prefetched_widgets,
                prefetch_dashboard_widget_data,
            )
            widget_inputs = prefetch_dashboard_widget_data(
                self.data_source,
                widgets,
                self._workspace_path_authorization(),
            )
        except Exception as exc:
            log.warning("[export] dashboard prefetch failed: %s", exc)
            return say(f"❌ Dashboard generation failed: {exc}", f"❌ 看板生成失败：{exc}")

        total_rows = 0
        for item in widget_inputs:
            df = item.get("df")
            if df is not None:
                try:
                    total_rows += len(df)
                except TypeError:
                    pass

        should_job = (
            self._job_runner is not None
            and (
                len(widgets) > DASHBOARD_JOB_WIDGET_THRESHOLD
                or total_rows >= DASHBOARD_JOB_ROW_THRESHOLD
            )
        )

        def _build(inputs):
            return build_dashboard_from_prefetched_widgets(
                self._chart_store,
                session_id=self._session_id,
                workspace_id=self._workspace_id,
                name=name,
                widget_inputs=inputs,
                color_scheme=color_scheme,
            )

        if not should_job:
            try:
                return self._format_dashboard_result(name, widgets, _build(widget_inputs))
            except Exception as exc:
                log.warning("[export] dashboard generation failed: %s", exc)
                return say(f"❌ Dashboard generation failed: {exc}", f"❌ 看板生成失败：{exc}")

        snapshot = []
        for item in widget_inputs:
            df = item.get("df")
            snapshot.append({
                "spec": copy.deepcopy(item.get("spec", {})),
                "df": df.copy(deep=True) if df is not None else None,
                "error": item.get("error"),
            })
        name_snapshot = str(name or say("Data Dashboard", "数据看板"))
        widgets_snapshot = copy.deepcopy(widgets)
        color_scheme_snapshot = str(color_scheme)
        result_holder = {}

        def _worker(ctx):
            ctx.set_progress(10, say("Preparing dashboard data", "正在整理看板数据"))
            ctx.check_canceled()
            ctx.set_progress(45, say("Rendering dashboard widgets", "正在渲染看板组件"))
            data = build_dashboard_from_prefetched_widgets(
                self._chart_store,
                session_id=self._session_id,
                workspace_id=self._workspace_id,
                name=name_snapshot,
                widget_inputs=snapshot,
                color_scheme=color_scheme_snapshot,
            )
            ctx.check_canceled()
            ctx.set_progress(90, say("Publishing dashboard", "正在发布看板"))
            result_holder["text"] = self._format_dashboard_result(
                name_snapshot, widgets_snapshot, data
            )
            ctx.set_progress(100, say("Dashboard generation complete", "看板生成完成"))
            return {
                "name": name_snapshot,
                "widgets": len(widgets_snapshot),
                "input_rows": total_rows,
            }

        job = yield from self._run_as_job(
            _worker,
            job_type="dashboard_generation",
            label=f"{name_snapshot} · {len(widgets_snapshot)} widgets",
        )
        if job.get("status") == "canceled":
            return say("Dashboard generation canceled.", "看板生成已取消。")
        if job.get("status") != "succeeded":
            return say(f"❌ Dashboard generation failed: {job.get('error') or 'background job failed'}",
                       f"❌ 看板生成失败：{job.get('error') or 'background job failed'}")
        return result_holder.get("text", say("❌ Dashboard generation failed: background result unavailable.", "❌ 看板生成失败：后台结果不可用。"))
