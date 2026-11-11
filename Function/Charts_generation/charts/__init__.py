# charts/__init__.py
"""
Chart_generate - 统一图表生成框架

图表元数据注册中心在 compute/chart_selector.py（_CHARTS）。
本包只保留图表实现层的公共接口（ChartResult / FieldMapping）。
"""
from .base import ChartResult, FieldMapping

__all__ = ["ChartResult", "FieldMapping"]
