"""把录制里的绝对路径、会话 id、临时时间戳替换成占位符，便于逐字比对。

从旧 `baseline/run_baseline.py` 抽出来：那里的其余部分（启动旧 agent、跑场景）已经删除，
但这段归一化仍是 `compute/tests/test_tools.py` 回放录制时需要的逻辑，逐字保留。
"""

from __future__ import annotations

import datetime as dt
import re
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]

VOLATILE_KEYS = {"elapsed_seconds", "created_at", "updated_at", "duration", "duration_ms",
                 "timestamp", "generated_at", "mtime", "size_bytes"}

_ISO_TS = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?")
_COMPACT_TS = re.compile(r"(?<!\d)(\d{4})(\d{2})(\d{2})[_-]?\d{6}(?:\d{1,6})?(?!\d)")
_EPOCH = re.compile(r"(?<![\d.])(\d{10})(\d{3}|\.\d+)?(?![\d.])")

GENERIC_RULES: list[tuple[str, re.Pattern, str]] = [
    ("uuid", re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I), "<UUID>"),
    ("tool-result id", re.compile(r"\btr_[0-9a-f]{16,64}\b"), "tr_<ID>"),
    ("evidence-claim id", re.compile(r"\bec_[0-9a-f]{16,64}\b"), "ec_<ID>"),
    ("sha256", re.compile(r"\b[0-9a-f]{64}\b"), "<SHA256>"),
    ("hex id 12-40", re.compile(r"(?<![0-9a-zA-Z])[0-9a-f]{12,40}(?![0-9a-zA-Z])"), "<HEX>"),
    ("loopback port", re.compile(r"\b(127\.0\.0\.1|localhost):\d{2,5}\b"), r"\1:<PORT>"),
    ("duration text", re.compile(r"(耗时|用时|elapsed)[:：\s]*\d+(?:\.\d+)?\s*(?:ms|s|秒|毫秒)", re.I), r"\1 <DUR>"),
    ("run-time suffix", re.compile(r"<TODAY>[_-]?\d{4,6}(?!\d)"), "<TODAY>_<HHMMSS>"),
    ("tmp path", re.compile(r"/tmp/[^\s\"'`)\]}>,;]+"), "<TMP_PATH>"),
]


class Normalizer:
    def __init__(self, data_root: Path, sids: list[str], extra_literals: dict[str, str]) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        self.now_epoch = now.timestamp()
        base_days = {now.date(), dt.date.today()}
        self.run_dates = {d + dt.timedelta(days=k) for d in base_days for k in (-1, 0, 1)}
        literals: dict[str, str] = {}
        for root in {str(data_root), str(data_root.resolve())}:
            literals[root] = "<DATA_ROOT>"
        literals[str(REPO)] = "<REPO>"
        for sid in sids:
            literals[sid] = "<SID>"
            literals[sid[:8]] = "<SID8>"
        for day in self.run_dates:
            literals[day.isoformat()] = "<TODAY>"
            literals[day.strftime("%Y%m%d")] = "<TODAY>"
            literals[f"{day.year}年{day.month}月{day.day}日"] = "<TODAY>"
            literals[f"{day.year}年{day.month:02d}月{day.day:02d}日"] = "<TODAY>"
        literals.update(extra_literals)
        # 长的在前，使根路径优先于它的前缀
        self.literals = sorted(literals.items(), key=lambda kv: -len(kv[0]))

    def _is_run_date(self, y: str, m: str, d: str) -> bool:
        try:
            return dt.date(int(y), int(m), int(d)) in self.run_dates
        except ValueError:
            return False

    def _ts(self, match: re.Match) -> str:
        return "<TS>" if self._is_run_date(*match.group(1, 2, 3)) else match.group(0)

    def _epoch(self, match: re.Match) -> str:
        seconds = int(match.group(1))
        return "<EPOCH>" if abs(seconds - self.now_epoch) < 2 * 86400 else match.group(0)

    def text(self, s: str) -> str:
        s = _ISO_TS.sub(self._ts, s)
        s = _COMPACT_TS.sub(self._ts, s)
        s = _EPOCH.sub(self._epoch, s)
        for lit, repl in self.literals:
            if lit:
                s = s.replace(lit, repl)
        for _name, pattern, repl in GENERIC_RULES:
            s = pattern.sub(repl, s)
        return s

    def __call__(self, value: Any, key: str | None = None) -> Any:
        if key in VOLATILE_KEYS and value is not None:
            return "<VOLATILE>"
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, list):
            return [self(v) for v in value]
        if isinstance(value, dict):
            return {k: self(v, k) for k, v in value.items()}
        return value


# ─────────────────────────────── 主流程 ───────────────────────────────────────
