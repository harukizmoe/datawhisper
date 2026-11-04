"""内置工具 registry 的 golden dump，由真实 Python 实现产出。

    .venv/bin/python scripts/golden/export_registry.py

写入 server/test/golden/registry.json。TS 移植版（server/src/tools/registry.ts）
维护一张手写表；server/test/registry.test.ts 逐字段证明它与本 dump 相等，
因此缺失、改名或打错类型的 tool/flag/keyword 都无法蒙混过关。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent.tools.registry import BUILTIN_TOOL_REGISTRY, get_tool_spec, is_job_eligible  # noqa: E402

OUT = ROOT / "server" / "test" / "golden" / "registry.json"


def dump() -> dict:
    specs = []
    for spec in BUILTIN_TOOL_REGISTRY.all():
        specs.append({
            "name": spec.name,
            "category": spec.category,
            "defaultExposed": spec.default_exposed,
            "discoverable": spec.discoverable,
            "discoveryKeywords": sorted(spec.discovery_keywords),
            "discoverySummary": spec.discovery_summary,
            "commands": sorted(spec.commands),
            "skills": sorted(spec.skills),
            "requiresDataSource": spec.requires_data_source,
            "concurrencySafe": spec.concurrency_safe,
            "executionMode": spec.execution_mode,
            "jobThreshold": spec.job_threshold,
            "requiresRuntime": spec.requires_runtime,
            "requiresWorkspace": spec.requires_workspace,
            "sideEffect": spec.side_effect,
            "confirmation": spec.confirmation,
        })
    names = sorted(BUILTIN_TOOL_REGISTRY.names())
    return {
        "specs": specs,
        "names": names,
        "jobEligible": sorted(name for name in names if is_job_eligible(name)),
        "missingSpecLookup": [name for name in names if get_tool_spec(name) is None],
        "categoryCounts": {
            category: sum(1 for spec in BUILTIN_TOOL_REGISTRY.all() if spec.category == category)
            for category in ("read", "analysis", "write", "output", "interaction")
        },
    }


def main() -> None:
    payload = dump()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {OUT.relative_to(ROOT)} ({len(payload['specs'])} specs)")


if __name__ == "__main__":
    main()
