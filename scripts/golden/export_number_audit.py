"""Golden cases for the numeric provenance audit, produced by the real Python implementation.

    .venv/bin/python scripts/golden/export_number_audit.py

Writes server/test/golden/number-audit.json. The TS port (server/src/agent/number-audit.ts) must
return exactly the same `(unsupported, total)` for every case.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent.number_audit import audit_report_numbers  # noqa: E402

HAND: list[dict] = [
    # transcription error the gate exists for
    {"report": "总订单 2,956 单", "evidence": ["rows: 1,956"], "context": []},
    {"report": "总订单 1,956 单", "evidence": ["rows: 1956"], "context": []},
    # rounding matches the evidence source (half up, not half even)
    {"report": "占比 40.7", "evidence": ["ratio=40.73"], "context": []},
    {"report": "均值 2.5", "evidence": ["x=2.45"], "context": []},
    {"report": "均值 12.4", "evidence": ["x=12.35"], "context": []},
    {"report": "均值 12.3", "evidence": ["x=12.25"], "context": []},
    {"report": "值 1234.6", "evidence": ["1234.55"], "context": []},
    # derived integer deltas (both operands >= 100)
    {"report": "删除 556 行", "evidence": ["2954669", "2954113"], "context": []},
    {"report": "合计 920 行", "evidence": ["919", "1"], "context": []},
    {"report": "合计 1020 行", "evidence": ["520", "500"], "context": []},
    {"report": "差 400 行", "evidence": ["900", "500"], "context": []},
    # skipped: percentages, magnitude suffixes, ranges, years, small ints, tiny decimals
    {"report": "增长 2,954.5%", "evidence": [], "context": []},
    {"report": "销售额 295.5 万", "evidence": [], "context": []},
    {"report": "销售额 295.5万元 3000亿 5000倍 8000‰", "evidence": [], "context": []},
    {"report": "2013-2017 年 GB 3095-2012 标准", "evidence": [], "context": []},
    {"report": "区间 1,000 – 2,000 之间", "evidence": [], "context": []},
    {"report": "区间 1000~2000 之间 3000～4000", "evidence": [], "context": []},
    {"report": "2019 年 2020 年 1999", "evidence": [], "context": []},
    {"report": "第 99 名，共 42 项，系数 2.5，比例 0.8", "evidence": [], "context": []},
    {"report": "PM2.5 浓度 v1.3 版本 L966 NO2 4567", "evidence": [], "context": []},
    {"report": "全角 １２３４５ 和 ％ 后缀 1234 ％", "evidence": [], "context": []},
    # context texts (user numbers, SQL thresholds) count as evidence
    {"report": "AQI 大于 150 的天数 365", "evidence": ["days: 365"], "context": ["WHERE aqi > 150"]},
    {"report": "用户说有 8,800 人", "evidence": [], "context": ["我们大约有 8800 人"]},
    # substring evidence is generous
    {"report": "编号 12345678", "evidence": ["id=12345678-extra"], "context": []},
    {"report": "数 123456", "evidence": ["x 1234567 y"], "context": []},
    # decimals with trailing zeros / equal numerically
    {"report": "金额 1500.00", "evidence": ["1500"], "context": []},
    {"report": "金额 1500", "evidence": ["1500.0"], "context": []},
    {"report": "金额 3.40", "evidence": ["3.4"], "context": []},
    # more than the listing cap (15 unsupported)
    {"report": " ".join(f"{1000 + i * 7}" for i in range(30)), "evidence": [], "context": []},
    # duplicates keep first-appearance order and are deduped
    {"report": "4,321 和 4321 和 4,321 以及 9,876", "evidence": [], "context": []},
    {"report": "", "evidence": ["1000"], "context": []},
    {"report": "无数字的段落", "evidence": ["1000"], "context": []},
    {"report": "1,234.5678 与 1,234,567.89", "evidence": ["1234.57", "1234567.9"], "context": []},
    {"report": "0.0000123 与 1e5 与 100.", "evidence": [], "context": []},
    {"report": "负数 -1500 与 +2500", "evidence": ["1500"], "context": []},
    {"report": "n1000 与 x_2000 与 .3000 与 ·4000 与 abc5000", "evidence": [], "context": []},
    {"report": "1000\n2000\t3000", "evidence": ["2000"], "context": []},
    {"report": "总额 99999999999999999999999999999.99", "evidence": ["99999999999999999999999999999.99"], "context": []},
    {"report": "总额 99999999999999999999999999999.9", "evidence": ["99999999999999999999999999999.94"], "context": []},
    {"report": "1,000,000.5", "evidence": ["1000000.46"], "context": []},
    {"report": "x" * 10 + " 7777", "evidence": ["7" * 60001 + " 7777"], "context": []},
]


def synthetic(seed: int, count: int) -> list[dict]:
    rng = random.Random(seed)
    cases = []
    for _ in range(count):
        evidence_numbers = []
        for _ in range(rng.randint(1, 6)):
            kind = rng.choice(["int", "dec1", "dec2", "big"])
            if kind == "int":
                evidence_numbers.append(str(rng.randint(100, 99999)))
            elif kind == "dec1":
                evidence_numbers.append(f"{rng.uniform(3, 900):.1f}")
            elif kind == "dec2":
                evidence_numbers.append(f"{rng.uniform(3, 5000):.2f}")
            else:
                evidence_numbers.append(f"{rng.randint(10**6, 10**9):,}")
        report_numbers = []
        for _ in range(rng.randint(1, 8)):
            base = rng.choice(evidence_numbers).replace(",", "")
            mode = rng.choice(["same", "round", "delta", "tweak", "fresh", "comma"])
            if mode == "same":
                report_numbers.append(base)
            elif mode == "round" and "." in base:
                report_numbers.append(f"{float(base):.{rng.randint(0, 1)}f}")
            elif mode == "delta":
                report_numbers.append(str(abs(int(float(base)) - rng.choice([100, 150, 500]))))
            elif mode == "tweak":
                report_numbers.append(str(int(float(base)) + rng.randint(1, 9)))
            elif mode == "comma":
                report_numbers.append(f"{int(float(base)):,}")
            else:
                report_numbers.append(str(rng.randint(100, 999999)))
        cases.append({
            "report": "，".join(f"指标{i} 为 {n}" for i, n in enumerate(report_numbers)),
            "evidence": [", ".join(evidence_numbers)],
            "context": [],
        })
    return cases


def main() -> None:
    cases = HAND + synthetic(20260101, 220)
    for case in cases:
        unsupported, total = audit_report_numbers(case["report"], case["evidence"], case["context"])
        case["unsupported"] = unsupported
        case["total"] = total
    out = ROOT / "server" / "test" / "golden" / "number-audit.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    flagged = sum(1 for c in cases if c["total"])
    print(f"{len(cases)} cases, {flagged} with unsupported numbers -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
