"""P3.4 工具暴露算法的 golden 矩阵，由真实 Python 实现产出。

    .venv/bin/python scripts/golden/export_exposure.py

写入 server/test/golden/exposure.json。每个用例都跑与 Python agent 每次模型调用
相同的四阶段流水线：

    agent.tools.exposure.filter_tools_for_turn
    agent.workflow_stage.infer_workflow_stage + filter_tools_for_stage
    agent.agent._scope_tool_result_reader
    agent.tools.exposure.limit_tools_for_turn

再加上来自 `data.session.ChatSession`（`record_discovered_tools`）与
`SessionState.restore_rewind_state` 的 discovery TTL 记账。

Schema 是合成的：每个用例只列出工具的 *名字*（`{"function": {"name": ...}}`），
因为 exposure 从不读取其他字段。`toolSets` 让 payload 保持精简；TS 测试会重建
完全相同的 schema 顺序。期望列表保持规范输入顺序（提示词缓存稳定性属于契约的
一部分），因此 TS 侧必须完全按序匹配，而不是按集合比较。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import agent.agent as agent_mod  # noqa: E402
import agent.tools.exposure as px  # noqa: E402
import agent.workflow_stage as ws  # noqa: E402
from agent.activation import ActivationContext  # noqa: E402
from agent.tools.registry import BUILTIN_TOOL_REGISTRY  # noqa: E402
from data.session import ChatSession  # noqa: E402

OUT = ROOT / "server" / "test" / "golden" / "exposure.json"

ALL_NAMES = [spec.name for spec in BUILTIN_TOOL_REGISTRY.all()]
MCP_NAMES = [
    "mcp__filesystem__read_file",
    "mcp__github__search_code",
    "mcp__playwright__screenshot",
    "mcp__notion__create_page",
    "mcp__linear__list_issues",
]
TOOL_SETS: dict[str, list[str]] = {
    "all": ALL_NAMES,
    "all+mcp": ALL_NAMES[:8] + MCP_NAMES[:2] + ALL_NAMES[8:40] + MCP_NAMES[2:] + ALL_NAMES[40:],
    "mcp-only": MCP_NAMES,
    "essentials": [
        "ask_user", "workspace_status", "read_tool_result", "search_mcp_tools",
        "query_knowledge", "get_schema", "query_data", "load_analysis_skill",
        "select_chart", "generate_chart",
    ],
}

COMMANDS = [
    "checkpoint", "clear", "compact", "data", "help", "instruction", "jobs", "knowledge",
    "mcp", "new", "robot", "sessions", "skills", "status", "stop", "teams", "workspace",
]

# 真实的用户回合。中英文兼有；合起来覆盖每个 discovery 分支、
# 每套按工具的 keyword，以及 workspace/web/diagram/CRUD 的冲突解析器。
MESSAGES = [
    "帮我分析一下这个季度的销售数据",
    "分析各区域销售额的同比变化",
    "看看最近三个月的订单趋势并画个折线图",
    "帮我做一份销售分析报告",
    "把结果导出成 Excel",
    "生成一个 PPT 汇报材料",
    "做一个销售看板 dashboard",
    "用商业模式画布梳理我们的业务",
    "画一个 SWOT 四象限分析图",
    "帮我画一下 BCG 矩阵",
    "查看当前的画布内容",
    "修改画布，把增长模块挪到左上角",
    "打开 https://example.com/pricing 帮我看看价格",
    "读取 https://docs.example.com/api 的接口文档",
    "搜索一下 2024 年新能源汽车销量",
    "google 一下最新的 LLM benchmark",
    "打开网页 https://news.example.com 看看头条",
    "点击页面上的登录按钮",
    "在网页的搜索框里填写表单关键词",
    "提取网页正文内容",
    "给这个网页截个图",
    "关闭浏览器",
    "把这个网页上的表格抓下来",
    "解析这个 PDF 表格并导入",
    "动态网页表格提取，需要处理 JS 渲染表格",
    "帮我配置 hooks，自动运行格式化",
    "新建一个飞书多维表格",
    "列出飞书表格里有哪些数据表",
    "读取飞书表格的数据来分析",
    "把这些结果写入飞书表格",
    "更新飞书表格里的那行记录",
    "删除无用的分析表",
    "对这张表做数据画像",
    "清洗数据里的缺失值和异常值",
    "PPT 配色改成深蓝色",
    "列出工作区里的文件",
    "在工作区里 grep 一下配置文件",
    "读取 sales.docx 的内容",
    "打开说明文档看看",
    "新建文件，把结论保存下来",
    "修改文件，替换掉旧的数字",
    "删除文件 tmp_report.md",
    "把报告重命名为 final_report.md",
    "运行 bash 看一下 git status",
    "创建一个待办任务：周五前完成月报",
    "查看任务详情",
    "列出所有任务",
    "更新任务状态为完成",
    "帮我创建一个团队",
    "删除团队 analyst-team",
    "列出团队列表",
    "查看团队状态和收件箱",
    "给团队发消息说数据已更新",
    "委派一个子任务给分析师",
    "创建一个团队计划，先建计划暂不执行",
    "并行团队批量委派三个分析任务",
    "创建一个工作流模板",
    "新建自定义工作流",
    "列出可用的工作流",
    "运行工作流跑一遍分析",
    "查看工作流状态",
    "你还记得我上次提到的偏好么",
    "查看之前的长期记忆",
    "帮我分析一下客户复购率的分布",
    "查一下有哪些数据表",
    "这张表的字段分布是什么样的",
    "统计每个品类的销量占比",
    "对销售数据做回归预测",
    "用 ARIMA 预测下个月的销量",
    "做一次 KMeans 聚类分析",
    "这个月的数据比上月增长了多少",
    "把异常订单筛出来",
    "做一个漏斗分析",
    "帮我做 RFM 分群",
    "对各省份销售额排名",
    "分析这份问卷的结果",
    "看看这张表的缺失值情况",
    "生成柱状图对比各产品线收入",
    "用散点图看看价格和销量的关系",
    "分析用户留存曲线的变化趋势",
    "帮我看看 database 里的表结构",
    "EXPLAIN 一下这个 SQL",
    "查询 orders 表里 2024 年的数据",
    "对比一下两个季度的转化率",
    "把分析结果写成 docx 报告",
    "生成周报，包含图表",
    "使用最合适的图表展示月度趋势",
    "将数据导出为 CSV",
    "把这批数据保存到工作区",
    "Please analyze the sales data for Q1",
    "Can you read the config.json file?",
    "search the web for the latest pandas release",
    "open https://example.com and summarize the page",
    "take a screenshot of the page",
    "create a task to review the report tomorrow",
    "list the tasks in this workspace",
    "show me the team status",
    "run the workflow for monthly analysis",
    "list available workflows",
    "what did I mention last time about the report format?",
    "remember my preference: always use bar charts",
    "看一下文件里的内容",
    "帮我看看这份说明文件",
    "打开 .txt 文件",
    "grep TODO in workspace files",
    "workspace 里列文件",
    "帮我下载这个 csv 链接 https://example.com/data.csv",
    "在线表格导入分析",
    "我需要一个 webhook 配置",
    "查看团队成员状态",
    "发送消息给团队",
    "创建动态计划，先预览计划",
    "切换到团队模式并行分析",
    "team delegate these three tasks",
    "删除团队 team1",
    "删除文件 old.csv 并清理目录",
    "编辑文件 notes.md",
    "移动工作区里的文件到 archive",
    "写文件到工作区，保存结论",
    "新建文件 summary.md",
    "执行场景 daily-report",
    "工作流状态如何",
    "分析飞书表格的销售数据",
    "bitable 里有哪些数据表",
    "modify diagram: add a new box",
    "edit the canvas diagram",
    "get the current diagram",
    "view the canvas",
    "swot 分析我们的竞争力",
    "data profile of the orders table",
    "clean the data with winsorize",
    "run a profile on this table",
    "check the json validate of config",
    "python compile the script",
    "checksum this file",
    "git diff",
    "shell 命令执行",
    "命令行运行脚本",
    "browser fill the email input",
    "click link on page",
    "close browser window",
    "navigate to https://example.com",
    "go to url https://example.com/docs",
    "打开网址 https://example.com",
    "访问网页 https://example.com",
    "查一下今天的汇率",
    "",
    "   ",
    "...",
    "你好",
    "分析一下数据",
    "打开文件",
    "看看内容",
    "read the document",
    "view file notes.md",
    "plot the revenue by month",
    "create the monthly workflow",
    "run the analysis and then generate the dashboard",
    "compare conversion between regions",
    "create an analysis table from the orders source",
    "delete table analysis_sales_tmp",
    "search files for the pricing policy",
    "rename file report.md to final.md",
    "move file a.txt to archive/b.txt",
    "delete analysis table old_tmp",
    "drop table analysis_sales_tmp",
    "create a team plan but do not execute yet",
    "parallel team analysis for three regions",
    "delegate a subtask to an analyst teammate",
    "send message to the team mailbox",
    "查询知识库里的指标口径",
    "使用分析技能做渠道归因",
    "load the analysis skill for churn",
]

SKILLS = [
    "export", "report", "ppt", "dashboard",
    "business-model-canvas", "web-table", "feishu-bitable", "workflow",
    "ab-test-analysis", "regression",
]

# 最近的 discovery LRU，最新的在最后，包含当前意图之外的名字。
RECENT_DISCOVERY = [
    "workspace_glob", "browser_search", "memory_read", "team_status",
    "workflow_list", "task_list", "set_ppt_color_scheme", "clean_data",
    "profile_data", "workspace_grep",
]

FLAG_MESSAGES = [
    "分析销售数据并生成图表",
    "读取工作区里的 notes.md",
    "创建团队并委派分析",
]


def activation_dict(activation: ActivationContext | None) -> dict[str, str] | None:
    if activation is None:
        return None
    return {
        "skillName": activation.skill_name,
        "commandName": activation.command_name,
        "internalAction": activation.internal_action,
    }


def act(skill: str = "", command: str = "", internal: str = "") -> ActivationContext:
    return ActivationContext(skill_name=skill, command_name=command, internal_action=internal)


def schemas(names: list[str]) -> list[dict]:
    return [{"type": "function", "function": {"name": name}} for name in names]


def names_of(items: list[dict]) -> list[str]:
    return [((item.get("function") or {}).get("name") or "") for item in items]


def make_case(
    cid: str,
    message: str,
    *,
    tool_set: str = "all",
    command: str = "",
    activation: ActivationContext | None = None,
    trusted_skill: str = "",
    skill_allowed: list[str] | None = None,
    has_data_source: bool = False,
    has_workspace: bool = False,
    teams_enabled: bool = False,
    include_mcp: bool = True,
    allowed_mcp: list[str] | None = None,
    artifacts: list[dict] | None = None,
    discovered: list[str] | None = None,
    needs_chart: bool = False,
    needs_output: bool = False,
    completed: list[str] | None = None,
    recent: list[str] | None = None,
    required: list[str] | None = None,
    max_tools: int | None = None,
) -> dict:
    case = {
        "id": cid,
        "toolSet": tool_set,
        "message": message,
        "command": command,
        "activation": activation_dict(activation),
        "trustedSkill": trusted_skill,
        "skillAllowedTools": skill_allowed,
        "hasDataSource": has_data_source,
        "hasWorkspace": has_workspace,
        "teamsEnabled": teams_enabled,
        "includeMcp": include_mcp,
        "allowedMcpTools": allowed_mcp,
        "allowedArtifacts": artifacts,
        "discoveredTools": discovered,
        "stage": {
            "needsChart": needs_chart,
            "needsOutput": needs_output,
            "completedTools": list(completed or []),
        },
        "recentDiscoveredTools": recent,
        "requiredTools": required,
        "maxTools": max_tools,
    }
    case["expected"] = run_case(case)
    return case


def run_case(case: dict) -> dict:
    activation = None
    if case["activation"] is not None:
        activation = act(
            skill=case["activation"]["skillName"],
            command=case["activation"]["commandName"],
            internal=case["activation"]["internalAction"],
        )
    tools = schemas(TOOL_SETS[case["toolSet"]])
    skill_allowed = case["skillAllowedTools"]
    filtered = px.filter_tools_for_turn(
        tools,
        command=case["command"],
        activation=activation,
        skill_allowed_tools=frozenset(skill_allowed) if skill_allowed is not None else None,
        trusted_skill=case["trustedSkill"],
        user_message=case["message"],
        discovered_tools=case["discoveredTools"],
        has_data_source=case["hasDataSource"],
        has_workspace=case["hasWorkspace"],
        teams_enabled=case["teamsEnabled"],
        include_mcp=case["includeMcp"],
        allowed_mcp_tools=frozenset(case["allowedMcpTools"]) if case["allowedMcpTools"] is not None else None,
    )
    stage_ctx = ws.infer_workflow_stage(
        activation=activation or act(),
        user_message=case["message"],
        has_data_source=case["hasDataSource"],
        needs_chart=case["stage"]["needsChart"],
        needs_output=case["stage"]["needsOutput"],
        completed_tools=case["stage"]["completedTools"],
    )
    staged = ws.filter_tools_for_stage(filtered, stage_ctx)
    scoped = agent_mod._scope_tool_result_reader(staged, case["allowedArtifacts"] or [])
    limited = px.limit_tools_for_turn(
        scoped,
        user_message=case["message"],
        recent_discovered_tools=case["recentDiscoveredTools"],
        command=case["command"],
        trusted_skill=case["trustedSkill"],
        required_tools=set(case["requiredTools"]) if case["requiredTools"] is not None else None,
        max_tools=case["maxTools"] if case["maxTools"] is not None else 20,
    )
    read_enum = None
    for schema in scoped:
        if ((schema.get("function") or {}).get("name") or "") != "read_tool_result":
            continue
        props = (((schema.get("function") or {}).get("parameters") or {}).get("properties") or {})
        read_enum = (props.get("artifact_id") or {}).get("enum")
    return {
        "discovered": sorted(px.discover_tool_names_for_query(case["message"])),
        "filtered": names_of(filtered),
        "stage": stage_ctx.stage,
        "staged": names_of(staged),
        "scoped": names_of(scoped),
        "readToolResultEnum": read_enum,
        "limited": names_of(limited),
    }


def build_cases() -> list[dict]:
    cases: list[dict] = []

    # ── A. 每条用户消息，基础策略 ────────────────────────────────────────────────────────
    for index, message in enumerate(MESSAGES):
        cases.append(make_case(f"msg-{index:03d}", message))

    # ── B. 每个 slash 命令，分别在有/无 data、workspace、teams 的情况下 ──────────────────
    command_messages = {
        "checkpoint": "checkpoint 保存一下当前进度",
        "clear": "clear 清空当前对话",
        "compact": "compact 压缩一下上下文",
        "data": "data 我想连接一个新的数据源",
        "help": "help 看看有哪些功能",
        "instruction": "instruction 设置一条临时指令",
        "jobs": "jobs 查看后台任务进度",
        "knowledge": "knowledge 查一下知识库里的口径",
        "mcp": "mcp 需要什么配置",
        "new": "new 开一个新对话",
        "robot": "robot 配置飞书机器人",
        "sessions": "sessions 列出历史会话",
        "skills": "skills 有哪些技能",
        "status": "status 当前状态如何",
        "stop": "stop 停止当前任务",
        "teams": "teams 打开团队模式",
        "workspace": "workspace 挂载工作区",
    }
    for command in COMMANDS:
        message = command_messages[command]
        cases.append(make_case(f"cmd-{command}", message, command=command))
        cases.append(make_case(
            f"cmd-{command}-flags", message, command=command,
            has_data_source=True, has_workspace=True, teams_enabled=True,
        ))
        cases.append(make_case(
            f"cmd-{command}-activation", "分析一下这个季度的销售数据", command=command,
            activation=act(command=command), has_data_source=True,
        ))

    # ── C. 受信任的 Skill（4 个自带命令的内置项 + 若干代表项）─────────────────────────
    skill_messages = {
        "export": "把分析结果导出成 Excel",
        "report": "帮我写一份季度分析报告",
        "ppt": "生成一个汇报 PPT",
        "dashboard": "做一个销售看板",
        "business-model-canvas": "用商业模式画布梳理业务",
        "web-table": "抓取这个网页上的表格",
        "feishu-bitable": "读取飞书多维表格的数据",
        "workflow": "运行这个工作流",
        "ab-test-analysis": "分析这次 AB 实验的结果",
        "regression": "对销量做回归分析",
    }
    for skill in SKILLS:
        cases.append(make_case(
            f"skill-{skill}", skill_messages[skill],
            activation=act(skill=skill), trusted_skill=skill, has_data_source=True,
        ))
        cases.append(make_case(
            f"skill-{skill}-teams", skill_messages[skill],
            activation=act(skill=skill), trusted_skill=skill,
            has_data_source=True, has_workspace=True, teams_enabled=True,
        ))

    # Skill 声明的工具限制取交集（空列表必须表示"不限制"）。
    for index, allowed in enumerate([
        ["query_data", "get_schema"],
        ["run_analysis", "query_data", "select_chart"],
        [],
        ALL_NAMES,
        ["query_data", "mcp__github__search_code"],
    ]):
        cases.append(make_case(
            f"skill-allowed-{index}", "分析销售数据并给出结论",
            activation=act(skill="report"), trusted_skill="report",
            skill_allowed=allowed, has_data_source=True,
            tool_set="all+mcp", allowed_mcp=MCP_NAMES[:2],
        ))
    cases.append(make_case(
        "skill-allowed-mcp-global", "分析销售数据",
        trusted_skill="report", skill_allowed=["mcp__github__search_code"],
        tool_set="all+mcp", allowed_mcp=MCP_NAMES[:2], has_data_source=True,
    ))

    # ── D. has_data_source × has_workspace × teams_enabled ────────────────────────────────
    for data_source in (False, True):
        for workspace in (False, True):
            for teams in (False, True):
                for index, message in enumerate(FLAG_MESSAGES):
                    cases.append(make_case(
                        f"flags-d{int(data_source)}w{int(workspace)}t{int(teams)}-{index}", message,
                        has_data_source=data_source, has_workspace=workspace, teams_enabled=teams,
                    ))

    # ── E. 可见性上限、优先级排序、MCP 直通 ─────────────────────────────────────────────
    wide_message = (
        "团队 任务 工作流 飞书 浏览器 文件 图表 记忆 画布 搜索 网页 报告 导出 数据画像 清洗"
    )
    for max_tools in (1, 3, 5, 10, 20):
        cases.append(make_case(
            f"cap-{max_tools}", wide_message,
            has_data_source=True, has_workspace=True, teams_enabled=True,
            tool_set="all+mcp", allowed_mcp=MCP_NAMES,
            max_tools=max_tools,
        ))
    cases.append(make_case(
        "cap-default", wide_message,
        has_data_source=True, has_workspace=True, teams_enabled=True,
        tool_set="all+mcp", allowed_mcp=MCP_NAMES,
    ))
    cases.append(make_case(
        "cap-required", "分析销售数据",
        has_data_source=True, teams_enabled=True,
        tool_set="all+mcp", allowed_mcp=MCP_NAMES,
        required=["team_plan_create", "propose_report_outline"], max_tools=5,
    ))
    cases.append(make_case(
        "cap-recent", "查看任务列表",
        has_data_source=True, tool_set="all+mcp", allowed_mcp=MCP_NAMES,
        recent=RECENT_DISCOVERY, max_tools=8,
    ))
    cases.append(make_case(
        "cap-recent-overflow", "分析销售数据",
        has_data_source=True, has_workspace=True, teams_enabled=True,
        tool_set="all+mcp", allowed_mcp=MCP_NAMES,
        recent=[f"mcp__github__search_code"] + ALL_NAMES[:30], max_tools=12,
    ))
    cases.append(make_case(
        "cap-mcp-excluded", wide_message,
        has_data_source=True, has_workspace=True, teams_enabled=True,
        tool_set="all+mcp", include_mcp=False, max_tools=20,
    ))
    cases.append(make_case(
        "cap-command", "导出分析结果", command="export",
        activation=act(command="export"), has_data_source=True,
        tool_set="all+mcp", allowed_mcp=MCP_NAMES, max_tools=6,
    ))
    cases.append(make_case(
        "cap-skill-restricted", "生成 PPT 汇报", activation=act(skill="ppt"),
        trusted_skill="ppt", skill_allowed=["propose_ppt_outline", "generate_ppt", "query_data"],
        has_data_source=True, tool_set="all+mcp", allowed_mcp=MCP_NAMES, max_tools=4,
    ))
    cases.append(make_case(
        "cap-small-toolset", "", tool_set="essentials", max_tools=3,
    ))

    # ── F. read_tool_result 的可见性 / enum 取范围 ─────────────────────────────────────
    artifacts_none: list[dict] = []
    artifacts_one = [{"artifact_id": "tr_0123456789abcdef"}]
    artifacts_many = [{"artifact_id": f"tr_{index:032x}"} for index in range(25)]
    artifacts_mixed = [
        {"artifact_id": "ec_evidence_claim"},
        {"artifact_id": "tr_first"},
        {"artifact_id": "tr_first"},
        {"artifact_id": "tr_second"},
        {},
        {"artifact_id": ""},
        {"artifact_id": "not-an-artifact"},
        {"artifact_id": "tr_third"},
    ]
    for cid, artifacts in (
        ("none", artifacts_none),
        ("one", artifacts_one),
        ("many", artifacts_many),
        ("mixed", artifacts_mixed),
    ):
        cases.append(make_case(
            f"artifact-{cid}", "查看之前的工具结果", artifacts=artifacts,
        ))
        cases.append(make_case(
            f"artifact-{cid}-capped", "查看之前的工具结果", artifacts=artifacts,
            has_data_source=True, max_tools=5,
        ))
    cases.append(make_case(
        "artifact-empty-message", "", artifacts=artifacts_mixed,
    ))

    # ── G. workflow 阶段 ────────────────────────────────────────────────────────────────
    stage_cases = [
        ("general", {}, [], False),
        ("inspect-knowledge", {"has_data_source": True}, [], False),
        ("inspect-skill", {"activation": act(skill="report"), "trusted_skill": "report", "has_data_source": True}, [], False),
        ("inspect-command", {"activation": act(command="report"), "has_data_source": True}, [], False),
        ("analyze-get-schema", {"has_data_source": True}, ["get_schema"], False),
        ("analyze-query-data", {"has_data_source": True}, ["query_data"], False),
        ("analyze-chart", {"has_data_source": True, "needs_chart": True}, ["get_schema"], False),
        ("analyze-output", {"has_data_source": True, "needs_output": True}, ["get_table_detail"], False),
        ("visualize", {"has_data_source": True, "needs_chart": True}, ["query_data"], False),
        ("visualize-output", {"has_data_source": True, "needs_chart": True, "needs_output": True}, ["run_analysis"], False),
        ("propose-outline", {"has_data_source": True}, ["propose_ppt_outline"], False),
        ("propose-needs-output", {"needs_output": True}, [], False),
        ("generate-confirm", {"activation": act(internal="ppt_confirm")}, ["propose_ppt_outline"], False),
        ("generate-report-confirm", {"activation": act(internal="report_confirm")}, [], False),
        ("verify", {"has_data_source": True}, ["generate_ppt"], True),
        ("verify-needs-output", {"needs_output": True}, ["export_report"], True),
        ("chart-removes-mcp", {"has_data_source": True, "needs_chart": True}, ["select_chart"], False),
    ]
    for cid, options, completed, needs_output in stage_cases:
        cases.append(make_case(
            f"stage-{cid}", "分析销售数据并输出结果", tool_set="all+mcp", allowed_mcp=MCP_NAMES,
            completed=completed, needs_output=options.pop("needs_output", needs_output),
            has_data_source=options.pop("has_data_source", False),
            **options,
        ))

    # ── H. 显式 discovery 输入（更早的回合）────────────────────────────────────────────
    cases.append(make_case(
        "discovered-carried", "你好",
        discovered=["workspace_bash", "profile_data", "browser_click"],
    ))
    cases.append(make_case(
        "discovered-carried-blocked", "你好",
        discovered=["team_create", "workspace_bash"], teams_enabled=False,
    ))
    cases.append(make_case(
        "discovered-carried-restricted", "你好",
        discovered=["workspace_bash", "profile_data"], skill_allowed=["workspace_bash"],
    ))
    cases.append(make_case(
        "discovery-skipped-by-command", "打开文件 todo.md", command="status",
    ))
    cases.append(make_case(
        "discovery-skipped-by-skill", "打开文件 todo.md",
        activation=act(skill="export"), trusted_skill="export",
    ))
    cases.append(make_case(
        "discovery-runs-with-skill-activation", "打开文件 todo.md",
        activation=act(skill="export"),
    ))
    return cases


def build_discovery_cases() -> list[dict]:
    return [
        {"message": message, "names": sorted(px.discover_tool_names_for_query(message))}
        for message in MESSAGES
    ]


def build_ttl_cases() -> list[dict]:
    sequences = [
        ("single", [("打开文件 a.md", False)]),
        ("expiry", [
            ("打开文件 a.md", False),
            ("搜索一下网页", False),
            ("你好", False),
            ("查看任务列表", False),
        ]),
        ("command-resets", [
            ("打开文件 a.md", False),
            ("", True),
            ("查看任务列表", False),
            ("", True),
            ("画个 SWOT", False),
        ]),
        ("same-tool-twice", [
            ("打开文件 a.md", False),
            ("看一下 b.txt", False),
        ]),
        ("disjoint-turns", [
            ("画个商业模式画布", False),
            ("查看任务列表", False),
            ("配置 hooks", False),
            ("查看工作流状态", False),
        ]),
    ]
    out: list[dict] = []
    for cid, turns in sequences:
        session = ChatSession()
        after: list[dict] = []
        for message, is_command in turns:
            added = session.record_discovered_tools("" if is_command else message)
            after.append({
                "discovered": list(session.discovered_tools),
                "turns": [list(turn) for turn in session.discovered_tool_turns],
                "added": list(added),
            })
        out.append({
            "id": cid,
            "inputs": [
                {"message": message, "isCommand": is_command} for message, is_command in turns
            ],
            "after": after,
        })
    return out


def build_restore_cases() -> list[dict]:
    cases = [
        ("per-turn", [[["a", "b"], ["b", "c"]], None]),
        ("per-turn-window", [[["a"], ["b"], ["c"], ["d"]], None]),
        ("per-turn-non-list", [[["a"], "x", None, ["d"]], None]),
        ("per-turn-empty-lists", [[[], []], None]),
        ("legacy", [None, ["a", "b", "a"]]),
        ("legacy-with-empty", [None, ["", "a", ""]]),
        ("both-preferred", [[["x"]], ["legacy"]]),
        ("neither", [None, None]),
        ("legacy-slots", [None, [f"tool_{index}" for index in range(25)]]),
        ("coerce-names", [[["a", 1, None, True]], None]),
    ]
    out: list[dict] = []
    for cid, (raw_turns, legacy) in cases:
        session = ChatSession()
        state: dict = {}
        if raw_turns is not None:
            state["discovered_tool_turns"] = raw_turns
        if legacy is not None:
            state["discovered_tools"] = legacy
        session.restore_rewind_state(state)
        out.append({
            "id": cid,
            "rawTurns": raw_turns,
            "legacyDiscovered": legacy,
            "expected": {
                "discovered": list(session.discovered_tools),
                "turns": [list(turn) for turn in session.discovered_tool_turns],
            },
        })
    return out


def coverage() -> dict:
    discoverable = [spec.name for spec in BUILTIN_TOOL_REGISTRY.all() if spec.discoverable]
    seen: set[str] = set()
    for message in MESSAGES:
        seen |= px.discover_tool_names_for_query(message)
    return {
        "discoverable": discoverable,
        "uncovered": sorted(set(discoverable) - seen),
    }


def main() -> None:
    cases = build_cases()
    discovery = build_discovery_cases()
    ttl = build_ttl_cases()
    restore = build_restore_cases()
    cov = coverage()
    if cov["uncovered"]:
        raise SystemExit(f"discovery golden misses tools: {cov['uncovered']}")
    payload = {
        "maxVisibleTools": px.MAX_VISIBLE_TOOLS,
        "discoveredToolTtlTurns": 3,
        "maxActiveDiscoveredTools": 20,
        "essentialTools": sorted(px._ESSENTIAL_TOOL_NAMES),
        "teamTools": sorted(px._TEAM_TOOLS),
        "taskTools": sorted(px._TASK_TOOLS),
        "workflowTools": sorted(px._WORKFLOW_TOOLS),
        "feishuTools": sorted(px._FEISHU_TOOLS),
        "toolSets": TOOL_SETS,
        "cases": cases,
        "discovery": discovery,
        "ttl": ttl,
        "restore": restore,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT.relative_to(ROOT)}: {len(cases)} pipeline cases, "
        f"{len(discovery)} discovery cases, {len(ttl)} ttl sequences, "
        f"{len(restore)} restore cases; discoverable tools covered: "
        f"{len(cov['discoverable'])}/{len(cov['discoverable'])}"
    )


if __name__ == "__main__":
    main()
