"""skills / skill discovery / commands / instructions / memory（读取侧）的 golden
用例，由真实 Python 实现产出。

    .venv/bin/python scripts/golden/export_skills.py

写入 server/test/golden/{skills,skill-discovery,commands,instructions,memory}.json。
各 TS 移植版（server/src/agent/{skills,skill-discovery,commands,instructions,memory}.ts）
必须复现每个用例。

输入：仓库的 `skills/` 与 `commands/`、server/test/fixtures/ 下的静态树，以及
"动态"树（超大文件、符号链接、CRLF、非法 UTF-8、op 序列）——后者以数据形式写在
golden 文件自身里，好让 TS 测试在临时目录中重建完全相同的树（见
server/test/support/fs-spec.ts）。输出中的所有路径都相对仓库根（静态树）或临时树
根（动态树）。
"""
from __future__ import annotations

import ast
import asyncio
import base64
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
FIX = ROOT / "server" / "test" / "fixtures"
OUT = ROOT / "server" / "test" / "golden"
NOWHERE = Path("/nonexistent-golden-dir")

# `Function.Knowledge.neural_embedder` 会拉起模型后端；discovery 只需要它里面的 5 个名字。
_embedder = types.ModuleType("Function.Knowledge.neural_embedder")
_embedder.embed_batch = lambda texts: []
_embedder.embed_query = lambda text: []
_embedder.get_embedding_signature = lambda: "stub"
_embedder.cosine = lambda a, b: 0.0 if not a or not b else sum(x * y for x, y in zip(a, b))
_embedder.is_neural = lambda: False
for _name in ("Function", "Function.Knowledge"):
    sys.modules.setdefault(_name, types.ModuleType(_name))
sys.modules["Function.Knowledge.neural_embedder"] = _embedder

from agent import activation as py_activation  # noqa: E402
from agent import instructions as py_instr  # noqa: E402
from agent import skill_discovery as py_sd  # noqa: E402
from agent.commands import catalog as py_catalog  # noqa: E402
from agent.commands import (  # noqa: E402
    CommandAvailabilityContext, CommandDispatcher, CommandDispatchError, CommandLoader, CommandRegistry,
    availability_provider, parse_slash_command, render_command_prompt,
)
from agent.skills import SkillExecutor, SkillLoader, parse_skill_file, render_skill_prompt  # noqa: E402
from agent.skills.executor import SkillDependencyError  # noqa: E402
from agent.skills.models import SkillDef  # noqa: E402
from agent.tools.registry import BUILTIN_TOOL_REGISTRY  # noqa: E402
from data import memory_store  # noqa: E402


def dump(name: str, payload: object) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def rel(path: object, base: Path = ROOT) -> str | None:
    if path is None:
        return None
    return Path(os.path.relpath(str(path), base)).as_posix()


# ───────────────────────────── 动态树规格 ─────────────────────────────

