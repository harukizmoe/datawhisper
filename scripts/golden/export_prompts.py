"""系统提示词移植版的 golden 用例 + 抽取出的静态文本，由真实 Python 代码产出。

    .venv/bin/python scripts/golden/export_prompts.py

写入
  * server/test/golden/prompts.json            —— TS 移植版必须逐字复现的每个用例
  * server/src/agent/prompt-text/*.txt|json    —— 静态提示词块，与 agent/prompts.py 逐字节相同
    （TS 移植版以文本方式导入它们；需要时重新生成，不要手改）

可在任意目录运行；输出是确定性的（重跑 => 零 diff）。
"""
from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import agent.prompts as P  # noqa: E402

GOLDEN_OUT = ROOT / "server" / "test" / "golden" / "prompts.json"
TEXT_DIR = ROOT / "server" / "src" / "agent" / "prompt-text"

# python 属性 -> prompt-text/ 内的文件名
BLOCKS = {
    "CORE_RULES": "core-rules.txt",
    "DATA_RULES": "data-rules.txt",
    "WORKSPACE_RULES": "workspace-rules.txt",
    "KNOWLEDGE_RULES": "knowledge-rules.txt",
    "CHART_RULES": "chart-rules.txt",
    "OUTPUT_RULES": "output-rules.txt",
    "TEAMS_RULES": "teams-rules.txt",
    "HOOKS_RULES": "hooks-rules.txt",
    "BROWSER_RULES": "browser-rules.txt",
    "INGEST_RULES": "ingest-rules.txt",
    "MULTI_SOURCE_RULES": "multi-source-rules.txt",
    "UNNAMED_COLUMN_RULES": "unnamed-column-rules.txt",
    "DIAGRAM_RULES": "diagram-rules.txt",
    "SKILL_CATALOG_RULES": "skill-catalog-rules.txt",
    # 由 prompts._build_analyze_guide / _build_chart_ids 在 import 时构建
    "_ANALYZE_GUIDE": "analyze-guide.txt",
    "_CHART_IDS": "chart-ids.txt",
}

FLAGS = [
    "has_data_source", "has_workspace", "needs_workspace", "teams_enabled", "needs_chart",
    "needs_output", "needs_hooks", "needs_browser", "needs_ingest", "has_knowledge",
    "has_unnamed_columns", "needs_diagram",
]


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w.title() for w in rest)


def ctx_json(ctx: P.PromptContext) -> dict:
    return {camel(k): v for k, v in dataclasses.asdict(ctx).items()}


def context_cases() -> list[dict]:
    kw: list[dict] = [{}]
    kw += [{f: True} for f in FLAGS]
    kw.append({f: True for f in FLAGS})
    kw.append({**{f: True for f in FLAGS}, "source_count": 2, "skill_catalog": "- sku: do things"})
    kw += [{"source_count": n} for n in (0, 1, 2, 3)]
    kw += [{"source_count": 2, "has_data_source": True}, {"source_count": -1}]
    kw += [
        {"skill_catalog": ""},
        {"skill_catalog": "- sales-review: 销售复盘 SOP\n- churn: 流失分析"},
        {"skill_catalog": "  padded catalog \n\n"},
        {"skill_catalog": "   "},
        {"skill_catalog": "price $1 and \\1 and {braces} and {0} and %s"},
        {"skill_catalog": "\u3000全角空白\u3000"},
        {"skill_catalog": "x", "has_data_source": True, "needs_chart": True},
        {"activation_kind": "skill", "activation_name": "canvas", "needs_diagram": True},
        {"activation_kind": "command", "activation_name": "chart"},
        {"has_data_source": True, "has_knowledge": True, "needs_chart": True, "needs_output": True,
         "source_count": 2},
        {"teams_enabled": True, "needs_hooks": True, "needs_browser": True, "needs_ingest": True},
    ]
    seen: list[dict] = []
    out: list[dict] = []
    for k in kw:
        if k in seen:
            continue
        seen.append(k)
        ctx = P.PromptContext(**k)
        out.append({"context": ctx_json(ctx), "prompt": P.get_system_prompt(ctx)})
    # 无参数 / None 的调用形式
    out.append({"context": None, "prompt": P.get_system_prompt(None)})
    # knowledge_summary 会被接受并忽略
    ctx = P.PromptContext(has_knowledge=True)
    assert P.get_system_prompt(ctx, knowledge_summary="SECRET") == P.get_system_prompt(ctx)
    return out


