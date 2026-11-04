"""P3.3 用户 hook 移植版的 golden 用例，由真实 Python 实现产出。

    .venv/bin/python scripts/golden/export_hooks.py

写入 server/test/golden/hooks.json：多种上下文下的条件求值、load_settings
校验结果（序列化后的 settings 或 HookConfigError 消息）、HookContext 展开、
Hook.should_run、once 注册表、事件归一化以及 shlex 分词
（条件与命令执行器所依赖的引号/转义规则）。
"""
from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from agent.hooks import conditions, events, loader, models  # noqa: E402

OUT = ROOT / "server" / "test" / "golden" / "hooks.json"

FIELDS = [
    "event_name",
    "session_id",
    "turn_id",
    "workspace_id",
    "workspace_name",
    "workspace_path",
    "tool_name",
    "tool_args",
    "tool_ok",
    "tool_error",
    "message",
    "final_answer",
    "error",
    "model_provider",
    "model",
    "elapsed_seconds",
    "extra",
]


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def context_json(ctx: models.HookContext) -> dict:
    return {camel(name): getattr(ctx, name) for name in FIELDS}


# --------------------------------------------------------------------------- 上下文

CONTEXTS = {
    "rich": models.HookContext(
        event_name="post_tool_use",
        session_id="sess-1",
        turn_id="turn-9",
        workspace_id="ws-1",
        workspace_name="销售 工作区",
        workspace_path="/tmp/工作 区",
        tool_name="query_data",
        tool_args={
            "sql": "SELECT * FROM orders WHERE region = 'east'",
            "limit": 10,
            "nested": {"deep": "yes"},
            "tags": ["a", "b"],
            "empty": "",
            "zero": 0,
            "flag": False,
            "cancel": True,
        },
        tool_ok=True,
        tool_error="",
        message="请分析 销售数据",
        final_answer="完成，销售额上升 12%",
        error="",
        model_provider="openai",
        model="gpt-4o",
        elapsed_seconds=1.25,
        extra={
            "manual": True,
            "code": "E42",
            "nested": {"k": "v"},
            "count": 0,
            "zero": 0,
            "false": False,
            "none": None,
            "list": [],
            "dict": {},
            "path": r"C:\temp\x",
            "quoted": 'he said "hi"',
        },
    ),
    "failed": models.HookContext(
        event_name="error",
        session_id="sess-2",
        turn_id="",
        tool_name="query_data",
        tool_args={"sql": "SELECT * FROM missing"},
        tool_ok=False,
        tool_error='relation "missing" does not exist',
        message="",
        error="内部错误：boom",
        elapsed_seconds=0.5,
    ),
    "empty": models.HookContext(event_name="turn_start"),
    "numbers": models.HookContext(
        event_name="turn_end",
        tool_args={"zero": 0, "half": 0.5, "neg": -1},
        tool_ok=None,
        elapsed_seconds=0.5,
        extra={"count": 0, "list": [], "dict": {}, "none": None},
    ),
    "chinese": models.HookContext(
        event_name="user_prompt_submit",
        tool_name="query_data",
        message="查询包含 SQL 关键字",
        final_answer="结论：销售额上升 12%",
        tool_args={"query": "SELECT 1"},
    ),
    "spaces": models.HookContext(
        event_name="turn_start",
        message="  padded  ",
        tool_name="",
        tool_args={"query": "a b\tc", "quote": 'he said "hi"'},
    ),
}

