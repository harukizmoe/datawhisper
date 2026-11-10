"""TimesFM-3 analysis over an optional HTTP service, without local ML dependencies."""
from __future__ import annotations

import hashlib
import json
import time
import uuid

import numpy as np
import pandas as pd

from compute.i18n import say

ANALYSIS_ID = "Time_Series_TimesFM3"
# registry 每次调用都会重新加载模块，因此模块级 say 随请求语言取值
ANALYSIS_NAME = say("TimesFM-3 time-series forecast (local API / Docker)", "TimesFM-3 时序预测（本地 API / Docker）")
ANALYSIS_DESC = say("Single- or multi-series forecasting through the configured local prediction service; no model download by default. analysis_options specifies time_column, series_column, horizon.", "通过已配置的本地预测服务进行单/多商品预测；默认不下载模型。analysis_options 指定 time_column、series_column、horizon。")
REQUIRED_PARAMS = ["target_column", "analysis_options.time_column"]
OPTIONAL_PARAMS = ["analysis_options.series_column", "analysis_options.target_columns", "analysis_options.horizon",
                   "analysis_options.frequency", "analysis_options.backtest_steps", "analysis_options.make_positive"]
OUTPUT_TABLES = ["analysis_result", "analysis_breakdown", "analysis_run_info"]
ACCEPTS_ANALYSIS_OPTIONS = True


def _integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(say(f"{name} must be an integer within {low}–{high}", f"{name} 必须为 {low}–{high} 的整数"))
    return value


def _prepare(df, target_column, groupby_column, options):
    time_col = options.get("time_column") or groupby_column
    if not time_col:
        time_col = next((c for c in ("date", "ds", "dt", "日期") if c in df.columns), None)
    if not time_col or time_col not in df.columns:
        raise ValueError(say("Specify the date column via analysis_options.time_column", "请通过 analysis_options.time_column 指定日期列"))
    frame = df.copy(deep=True)
    frame[time_col] = pd.to_datetime(frame[time_col], errors="raise")
    if frame[time_col].isna().any():
        raise ValueError(say("Dates cannot be missing", "日期不能缺失"))
    wide = options.get("target_columns")
    series_col = options.get("series_column") or ("series_id" if "series_id" in frame.columns and not wide else None)
    if wide is not None:
        if not isinstance(wide, list) or not 1 <= len(wide) <= 8 or any(not isinstance(c, str) for c in wide) or len(set(wide)) != len(wide):
            raise ValueError(say("target_columns needs 1–8 unique column names", "target_columns 需要 1–8 个不重复列名"))
        if series_col:
            raise ValueError(say("Wide target columns and a long-table series column cannot be used together", "宽表目标列和长表分组列不能同时使用"))
        if time_col in wide or any(c not in frame.columns for c in wide):
            raise ValueError(say("Target columns do not exist or include the date column", "目标列不存在或包含日期列"))
        groups = [(name, frame[[time_col, name]].rename(columns={name: "__value"})) for name in wide]
    else:
        if target_column not in frame.columns:
            raise ValueError(say("Target column does not exist", "目标列不存在"))
        if series_col:
            if series_col not in frame.columns or frame[series_col].isna().any():
                raise ValueError(say("Series column does not exist or contains empty values", "分组列不存在或包含空值"))
            frame[series_col] = frame[series_col].map(str)
            groups = [(str(name), group[[time_col, target_column]].rename(columns={target_column: "__value"}))
                      for name, group in frame.groupby(series_col, sort=True)]
        else:
            groups = [(target_column, frame[[time_col, target_column]].rename(columns={target_column: "__value"}))]
    if not 1 <= len(groups) <= 8:
        raise ValueError(say("Each joint forecast needs 1–8 targets; group by store/category", "每次联合预测需要 1–8 个目标，请按门店/品类分组"))
    contexts, dates, names = [], None, []
    for name, group in groups:
        group = group.sort_values(time_col)
        if group[time_col].duplicated().any():
            raise ValueError(say(f"{name} has duplicate dates; specify an aggregation method first", f"{name} 存在重复日期，请先明确聚合方式"))
        index = pd.DatetimeIndex(group[time_col])
        if not 2 <= len(index) <= 2048:
            raise ValueError(say("Each target needs 2–2048 historical points", "每个目标需要 2–2048 个历史点"))
        if dates is not None and not dates.equals(index):
            raise ValueError(say("Joint forecast targets must share the same historical dates; zero-filling is not done automatically", "联合预测目标需要相同历史日期，不能自动补零"))
        values = pd.to_numeric(group["__value"], errors="raise").to_numpy(dtype=float)
        if not np.isfinite(values).all() or np.max(np.abs(values)) > 1e15:
            raise ValueError(say("Sales contain missing or invalid values; clean them first", "销量包含缺失或无效数值，请先清理"))
        contexts.append(values.tolist())
        names.append(name)
        dates = index
    freq = options.get("frequency") or (pd.infer_freq(dates) if len(dates) >= 3 else None)
    if not freq or not isinstance(freq, str):
        raise ValueError(say("Cannot confirm an evenly spaced frequency; specify frequency and check for missing dates", "无法确认等间隔频率，请指定 frequency 并检查缺失日期"))
    expected = pd.date_range(dates[0], periods=len(dates), freq=freq)
    if not dates.equals(expected):
        raise ValueError(say("Historical dates do not match the requested frequency", "历史日期与指定频率不一致"))
    return contexts, names, dates, freq


