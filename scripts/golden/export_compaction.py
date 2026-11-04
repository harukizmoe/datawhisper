"""Harness 压缩阈值的 golden 生成器：旧 `agent/compaction.py` 是行为基准。

    .venv/bin/python scripts/golden/export_compaction.py

写 server/test/golden/compaction.json：对一批上下文窗口，记录旧实现算出的「可输入上限」
（`compaction_threshold`），TS 侧 `reserveTokensFor` 必须满足 `contextWindow - reserve == threshold`。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent.compaction import compaction_threshold  # noqa: E402

WINDOWS = [
    1, 512, 1_000, 2_048, 4_096, 8_192, 16_384, 32_000, 32_768, 65_536,
    100_000, 128_000, 131_072, 200_000, 262_144, 384_000, 500_000, 1_000_000,
    1_048_576, 2_000_000, 10_000_000,
]


def main() -> None:
    cases = [
        {"contextWindow": w, "threshold": compaction_threshold(w)}
        for w in WINDOWS
    ]
    path = ROOT / "server" / "test" / "golden" / "compaction.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cases, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(cases)} cases -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