CONDITION_EXPRESSIONS = [
    # 空 / 空白
    "",
    "   ",
    "\t\n",
    # 单 token 的真值判断
    "tool_name",
    "message",
    "tool_ok",
    "ok",
    "nonexistent",
    "event",
    "tool",
    "args",
    "tool_args",
    "extra",
    "args.sql",
    "tool_args.sql",
    "args.empty",
    "args.zero",
    "args.tags",
    "args.missing",
    "extra.manual",
    "extra.count",
    "extra.none",
    "extra.list",
    "extra.dict",
    "extra.nested.k",
    "extra.nested.nope",
    "elapsed_seconds",
    "error",
    # == 与 !=
    "tool_name == query_data",
    "tool_name == Query_Data",
    "tool_name == \"query_data\"",
    "tool_name == 'query_data'",
    "tool_name != query_data",
    "tool_name = query_data",
    "tool_name === query_data",
    "tool_name ==",
    "tool_name == \"\"",
    "message ==",
    "message == 请分析 销售数据",
    "message == \"请分析 销售数据\"",
    "\"请分析 销售数据\" == message",
    "event == post_tool_use",
    "event == post-tool-use",
    "args.limit == 10",
    "args.limit == 10.0",
    "args.zero == 0",
    "extra.code == E42",
    "extra.code != E42",
    "extra.none == None",
    "extra.none == \"\"",
    "args.missing == \"\"",
    "elapsed_seconds == 1.25",
    "tool_error == relation",
    # booleans
    "tool_ok == true",
    "tool_ok == True",
    "tool_ok == \"true\"",
    "tool_ok == 1",
    "tool_ok != false",
    "ok == true",
    "ok != false",
    "args.flag == false",
    "args.flag != false",
    "args.flag == False",
    "args.cancel == true",
    "extra.manual == true",
    "extra.false == false",
    # contains / startswith / endswith（不区分大小写）
    "message contains 销售",
    "message contains 销售 数据",
    "message contains \"销售 数据\"",
    "message not_contains 销售",
    "message not_contains 库存",
    "message startswith 请",
    "message endswith 数据",
    "message startswith \"请分析\"",
    "args.sql contains select",
    "args.sql contains SELECT",
    "args.sql contains \"from orders\"",
    "args.sql startswith SELECT",
    "args.sql endswith orders",
    "args.tags contains a",
    "args.tags contains A",
    "tool_error contains \"does not exist\"",
    "tool_error not_contains missing",
    "final_answer endswith 12%",
    "extra.quoted contains hi",
    "extra.quoted == \"he said \\\"hi\\\"\"",
    # exists
    "args.empty exists",
    "args.tags exists",
    "args.zero exists",
    "nonexistent exists",
    "tool_name exists ignored extra",
    "message exists",
    "extra.none exists",
    # 反斜杠与引号
    r'extra.path == "C:\temp\x"',
    r"extra.path == 'C:\temp\x'",
    r"extra.path == C:\temp\x",
    r'extra.path contains temp',
    r'message == "unclosed',
    "tool_name == trailing\\",
    "message == 'single unclosed",
    # 引号内的空格
    'message startswith "  padded"',
    "message == padded",
    'tool_args.query == "a b\tc"',
    # 格式错误 / 未知的运算符
    "tool_name ~ query_data",
    "tool_name in query,data",
    "tool_name exists",
    # 布尔组合
    "tool_name == query_data && message contains 销售",
    "tool_name == nope && message contains 销售",
    "tool_name == nope || message contains 销售",
    "tool_name == nope||message contains 销售",
    "tool_name == nope && message contains 销售 || extra.manual",
    "extra.manual && tool_name == query_data",
    "&&",
    "||",
    "tool_name == query_data &&",
    "|| tool_name == query_data",
    "tool_name == query_data && ",
    " ",
]


def condition_cases() -> list[dict]:
    out = []
    for name, ctx in CONTEXTS.items():
        for expr in CONDITION_EXPRESSIONS:
            out.append(
                {
                    "context": name,
                    "expr": expr,
                    "expected": conditions.evaluate_condition(expr, ctx),
                }
            )
    return out


# --------------------------------------------------------------------------- loader（加载）

def base_hook(**overrides):
    hook = {
        "id": "h1",
        "event": "turn_start",
        "action": {"type": "prompt", "message": "hello"},
    }
    hook.update(overrides)
    return hook


