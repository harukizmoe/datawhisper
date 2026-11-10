"""Lightweight TimesFM HTTP adapter; no torch/hub imports or network on import."""
from __future__ import annotations

import json
import math
import socket
import urllib.error
import urllib.request

from compute.i18n import say
from data.forecast_config import load_config, validate_url

MODEL_ID = "google/timesfm-3.0-pytorch"
QUANTILES = [i / 10 for i in range(1, 10)]


class ForecastError(RuntimeError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ForecastClient:
    def __init__(self, config: dict | None = None, *, require_enabled=True, token=None):
        self.config = dict(config if config is not None else load_config())
        self.token = token
        if require_enabled and not self.config.get("enabled"):
            raise ForecastError(say("Forecast service is disabled; select a forecast service in Settings → Local services", "预测服务尚未启用，请在设置→本地服务中选择用于预测的服务"))
        self.base_url = validate_url(self.config.get("base_url", ""), self.config.get("mode", "api"))
        if not self.base_url:
            raise ForecastError(say("Configure a forecast service URL", "请先填写预测服务地址"))

    def _request(self, path, payload=None, *, timeout=None):
        headers = {"Accept": "application/json"}
        reference = self.config.get("credential_ref")
        if self.token is not None:
            headers["Authorization"] = "Bearer " + self.token
        elif reference:
            from infrastructure.credential_store import load_secret
            headers["Authorization"] = "Bearer " + load_secret(reference)
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            opener = urllib.request.build_opener(_NoRedirect())
            with opener.open(request, timeout=timeout or self.config.get("timeout", 180)) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise ForecastError(say("Forecast response exceeds limit", "预测响应过大"))
                value = json.loads(raw)
        except urllib.error.HTTPError as exc:
            messages = {
                401: say("Authentication failed", "认证失败"), 403: say("Access denied", "访问被拒绝"),
                404: say("Forecast endpoint not found", "未找到预测接口，请检查端口和适配器"),
                409: say("Model is busy; retry later", "模型忙，请稍后重试"),
                422: say("Model rejected input shape or options", "模型拒绝输入，请检查形状和参数"),
                503: say("Model is not ready or GPU memory is insufficient", "模型尚未就绪或显存不足"),
            }
            raise ForecastError(messages.get(exc.code, say(f"Forecast service returned HTTP {exc.code}", f"预测服务返回 HTTP {exc.code}"))) from None
        except (TimeoutError, socket.timeout):
            raise ForecastError(say("Request timed out; execution may still be running", "预测请求超时；服务可能仍在计算，请核对状态再重试")) from None
        except urllib.error.URLError:
            raise ForecastError(say("Cannot connect to forecast service", "无法连接预测服务，请检查地址、端口和服务状态")) from None
        except (ValueError, UnicodeError):
            raise ForecastError(say("Invalid JSON from forecast service", "预测服务返回了无效 JSON")) from None
        if not isinstance(value, dict):
            raise ForecastError(say("Invalid forecast response", "预测响应结构无效"))
        return value

    def health(self):
        value = self._request("/health", timeout=8)
        if value.get("model") != MODEL_ID or value.get("service") not in {"timesfm3-local", "timesfm3-service"}:
            raise ForecastError(say("Endpoint is not a compatible TimesFM-3 service", "该端口不是兼容的 TimesFM-3 预测服务"))
        if value.get("ready") is not True:
            raise ForecastError(say("Service is online but model is not ready", "服务在线，模型尚未就绪"))
        return value

    def predict(self, context, horizon, target_names, **options):
        if not isinstance(horizon, int) or isinstance(horizon, bool) or not 1 <= horizon <= 256:
            raise ForecastError(say("Horizon must be 1–256", "预测步数须为 1–256"))
        if (not isinstance(context, list) or not isinstance(target_names, list)
                or any(not isinstance(n, str) or not n for n in target_names)
                or not 1 <= len(context) <= 8 or len(context) != len(target_names)
                or len(set(target_names)) != len(target_names)):
            raise ForecastError(say("Need 1–8 uniquely named targets", "需要 1–8 个名称唯一的目标"))
        length = len(context[0])
        if not 2 <= length <= 2048 or any(len(row) != length for row in context):
            raise ForecastError(say("Context rows must have equal length within 2–2048", "历史长度须等长且为 2–2048"))
        if any(not math.isfinite(float(x)) or abs(float(x)) > 1e15 for row in context for x in row):
            raise ForecastError(say("Context must contain finite values", "历史数据必须是有限数值"))
        allowed = {k: v for k, v in options.items() if k in {
            "make_positive", "use_symmetric_averaging", "past_only_covariates", "past_future_covariates", "request_id",
        }}
        value = self._request("/forecast", {"context": context, "horizon": horizon,
                                           "target_names": target_names, **allowed})
        if value.get("model") != MODEL_ID or value.get("target_names") != target_names or value.get("horizon") != horizon:
            raise ForecastError(say("Forecast identity or target order mismatch", "预测模型、目标顺序或步数与请求不一致"))
        pred, quantiles = value.get("forecast"), value.get("quantiles")
        try:
            if len(pred) != len(context) or len(quantiles) != len(context) or value.get("quantile_levels") != QUANTILES:
                raise ValueError("shape")
            for p, q in zip(pred, quantiles):
                if len(p) != horizon or len(q) != horizon:
                    raise ValueError("horizon")
                for median, row in zip(p, q):
                    if (len(row) != 9 or not all(math.isfinite(float(x)) for x in [median, *row])
                            or not all(float(a) <= float(b) + 1e-6 for a, b in zip(row, row[1:]))
                            or not math.isclose(float(median), float(row[4]), rel_tol=1e-5, abs_tol=1e-6)):
                        raise ValueError("quantiles")
        except (TypeError, ValueError, OverflowError):
            raise ForecastError(say("Invalid forecast shape, values or quantiles", "预测形状、数值或分位数无效")) from None
        return value

    def smoke_test(self):
        self.health()
        return self.predict([[1.0, 1.2, 1.1, 1.3, 1.2, 1.4, 1.3, 1.5]], 2, ["connection_test"], make_positive=True)
