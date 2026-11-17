# -*- coding: utf-8 -*-
"""所有图表模板的结构化渲染门：每个 ``chart_id`` 用一份合成数据跑一遍 ``generate_chart``。

只断言结构与数据到达情况（成功、非空 HTML、库已注入、至少一个数据标记出现在输出里），
不比较像素或具体文案：视觉差异交给截图回归，行为差异交给单测。
图表清单以 ``compute.chart_selector._CHARTS`` 为唯一事实源；新增模板会自动被这个用例覆盖。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "Function" / "Charts_generation"))

from chart_generate import generate_chart  # noqa: E402
from compute.chart_selector import _CHARTS  # noqa: E402

NUMERIC_ROLES = {
    "y", "value", "start", "end", "actual", "target", "left_value", "right_value",
    "z", "size", "low", "medium", "high", "weight", "values",
}
LIST_ROLES = {"dimensions", "value_cols"}
# 这些图的 x/y 是连续数值；其余按「x 分类 + y 数值」构造，别让类别轴拿到浮点数。
NUMERIC_XY = {"Scatter_Plot", "Connected_Scatter", "Bubble_Plot", "Sparkline", "Arc_Chart"}
# 这三个图里的 source/target 是节点名，不是数值；Bullet 的 actual/target 才是数值。
SOURCE_TARGET_CHARTS = {"Sankey_Chart", "Chord_Diagram", "Network_Diagram"}
# 时间轴类图表：给真实日期，否则解析失败会静默拿到空序列，结构门就形同虚设。
DATE_X_CHARTS = {"Cycle_Chart", "Horizon_Chart", "Line_Chart", "Area_Chart", "Circular_Line_Chart", "Sparkline"}
DATE_VALUES = [f"2026-01-{day:02d}" for day in range(1, 13)]
NODE_LABELS = [f"node_{name}" for name in "abcdefghijkl"]
# 地图类图表只认真实地区名；其余图表用可搜索的假标签。
MAP_LABELS = ["北京", "上海", "广州", "深圳"]
CATEGORY_LABELS = ["zz_alpha", "zz_beta", "zz_gamma", "zz_delta"]
ROWS = 12
NUMERIC_SENTINEL = 4242.0
LIBRARY_MARKERS = ("plotly", "Plotly", "echarts", "d3")


def build_frame(chart_id: str, roles: list[str]) -> tuple[pd.DataFrame, dict]:
    """按角色造列并给出完整 mapping：每列名就是角色名，文本列带可搜索的标记。"""
    data: dict[str, list] = {}
    mapping: dict = {}
    if chart_id == "Stacked_Area_Chart":
        # 宽格式路径：mapping.y 给两列数值，否则模板会要求「至少 2 个 y 列」。
        for index in (1, 2):
            data[f"y{index}"] = [NUMERIC_SENTINEL + index * 10 + row for row in range(ROWS)]
        data["x_date"] = DATE_VALUES
        return pd.DataFrame(data), {"x": "x_date", "y": ["y1", "y2"]}
    for role in roles:
        if role in LIST_ROLES:
            cols = [f"{role}_{i}" for i in range(1, 4)]
            for index, col in enumerate(cols):
                data[col] = [float(index + 1) * 10 + row for row in range(ROWS)]
            mapping[role] = cols
            continue
        if role in {"source", "target"} and chart_id in SOURCE_TARGET_CHARTS:
            column = f"{role}_node"
            mapping[role] = column
            offset = 0 if role == "source" else 1
            data[column] = [NODE_LABELS[(row + offset) % len(NODE_LABELS)] for row in range(ROWS)]
        elif role in NUMERIC_ROLES:
            column = f"{role}_metric"
            mapping[role] = column
            data[column] = [NUMERIC_SENTINEL + row for row in range(ROWS)]
        elif role in {"x", "time"} and chart_id in DATE_X_CHARTS:
            column = f"{role}_date"
            mapping[role] = column
            data[column] = DATE_VALUES
        elif role == "x" and chart_id in NUMERIC_XY:
            column = "x_metric"
            mapping[role] = column
            data[column] = [float(row) for row in range(ROWS)]
        elif role == "y" and chart_id in NUMERIC_XY:
            column = "y_metric"
            mapping[role] = column
            data[column] = [float(row * 2 + 1) for row in range(ROWS)]
        elif chart_id == "Dot_Density_Map" and role == "label":
            mapping[role] = role
            data[role] = [MAP_LABELS[row % len(MAP_LABELS)] for row in range(ROWS)]
        else:
            mapping[role] = role
            data[role] = [CATEGORY_LABELS[row % len(CATEGORY_LABELS)] for row in range(ROWS)]
    return pd.DataFrame(data), mapping


class AllChartTemplatesRender(unittest.TestCase):
    def test_every_chart_renders_with_its_declared_roles(self):
        self.assertEqual(len(_CHARTS) >= 40, True, "chart registry shrank unexpectedly")
        failures: list[str] = []
        for chart in _CHARTS:
            chart_id = chart["chart_id"]
            # 只给必填角色：可选角色各模板语义不同（weight/color/city…），给了反而可能走错分支。
            roles = list(dict.fromkeys(chart["required_roles"]))
            frame, mapping = build_frame(chart_id, roles)
            with self.subTest(chart=chart_id):
                result = generate_chart(df=frame, chart_type=chart_id, mapping=mapping, options={})
                if "error" in result or not result.get("success"):
                    failures.append(f"{chart_id}: {result.get('error') or result.get('warnings')}")
                    continue
                html = result.get("html") or ""
                problems: list[str] = []
                if len(html) <= 500:
                    problems.append(f"html too short ({len(html)})")
                if not any(marker in html for marker in LIBRARY_MARKERS):
                    problems.append("no chart library injected")
                markers = CATEGORY_LABELS + NODE_LABELS + ["_metric", "dimensions_", "_date", "2026", "4242", "4,242"]
                if not any(token in html for token in markers):
                    problems.append("data markers missing from output")
                if problems:
                    failures.append(f"{chart_id}: {'; '.join(problems)}")
        self.assertEqual(failures, [], "\n" + "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