LOADER_CASES = [
    None,
    {},
    [],
    "not-settings",
    {"hooks": [base_hook()], "enabled": True, "allow_command_hooks": True},
    {"enabled": False},
    {"hooks": None},
    {"hooks": []},
    {"hooks": {}},
    {"hooks": 0},
    {"hooks": "nope"},
    {"enabled": "yes"},
    {"enabled": None},
    {"allow_command_hooks": 1},
    {"hooks": [base_hook()]},
    {"hooks": [base_hook(), base_hook(id="h2", event="turn_end")]},
    {"hooks": [base_hook(), base_hook()]},
    {"hooks": ["not-a-dict"]},
    {"hooks": [{}]},
    {"hooks": [{"id": "   ", "event": "turn_start", "action": {"type": "prompt", "message": "x"}}]},
    {"hooks": [base_hook(event="unknown_event")]},
    {"hooks": [base_hook(event="Turn-End")]},
    {"hooks": [base_hook(event="SubagentStart")]},
    {"hooks": [base_hook(event="pre_compact")]},
    {"hooks": [{"id": "h1", "event": "turn_start"}]},
    {"hooks": [base_hook(action={"type": "shell", "command": "echo"})]},
    {"hooks": [base_hook(action={"type": ""})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": 0})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": 121})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": "15"})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": 10.9})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": True})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": "abc"})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "x", "timeout": None})]},
    {"hooks": [base_hook(action={"type": "prompt", "message": "  "})]},
    {"hooks": [base_hook(action={"type": "prompt"})]},
    {"hooks": [base_hook(action={"type": "prompt", "prompt": "from prompt key"})]},
    {"hooks": [base_hook(action={"type": "http", "url": ""})]},
    {"hooks": [base_hook(action={"type": "http", "url": "https://example.com/x", "method": "get", "headers": {"X-A": 1, "X-B": None}})]},
    {"hooks": [base_hook(action={"type": "http", "url": "https://example.com/x", "headers": []})]},
    {"hooks": [base_hook(action={"type": "http", "url": "https://example.com/x", "headers": [1]})]},
    {"hooks": [base_hook(action={"type": "http", "url": "https://example.com/x", "headers": "X-A: 1"})]},
    {"hooks": [base_hook(action={"type": "command"})]},
    {"hooks": [base_hook(action={"type": "command", "command": "  "})]},
    {"hooks": [base_hook(action={"type": "command", "command": "echo hi", "timeout": 120})]},
    {
        "hooks": [
            base_hook(
                id="full",
                name="  Full name  ",
                event="pre_tool_use",
                **{"if": "  tool_name == query_data  "},
                internal_endpoint=True,
                reject=True,
                once=True,
                once_scope=" Turn ",
                async_exec=False,
                enabled=False,
                action={
                    "type": "prompt",
                    "message": "blocked ${TOOL}",
                    "command": "ignored",
                    "url": "https://example.com",
                    "method": "put",
                    "body": {"a": [1, 2]},
                    "headers": {"Content-Type": "text/plain"},
                    "timeout": 30,
                },
            )
        ]
    },
    {"hooks": [base_hook(id="promlight-turn-end", name="")]},
    {"hooks": [base_hook(id="promlight-turn-end", title="标题名")]},
    {"hooks": [base_hook(id="codex_bridge", event="stop")]},
    {"hooks": [base_hook(id="codex_bridge", event="stop", internal_endpoint=False)]},
    {"hooks": [base_hook(id="h1", title="Title wins?", name="")]},
    {"hooks": [base_hook(condition="event == turn_start")]},
    {"hooks": [base_hook(**{"if": "", "condition": "event == turn_start"})]},
    {"hooks": [base_hook(once_scope="global", once=True)]},
    {"hooks": [base_hook(once_scope="turn")]},
    {"hooks": [base_hook(once_scope="weekly")]},
    {"hooks": [base_hook(once_scope=7)]},
    {"hooks": [base_hook(reject=True, event="pre_tool_use")]},
    {"hooks": [base_hook(reject=True)]},
    {"hooks": [base_hook(reject=True, event="pre_tool_use", action={"type": "command", "command": "true"})]},
    {"hooks": [base_hook(async_exec=True)]},
    {"hooks": [base_hook(**{"async": True})]},
    {"hooks": [base_hook(async_exec=True, event="pre_tool_use", action={"type": "http", "url": "https://example.com"})]},
    {"hooks": [base_hook(async_exec=True, action={"type": "http", "url": "https://example.com"})]},
    {"hooks": [base_hook(async_exec=True, action={"type": "command", "command": "true"})]},
    {"hooks": [base_hook(enabled="yes")]},
    {"hooks": [base_hook(internal_endpoint="yes")]},
    {"hooks": [base_hook(reject="yes")]},
    {"hooks": [base_hook(once="yes")]},
    {"hooks": [base_hook(async_exec="yes")]},
    {"hooks": [base_hook(name=5)]},
    {"hooks": [base_hook(event="PRE_TOOL_USE", action={"type": "prompt", "message": "x"})]},
    {"hooks": [base_hook(event=" session-start ", action={"type": "prompt", "message": "x"})]},
    {"hooks": [base_hook(event="tool call", action={"type": "prompt", "message": "x"})]},
]


def loader_cases() -> list[dict]:
    out = []
    for raw in LOADER_CASES:
        try:
            settings = loader.load_settings(json.loads(json.dumps(raw)))
        except loader.HookConfigError as exc:
            out.append({"raw": raw, "error": str(exc)})
        else:
            out.append({"raw": raw, "settings": loader.serialize_settings(settings)})
    return out


# --------------------------------------------------------------------------- 展开