MESSAGES: list[str] = [
    # --- 空 / 退化输入 ---
    "", " ", "\n", "\t \n", "?", "...", "。",
    # --- 问候语（knowledge 闸门：非业务 fullmatch）---
    "你好", "您好", "你好！", "你好?", "你好？？", "你好。", "你好 ", "  你好  ", "你好呀", "你好吗",
    "你是谁", "你是谁？", "你叫什么", "你叫什么名字", "介绍一下你自己", "介绍你自己", "介绍一下你自己。",
    "who are you", "Who Are You?", "WHO  ARE  YOU", "what is your name", "What's your name?",
    "what's your name!!", "hello", "Hello!", "HELLO", "hi", "Hi.", "hi!", "hi there", "hello world",
    "thanks", "thank", "Thanks!", "thanks a lot", "谢谢", "谢谢！", "谢谢你", "help", "Help?", "帮助", "帮助。",
    "help me analyze sales", "hello\n", "\nhello\n", "hello\n\nthere", "hi\u3000", "\u3000hi",
    "hı", "HİLLO", "hİ", "hı!", "Hi\x85", "\x85hi", "\x1chi\x1f", "hi\ufeff", "\ufeffhi",
    # --- 工作区 ---
    "请读取工作目录下的文件", "打开工作区", "查找文件 report", "读取文件 data.csv", "打开文件夹", "列出磁盘上的文件",
    "查看本地文件", "list my local file", "list my local   file", "local\tfile", "local\nfile", "localfile",
    "on disk", "on   disk please", "ondisk", "check the Workspace", "WORKDIR", "workdir=/tmp", "my folder",
    "Folder structure", "directory listing", "Directory", "目录", "文件夹里有什么", "磁盘空间", "硬盘",
    "local\u00a0file", "local\u3000file", "local\x85file", "local\x1cfile", "local\ufefffile", "on\u2028disk",
    "WORKSPACE", "wοrkspace",  # 希腊字母 omicron
    "sales.csv", "sales.CSV", "sales.xlsx", "sales.xls", "sales.xlsm", "sales.doc", "sales.docx", "sales.txt",
    "notes.md", "report.pdf", "report.PDF", "report.pdfx", "report.pdf文件", "report.pdf_", "report.pdf1",
    "report.pdf.bak", "report.pdf。", "report.pdf，", "见 a.csv", "a.csv\u00e9", "a.csv\u4e2d", "a.csv\u0661",
    "a.csv\u0301", "a.csv\u2160", "a.csv\u00b2", "a.csv\u00aa", "a.csv\u02b0", "a.csv\u1100",
    "销售数据.xlsx 分析", "data.json", "data.xlsb", "xlsx", ".csv", "a. csv", "a.docs", "a.doc.", "a.xls\n",
    "A.XLSX", "a.Docx", "a.TxT",
    # --- hook 配置 ---
    "配置 webhook", "设置 Webhook 回调", "hooks", "hook", "Hook config", "callback url", "回调地址", "自动化流程",
    "automation", "钩子配置", "配置这个链接", "配置这个 url", "配置这个URL", "配置这个 https://x.com/a 的链接",
    "配置这个" + "字" * 20 + "链接", "配置这个" + "字" * 21 + "链接", "配置这个\n链接", "配置这个\r链接",
    "配置这个\u2028链接", "配置这个\u0085链接", "配置这个链接", "配置这个", "配置这个abc", "gohooks", "webhooks!",
    "HOOKS", "wehook", "call back", "callbacks",
    # --- 浏览器 ---
    "google it", "Google", "baidu", "Bing search", "search for revenue", "SEARCH", "搜索一下", "调研竞品", "查找资料",
    "查一下", "打开浏览器", "browser", "Browser use", "research", "websearch", "百度一下", "谷歌", "浏览", "查找", "research the market",
    # --- ingest（URL + 提示）---
    "https://example.com", "https://example.com 抓取表格", "抓取 http://a.b/c 的数据", "HTTP://X.COM/T csv",
    "导入 https://x.com/a.csv", "fetch https://x.com", "scrape the page https://x.com/p", "crawl http://x",
    "把 https://x.com/t 转成表", "把 https://x.com/t 转成一个数据表", "把 https://x.com/t 转成" + "字" * 6 + "表",
    "把 https://x.com/t 转成" + "字" * 7 + "表", "https://x.com/t table", "https://x.com/t TABLE", "dataset at https://x",
    "https://x.com/a.json", "see https://x.com/doc.pdf", "ftp://x.com 表格", "www.x.com 表格", "https:// 表格",
    "https:/x 表格", "表格 https://", "https://\u3000表格", "https://\n表格", "http://x", "https://x。表格",
    "提取 https://x.com", "爬取 https://x.com/p", "抓下来 https://x", "表格", "数据", "csv", "import", "important https://x",
    "https://importer.example", "https://x.com/路径 数据", "https://x?a=1&b=2 table", "http s://x.com 表格",
    "https://x\ufeff", "https://\ufeff 表格", "https://\x85 表格", "https://\x1c 表格", "https://\u2028 表格",
    # --- 图表 ---
    "画个图表", "生成图表", "可视化销售数据", "画图", "绘图", "看板", "dashboard", "Dashboard设计", "create a chart",
    "plot the data", "visualize", "visualise", "Visualization", "visualiz", "visualis", "visuali", "visualise it",
    "VISUALISE", "VİSUALİZE", "vısualıze", "chartreuse", "charts", "bar chart", "条形图", "折线图", "饼图", "chrt",
    # --- 示意图 ---
    "商业模式画布", "价值主张画布", "BCG 矩阵", "bcg矩阵", "BCG matrix", "bcg   matrix", "bcg\nmatrix", "SWOT 分析",
    "swot", "波特五力", "porter five forces", "Porter's five forces", "porter\nfive", "四象限", "strategic canvas",
    "strategic  business canvas", "business model canvas", "draw.io", "drawio", "draw io", "draw-io", "diagram",
    "Diagram of flow", "画布", "框架图", "战略图", "绘制矩阵", "绘制一个矩阵", "绘制画布", "绘制分析", "绘制市场分析图",
    "绘制\n矩阵", "绘制\r矩阵", "绘制\u2028矩阵", "BCG\u00a0矩阵", "bcg\u3000matrix", "bcg\ufeffmatrix", "bcg\x85matrix",
    "BCG\x1fmatrix", "porter 的 five", "porterfive", "ＢＣＧ矩阵",
    # --- knowledge：业务分析 ---
    "分析一下销售趋势", "统计订单数", "查询用户", "计算利润", "汇总", "总结", "对比去年", "比较两组", "趋势", "变化", "增长率",
    "下降", "占比", "分布", "排名", "预测", "回归", "相关性", "异常", "诊断", "洞察", "指标", "口径", "规则", "成本", "收入",
    "利润", "订单", "客户", "用户", "销售", "运营", "转化", "留存", "流失", "效率", "绩效", "预算", "业务", "报表", "数据",
    "schema", "SQL", "select * from t", "metric", "KPI", "kpi", "analyze", "analyse", "ANALYZE", "analysis", "analyzing",
    "analyzer", "analyz", "analys", "trend", "forecast", "revenue", "profit", "cost", "sales", "customer", "retention",
    "churn", "Churn rate", "ANALİZE", "anaıyze", "ANALYſE", "analyse sales", "sales\u212a", "\u212apı", "KPİ", "kpı",
    "今天天气怎么样", "讲个笑话", "写一首诗", "1+1等于几", "天气", "random chatter", "the quick brown fox",
    # --- knowledge：文件导航 vs 分析 ---
    "打开文件", "读取文件", "查找文件", "列出文件", "浏览目录", "上传文件", "删除文件夹", "移动文件", "重命名文件",
    "open file", "read the file", "find folder", "list directory", "Browse Directory", "upload file", "delete file",
    "move folder", "rename file", "open", "file", "open " + "x" * 20 + "file", "open " + "x" * 21 + "file",
    "open\nfile", "open\rfile", "open\u2028file", "open\u0085file", "打开文件并分析", "打开文件然后统计订单",
    "读取文件，计算利润", "open file and analyze", "open the file and compare", "list file then calculate",
    "browse folder sales", "上传文件 销售数据", "上传文件 sales", "删除文件 订单", "open file with revenue",
    "open file churn", "read file trend", "read file sql", "read file schema", "读取文件 kpi", "OPEN FILE",
    "Open File Trend", "OPEN FOLDER ANALYZE", "open directory forecast", "open directory compare", "open directory calculate",
    "find file 趋势", "find file 回归", "find file 洞察", "find file 诊断", "find file 汇总", "find file 总结",
    "find file 报表", "移动文件 排名", "重命名文件 比较", "list file 统计",
    # --- 混合 / 长文本 / unicode ---
    "请帮我分析 https://x.com/a.csv 的销售数据并画图", "帮我搜索一下并抓取表格 https://a.com",
    "x" * 5000, "分析" * 3000, "hello " * 1000, "\n".join(["line"] * 50), "😀 分析 😀", "😀" * 10, "𠮷野家 销售",
    "ＳＱＬ", "ＳＱＬ select", "Ｋpi", "re-visit", "naïve analysis", "çok güzel", "İstanbul sales", "ISTANBUL SALES",
    "straße revenue", "ǅ", "ᾈ",
]