def materialize(root: Path, files: dict) -> None:
    """条目形式：str | {text} | {b64} | {repeat:{head,unit,times,tail}} | {link} | {dir:true}；可选 mtime。"""
    for relpath, entry in files.items():
        path = root / relpath
        if isinstance(entry, str):
            entry = {"text": entry}
        if entry.get("dir"):
            path.mkdir(parents=True, exist_ok=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        if "link" in entry:
            os.symlink(entry["link"], path)
            continue
        if "b64" in entry:
            data = base64.b64decode(entry["b64"])
        elif "repeat" in entry:
            r = entry["repeat"]
            data = (r.get("head", "") + r["unit"] * r["times"] + r.get("tail", "")).encode("utf-8")
        else:
            data = entry["text"].encode("utf-8")
        path.write_bytes(data)
        if "mtime" in entry:
            os.utime(path, (entry["mtime"], entry["mtime"]))


def skill_md(name: str, desc: str = "d", prompt: str = "p", extra: str = "") -> str:
    return f"---\nname: {name}\ndescription: {desc}\n{extra}---\n{prompt}\n"


# ───────────────────────────── skills 读取 ─────────────────────────────

DIGEST_OVER = 2000


def skill_json(skill: SkillDef, base: Path, *, digest: bool = False) -> dict:
    """长于 DIGEST_OVER 个字符的 prompt 以 sha256/length/head 形式保存，而不是全文。"""
    digest = digest or len(skill.prompt) > DIGEST_OVER
    out = {
        "name": skill.name, "display_name": skill.display_name, "description": skill.description,
        "icon": skill.icon, "allowed_tools": list(skill.allowed_tools), "tags": list(skill.tags),
        "source": skill.source, "path": rel(skill.path, base),
        "resources": [
            {"kind": r.kind, "relative_path": r.relative_path, "path": rel(r.path, base), "size": r.size}
            for r in skill.resources
        ],
        "public": skill.to_public_dict(),
    }
    if digest:
        out["prompt_sha256"] = hashlib.sha256(skill.prompt.encode("utf-8")).hexdigest()
        out["prompt_chars"] = len(skill.prompt)
        out["prompt_head"] = skill.prompt[:60]
    else:
        out["prompt"] = skill.prompt
    return out


def diag_json(loader, base: Path) -> list[dict]:
    return [{"path": rel(d.path, base), "source": d.source, "error": d.error} for d in loader.diagnostics()]


def run_skill_loader(dirs: dict[str, Path | None], base: Path, probe_names: list[str]) -> dict:
    loader = SkillLoader(
        builtin_dir=dirs.get("builtin") or NOWHERE, user_dir=dirs.get("user") or NOWHERE, workspace_dir=dirs.get("workspace"),
    )
    loaded = loader.load_all()
    return {
        "skills": [skill_json(s, base) for s in loaded.values()],
        "diagnostics": diag_json(loader, base),
        "get": {n: (skill_json(s, base) if (s := loader.get(n)) else None) for n in probe_names},
        "catalog": [s.name for s in loader.catalog()],
    }


def skills_section() -> dict:
    repo_loader = SkillLoader(builtin_dir=ROOT / "skills", user_dir=NOWHERE)
    repo = repo_loader.load_all()
    sfix = FIX / "skills"
    static_cases = []
    for case_id, dirs in {
        "valid": {"builtin": "valid"},
        "invalid": {"builtin": "invalid"},
        "dupes": {"builtin": "dupes"},
        "layers-all": {"builtin": "layers/builtin", "user": "layers/user", "workspace": "layers/workspace"},
        "layers-builtin-workspace": {"builtin": "layers/builtin", "workspace": "layers/workspace"},
        "layers-user-only": {"user": "layers/user"},
        "missing-dirs": {"builtin": "does-not-exist", "workspace": "also-missing"},
        "no-dirs": {},
    }.items():
        resolved = {k: sfix / v for k, v in dirs.items()}
        names = ["alpha", "beta", "gamma", "x", "y", "z", "u", "w", "foo", "same", "nope", "Bad-Name", ""]
        static_cases.append({"id": case_id, "dirs": dirs, **run_skill_loader(resolved, sfix, names)})

    # 直接对静态树中的每个文件调 parse_skill_file
    parse_cases = []
    for path in sorted(sfix.rglob("*.md"), key=lambda p: str(p)):
        if path.is_file():
            try:
                skill = parse_skill_file(path)
                parse_cases.append({"path": rel(path, sfix), "skill": skill_json(skill, sfix)})
            except Exception as exc:  # SkillError
                parse_cases.append({"path": rel(path, sfix), "error": str(exc), "error_type": type(exc).__name__})

    big = lambda n, **kw: {"repeat": {"head": "---\nname: big\ndescription: d\n---\n", "unit": "a", "times": n, **kw}}
    dynamic = [
        {"id": "sizes", "dirs": {"builtin": "."}, "files": {
            "file-too-big/SKILL.md": big(100_001 - len("---\nname: big\ndescription: d\n---\n")),
            "file-100000/SKILL.md": big(100_000 - len("---\nname: big\ndescription: d\n---\n")),
            "prompt-50000/SKILL.md": {"text": "---\nname: p50000\ndescription: d\n---\n" + "x" * 50_000},
            "prompt-50001/SKILL.md": {"text": "---\nname: p50001\ndescription: d\n---\n" + "x" * 50_001},
            "prompt-cjk-33000/SKILL.md": {"text": "---\nname: pcjk\ndescription: d\n---\n" + "字" * 33_000},
            "prompt-padded-50000/SKILL.md": {"text": "---\nname: ppad\ndescription: d\n---\n\n\n" + "y" * 50_000 + "\n\n   "},
            "prompt-emoji-30000/SKILL.md": {"text": "---\nname: pemoji\ndescription: d\n---\n" + "😀" * 24_000},
        }},
        {"id": "symlinks", "dirs": {"builtin": "."}, "files": {
            "real/SKILL.md": skill_md("real-skill", "real", "Real prompt"),
            "link-file/SKILL.md": {"link": "../real/SKILL.md"},
            "linkdir": {"link": "real"},
            "dangling/SKILL.md": {"link": "nowhere.md"},
            "direct-link.md": {"link": "real/SKILL.md"},
            "res/SKILL.md": skill_md("res-skill", "resources", "Res prompt"),
            "res/references/a.txt": "aaa",
            "res/references/link.txt": {"link": "a.txt"},
            "res/references/linkdir": {"link": "../scripts"},
            "res/scripts/s.sh": "echo",
            "res/assets": {"link": "../real"},
            "res2/SKILL.md": skill_md("res2-skill", "references is a symlink", "Prompt"),
            "res2/references": {"link": "../res/references"},
            "res2/scripts/only.py": "x",
        }},
        {"id": "resource-limits", "dirs": {"builtin": "."}, "files": {
            **{"r200/SKILL.md": skill_md("r200", "200 resources", "p")},
            **{f"r200/references/f{n:03d}.txt": str(n) for n in range(200)},
            "r201/SKILL.md": skill_md("r201", "201 resources", "p"),
            **{f"r201/references/f{n:03d}.txt": str(n) for n in range(201)},
            "r200dir/SKILL.md": skill_md("r200dir", "200 files then an extra entry", "p"),
            **{f"r200dir/references/f{n:03d}.txt": str(n) for n in range(200)},
            "r200dir/references/zz": {"dir": True},
            "split/SKILL.md": skill_md("split", "resources across kinds", "p"),
            **{f"split/references/f{n:03d}.txt": "r" for n in range(120)},
            **{f"split/scripts/g{n:03d}.txt": "s" for n in range(81)},
            "order/SKILL.md": skill_md("order", "resource order", "p"),
            "order/references/B.md": "1", "order/references/a.md": "22", "order/references/A2.md": "333",
            "order/references/a/z.md": "4444", "order/references/a-b.md": "55555", "order/references/a.b/c.md": "6",
            "order/scripts/Run.py": "7", "order/assets/æ.txt": "8", "order/assets/z.txt": "9",
        }},
        {"id": "case-insensitive-name", "dirs": {"builtin": "."}, "files": {
            "lower/skill.md": skill_md("lower-skill", "nested lowercase skill.md is not SKILL.md", "p"),
            "direct-skill.md": skill_md("direct-skill-file", "a direct file named skill.md style", "p"),
            "skill.md": skill_md("root-skill-md", "root skill.md => resources are looked up in the root", "p"),
            "references/r.txt": "root resource",
            "SKILL.md": skill_md("root-upper", "SKILL.md at the root is not a nested candidate but is a direct *.md", "p"),
        }},
    ]
    for case in dynamic:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            materialize(tmp_root, case["files"])
            dirs = {k: tmp_root / v for k, v in case["dirs"].items()}
            case.update(run_skill_loader(dirs, tmp_root, []))

    # 热重载：get() 会重新解析；被改坏或改名的修改回退到缓存副本
    hot = {"id": "hot-reload", "dirs": {"builtin": "b"}, "files": {"b/hr/SKILL.md": skill_md("hr", "v1", "prompt v1")}, "ops": [
        {"op": "load"}, {"op": "get", "name": "hr"},
        {"op": "write", "path": "b/hr/SKILL.md", "entry": skill_md("hr", "v2", "prompt v2 $ARGUMENTS")}, {"op": "get", "name": "hr"},
        {"op": "write", "path": "b/hr/SKILL.md", "entry": "broken, no frontmatter"}, {"op": "get", "name": "hr"},
        {"op": "write", "path": "b/hr/SKILL.md", "entry": skill_md("renamed", "v3", "prompt v3")}, {"op": "get", "name": "hr"},
        {"op": "get", "name": "renamed"},
        {"op": "write", "path": "b/hr/SKILL.md", "entry": skill_md("hr", "v4", "prompt v4")}, {"op": "get", "name": "hr"},
        {"op": "remove", "path": "b/hr/SKILL.md"}, {"op": "get", "name": "hr"},
        {"op": "load"}, {"op": "get", "name": "hr"},
        {"op": "write", "path": "b/hr/SKILL.md", "entry": skill_md("hr", "v5", "prompt v5")}, {"op": "get", "name": "hr"}, {"op": "load"}, {"op": "get", "name": "hr"},
    ]}
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        materialize(tmp_root, hot["files"])
        loader = SkillLoader(builtin_dir=tmp_root / "b", user_dir=NOWHERE)
        results = []
        for op in hot["ops"]:
            if op["op"] == "load":
                results.append(list(loader.load_all()))
            elif op["op"] == "get":
                s = loader.get(op["name"])
                results.append(skill_json(s, tmp_root) if s else None)
            elif op["op"] == "write":
                materialize(tmp_root, {op["path"]: op["entry"]})
                results.append(None)
            elif op["op"] == "remove":
                (tmp_root / op["path"]).unlink()
                results.append(None)
        hot["results"] = results

    # render_skill_prompt / 激活
    requests = ["", "   ", "分析 销量\n", "  padded \n", "$ARGUMENTS", "a $& b $1 $$", "line1\nline2",
                "　全角空格　", "\ufeffbom", "\x1c\x85 sep \x1f", "😀 emoji", "$ARGUMENTS $ARGUMENTS"]
    render = []
    for fixture in ("valid/alpha.md", "valid/beta/SKILL.md", "valid/gamma/SKILL.md", "valid/noargs/SKILL.md",
                    "valid/chinese/SKILL.md", "valid/dollar/SKILL.md", "valid/crlf/SKILL.md", "valid/folded/SKILL.md"):
        skill = parse_skill_file(sfix / fixture)
        for request in requests:
            render.append({"fixture": fixture, "request": request, "output": render_skill_prompt(skill, request)})
    repo_render = [
        {"name": n, "request": r, "sha256": hashlib.sha256(render_skill_prompt(s, r).encode()).hexdigest()}
        for n, s in repo.items() for r in ("", "按地区拆分销量")
    ]

    known = sorted(BUILTIN_TOOL_REGISTRY.names())
    activate = []
    for fixture in ("valid/beta/SKILL.md", "valid/tools-missing/SKILL.md", "valid/alpha.md", "valid/gamma/SKILL.md"):
        skill = parse_skill_file(sfix / fixture)
        try:
            act = SkillExecutor().activate(skill, "do it")
            activate.append({"fixture": fixture, "ok": {
                "name": act.name, "prompt": act.prompt, "requested_tools": sorted(act.requested_tools),
                "resources": [r.relative_path for r in act.resources]}})
        except SkillDependencyError as exc:
            activate.append({"fixture": fixture, "error": str(exc)})
    repo_activate = []
    for n, s in repo.items():
        try:
            act = SkillExecutor().activate(s, "测试")
            repo_activate.append({"name": n, "requested_tools": sorted(act.requested_tools)})
        except SkillDependencyError as exc:
            repo_activate.append({"name": n, "error": str(exc)})
    filters = []
    exposed_sets = [[], ["get_schema"], ["get_schema", "query_data", "run_analysis"], ["generate_chart", "nope"], known[:10]]
    for fixture in ("valid/beta/SKILL.md", "valid/alpha.md"):
        skill = parse_skill_file(sfix / fixture)
        # tools-missing 时无法激活；只从已注册的子集构建激活对象
        act = SkillExecutor().activate(skill, "")
        for exposed in exposed_sets:
            filters.append({"fixture": fixture, "exposed": exposed, "result": sorted(act.filter_exposed_tools(set(exposed)))})

    # 直接从 models 取 normalize_skill_tags 与 SkillDef 校验
    from agent.skills.models import normalize_skill_tags
    tag_cases = [None, [], ["a"], [" A ", "b-c"], "x", ["a", 1], ["a", "a"], ["A", "a"], [""], ["1a"], ["a_b"],
                 ["a" * 32], ["a" * 33], [f"t{i}" for i in range(12)], [f"t{i}" for i in range(13)], ("a", "b"), [" "]]
    tags = []
    for value in tag_cases:
        try:
            tags.append({"value": list(value) if isinstance(value, tuple) else value, "ok": list(normalize_skill_tags(value))})
        except ValueError as exc:
            tags.append({"value": value, "error": str(exc)})
    defs = []
    for kwargs in [
        dict(name="ok", description="d", prompt="p"), dict(name="Bad", description="d", prompt="p"),
        dict(name="has space", description="d", prompt="p"), dict(name="it's", description="d", prompt="p"),
        dict(name='say "hi"', description="d", prompt="p"), dict(name="it's \"x\"", description="d", prompt="p"),
        dict(name="tab\tname", description="d", prompt="p"), dict(name="nl\nname", description="d", prompt="p"),
        dict(name="uni分析", description="d", prompt="p"), dict(name="nb\u00a0sp", description="d", prompt="p"),
        dict(name="zw\u200bjoin", description="d", prompt="p"), dict(name="emoji😀", description="d", prompt="p"),
        dict(name="back\\slash", description="d", prompt="p"), dict(name="\x00nul", description="d", prompt="p"),
        dict(name="ok", description="  ", prompt="p"), dict(name="ok", description="d", prompt=" \n"),
        dict(name="ok", description="d", prompt="p", allowed_tools=("a", "a")),
        dict(name="ok", description="d", prompt="p", source="martian"),
        dict(name="ok", description="d", prompt="p", tags=("A",)),
    ]:
        try:
            d = SkillDef(path=Path("x.md"), **kwargs)
            defs.append({"kwargs": {k: list(v) if isinstance(v, tuple) else v for k, v in kwargs.items()}, "ok": True,
                         "modes": {m: d.supports_analysis_mode(m) for m in ("business", "ml", "empirical", "other", " ML ")}})
        except ValueError as exc:
            defs.append({"kwargs": {k: list(v) if isinstance(v, tuple) else v for k, v in kwargs.items()}, "error": str(exc)})
    mode_skill = SkillDef(name="m", description="d", prompt="p", path=Path("m.md"), tags=("mode-business", "mode-ml"))
    modes = {m: mode_skill.supports_analysis_mode(m) for m in ("business", " Business ", "ML", "empirical", "", "mode-business", "x")}

    # agent.py 的策略辅助函数：从真实源码执行，但不 import 那个 4900 行的模块
    tree = ast.parse((ROOT / "agent" / "agent.py").read_text(encoding="utf-8"))
    wanted = {"_REQUIRED_SUCCESSFUL_SKILL_TOOLS", "_missing_required_skill_tools", "_missing_skill_response_contract",
              "_skill_requires_text_only"}
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(getattr(t, "id", "") in wanted for t in node.targets):
            nodes.append(node)
    namespace: dict = {}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "agent.py(policy)", "exec"), {"__builtins__": __builtins__, "annotations": None}, namespace)
    namespace_globals = namespace
    policy_missing, policy_contract, policy_text_only = [], [], []
    fn_missing = namespace["_missing_required_skill_tools"]
    # 这些函数引用了模块全局变量；把命名空间当作它们的 globals
    for fn in ("_missing_required_skill_tools", "_missing_skill_response_contract", "_skill_requires_text_only"):
        namespace[fn].__globals__.update(namespace)
    for skill_name in ("regression", "ab-test-analysis", "other", "", None, "Regression"):
        for done in ([], ["run_analysis"], ["query_data"], ["run_analysis", "query_data"], ["query_data", "get_schema"]):
            policy_missing.append({"skill": skill_name, "successful": done,
                                   "missing": list(fn_missing(skill_name, set(done))),
                                   "text_only": namespace["_skill_requires_text_only"](skill_name, set(done))})
    contract_texts = [
        "", None, "负相关，显著，p值 0.01，不代表因果", "存在 negative correlation; p-value<0.05; no causal claim",
        "NEGATIVE RELATIONSHIP, P VALUE small, CAUSALITY unproven", "只有负线性", "显著 但是没有其他", "因果",
        "P值", "P 值", "p-value", "Causal", "无关内容", "负相关 显著 因果", "负相关" * 3, "ｐ值（全角）",
    ]
    for skill_name in ("regression", "ab-test-analysis", "", None):
        for text in contract_texts:
            policy_contract.append({"skill": skill_name, "content": text,
                                    "missing": list(namespace["_missing_skill_response_contract"](skill_name, text))})

    activation_cases = []
    for kwargs in [{}, {"skill_name": "s"}, {"command_name": "c"}, {"internal_action": "ppt_confirm"},
                   {"skill_name": "s", "command_name": "c"}, {"command_name": "c", "internal_action": "x"},
                   {"skill_name": "s", "command_name": "c", "internal_action": "x"}, {"skill_name": ""}]:
        try:
            ctx = py_activation.ActivationContext(**kwargs)
            activation_cases.append({"kwargs": kwargs, "record": ctx.to_record(), "dict": ctx.to_dict()})
        except ValueError as exc:
            activation_cases.append({"kwargs": kwargs, "error": str(exc)})

    return {
        "repo": {
            "count": len(repo), "names": list(repo),
            "diagnostics": diag_json(repo_loader, ROOT),
            "skills": [skill_json(s, ROOT, digest=True) for s in repo.values()],
            "render": repo_render, "activate": repo_activate,
        },
        "static_cases": static_cases, "parse_cases": parse_cases, "dynamic": dynamic, "hot_reload": hot,
        "render": render, "known_tools": known, "activate": activate, "filters": filters,
        "tags": tags, "defs": defs, "modes": modes,
        "policy": {"missing": policy_missing, "contract": policy_contract,
                   "required": {k: sorted(v) for k, v in namespace["_REQUIRED_SUCCESSFUL_SKILL_TOOLS"].items()}},
        "activation": activation_cases, "internal_actions": sorted(py_activation.INTERNAL_ACTIONS),
    }