EXPANSION_CONTEXT = models.HookContext(
    event_name="post_tool_use",
    session_id="sess-1",
    turn_id="turn-9",
    workspace_id="ws-1",
    workspace_name="销售 工作区",
    workspace_path="/tmp/工作 区",
    tool_name="query_data",
    tool_args={
        "sql": "SELECT 1",
        "limit": 10,
        "nested": {"deep": "yes"},
        "empty": "",
        "list": [1, "二", None],
    },
    tool_ok=True,
    tool_error="",
    message="请分析 销售数据",
    final_answer="done",
    error="",
    model_provider="openai",
    model="gpt-4o",
    elapsed_seconds=1.25,
    extra={"manual": True, "code": "E42", "nested": {"k": "v"}, "none": None, "zero": 0},
)

EXPANSION_TEMPLATES = [
    "",
    "plain text",
    "$",
    "$ ",
    "$1ABC",
    "$tool_name",
    "$TOOL_NAME",
    "$EVENT",
    "$EVENT_NAME",
    "$TOOL",
    "$ARGS",
    "$args.list",
    "$ARGS.LIST",
    "$ARGS.list",
    "$TOOL_ARGS",
    "$TOOL_ARGS.SQL",
    "$ARGS.NESTED.DEEP",
    "$ARGS.EMPTY",
    "$ARGS.MISSING",
    "$args.missing",
    "$EXTRA",
    "$EXTRA.CODE",
    "$EXTRA.MANUAL",
    "$EXTRA.NONE",
    "$EXTRA.ZERO",
    "$OK",
    "$ELAPSED_SECONDS",
    "$MESSAGE",
    "$SESSION_ID",
    "$TURN_ID",
    "$WORKSPACE_PATH",
    "$MODEL",
    "$MODEL_PROVIDER",
    "$FINAL_ANSWER",
    "$NONEXISTENT",
    "$TOOL-NAME",
    "$$TOOL_NAME",
    "$TOOL_NAME$MESSAGE",
    "prefix $TOOL_NAME middle $EXTRA.CODE suffix",
    "$SESSIONID",
    "$TOOL_ARGS.LIMIT",
    "$TOOL_ARGS..SQL",
    "$EXTRA.NESTED.K",
    "$EXTRA.NESTED.K.DEEP",
    "$HOOK_ENV_PROBE",
    "$SESSION_ENV_PROBE",
    "$hook_env_probe",
    "job $SESSION_ID $TURN_ID",
    "中文 $TOOL_NAME 结尾",
    "${TOOL_NAME}",
    "$",
    5,
    None,
    True,
    ["$TOOL_NAME", 3, None],
    {"a": "$TOOL_NAME", "b": ["$MESSAGE", 4], "c": {"d": "$EXTRA.CODE"}},
]


def expansion_cases() -> list[dict]:
    return [
        {"template": template, "expected": EXPANSION_CONTEXT.expand(template)}
        for template in EXPANSION_TEMPLATES
    ]


# --------------------------------------------------------------------------- should_run（是否执行）

def make_hook(**overrides) -> models.Hook:
    data = {
        "id": "h1",
        "event": "turn_start",
        "action": models.Action(type="prompt", message="x"),
    }
    data.update(overrides)
    return models.Hook(**data)


SHOULD_RUN_CASES = [
    {"hook": {}, "executed": False},
    {"hook": {}, "executed": True},
    {"hook": {"enabled": False}, "executed": False},
    {"hook": {"condition": ""}, "executed": False},
    {"hook": {"condition": "tool_name == query_data"}, "executed": False},
    {"hook": {"condition": "tool_name == nope"}, "executed": False},
    {"hook": {"condition": "tool_name == query_data", "once": True}, "executed": False},
    {"hook": {"condition": "tool_name == query_data", "once": True}, "executed": True},
    {"hook": {"condition": "tool_name == query_data", "once": False}, "executed": True},
    {"hook": {"condition": "   "}, "executed": False},
    {"hook": {"condition": "tool_name", "enabled": True}, "executed": False},
]


def hook_json(hook: models.Hook) -> dict:
    return {camel(name): getattr(hook, name) for name in (
        "id", "event", "name", "enabled", "internal_endpoint", "condition",
        "reject", "once", "once_scope", "async_exec", "executed",
    )}


def should_run_cases() -> list[dict]:
    out = []
    for case in SHOULD_RUN_CASES:
        hook = make_hook(**case["hook"])
        hook.executed = case["executed"]
        out.append(
            {
                "hook": hook_json(hook),
                "context": context_json(CONTEXTS["rich"]),
                "expected": hook.should_run(CONTEXTS["rich"]),
            }
        )
    return out


