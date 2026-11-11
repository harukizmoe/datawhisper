"""图表注册表（chart_selector._CHARTS）的英文文案。

_CHARTS 保留中文原文（同时作为关键词匹配的语料）；界面语言为英文时，`localize` 按
chart_id 把 name / category / desc / data_format / constraints 换成这里的英文。
"""

from __future__ import annotations

from typing import Any, Dict

CATEGORY_EN: Dict[str, str] = {
    "对比类 COMPARING": "COMPARING",
    "时间趋势类 TIME": "TIME",
    "分布类 DISTRIBUTION": "DISTRIBUTION",
    "地理类 GEOSPATIAL": "GEOSPATIAL",
    "关系类 RELATIONSHIP": "RELATIONSHIP",
    "占比图 PART-TO-WHOLE": "PART-TO-WHOLE",
}

# chart_id -> {name, desc, data_format, constraints}
CHARTS_EN: Dict[str, Dict[str, str]] = {
    "Marimekko_ABS": dict(
        name="Marimekko (absolute)",
        desc="Column width encodes the share of the first dimension; height inside a column encodes the absolute value of the second dimension. Good for comparing the size and internal composition of different brands.",
        data_format="x column (brand) + y column (sales) + group column (product category)",
        constraints="Two-dimension shares; height inside a column is an absolute value",
    ),
    "Marimekko_PCT": dict(
        name="Marimekko (percent)",
        desc="Column width encodes the share of the first dimension; height inside a column encodes the share of the second dimension. Good for showing relative composition.",
        data_format="x column (brand) + y column (sales) + group column (product category)",
        constraints="Two-dimension shares; height inside a column is a percentage",
    ),
    "Bar_Chart": dict(
        name="Bar chart",
        desc="Encodes values as rectangle height; the most common comparison chart",
        data_format="x column (category) + y column (value)",
        constraints="Value column >= 0; y axis starts at zero",
    ),
    "Grouped_Bar_Chart": dict(
        name="Grouped bar chart",
        desc=(
            "Several groups per category shown side by side for easy comparison. Two data formats are supported: "
            "(1) long format (x column + group column + value column); (2) wide format (x column + several value columns, converted automatically). "
            "In wide format, to compare several metric columns pass value_cols=[\"colA\",\"colB\",...] in field_mapping to name the columns explicitly "
            "(this excludes unrelated numeric columns such as sample counts); y and series can then be omitted. To compare a single metric, pass x and y as usual."
        ),
        data_format="Long: x column (category) + series column (group) + y column (value) | Wide: x column (category) + several value columns (column names become the groups)",
        constraints="At most 8 groups; when comparing several metrics in wide format, use value_cols to exclude columns with a different scale (e.g. sample counts)",
    ),
    "Stacked_Bar_Chart": dict(
        name="Stacked bar chart",
        desc="Stacked segments showing the part-to-whole relationship. Supports long and wide formats.",
        data_format="Long: x column + series column + y column | Wide: x column + several value columns (via y=[...] or value_cols=[...])",
        constraints="Values >= 0",
    ),
    "Diverging_Bar_Chart": dict(
        name="Diverging bar chart",
        desc="Positive/negative comparison; supports positive and negative values",
        data_format="Label + positive/negative value",
        constraints="Supports positive and negative values",
    ),
    "Dot_Plot": dict(
        name="Dot plot",
        desc="Uses dots and connecting lines to show the range and change between two data points across categories; clean and suited to comparing differences over many categories.",
        data_format="Category column (Y axis) + start column (X axis) + end column (X axis)",
        constraints="10-50 categories recommended (more than 50 triggers a warning); rows with an empty start or end are dropped automatically; shows only two time points, not the fluctuation in between",
    ),
    "Waffle": dict(
        name="Waffle chart",
        desc="Shares shown on a 10x10 grid where each cell is one percentage point; good for talks and presentations",
        data_format="Category (category) + value (value)",
        constraints="Value >= 0; normalized internally so the total is 100",
    ),
    "Bullet_Chart": dict(
        name="Bullet chart",
        desc="Target attainment display; compares KPI completion",
        data_format="Category + actual value + target value + optional ranges",
        constraints="KPI display",
    ),
    "Sankey_Chart": dict(
        name="Sankey chart",
        desc="Shows flow direction and volume; good for presenting processes",
        data_format="Source + target + flow",
        constraints="Suited to process display",
    ),
    "Heatmap": dict(
        name="Heatmap",
        desc="Shows value magnitude through color intensity; good for multi-dimensional matrices and correlation analysis",
        data_format="x column + y column + value column",
        constraints="Supports a large number of data points",
    ),
    "Waterfall": dict(
        name="Waterfall chart",
        desc="Shows the cumulative change from a start to an end point; good for analyzing the contribution of each increase or decrease",
        data_format="x column (stage) + y column (value; first row is the starting value, middle rows are increments/decrements, the last row may be a total) [+ type column (optional: absolute/relative/total)]",
        constraints="Supports positive and negative values; at least 2 rows; by default the first row is absolute, the last is total, and the rest are relative",
    ),
    "Line_Chart": dict(
        name="Line chart",
        desc="Shows how data changes over time or another continuous variable",
        data_format="x column (time/continuous) + y column (value)",
        constraints="Suited to time series",
    ),
    "Circular_Line_Chart": dict(
        name="Circular line chart",
        desc="Shows the trend of periodic data in polar coordinates; the time axis is mapped onto a circle so the start and end of a period connect, emphasizing the cyclical nature. Good for seasonal and daily-cycle scenarios.",
        data_format="Wide format: the first column holds period labels (e.g. month, week); the other columns are value columns (one line per column)",
        constraints="Suited to periodic time series (>= 3 periods, 12-52 recommended); 2-5 lines recommended; data must be complete; not suited to precise value comparison",
    ),
    "Slope_Chart": dict(
        name="Slope chart",
        desc="Shows the magnitude and direction of change between two time points via line slope; green marks growth and red marks decline; entities are sorted by change magnitude automatically",
        data_format="group column (entity name) + start column (starting value) + end column (ending value)",
        constraints="At most 30 entities; compares two time points only",
    ),
    "Sparkline": dict(
        name="Sparkline",
        desc="A minimal trend line designed for embedding in tables. Generates a compact trend chart per row and uses color to convey the overall trend direction at a glance",
        data_format="x column (time) + y column (value)",
        constraints="Saves space; good for multi-metric trend summary tables",
    ),
    "Bump_Chart": dict(
        name="Bump chart",
        desc="Shows how the rankings of several entities change over time. Presents relative rank rather than absolute values; good for spotting dark horses and laggards.",
        data_format="x column (time) + y column (rank/score) + group column (entity name)",
        constraints="At most 15 entities (detected automatically); supports highlighting",
    ),
    "Cycle_Chart": dict(
        name="Cycle chart",
        desc="Shows periodic patterns. Supports wide format (first column is the period, e.g. year; the other columns are phases, e.g. month/category) and long format (time + value + group); multiple cycle lines and a mean reference line are detected and drawn automatically.",
        data_format="Wide: period column + several phase columns; or long: time column + value column + group column (optional)",
        constraints="At least one time/period field and one numeric field; in wide format the first column should be parseable as a year/time; the remaining columns must be numeric",
    ),
    "Area_Chart": dict(
        name="Area chart",
        desc="A filled version of the line chart; good for showing time-series trends and overall magnitude",
        data_format="x column (time) + y column (value)",
        constraints="Suited to time series",
    ),
    "Stacked_Area_Chart": dict(
        name="Stacked area chart",
        desc=(
            "Shows the cumulative contribution of several series over time with filled areas; good for observing the overall trend and changes in each component's share. "
            "Two input forms are supported: "
            "1) wide format: x column + several value columns; "
            "2) long format: x column + a single value column + series group column."
        ),
        data_format="Wide: x column (time/category) + several y columns (value columns); long: x column (time/category) + a single y column (value) + series column (group)",
        constraints=(
            "Suited to continuous time series; the x axis must be sortable with >= 3 data points; "
            "in wide format use 2-5 y columns; "
            "in long format use exactly one y column and 2-5 series groups; "
            "each (x, series) combination must be unique, aggregate first if there are duplicates; "
            "missing (x, series) combinations should be filled with 0; "
            "not suitable for stacks containing negative values by default."
        ),
    ),
    "Horizon_Chart": dict(
        name="Horizon chart",
        desc="A compact trend chart that layers a time series by magnitude and folds the bands on top of each other; good for comparing many series in limited space",
        data_format="x column (time/order) + y column (value; a single column or several; optional series grouping)",
        constraints="Needs an ordered x axis; y must be numeric; more bands give more detail but make it harder to read",
    ),
    "Connected_Scatter": dict(
        name="Connected scatter plot",
        desc="A scatter plot whose points are joined by line segments to show evolution or a trajectory. Good for ordered paths, time series, or causal relationships.",
        data_format="x column (value) + y column (value) + optional size column (marker size)",
        constraints="Supports automatic ordering",
    ),
    "Histogram_Pareto_chart": dict(
        name="Histogram and Pareto chart",
        desc="Shows value distributions; supports a frequency histogram (one value column) and a Pareto chart (two columns: category + value)",
        data_format="One value column (frequency distribution) | two columns (category + value, Pareto chart)",
        constraints="The mode is chosen automatically from the column count; >= 30 data points recommended for a frequency distribution; a Pareto chart sorts values in descending order automatically, with cumulative percentage 0-100%",
    ),
    "Pyramid_Chart": dict(
        name="Pyramid chart",
        desc="Symmetrically compares the distribution of two groups across categories to reveal overall structure quickly (e.g. population by age and sex)",
        data_format="Label column + left value column + right value column",
        constraints="Left values are shown as negatives automatically and right values as positives; labels should be in ascending order; adjacent items are merged when there are too many categories (>30); the legend is placed at the bottom",
    ),
    "Error_Bar_Chart": dict(
        name="Error bar chart",
        desc="Shows the median and interquartile range (Q25-Q75) of grouped data to compare the distribution and variability of each group",
        data_format="Label column + value column (raw data; the system groups and computes the statistics)",
        constraints="The system groups by label and computes Q25/Q50/Q75; error bars show the interquartile range; >= 10 data points per group recommended; hover shows the median, Q25, Q75 and sample count",
    ),
    "Box-and-Whisker_Plot": dict(
        name="Box plot",
        desc="Shows quartiles and outliers; good for comparing the distributions of several groups",
        data_format="Value column + optional group column",
        constraints="Suited to comparing distributions",
    ),
    "Violin_Chart": dict(
        name="Violin plot",
        desc="Combines a box plot with kernel density estimation to show the shape of a distribution (e.g. bimodal, skewed); suited to comparing several groups",
        data_format="Value column (y) + optional category column (x); wide-format data is converted automatically (first column is the group, the rest are values)",
        constraints="At least 10 data points per group recommended, and >= 20 in total",
    ),
    "Ridgeline_Plot": dict(
        name="Ridgeline plot",
        desc="Shows the distribution shape of several groups, compared through overlapping density curves",
        data_format="group column (category/group name) + value column (value/distribution value), or wide format: the first column holds group labels and the remaining columns hold the sample values",
        constraints="At least 5 data points per group, 3-15 groups recommended, and >= 20 data points in total",
    ),
    "Beeswarm_Plot": dict(
        name="Beeswarm plot",
        desc="Uses jitter to avoid overlapping points and shows the density and clustering of individual data points; supports group comparison",
        data_format="Value column + optional group column (wide format is converted automatically: first column is the group, the rest are values)",
        constraints="Data size >= 20, 10-200 points per group recommended, total points should not exceed 500-1000",
    ),
    "Dot_Density_Map": dict(
        name="Dot density map",
        desc="Uses the number and density of dots to show the distribution of absolute values; each dot represents a fixed unit, and denser dots mean a larger total",
        data_format="label + value + (optional category)",
        constraints="Place names must match the built-in pyecharts library of Chinese cities/districts (3700+); value must be an absolute number; data is in long format (one place/group combination per row)",
    ),
    "Choropleth_Map": dict(
        name="Choropleth map",
        desc="Uses the depth of region fill color to show the distribution of relative values; darker means larger; good for normalized metrics such as density and rates",
        data_format="Region + relative value (density, rate, percentage, etc.)",
        constraints="Place names must match the built-in pyecharts library of Chinese cities/districts (3700+); value must be a relative number (not an absolute total); data is in long format (one region per row)",
    ),
    "Scatter_Plot": dict(
        name="Scatter plot",
        desc="Shows the relationship between two numeric variables and detects positive, negative or no correlation. size can encode a third (numeric) dimension and color can distinguish groups.",
        data_format="x (numeric), y (numeric), size (numeric, optional), color (text/numeric, optional)",
        constraints="x and y must be numeric columns with at least two valid data points. Missing values are dropped automatically; for many overlapping points use transparency or a hexbin heatmap.",
    ),
    "Bubble_Plot": dict(
        name="Bubble chart",
        desc="Shows data through four linked dimensions: bubble x/y position, size and color. Good for multi-dimensional relationship analysis, clustering and quadrant strategy positioning. Pass x_mid/y_mid values in options to overlay quadrant dividers (note: they are coordinate values and go in options, not field_mapping) for matrix-style strategy analysis",
        data_format="x column (numeric) + y column (numeric) + [size column (numeric)] + [color column (category)]",
        constraints=(
            "x/y must be continuous numeric, not category columns; if size is not given, a medium 40px size is used; "
            "if color is not given, a single default color is used; color prefers a category column, and a numeric column is colored by magnitude; "
            "x_mid/y_mid are optional quadrant dividers, drawn only when passed explicitly; "
            "when the x range is within 0-1, axis labels are multiplied by 100 and shown as percentages; "
            "5-30 bubbles recommended; with too many, slight random jitter is added automatically to reduce overlap"
        ),
    ),
    "Chord_Diagram": dict(
        name="Chord diagram",
        desc="Shows the strength of multi-directional relationships among several entities; nodes sit on a circle and arc thickness encodes relationship strength",
        data_format="Edge list (source, target, value) or adjacency matrix",
        constraints="5-15 nodes recommended; relationship values must be positive; an adjacency matrix must be complete with a zero diagonal",
    ),
    "Arc_Chart": dict(
        name="Arc diagram",
        desc="Shows paths as arcs; data labels show the outflow value on the semicircle",
        data_format="Outflow x + inflow y + outflow value Z",
        constraints="Relationship chart",
    ),
    "Network_Diagram": dict(
        name="Network diagram",
        desc="Shows nodes and their connections; good for network analysis",
        data_format="Source + target + optional weight",
        constraints="Suited to network analysis",
    ),
    "Parallel_Coordinates_Plot": dict(
        name="Parallel coordinates plot",
        desc="Uses several vertical axes for different variables; each line connects its points on every axis to show relationships among many variables. Supports normalized axes and independent-range axes.",
        data_format="Several numeric columns (dimensions) + optional group column (color)",
        constraints="3-6 dimensions; 10-100 data rows; all dimension columns must be convertible to numeric",
    ),
    "Treemap": dict(
        name="Treemap",
        desc="Uses rectangle area for share and supports multi-level nesting. Good for hierarchical categorical data with many items, and saves more space than a bar chart.",
        data_format="Optional parents column (parent) + labels column (category name) + values column (value)",
        constraints="Values must be > 0; at most 200 rows recommended; supports multi-level nesting",
    ),
    "Sunburst_Diagram": dict(
        name="Sunburst chart",
        desc="Multi-level share display; a circular layered structure shows the part-to-whole relationship",
        data_format="Label + value (+ optional parent label)",
        constraints="Supports multiple levels; values in the parents column must exist in the labels column; values must be positive; at most 3 levels and 200 rows recommended",
    ),
    "Nightingale_Chart": dict(
        name="Nightingale rose chart",
        desc="A polar sector-area chart that encodes value by sector area. Good for periodic data (e.g. 12 months, 4 quarters) or the shares of categorical data, with strong visual impact.",
        data_format="names column (category/month) + values column (value >= 0)",
        constraints="At most 12 categories; values >= 0; negatives not supported; 4-12 data points recommended; sector area = value",
    ),
    "Pie_Chart": dict(
        name="Pie chart",
        desc="Shows each part's share of the whole",
        data_format="Label column + value column",
        constraints="At most 8 categories, total = 100%",
    ),
}


def localize(chart: Dict[str, Any]) -> Dict[str, Any]:
    """返回把展示字段换成英文后的浅拷贝；没有英文条目的 chart_id 原样保留。"""
    out = dict(chart)
    out["category"] = CATEGORY_EN.get(chart["category"], chart["category"])
    out.update(CHARTS_EN.get(chart["chart_id"], {}))
    return out
