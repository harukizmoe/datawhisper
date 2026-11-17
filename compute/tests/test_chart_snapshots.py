# -*- coding: utf-8 -*-
"""代表性图表的输出快照：5 个模板各钉一份完整 HTML，模板漂移时立刻可见。

为什么不用像素截图：容器里没有浏览器与稳定的字体栈，像素比对在不同机器/发行版上会漂；
这里钉住的是“渲染出来的那一份文档”——轴标题、颜色、序列配置、标签与数据都在里面，
模板改动、库升级导致的输出变化都能拦下。

更新快照：``UPDATE_CHART_GOLDEN=1 python -m unittest compute.tests.test_chart_snapshots``
（只在确认变化是有意的时候跑，并在提交信息里说明原因）。
"""
from __future__ import annotations

import os
import re
import unittest
from pathlib import Path

from compute.chart_selector import _CHART_INDEX
from compute.tests.test_chart_templates import build_frame
from chart_generate import generate_chart

GOLDEN = Path(__file__).resolve().parent / "golden" / "charts"
# 柱/折线/热力/桑基/饼：分别代表直角坐标、时间轴、矩阵、关系图与占比图。
SNAPSHOTS = ("Bar_Chart", "Line_Chart", "Heatmap", "Sankey_Chart", "Pie_Chart")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def render(chart_id: str) -> str:
    chart = _CHART_INDEX[chart_id]
    roles = list(dict.fromkeys(chart["required_roles"]))
    frame, mapping = build_frame(chart_id, roles)
    result = generate_chart(df=frame, chart_type=chart_id, mapping=mapping, options={})
    if not result.get("success"):
        raise AssertionError(f"{chart_id} failed to render: {result.get('error') or result.get('warnings')}")
    # 每个模板会给根节点一个随机 uuid；它是唯一不稳定项，替换成占位符。
    return UUID_RE.sub("{uuid}", result["html"])


class ChartSnapshots(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 文案语言必须是确定的：同一份模板在不同语言下轴标题不同。
        from compute.i18n import language, set_language
        cls.previous = language()
        set_language("en")

    @classmethod
    def tearDownClass(cls):
        from compute.i18n import set_language
        set_language(cls.previous)

    def test_representative_charts_match_their_snapshots(self):
        update = os.environ.get("UPDATE_CHART_GOLDEN") == "1"
        GOLDEN.mkdir(parents=True, exist_ok=True)
        for chart_id in SNAPSHOTS:
            with self.subTest(chart=chart_id):
                html = render(chart_id)
                path = GOLDEN / f"{chart_id}.html"
                if update or not path.exists():
                    path.write_text(html, encoding="utf-8")
                    continue
                want = path.read_text(encoding="utf-8")
                if html == want:
                    continue
                want_lines, got_lines = want.splitlines(), html.splitlines()
                for index, (old, new) in enumerate(zip(want_lines, got_lines), 1):
                    if old != new:
                        self.fail(
                            f"{chart_id}: line {index} changed\n- {old[:200]}\n+ {new[:200]}\n"
                            f"如果是有意修改，运行 UPDATE_CHART_GOLDEN=1 python -m unittest compute.tests.test_chart_snapshots"
                        )
                self.fail(f"{chart_id}: length changed ({len(want_lines)} -> {len(got_lines)} lines)")


if __name__ == "__main__":
    unittest.main()