# ───────────────────────────── skill 发现 ─────────────────────────────

DIM = 256
SIGNATURE = ["sig-a"]


def fake_vector(text: str) -> list[float]:
    vec = [0.0] * DIM
    for token in py_sd._lexical_tokens(text.lower()):
        vec[int(hashlib.sha256(token.encode("utf-8")).hexdigest()[:8], 16) % DIM] += 1.0
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


def discovery_section(skills: dict) -> dict:
    seen_texts: dict[str, list[float]] = {}
    batches: list[int] = []

    def embed_batch(texts):
        batches.append(len(texts))
        for t in texts:
            seen_texts[t] = fake_vector(t)
        return [seen_texts[t] for t in texts]

    def embed_query(text):
        q = str(text or "").strip()
        seen_texts[q] = fake_vector(q)
        return seen_texts[q]

    py_sd._embed_batch = embed_batch
    py_sd._embed_query = embed_query
    py_sd._embedding_signature = lambda: SIGNATURE[0]
    corpus = [s.to_public_dict() for s in skills.values()] + [
        {"name": "long-description", "description": "超长描述" * 80, "tags": ["mode-business"]},
        {"name": "emoji-skill", "description": "😀" * 250, "tags": []},
        {"name": "  ", "description": "blank name is dropped", "tags": []},
        {"name": "", "description": "empty name is dropped"},
        {"name": "no-tags", "description": "A skill without a tags key about churn retention cohorts"},
        {"name": "tag-ints", "description": "tags are stringified", "tags": [1, "", "x", 0]},
        {"name": "snake_case_name", "description": "name with underscores for the name bonus", "tags": []},
        {"name": "word-boundary", "description": "short", "tags": ["ab", "pie"]},
    ]
    with tempfile.TemporaryDirectory() as tmp:
        py_sd._SKILL_CACHE_PATH = Path(tmp) / "cache" / "skill_embeddings.json"
        catalog = py_sd.build_skill_catalog(corpus)

        queries = [
            "", "   ", "你好", "hello", "thanks!", "谢谢", "做一个SWOT分析", "swot", "SWOT analysis of our product",
            "arima forecast", "ARIMA 预测销量", "时间序列预测", "kmeans 聚类", "客户分群 聚类分析", "逻辑回归 违约概率",
            "regression significance p-value", "回归分析 显著性", "A/B 测试 显著性检验", "转化率对比", "bcg", "波士顿矩阵",
            "漏斗分析", "funnel", "dashboard 仪表盘", "导出 ppt", "export report", "生成报告", "sql 查询", "web table 抓取",
            "缩尾 winsorize", "trim outliers", "decile 十分位", "prophet 趋势", "gru 神经网络预测", "timesfm",
            "snake case name", "snake_case_name", "word", "pie", "tag", "!!!", "。。。", "x", "ab",
            "a very long query " * 20, "分析" * 100, "business model canvas 商业模式画布", "value proposition",
            "飞书 多维表格", "feishu bitable", "客户留存 churn retention", "cohorts", "emoji 😀",
        ]
        descriptions = [s.description for s in skills.values()][:6]
        queries += descriptions
        searches = []
        for query in queries:
            for limit in (5,) if len(query) > 1 else (5,):
                searches.append({"query": query, "limit": limit, "results": strip_embedding(py_sd.search_skill_catalog(catalog, query, limit=limit))})
        for query in ("分析", "预测", "analysis", "chart", "销量 预测 分析", "model"):
            for limit in (1, 2, 3, 10, 100):
                searches.append({"query": query, "limit": limit, "results": strip_embedding(py_sd.search_skill_catalog(catalog, query, limit=limit))})
        searches.append({"query": "分析", "limit": 5, "catalog_empty": True, "results": py_sd.search_skill_catalog([], "分析", limit=5)})

        lexical = [{"query": q, "text": t, "score": py_sd._lexical_score(q, t)} for q, t in [
            ("", "x"), ("x", ""), ("  a  ", "a b"), ("sales forecast", "forecast of sales by region"), ("销量预测", "分析销量并预测"),
            ("销", "销量"), ("ab", "ab cd"), ("ABC def", "abc DEF"), ("aaa", "a"), ("1 2", "1 2 3"), ("分析 销量", "销量 分析 报告"),
            ("test-case", "test case"), ("x" * 40, "x" * 40), ("hello world foo bar", "hello"), ("你好吗", "你好"), ("你", "你好"),
            ("a\u3000b", "a b"), ("İstanbul", "i̇stanbul"), ("数据 data 123", "数据data123"),
            ("one two three four five six seven eight", "one two three"),
        ]]
        names = [{"name": n, "query": q, "score": py_sd._name_bonus(n, q)} for n, q in [
            ("swot-analysis", "swot analysis please"), ("swot-analysis", "SWOT"), ("swot-analysis", "swo"), ("kmeans", "kmeans"),
            ("kmeans", "KMeans 聚类"), ("a-b", "a-b"), ("ab", "xaby"), ("snake_case_name", "snake"), ("snake_case_name", "case"),
            ("ppt", "make a ppt"), ("web-table", "table"), ("web-table", "web"), ("x y z", "x y z"), ("tab\tname", "name"),
            ("two  spaces here", "here"), ("日本語", "日本語"), ("a", "a"), ("--x--", "x"), ("abc-de", "de abc"),
        ]]

        # embedding 缓存行为：只有描述变了的才重新计算 embedding，过期条目被清除
        sequence = []
        cache_path = py_sd._SKILL_CACHE_PATH
        sub = corpus[:6]
        edited = [dict(sub[0], description="CHANGED description text")] + sub[1:]
        steps = [
            ("initial build", "sig-a", sub), ("same input", "sig-a", sub), ("one description edited", "sig-a", edited),
            ("one skill removed", "sig-a", edited[:-1]), ("skill added back", "sig-a", edited),
            ("signature changed", "sig-b", edited), ("signature unchanged again", "sig-b", edited),
            ("duplicate names and empty input", "sig-b", edited + [edited[0]]), ("empty input", "sig-b", []),
        ]
        cache_path.unlink(missing_ok=True)
        for label, sig, inputs in steps:
            SIGNATURE[0] = sig
            before = cache_path.read_text(encoding="utf-8") if cache_path.exists() else None
            stats: dict = {}
            batches.clear()
            built = py_sd.build_skill_catalog(inputs, stats=stats)
            after = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else None
            sequence.append({
                "label": label, "signature": sig, "inputs": inputs, "rebuilt": stats["rebuilt"], "total": stats["total"],
                "batches": list(batches), "catalog": [c["name"] for c in built],
                "cache_signature": after["signature"] if after else None, "cache_entries": len(after["entries"]) if after else None,
                "rewritten": (cache_path.read_text(encoding="utf-8") if cache_path.exists() else None) != before,
            })
        SIGNATURE[0] = "sig-a"
        catalog_json = [{k: v for k, v in c.items() if k != "embedding"} for c in catalog]

    return {
        "signature": "sig-a", "dim": DIM, "corpus": corpus, "texts": seen_texts, "catalog": catalog_json,
        "searches": searches, "lexical": lexical, "name_bonus": names, "cache_sequence": sequence,
    }