# --------------------------------------------------------------------------- once 注册表

CONTEXT_KEYS = {name: camel(name) for name in FIELDS}
CONTEXT_FROM_JSON = {camel(name): name for name in FIELDS}


def context_from_json(data: dict) -> models.HookContext:
    return models.HookContext(**{CONTEXT_FROM_JSON[key]: value for key, value in data.items()})


def key_json(key):
    return None if key is None else list(key)


def once_sequences() -> list[dict]:
    from agent.hooks.engine import OnceRegistry

    rich = CONTEXTS["rich"]
    no_turn = models.HookContext(event_name="turn_start", session_id="sess-2")
    anonymous = models.HookContext(event_name="turn_start")
    turn_only = models.HookContext(event_name="x", turn_id="t1")

    def reserve_op(hook: models.Hook, ctx: models.HookContext) -> dict:
        return {
            "op": "reserve",
            "hook": {"id": hook.id, "once": hook.once, "onceScope": hook.once_scope},
            "context": context_json(ctx),
        }

    def key_op(op: str, key) -> dict:
        return {"op": op, "key": key_json(key)}

    def once_hook(scope: str, hook_id: str = "h1") -> models.Hook:
        return make_hook(**{"id": hook_id, "once": True, "once_scope": scope})

    def replay(name: str, max_completed, ops: list[dict]) -> dict:
        registry = OnceRegistry() if max_completed is None else OnceRegistry(max_completed)
        expected = []
        for op in ops:
            if op["op"] == "reserve":
                hook = make_hook(
                    **{
                        "id": op["hook"]["id"],
                        "once": op["hook"]["once"],
                        "once_scope": op["hook"]["onceScope"],
                        "event": "turn_start",
                    }
                )
                key = registry.reserve(hook, context_from_json(op["context"]))
                expected.append(key_json(key))
            elif op["op"] == "release":
                registry.release(tuple(op["key"]) if op["key"] else ("", ""))
                expected.append(True)
            else:
                registry.complete(tuple(op["key"]) if op["key"] else ("", ""))
                expected.append(True)
        return {"name": name, "max_completed": max_completed, "ops": ops, "expected": expected}

    sequences = []

    for scope, ctx in (("turn", rich), ("session", rich), ("global", rich)):
        hook = once_hook(scope)
        ops = [reserve_op(hook, ctx), reserve_op(hook, ctx)]
        key = [hook.id, f"{scope}:" + (ctx.turn_id or ctx.session_id or "anonymous") if scope == "turn"
               else f"{scope}:" + (ctx.session_id or "anonymous") if scope == "session" else "global:global"]
        ops += [
            key_op("release", key),
            reserve_op(hook, ctx),
            key_op("complete", key),
            reserve_op(hook, ctx),
            key_op("complete", key),
            key_op("complete", None),
            key_op("release", None),
        ]
        sequences.append(replay(f"scope-{scope}", None, ops))

    plain = make_hook(**{"id": "h1"})
    key = ["", ""]
    sequences.append(
        replay("not-once", None, [reserve_op(plain, rich), key_op("complete", key), key_op("release", key)])
    )

    hook = once_hook("turn")
    sequences.append(
        replay(
            "turn-fallback",
            None,
            [reserve_op(hook, no_turn), reserve_op(hook, anonymous), reserve_op(hook, rich)],
        )
    )

    hook = once_hook("session")
    sequences.append(
        replay(
            "session-fallback",
            None,
            [reserve_op(hook, anonymous), reserve_op(hook, turn_only), reserve_op(hook, rich)],
        )
    )

    hook = once_hook("weekly")
    sequences.append(
        replay("unknown-scope-is-global", None, [reserve_op(hook, rich), reserve_op(hook, no_turn)])
    )

    ops = []
    for name in ("a", "b", "c", "d"):
        hook = once_hook("global", name)
        ops.append(reserve_op(hook, rich))
        ops.append(key_op("complete", [name, "global:global"]))
    for name in ("a", "b", "c", "d"):
        ops.append(reserve_op(once_hook("global", name), rich))
    sequences.append(replay("completed-cap", 3, ops))

    ops = []
    for name in ("x", "y"):
        ops.append(reserve_op(once_hook("global", name), rich))
        ops.append(key_op("complete", [name, "global:global"]))
    ops.append(reserve_op(once_hook("global", "x"), rich))
    ops.append(reserve_op(once_hook("global", "y"), rich))
    sequences.append(replay("completed-cap-one", 1, ops))

    ops = [reserve_op(once_hook("global", "z"), rich), key_op("complete", ["z", "global:global"]),
           reserve_op(once_hook("global", "z"), rich)]
    sequences.append(replay("cap-clamped-to-one", 0, ops))
    return sequences