SCHEMAS: list[str] = [
    "", " ", "col", "col_1", "col_23", "col_", "col_x", "col1", "Col", "COL", "cols", "mycol", "my_col", "my col",
    "id, col, name", "id,col,name", "id|col|name", "(col)", "[col_2]", "'col'", "\"col\"", "col\ncol_2", "name col",
    "col_٣", "col_٣٤", "col_３", "col_１２", "col_²", "col_½", "col_一", "col_x1", "col_1a", "col_1_", "col_1_2", "col__1",
    "col-1", "col.1", "col:1", "col,", "列 col", "col列", "colé", "colü", "coL", "cöl", "ｃｏｌ", "the col_2 is blank",
    "_col", "1col", "col_12345678901234567890", "colcol", "col col", "colum", "column", "Unnamed: 0", "Unnamed: 1",
    "a" * 1000 + " col", "col" + "x" * 1000, "字col", "col字", "col_1字", "字col_1", "\u00c0col", "col\u00c0", "col\u0301",
    "\u0301col", "col\u2160", "col\u00b2", "table t (id int, col text)", "table t (id int, col_2 text, col_3 text)",
]


TEMP_PROMPTS: list[str | None] = [
    None, "", " ", "\n\n", "\t", "只回答 yes 或 no", "  padded  ", "\n\n\n lead", "trail \n\n\n", "a\n\n\n\nb", "a\n\nb", "a\nb",
    "a\n\n\n\n\n\n\nb\n\n\n\nc", "a \n\n\n b", "a\r\n\r\n\r\nb", "a\n\n\n\u3000\nb",
    "<think>secret</think>visible", "<think>secret</think>", "<think></think>", "<think>a</think> after", "before <think>a</think> after",
    "<THINK>a</THINK>b", "<Think>a</Think>b", "<think >a</think >b", "<think\n>a</think>b", "<think attr=\"1\">a</think>b",
    "<think attr=\">\">a</think>b", "<think a='x'>a</think\t>b", "<think>line1\nline2\n</think>\nkept",
    "<think>a</think><think>b</think>c", "<think>a</think>x<think>b</think>y", "<think>a<think>b</think>c</think>d",
    "<think>a</think>x</think>y", "<think>a</think><think>unclosed", "x<think>a</think>y<think>never closed because",
    "x<think>never closed", "<think>never closed", "<think", "<think>", "x<think>", "<think/>x", "<think />x", "<think/>",
    "keep <think attr> rest", "keep <THINK rest> more", "keep <think rest",
    "</think>orphan", "orphan</think>", "a</think>b", "a</THINK>b", "a</think >b", "a</think\n>b", "a</think\u3000>b",
    "a</think\u00a0>b", "a</think\x85>b", "a</think\x1c>b", "a</think\ufeff>b", "a</think\u2028>b", "</think></think>",
    "</thinking>keep", "</thinker>keep", "</think x>keep", "</ think>keep", "< /think>keep",
    "<thinking>keep</thinking>", "<thinker>x</thinker>", "<think考虑>x</think>y", "<think_>x</think>y", "<think1>x</think>y",
    "<think-x>x</think>y", "<think:x>x</think>y", "<think.x>x</think>y", "<think\u00e9>x</think>y", "<think\u0661>x</think>y",
    "<think\u0301>x</think>y", "<think\u00aa>x</think>y", "<think\u2160>x</think>y", "<thİnk>x</think>y", "<thınk>x</think>y",
    "<thınk>x</thınk>y", "<tHİNK>x</think>y",
    "<think>思考中</think>请用中文回答", "<think>思考</think>\n\n\n\n请用中文回答\n\n\n", "<think>\n\n\n</think>\n\n\n\nx",
    "x\n\n\n<think>a</think>\n\n\ny", "x<think>a</think>\n\n\ny", "<think>a</think>\u3000", "\u3000<think>a</think>\u3000z\u3000",
    "\ufeffbom", "bom\ufeff", "\x85nel\x85", "\x1cfs\x1f", "\u2028ls\u2029", "\u200bzw\u200b", "\u00a0nb\u00a0", "\u180eMV\u180e",
    "z" * 3999, "z" * 4000, "z" * 4001, "z" * 4002, "z" * 10000, "字" * 4000, "字" * 4001, "字" * 5000,
    "a" * 3999 + "\u3000", "a" * 4000 + "\u3000" + "b", "a" * 3990 + "\n\n\n\n\n\n\n\n\n\n" + "b" * 100,
    "a" * 3999 + "\n\n\n\nb", "a" * 3998 + "\n\n\n\n\n\nb",
    "😀" * 4000, "😀" * 4001, "😀" * 5000, "a" + "😀" * 4000, "a" * 3999 + "😀", "a" * 3999 + "😀😀", "a" * 3998 + "😀",
    "𠮷" * 4005, "<think>x</think>" + "😀" * 4001, "<think>x" + "😀" * 4001, "😀" * 4001 + "<think>x", "😀" * 10 + "<think>x</think>" + "😀" * 4000,
    "z" * 4001 + "<think>x", "z" * 4001 + "<think>x</think>", "z" * 3000 + "<think>" + "q" * 2000 + "</think>" + "z" * 1500,
    "⚠️ 注意", "a\u0000b", "tab\tinside", "emoji 👨\u200d👩\u200d👧 family", "多\u6bb5\n\n\n文本\n\n\n\n结束",
]


