"""Golden cases for the P3.3 hook policies, produced by the real Python implementations.

    .venv/bin/python scripts/golden/export_hook_policies.py

Writes server/test/golden/hook-policies.json: text-fallback parsing cases (agent/agent.py
`_parse_text_fallback_tool_calls`) and the output-tool guard table (`_OUTPUT_TOOL_GUARDS`).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import agent.agent as agent_mod  # noqa: E402

parse = agent_mod._parse_text_fallback_tool_calls

PARSE_CASES: list[str] = [
    "",
    "no markup at all",
    "plain <b>bold</b> html",
    '<display_diagram><parameter name="xml">&lt;mxfile&gt;x&lt;/mxfile&gt;</parameter></display_diagram>',
    '<display_diagram><parameter name="xml">a</parameter><parameter name="title">T</parameter></display_diagram>',
    "<display_diagram></display_diagram>",
    "<display_diagram>no parameters here</display_diagram>",
    '<DISPLAY_DIAGRAM><PARAMETER NAME="xml">upper</PARAMETER></DISPLAY_DIAGRAM>',
    '<edit_diagram><parameter name="id">3</parameter></edit_diagram>',
    '<append_diagram><parameter name="xml">y</parameter></append_diagram>',
    '<some_other_tool><parameter name="x">1</parameter></some_other_tool>',
    '<display_diagram><parameter name="xml">m1</parameter></display_diagram><edit_diagram><parameter name="id">9</parameter></edit_diagram>',
    '<display_diagram\n  id="1"><parameter name="xml">newline attr</parameter></display_diagram>',
    '<display_diagram><parameter name="xml">multi\nline\nvalue</parameter></display_diagram>',
    "<display_diagram><parameter name='xml'>single quotes</parameter></display_diagram>",
    '<display_diagram><parameter name="xml">unclosed</display_diagram>',
    '<display_diagram><parameter name="xml">a</parameter><parameter name="xml">b</parameter></display_diagram>',
    '<display_diagram><parameter name="中文">值</parameter></display_diagram>',
    '<display_diagram>pre<parameter name="xml">x</parameter>post</display_diagram>',
    '<display_diagram><display_diagram><parameter name="xml">nested</parameter></display_diagram></display_diagram>',
    'text before <display_diagram><parameter name="xml">v</parameter></display_diagram> text after',
    '<display_diagram><parameter name="xml">a &amp; b &lt;c&gt;</parameter></display_diagram>',
    '<display_diagram_name><parameter name="xml">x</parameter></display_diagram_name>',
    '<display_diagram><parameter name = "xml" >spaced</parameter ></display_diagram>',
]


def guard_table() -> dict[str, list[str]]:
    """`_OUTPUT_TOOL_GUARDS` is a local of the run method; read its literal from the source with ast."""
    import ast

    tree = ast.parse((ROOT / "agent" / "agent.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "_OUTPUT_TOOL_GUARDS" for t in node.targets
        ):
            value = ast.literal_eval(node.value)
            return {name: sorted(tokens) for name, tokens in value.items()}
    raise SystemExit("_OUTPUT_TOOL_GUARDS assignment not found")


def main() -> None:
    guards = guard_table()
    out = {
        "parse": [{"content": c, "calls": [[name, args] for name, args in parse(c)]} for c in PARSE_CASES],
        "guards": guards,
    }
    path = ROOT / "server" / "test" / "golden" / "hook-policies.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(PARSE_CASES)} parse cases, {len(guards)} guarded tools -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