# --------------------------------------------------------------------------- 事件 / shlex

EVENT_INPUTS = [
    "",
    "   ",
    "startup",
    "STARTUP",
    "session_start",
    "session-start",
    "sessionstart",
    "SessionStart",
    "session_end",
    "user_prompt_submit",
    "UserPromptSubmit",
    "user-prompt-submit",
    "turn_begin",
    "turn-begin",
    "turn_start",
    "turnstart",
    "turn_end",
    "TurnEnd",
    "tool_call",
    "tool-call",
    "toolcall",
    "pre_tool_use",
    "PreToolUse",
    "post_tool_use",
    "posttooluse",
    "permission_request",
    "PermissionRequest",
    "subagent_start",
    "SubagentStop",
    "pre_compact",
    "postcompact",
    "stop",
    "error",
    "unknown-event",
    "turn__start",
    " tool call ",
    "turn_start\t",
]

SHLEX_INPUTS = [
    "",
    "   ",
    "\t\n",
    "echo hi",
    "  echo   hi  ",
    "echo 'hello world'",
    'echo "hello world"',
    "echo 'it''s'",
    "echo ''",
    'echo ""',
    "echo ''''",
    "printf '%s\\n' a",
    r"printf '%s\n' a",
    r'echo "a\nb"',
    r"echo a\nb",
    r"echo 'a\nb'",
    r'echo "a\"b"',
    r'echo "a\\b"',
    r'echo "a\$b"',
    "echo 'unclosed",
    'echo "unclosed',
    "echo trailing\\",
    "echo a\tb",
    "echo 'a b' c",
    "echo $HOME",
    "echo ${VAR}",
    "echo `date`",
    "sh -c 'echo 1 && echo 2'",
    "python -m http.server 8000",
    "a|b",
    "a && b",
    "echo 中文 '值 二'",
    "echo \\  x",
    'echo "\\""',
    "echo '\\'",
    "echo a\\\\b",
    "\\a b",
    "\\&x",
    "\\-=",
    "x \\ y",
    "\\ 中 \\$",
    "echo \\\\ a",
    "echo \"'\"",
    "cmd 'a\"b'",
    'cmd "a\'b"',
]


NONPOSIX_INPUTS = [
    "",
    "echo hi",
    "echo 'hello world'",
    'echo "hello world"',
    "echo 'it''s'",
    "echo ''",
    "echo a\\b",
    "echo 'unclosed",
    "echo trailing\\",
    "echo \\  x",
    "sh -c 'echo 1 && echo 2'",
    "echo 中文 '值 二'",
]


def shlex_cases() -> list[dict]:
    out = []
    for posix, values in ((True, SHLEX_INPUTS), (False, NONPOSIX_INPUTS)):
        for text in values:
            try:
                out.append({"input": text, "posix": posix, "tokens": shlex.split(text, posix=posix)})
            except ValueError as exc:
                out.append({"input": text, "posix": posix, "error": str(exc)})
    return out


# --------------------------------------------------------------------------- 主流程

def main() -> None:
    os.environ["HOOK_ENV_PROBE"] = "from-env"
    os.environ["SESSION_ENV_PROBE"] = "from-env"

    out = {
        "contexts": {name: context_json(ctx) for name, ctx in CONTEXTS.items()},
        "conditions": condition_cases(),
        "expansion": [
            {"context": context_json(EXPANSION_CONTEXT), **case} for case in expansion_cases()
        ],
        "loader": loader_cases(),
        "should_run": should_run_cases(),
        "once": once_sequences(),
        "events": {
            "supported": sorted(events.SUPPORTED_EVENTS),
            "dispatched": sorted(events.DISPATCHED_EVENTS),
            "normalize": [
                {"input": value, "expected": events.normalize_event_name(value)}
                for value in EVENT_INPUTS
            ],
        },
        "shlex": shlex_cases(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(
        f"{len(out['conditions'])} condition cases, {len(out['loader'])} loader cases, "
        f"{len(out['expansion'])} expansion cases, {len(out['shlex'])} shlex cases -> "
        f"{OUT.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