def strip_embedding(results: list[dict]) -> list[dict]:
    return [{k: v for k, v in r.items() if k != "embedding"} for r in results]


# ───────────────────────────── commands 解析 ─────────────────────────────

def command_json(c) -> dict:
    return {
        "name": c.name, "description": c.description, "type": c.type.value, "aliases": list(c.aliases), "usage": c.usage,
        "argument_hint": c.argument_hint, "arguments": c.arguments, "icon": c.icon, "category": c.category,
        "prompt": c.prompt, "handler_key": c.handler_key, "hidden": c.hidden, "protected": c.protected,
        "uses_model": c.uses_model, "confirmation": c.confirmation, "source": c.source, "path": rel(c.path),
        "public": c.to_public_dict(),
    }


def commands_section() -> dict:
    py_catalog.builtin_commands.cache_clear()
    builtins = py_catalog.builtin_commands()
    saved_dir = py_catalog.PROJECT_COMMANDS_DIR
    py_catalog.PROJECT_COMMANDS_DIR = NOWHERE
    fallback = py_catalog.builtin_commands.__wrapped__()
    py_catalog.PROJECT_COMMANDS_DIR = saved_dir

    cfix = FIX / "commands"
    probes = ["help", "HELP", "h", "?", "s", "status", "sk", "skills", "kb", "n", "new", "ws", "nope", "", "deploy", "dp",
              "review-report", "team:standup", "team:deep-dive:notes", "sh", "shw", "shared", "wso", "ws-only",
              "shared-alias", "uses-alias-as-name", "zz-alias-of-name", "alias-12", "r0", "r11"]
    cases = []
    for case_id, user, ws in [
        ("basic", "basic/user", "basic/workspace"), ("basic-user-only", "basic/user", None),
        ("invalid", "invalid/user", None), ("override", "override/user", "override/workspace"),
        ("override-ws-only", None, "override/workspace"), ("none", None, None),
        ("missing-dirs", "nope/user", "nope/workspace"),
    ]:
        CommandLoader.clear_cache()
        loader = CommandLoader(builtins=builtins, user_dir=(cfix / user) if user else NOWHERE, workspace_dir=(cfix / ws) if ws else None)
        registry = loader.load()
        cases.append({
            "id": case_id, "user": user, "workspace": ws,
            "commands": [command_json(c) for c in registry.all(include_hidden=True)],
            "visible": [c.name for c in registry.all()],
            "diagnostics": [{"path": rel(d.path), "source": d.source, "error": d.error} for d in loader.diagnostics()],
            "resolve": {p: registry.canonical_name(p) for p in probes},
        })
    # 带兜底 builtins 的 loader（commands 目录为空/缺失）
    CommandLoader.clear_cache()
    fb_loader = CommandLoader(builtins=fallback, user_dir=NOWHERE)
    fb_registry = fb_loader.load()

    # 对每个 fixture 文件、两种 trust 级别都调用 parse_command_file
    parse_cases = []
    for base in sorted((cfix).glob("*/*")):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.md"), key=lambda p: str(p).lower()):
            for trusted in (False, True):
                from agent.commands import CommandError, parse_command_file
                try:
                    parse_cases.append({"base": rel(base), "path": rel(path), "trusted": trusted,
                                        "command": command_json(parse_command_file(base, path, source="builtin" if trusted else "user", allow_trusted_types=trusted))})
                except CommandError as exc:
                    parse_cases.append({"base": rel(base), "path": rel(path), "trusted": trusted, "error": str(exc)})

    dynamic = [
        {"id": "files", "files": {
            "user/big-prompt.md": {"text": "---\ndescription: d\n---\n" + "p" * 50_000},
            "user/too-big-prompt.md": {"text": "---\ndescription: d\n---\n" + "p" * 50_001},
            "user/too-big-file.md": {"repeat": {"head": "---\ndescription: d\n---\n", "unit": "p", "times": 100_001}},
            "user/real.md": "---\ndescription: real\n---\nreal prompt\n",
            "user/link.md": {"link": "real.md"},
            "user/linkdir": {"link": "sub"},
            "user/sub/inner.md": "---\ndescription: inner\n---\ninner prompt\n",
            "user/dir.md/child.md": "---\ndescription: child of a dir named dir.md\n---\nchild\n",
            "user/dangling.md": {"link": "nowhere.md"},
            "user/upper/Mixed Case.md": "---\ndescription: m\n---\nmixed\n",
            "user/.hidden/x.md": "---\ndescription: hidden dir\n---\nhidden\n",
            "user/a.b.c.md": "---\ndescription: dots\n---\ndots\n",
            "user/.md": "---\ndescription: dotfile\n---\nx\n",
            "user/emoji😀.md": "---\ndescription: emoji name\n---\nx\n",
            "user/Sort-B.md": "---\ndescription: b\n---\nb\n", "user/sort-a.md": "---\ndescription: a\n---\na\n",
            "user/sort/z.md": "---\ndescription: z\n---\nz\n", "user/sort-c.md": "---\ndescription: c\n---\nc\n",
            "user/bad-utf8-skip.md": {"text": "---\ndescription: ok\n---\nok\n"},
            "user/colon:name.md": "---\ndescription: colon in file name\n---\ncolon\n",
            "user/mixed-case-alias.md": "---\ndescription: a\naliases: [Foo, BAR]\n---\nx\n",
            "user/hidden-true.md": "---\ndescription: h\nhidden: true\n---\nx\n",
            "user/hidden-false.md": "---\ndescription: h\nhidden: false\n---\nx\n",
            "user/no-desc.md": "---\nicon: 🎯\n---\nbody only\n",
            "user/trailing-fm.md": "---   \ndescription: d\n---   \nbody\n",
            "user/eof-fence.md": "---\ndescription: d\n---",
            "user/blank-fm.md": "---\n\n---\nbody\n",
        }},
    ]
    for case in dynamic:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            materialize(tmp_root, case["files"])
            CommandLoader.clear_cache()
            loader = CommandLoader(builtins=builtins, user_dir=tmp_root / "user")
            registry = loader.load()
            case["commands"] = [{**command_json(c), "path": rel(c.path, tmp_root)} for c in registry.all(include_hidden=True)]
            case["diagnostics"] = [{"path": rel(d.path, tmp_root), "source": d.source, "error": d.error.replace(str(tmp_root), "<tmp>")}
                                  for d in loader.diagnostics()]

    slash_inputs = ["", "   ", "hello", "/", "/ ", "  /help  ", "/help", "/HELP me", "/Help  x  y ", "/?", "/? foo", "/help\tx", "/help\nline2",
                    "/help\u3000全角空格参数", "/　help", "/中文 命令 参数", "//double", "/a/b c", "/ help", "/help   ", "/h\x1cx", "/h\x85x",
                    "/Ünï", "/😀 x", "\ufeff/help", "\u3000/help\u3000", "/compact 保留重点：A\nB", "/skills info swot-analysis", "x /help"]
    slash = [{"input": s, **{k: v for k, v in zip(("name", "arguments", "is_command"), (lambda p: (p.name, p.arguments, p.is_command))(parse_slash_command(s)))}} for s in slash_inputs]

    prompt_cmds = [c for c in CommandLoader(builtins=builtins, user_dir=cfix / "basic/user").load().all(include_hidden=True) if c.type.value == "prompt"]
    arg_inputs = ["", "  ", "prod", "  prod  ", "a\nb", "$ARGUMENTS", "x $& y $1", "全角　空格", "\ufeffbom"]
    render = [{"command": c.name, "arguments": a, "output": render_command_prompt(c, a)} for c in prompt_cmds for a in arg_inputs]

    registry = CommandLoader(builtins=builtins, user_dir=cfix / "basic/user").load()
    dispatcher = CommandDispatcher(registry, {
        "client:help": lambda args, ctx: f"help[{args}|{ctx}]", "server:compact": lambda args, ctx: {"compacted": args, "ctx": ctx},
    })

    async def run_dispatch(name, args, ctx):
        try:
            r = await dispatcher.dispatch(name, args, ctx)
            return {"command": r.command.name, "arguments": r.arguments, "prompt": r.prompt, "value": r.value}
        except CommandDispatchError as exc:
            return {"error": str(exc)}

    dispatch, prepare, resolve = [], [], []
    for name, args in [("help", "x"), ("H", ""), ("?", "topic"), ("compact", "重点"), ("c", ""), ("status", ""), ("deploy", "prod"),
                       ("DP", ""), ("review-report", "q3"), ("nope", ""), ("", ""), ("skills", "reload"), ("team:standup", "now"), ("plain", "")]:
        dispatch.append({"name": name, "arguments": args, "context": "ctx", "result": asyncio.run(run_dispatch(name, args, "ctx"))})
        try:
            r = dispatcher.prepare_agent_turn(name, args)
            prepare.append({"name": name, "arguments": args, "result": {"command": r.command.name, "arguments": r.arguments, "prompt": r.prompt}})
        except CommandDispatchError as exc:
            prepare.append({"name": name, "arguments": args, "result": {"error": str(exc)}})
        try:
            resolve.append({"name": name, "result": dispatcher.resolve(name).name})
        except CommandDispatchError as exc:
            resolve.append({"name": name, "result": {"error": str(exc)}})

    contexts = [None, CommandAvailabilityContext(), CommandAvailabilityContext(3, True, True), CommandAvailabilityContext(4, False, True),
                CommandAvailabilityContext(4, True, False), CommandAvailabilityContext(10, True, True), CommandAvailabilityContext(10, False, False)]
    availability = []
    for c in builtins:
        for ctx in contexts:
            a = availability_provider.evaluate(c, ctx)
            availability.append({"command": c.name,
                                 "context": None if ctx is None else {"history_length": ctx.history_length, "model_available": ctx.model_available, "workspace_mounted": ctx.workspace_mounted},
                                 "available": a.available, "code": a.code, "reason": a.reason, "public": c.to_public_dict(availability=a)})

    frozen = CommandRegistry([builtins[0]]).freeze()
    try:
        frozen.register(builtins[1])
        frozen_error = None
    except RuntimeError as exc:
        frozen_error = str(exc)

    return {
        "builtin": {"count": len(builtins), "commands": [command_json(c) for c in builtins]},
        "fallback": {"count": len(fallback), "commands": [command_json(c) for c in fallback],
                     "registry": [c.name for c in fb_registry.all(include_hidden=True)], "diagnostics": [d.error for d in fb_loader.diagnostics()]},
        "cases": cases, "parse_cases": parse_cases, "dynamic": dynamic, "slash": slash, "render": render,
        "dispatch": dispatch, "prepare": prepare, "resolve": resolve, "availability": availability, "frozen_error": frozen_error,
    }