def temp_cases() -> list[dict]:
    out = []
    for t in TEMP_PROMPTS:
        out.append({
            "input": t,
            "stripped": P.strip_temp_prompt_thinking(t),
            "section": P.build_temp_prompt_section(t),
        })
    return out


def matcher_cases() -> list[dict]:
    out = []
    for m in MESSAGES:
        out.append({
            "message": m,
            "workspace": P.message_needs_workspace_rules(m),
            "workspaceWithWorkspace": P.message_needs_workspace_rules(m, has_workspace=True),
            "hooks": P.message_needs_hooks_rules(m),
            "browser": P.message_needs_browser_rules(m),
            "ingest": P.message_needs_ingest_rules(m),
            "chart": P.message_needs_chart_rules(m),
            "diagram": P.message_needs_diagram_rules(m),
            "diagramWithCanvas": P.message_needs_diagram_rules(m, has_canvas_skill=True),
            "knowledge": P.message_needs_knowledge(m),
        })
    return out


def schema_cases() -> list[dict]:
    return [{"schema": s, "unnamed": P.schema_has_unnamed_columns(s)} for s in SCHEMAS]


def write_text_files() -> dict:
    TEXT_DIR.mkdir(parents=True, exist_ok=True)
    for attr, fname in BLOCKS.items():
        (TEXT_DIR / fname).write_bytes(getattr(P, attr).encode("utf-8"))
    (TEXT_DIR / "command-hints.json").write_bytes(
        (json.dumps(P.COMMAND_HINTS, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )
    return {
        "blocks": {attr: getattr(P, attr) for attr in BLOCKS},
        "commandHints": dict(P.COMMAND_HINTS),
    }


def main() -> None:
    assert len(MESSAGES) >= 60
    statics = write_text_files()
    data = {
        **statics,
        "tempPromptMaxChars": P.TEMP_PROMPT_MAX_CHARS,
        "contexts": context_cases(),
        "matchers": matcher_cases(),
        "schemas": schema_cases(),
        "tempPrompts": temp_cases(),
    }
    GOLDEN_OUT.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN_OUT.write_bytes((json.dumps(data, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    pos = {k: sum(1 for c in data["matchers"] if c[k]) for k in
           ("workspace", "workspaceWithWorkspace", "hooks", "browser", "ingest", "chart", "knowledge")}
    print(f"{len(data['contexts'])} contexts, {len(data['matchers'])} messages, {len(data['schemas'])} schemas, "
          f"{len(data['tempPrompts'])} temp prompts, {len(P.COMMAND_HINTS)} command hints, {len(BLOCKS)} blocks")
    print("positives per matcher:", pos)


if __name__ == "__main__":
    main()