def run(df, target_column, groupby_column=None, n_deciles=10, analysis_options=None, progress_callback=None, **kwargs):
    from infrastructure.paths import is_cloud_managed_runtime
    if is_cloud_managed_runtime():
        raise ValueError(say("Local prediction is only available for local or desktop runs", "本地预测仅适用于本地或桌面运行"))
    from infrastructure.forecast_client import ForecastClient
    opts = dict(analysis_options or {})
    allowed = {"time_column", "series_column", "target_columns", "horizon", "frequency", "backtest_steps",
               "make_positive", "use_symmetric_averaging", "language", "unit"}
    if set(opts) - allowed:
        raise ValueError(say("Unsupported forecast options: ", "包含不支持的预测选项: ") + ", ".join(sorted(set(opts) - allowed)))
    progress = progress_callback or (lambda *_: None)
    progress(3, say("Validating series and dates", "校验预测数据与日期"))
    horizon = _integer(opts.get("horizon", 7), "horizon", 1, 256)
    holdout = _integer(opts.get("backtest_steps", 0), "backtest_steps", 0, 256)
    for key in ("make_positive", "use_symmetric_averaging"):
        if key in opts and not isinstance(opts[key], bool):
            raise ValueError(say(f"{key} must be boolean", f"{key} 必须为布尔值"))
    contexts, names, dates, freq = _prepare(df, target_column, groupby_column, opts)
    if holdout and len(dates) - holdout < 7:
        raise ValueError(say("Backtesting needs at least 7 earlier context points", "回测需保留至少 7 个历史点"))
    snapshot = {"dates": [d.isoformat() for d in dates], "names": names, "context": contexts}
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True, allow_nan=False).encode()).hexdigest()
    run_id = uuid.uuid4().hex
    client = ForecastClient()
    health = client.health()
    predict_opts = {"make_positive": opts.get("make_positive", True),
                    "use_symmetric_averaging": opts.get("use_symmetric_averaging", False)}
    metrics = []
    started = time.perf_counter()
    if holdout:
        progress(15, say("Evaluating a historical holdout", "使用历史截断点进行留出回测"))
        past = [series[:-holdout] for series in contexts]
        validation = client.predict(past, holdout, names, request_id=run_id + "-validation", **predict_opts)
        for k, name in enumerate(names):
            actual = np.asarray(contexts[k][-holdout:])
            predictions = {"timesfm3": validation["forecast"][k],
                           "recent7_mean": [float(np.mean(past[k][-7:]))] * holdout,
                           "seasonal_naive": [past[k][-7 + (j % 7)] for j in range(holdout)]}
            for method, pred in predictions.items():
                error = np.asarray(pred) - actual
                q = np.asarray(validation["quantiles"][k]) if method == "timesfm3" else None
                metrics.append({"series_id": name, "method": method, "MAE": float(np.abs(error).mean()),
                    "RMSE": float(np.sqrt((error ** 2).mean())),
                    "WAPE_pct": float(np.abs(error).sum() / np.abs(actual).sum() * 100) if np.abs(actual).sum() else None,
                    "coverage_pct": float(((q[:, 0] <= actual) & (actual <= q[:, 8])).mean() * 100) if q is not None else None,
                    "evaluated_points": holdout, "run_id": run_id})
    progress(50, say("Calling the configured TimesFM service", "调用已配置的 TimesFM 预测服务"))
    output = client.predict(contexts, horizon, names, request_id=run_id, **predict_opts)
    progress(90, say("Preparing forecast tables and quantiles", "整理预测结果与分位数"))
    future = pd.date_range(dates[-1], periods=horizon + 1, freq=freq)[1:]
    rows = []
    for k, name in enumerate(names):
        for ds, actual in zip(dates, contexts[k]):
            rows.append({"series_id": name, "ds": ds, "y_actual": actual, "y_pred": None,
                         "segment": "history", **{f"q{i}": None for i in range(10, 100, 10)}})
        for j, ds in enumerate(future):
            rows.append({"series_id": name, "ds": ds, "y_actual": None, "y_pred": output["forecast"][k][j],
                         "segment": "forecast", **{f"q{i*10}": output["quantiles"][k][j][i-1] for i in range(1, 10)}})
    result = pd.DataFrame(rows)
    result["run_id"] = run_id
    result["input_sha256"] = fingerprint
    revision = output.get("model_revision") or health.get("model_revision") or "not_reported_by_service"
    metadata = pd.DataFrame([{"run_id": run_id, "model": output["model"], "model_revision": revision,
        "input_sha256": fingerprint, "device": output.get("device", health.get("device", "unknown")),
        "targets": len(names), "context_points": len(dates), "horizon": horizon, "frequency": freq,
        "last_observed_at": dates[-1].isoformat(), "elapsed_seconds": time.perf_counter() - started,
        "server_inference_seconds": output.get("elapsed_seconds"), "backtest_steps": holdout,
        "evaluation_status": "historical_holdout" if holdout else "not_evaluated",
        "unit": opts.get("unit", "source_units"), "license": "research_only"}])
    breakdown = pd.DataFrame(metrics, columns=["series_id", "method", "MAE", "RMSE", "WAPE_pct", "coverage_pct", "evaluated_points", "run_id"])
    markdown = "\n".join([
        say("### TimesFM-3 forecast completed", "### TimesFM-3 预测完成"),
        say(f"{len(names)} targets, {len(dates)} historical points, {horizon} forecast steps.", f"{len(names)} 个目标，{len(dates)} 个历史点，预测 {horizon} 步。"),
        f"Run: `{run_id}` · Device: `{metadata.iloc[0]['device']}`",
        say("Tables: `analysis_result`, `analysis_breakdown`, `analysis_run_info`.", "结果：`analysis_result`；回测：`analysis_breakdown`；来源与耗时：`analysis_run_info`。"),
        say("Chart: ds on the x-axis, y_actual/y_pred on the y-axis, grouped by series_id.", "图表建议：以 ds 为横轴、y_actual 与 y_pred 为纵轴，按 series_id 分组。"),
        say("Historical holdout compares TimesFM with recent-mean and seasonal baselines; no automatic winner selection." if holdout else "No holdout requested; forecast accuracy has not been evaluated.", "已使用历史留出数据比较 TimesFM、近期均值与同期基线；不以该窗口自动选择最优方法。" if holdout else "未提供回测窗口，尚未评估准确率。"),
        say("Values retain source units; forecasts are not order quantities. Model is for non-commercial, non-production research.", "数值保持来源单位；预测不直接等于补货量。模型仅用于非商业、非生产研究。"),
    ])
    progress(98, say("Forecast computation completed", "预测计算完成"))
    return result, breakdown, metadata, markdown