# ───────────────────────────── instructions 读取 ─────────────────────────────

def run_instructions(case_root: Path, tag: str) -> str:
    user, ws = case_root / "user", case_root / "ws"
    os.environ["BAA_DATA_DIR"] = str(user)
    py_instr._cache.clear()
    py_instr._workspace_root = lambda wid: Path(ws).resolve(strict=False)
    return py_instr.load_instruction_section(workspace_id=f"ws-{tag}" if ws.is_dir() else "")


def instructions_section() -> dict:
    ifix = FIX / "instructions"
    static = []
    for case in sorted(p for p in ifix.iterdir() if p.is_dir()):
        static.append({"id": case.name, "has_workspace": (case / "ws").is_dir(), "output": run_instructions(case, case.name)})

    def file(n):  # 一条 n 个字符长的单行
        return {"repeat": {"unit": "x", "times": n}}

    u = "[USER INSTRUCTIONS]\n"
    dynamic = [
        {"id": "truncate-over", "files": {"user/ZHIXI.md": file(20_000), "ws/ZHIXI.md": file(10_000)}},
        {"id": "truncate-emoji", "files": {"user/ZHIXI.md": {"repeat": {"unit": "😀", "times": 13_000}}, "ws/ZHIXI.md": {"repeat": {"unit": "😀", "times": 13_000}}}},
        {"id": "exact-limit", "files": {"user/ZHIXI.md": file(25_000 - len(u))}},
        {"id": "one-over-limit", "files": {"user/ZHIXI.md": file(25_000 - len(u) + 1)}},
        {"id": "cjk-limit", "files": {"user/ZHIXI.md": {"repeat": {"unit": "字", "times": 25_000 - len(u) + 3}}}},
        {"id": "separators", "files": {
            "ws/ZHIXI.md": {"text": "a\u2028@include <inc.md>\u2029b\vc\fd\x1ce\x1df\x1eg\x85h\n  @include <inc.md>\u2028tail"},
            "ws/inc.md": {"text": "inc1\x85inc2\u2028inc3"}}},
        {"id": "crlf", "files": {
            "ws/ZHIXI.md": {"text": "x\r\n@include <inc.md>\r\ny\rz\r\n\r\nlast"}, "ws/inc.md": {"text": "i1\r\ni2\r\n"}}},
        {"id": "invalid-utf8", "files": {
            "user/ZHIXI.md": {"b64": base64.b64encode(b"bad \xff\xfe bytes\n").decode()},
            "ws/ZHIXI.md": {"text": "ok\n@include <bad.md>\nafter\n"}, "ws/bad.md": {"b64": base64.b64encode(b"\x80abc").decode()}}},
        {"id": "bom", "files": {"ws/ZHIXI.md": {"b64": base64.b64encode(b"\xef\xbb\xbfwith bom\n@include <inc.md>\n").decode()}, "ws/inc.md": {"b64": base64.b64encode(b"\xef\xbb\xbf@include <inc2.md>\n").decode()}, "ws/inc2.md": "deep\n"}},
        {"id": "symlinks", "files": {
            "outside/x.md": "outside content\n", "ws/real.md": "real inside\n",
            "ws/ZHIXI.md": {"text": "top\n@include <link/x.md>\n@include <inner-link.md>\n@include <dangling.md>\n@include <link>\n@include <dir-link/y.md>\nend\n"},
            "ws/link": {"link": "../outside"}, "ws/inner-link.md": {"link": "real.md"}, "ws/dangling.md": {"link": "nowhere.md"},
            "ws/realdir/y.md": "y inside\n", "ws/dir-link": {"link": "realdir"}}},
        {"id": "symlink-root", "files": {
            "real-ws/ZHIXI.md": {"text": "via symlinked root\n@include <inc.md>\n@include <../escape.md>\n"}, "real-ws/inc.md": "inc\n", "escape.md": "escape\n",
            "ws": {"link": "real-ws"}}},
        {"id": "dotdot-through-symlink", "files": {
            "elsewhere/deep/keep.txt": "x", "elsewhere/target.md": "target outside\n", "ws/inner/target.md": "inner target\n",
            "ws/ZHIXI.md": {"text": "@include <jump/../target.md>\n@include <inner/../inner/target.md>\n"},
            "ws/jump": {"link": "../elsewhere/deep"}}},
        {"id": "dir-with-md-name", "files": {"ws/ZHIXI.md": "@include <thing.md>\n", "ws/thing.md/keep": "x"}},
        {"id": "ws-is-file", "files": {"ws": "this is a file, not a directory\n", "user/ZHIXI.md": "user only\n"}},
        {"id": "whitespace-includes", "files": {
            "ws/ZHIXI.md": {"text": "\u3000@include\u3000<\u3000inc.md\u3000>\u3000\n@include\x1c<inc.md>\n\x85@include <inc.md>\n@include <inc.md>\u00a0\n"}, "ws/inc.md": "I\n"}},
        {"id": "multi-gt", "files": {"ws/ZHIXI.md": "@include <a>b.md>\n@include <a.md>>\n", "ws/a.md": "A\n"}},
        {"id": "depth-fan", "files": {
            "ws/ZHIXI.md": "@include <l1.md>\n@include <l1.md>\n", "ws/l1.md": "1\n@include <l2.md>\n", "ws/l2.md": "2\n@include <l3.md>\n",
            "ws/l3.md": "3\n@include <l4.md>\n", "ws/l4.md": "4\n@include <l5.md>\n", "ws/l5.md": "5\n@include <l6.md>\n", "ws/l6.md": "6\n"}},
    ]
    for case in dynamic:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            materialize(tmp_root, case["files"])
            case["has_workspace"] = (tmp_root / "ws").is_dir()
            case["output"] = run_instructions(tmp_root, case["id"])

    # mtime 缓存：mtime 相同 = 直接用缓存（即便内容变了）；新的 mtime/删除会使缓存失效
    seq = {"id": "mtime-cache", "files": {"user/ZHIXI.md": {"text": "user v1\n", "mtime": 1000}, "ws/ZHIXI.md": {"text": "ws v1\n@include <inc.md>\n", "mtime": 1000}, "ws/inc.md": {"text": "inc v1\n", "mtime": 1000}},
           "ops": [
               {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.md", "entry": {"text": "ws v2 same mtime\n@include <inc.md>\n", "mtime": 1000}}, {"op": "render"},
               {"op": "write", "path": "ws/inc.md", "entry": {"text": "inc v2 (include target, parent mtime unchanged)\n", "mtime": 5000}}, {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.md", "entry": {"text": "ws v3 new mtime\n@include <inc.md>\n", "mtime": 2000}}, {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.local.md", "entry": {"text": "local appears\n", "mtime": 3000}}, {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.local.md", "entry": {"text": "local edited same mtime\n", "mtime": 3000}}, {"op": "render"},
               {"op": "remove", "path": "ws/ZHIXI.local.md"}, {"op": "render"},
               {"op": "remove", "path": "user/ZHIXI.md"}, {"op": "render"},
               {"op": "remove", "path": "ws/ZHIXI.md"}, {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.md", "entry": {"text": "back again\n", "mtime": 1000}}, {"op": "render"},
               {"op": "write", "path": "ws/ZHIXI.md", "entry": {"text": "older mtime goes back in time\n", "mtime": 500}}, {"op": "render"},
           ]}
    with tempfile.TemporaryDirectory() as tmp:
        tmp_root = Path(tmp)
        materialize(tmp_root, seq["files"])
        os.environ["BAA_DATA_DIR"] = str(tmp_root / "user")
        py_instr._cache.clear()
        py_instr._workspace_root = lambda wid: Path(tmp_root / "ws").resolve(strict=False)
        outputs = []
        for op in seq["ops"]:
            if op["op"] == "render":
                outputs.append(py_instr.load_instruction_section(workspace_id="ws-seq"))
            elif op["op"] == "write":
                materialize(tmp_root, {op["path"]: op["entry"]})
                outputs.append(None)
            else:
                (tmp_root / op["path"]).unlink()
                outputs.append(None)
        seq["outputs"] = outputs
    return {"constants": {"MAX_INSTRUCTION_CHARS": py_instr.MAX_INSTRUCTION_CHARS, "MAX_INCLUDE_DEPTH": py_instr.MAX_INCLUDE_DEPTH},
            "static": static, "dynamic": dynamic, "cache": seq}


# ───────────────────────────── memory 读取 ─────────────────────────────

def memory_json(record: dict) -> dict:
    return {k: record[k] for k in ("name", "type", "scope", "title", "body", "why", "how_to_apply", "created_at", "updated_at", "last_seen_at", "source_session")}


def run_memory(case_root: Path, tag: str) -> dict:
    """在副本上运行 Python 读取路径（它会重写 MEMORY.md），返回 records/section/read 结果。"""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "case"
        shutil.copytree(case_root, copy, symlinks=True)
        ws = copy / "ws"
        os.environ["BAA_DATA_DIR"] = str(copy / "data")
        stub = types.ModuleType("data.workspace")
        stub.workspace_manager = types.SimpleNamespace(root_for_workspace=lambda wid: str(ws))
        sys.modules["data.workspace"] = stub
        wid = f"ws-{tag}" if ws.is_dir() else ""
        records = memory_store.list_records(user_id="", workspace_id=wid)
        section = memory_store.render_memory_section(user_id="", workspace_id=wid)
        reads = {}
        for name in [r["name"] for r in records] + ["nope", "", "Bad Name", "UPPER", "ok", "solo"]:
            record = memory_store.get_record(name, user_id="", workspace_id=wid)
            if not record:
                reads[name] = {"get": None, "read": "Memory record is unavailable in the current scope."}
                continue
            lines = [f"[{record['type']}] {record['title']}", record["body"]]
            if record.get("why"):
                lines.append(f"Why: {record['why']}")
            if record.get("how_to_apply"):
                lines.append(f"How to apply: {record['how_to_apply']}")
            reads[name] = {"get": memory_json(record), "read": "\n".join(lines)}
        return {"records": [memory_json(r) for r in records], "section": section, "reads": reads, "has_workspace": ws.is_dir()}


def memory_section() -> dict:
    mfix = FIX / "memory"
    static = [{"id": case.name, **run_memory(case, case.name)} for case in sorted(p for p in mfix.iterdir() if p.is_dir())]

    def record_file(i: int, title: str, type_="user", body="b") -> dict:
        return {"text": f"---\nname: r{i:03d}\ntype: {type_}\ntitle: {title}\nupdated_at: '2026-01-{(i % 28) + 1:02d}T{i // 28:02d}:00:00+00:00'\n---\n{body}\n"}

    dynamic = [
        {"id": "over-200-records", "files": {f"data/memory/memories/r{i:03d}.md": record_file(i, f"Record number {i}") for i in range(205)}},
        {"id": "exactly-200-records", "files": {f"data/memory/memories/r{i:03d}.md": record_file(i, f"Record number {i}") for i in range(200)}},
        {"id": "index-char-limit", "files": {f"data/memory/memories/r{i:03d}.md": record_file(i, "标" * 170) for i in range(190)}},
        {"id": "index-char-limit-both-scopes", "files": {
            **{f"data/memory/memories/r{i:03d}.md": record_file(i, "t" * 175) for i in range(70)},
            **{f"ws/.zhixi/memory/memories/r{i:03d}.md": record_file(i, "w" * 175, "project") for i in range(70, 140)}}},
        {"id": "symlinks", "files": {
            "data/memory/memories/real.md": record_file(1, "real")["text"].replace("r001", "real"),
            "data/memory/memories/link.md": {"link": "real.md"},
            "data/memory/memories/escape.md": {"link": "../../../outside.md"},
            "outside.md": record_file(2, "outside")["text"].replace("r002", "escape"),
            "data/memory/memories/dangling.md": {"link": "nowhere.md"}}},
        {"id": "invalid-utf8", "files": {
            "data/memory/memories/bad.md": {"b64": base64.b64encode(b"---\nname: bad\ntype: user\ntitle: \xff\n---\nbody\n").decode()},
            "data/memory/memories/good.md": record_file(3, "good")["text"].replace("r003", "good")}},
    ]
    for case in dynamic:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            materialize(tmp_root, case["files"])
            case.update(run_memory(tmp_root, case["id"]))
            # 大用例只有聚合结果值得关注
            if len(case["files"]) > 20:
                case["records"] = [{"name": r["name"], "type": r["type"], "title": r["title"], "updated_at": r["updated_at"]} for r in case["records"]]
                case["reads"] = {}

    payloads = []
    base = {"name": "pref-one", "type": "user", "title": "T", "body": "B"}
    long = lambda n: "x" * n
    for label, payload, kw in [
        ("valid", base, {}), ("full", {**base, "why": "w", "how_to_apply": "h"}, {}),
        ("missing name", {**base, "name": ""}, {}), ("snake name", {**base, "name": "a_b"}, {}), ("upper name", {**base, "name": "Ab"}, {}),
        ("trailing dash", {**base, "name": "ab-"}, {}), ("double dash", {**base, "name": "a--b"}, {}), ("digits", {**base, "name": "1-2"}, {}),
        ("padded name", {**base, "name": "  ab  "}, {}), ("unicode name", {**base, "name": "分析"}, {}),
        ("bad type", {**base, "type": "nope"}, {}), ("missing type", {k: v for k, v in base.items() if k != "type"}, {}),
        ("project", {**base, "type": "project"}, {}), ("padded type", {**base, "type": " feedback "}, {}),
        ("empty title", {**base, "title": ""}, {}), ("blank title", {**base, "title": " \u3000 "}, {}), ("none title", {**base, "title": None}, {}),
        ("int title", {**base, "title": 5}, {}), ("zero title", {**base, "title": 0}, {}), ("false title", {**base, "title": False}, {}),
        ("true title", {**base, "title": True}, {}), ("list title", {**base, "title": ["a", "b"]}, {}), ("empty list title", {**base, "title": []}, {}),
        ("float title", {**base, "title": 2.5}, {}), ("dict body", {**base, "body": {"k": 1}}, {}), ("nested", {**base, "title": [1, "a", None, True, [2.5]]}, {}),
        ("title 180", {**base, "title": long(180)}, {}), ("title 181", {**base, "title": long(181)}, {}), ("title emoji 180", {**base, "title": "😀" * 180}, {}),
        ("title emoji 181", {**base, "title": "😀" * 181}, {}),
        ("body 2000", {**base, "body": long(2000)}, {}), ("body 2001", {**base, "body": long(2001)}, {}),
        ("why 500", {**base, "why": long(500)}, {}), ("why 501", {**base, "why": long(501)}, {}),
        ("how 501", {**base, "how_to_apply": long(501)}, {}), ("none why", {**base, "why": None}, {}),
        ("secret api_key", {**base, "body": "api_key: abc123"}, {"automatic": True}), ("secret api_key manual", {**base, "body": "api_key: abc123"}, {}),
        ("secret token eq", {**base, "body": "my TOKEN=xyz"}, {"automatic": True}), ("secret bearer", {**base, "body": "Authorization : Bearer abc"}, {"automatic": True}),
        ("secret mysql", {**base, "body": "see mysql://u:p@h/db"}, {"automatic": True}), ("secret postgresql", {**base, "title": "postgresql://x"}, {"automatic": True}),
        ("secret mongodb+srv", {**base, "why": "mongodb+srv://c"}, {"automatic": True}), ("secret redis", {**base, "how_to_apply": "REDIS://h"}, {"automatic": True}),
        ("secret private key", {**base, "body": "-----BEGIN RSA PRIVATE KEY-----"}, {"automatic": True}),
        ("secret password", {**base, "body": "password = v"}, {"automatic": True}), ("secret passwd ideographic space", {**base, "body": "passwd\u3000:\u3000pw"}, {"automatic": True}),
        ("secret key no value", {**base, "body": "api_key:"}, {"automatic": True}), ("secret word only", {**base, "body": "the token is hidden"}, {"automatic": True}),
        ("secret api key variants", {**base, "body": "API KEY = z"}, {"automatic": True}), ("secret api-key", {**base, "body": "api-key=1"}, {"automatic": True}),
        ("secret apikey", {**base, "body": "apikey:1"}, {"automatic": True}), ("secret secrets", {**base, "body": "secrets: 1"}, {"automatic": True}),
        ("secret fullwidth colon", {**base, "body": "token：abc"}, {"automatic": True}), ("secret newline value", {**base, "body": "token:\nabc"}, {"automatic": True}),
        ("secret nbsp", {**base, "body": "token:\u00a0abc"}, {"automatic": True}),
        ("existing merge", {"title": "New", "body": None}, {"existing": {"name": "pref-one", "type": "user", "title": "Old", "body": "Kept"}}),
        ("existing override type", {"type": "reference"}, {"existing": {"name": "pref-one", "type": "user", "title": "Old", "body": "Kept"}}),
        ("existing all none", {"name": None, "type": None, "title": None, "body": None}, {"existing": {"name": "x", "type": "user", "title": "t", "body": "b"}}),
    ]:
        try:
            result = memory_store._validate_payload(payload, **kw)
            payloads.append({"label": label, "payload": payload, "options": kw, "ok": result})
        except ValueError as exc:
            payloads.append({"label": label, "payload": payload, "options": kw, "error": str(exc)})

    labels = {t: memory_store._render_index([{"type": t, "title": "T", "name": "n"}]) for t in ("user", "feedback", "project", "reference")}
    index_probe = [{"records": [{"type": "user", "title": f"t{i}", "name": f"n{i}"} for i in range(n)]} for n in (0, 1, 2, 199, 200, 201, 250)]
    for item in index_probe:
        item["index"] = memory_store._render_index(item["records"])
    return {
        "constants": {"MAX_TITLE_CHARS": memory_store.MAX_TITLE_CHARS, "MAX_BODY_CHARS": memory_store.MAX_BODY_CHARS,
                      "MAX_RECORDS": memory_store.MAX_RECORDS, "MAX_INDEX_CHARS": memory_store.MAX_INDEX_CHARS},
        "static": static, "dynamic": dynamic, "payloads": payloads, "labels": labels, "index_probe": index_probe,
    }


def main() -> None:
    skills = SkillLoader(builtin_dir=ROOT / "skills", user_dir=NOWHERE).load_all()
    dump("skills.json", skills_section())
    dump("skill-discovery.json", discovery_section(skills))
    dump("commands.json", commands_section())
    dump("instructions.json", instructions_section())
    dump("memory.json", memory_section())


if __name__ == "__main__":
    main()
