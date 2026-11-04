#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工具调用参数的前置校验。

在任何工具 dispatch 之前运行，因此危险输入（写 SQL、格式错误的 schema）永远
到不了底层执行器。

集中放在这里的目的：
  - "什么被拦截"的策略只有一处
  - 测试无需起一个 LLM 就能验证这些规则
  - BusinessAgent 与将来任何旁路（例如 /sql 快速路径）都能套用同样的护栏

SQL 校验策略（AST 级，而非关键词匹配）
---------------------------------------------------------
旧做法：关键词黑名单（DROP/DELETE/…）+ "必须以 SELECT 开头"。

旧做法的问题：
  1. 误报：SELECT update_time FROM … 或 WHERE note = 'please DELETE'
     明明是只读查询却被拦截。
  2. 绕过：DuckDB 允许通过 read_csv('/etc/passwd') 读任意文件、ATTACH 外部
     数据库、INSTALL/LOAD 扩展、COPY … TO … —— 这些都可以写成 SELECT 开头，
     或完全不含被拦关键词。

新做法（A4）：
  - 用 sqlglot 把 SQL 解析成 AST 并检查结构。
  - 只接受单条 SELECT 或 WITH（CTE）语句。
  - 递归扫描被禁函数调用与 COPY 节点。
  - 对文件读取函数（read_csv / read_parquet / read_json / read_text /
    read_blob）做路径白名单校验：取出字面量路径参数，相对 workspace 的
    allowed roots（workdir + uploads + Information + artifacts + cache）解析，
    非字面量或超出白名单一律拒绝。
  - sqlglot 不可用时回退到旧的关键词启发式（因此没有这个可选依赖时应用仍可用）。

A6 放宽（允许写，但只在内存中）：
  - 写语句（CREATE TABLE/VIEW、INSERT、UPDATE、DELETE、DROP TABLE/VIEW、
    ALTER、TRUNCATE、MERGE）现在可以通过校验。执行层会把它们重定向到内存
    快照，用户磁盘上的数据永远不会被改动。
  - 系统语句仍然拦截：PRAGMA / INSTALL / LOAD / ATTACH / DETACH /
    COPY TO / SET / BEGIN-COMMIT / 对 FUNCTION、MACRO、INDEX、
    SCHEMA、SEQUENCE、TYPE 的 CREATE-DROP。

DuckDB 连接级锁定（第二层，在 _utils.py 中，A4 之后）：
  SET enable_external_access = false  # 仍然禁网络（HTTP/S3 扩展）
  # A4 起：不再 SET disabled_filesystems='LocalFileSystem' —— 改由本模块的
  # AST 路径白名单做精细控制，工作目录内文件可直读。
"""
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple, TYPE_CHECKING


ASK_USER_EMPTY_OPTIONS = "ASKU-001"
ASK_USER_OPTION_COUNT = "ASKU-002"
ASK_USER_INVALID_ARGUMENT = "ASKU-003"

if TYPE_CHECKING:
    from data.workspace import WorkspacePathAuthorization

log = logging.getLogger(__name__)

# JSON 参数中带 `sql` 字段、会打到数据源的工具名。
SQL_TOOLS = {"create_analysis_table", "query_data", "generate_chart", "run_analysis"}


@dataclass(frozen=True)
class SqlValidationResult:
    """供 UI 徽标使用的结构化 SQL 校验结果。

    status:
      - "passed":   sqlglot AST 校验通过（完全可信）。
      - "degraded": sqlglot 不可用或无法解析该语句，于是执行了较弱的启发式
                    检查并通过。以带错误码（SQLG-001/002）的
                    "sqlglot 错误" 徽标呈现。
      - "failed":   校验拒绝了该 SQL（AST 或启发式）—— 被拦截。
    message: 人类可读的细节（通过时为空）。
    used_heuristic: 走的是关键词兜底而非 AST 时为 True。
    code: degraded/failed 结果的稳定错误码（如 "SQLG-001"），
                    记录于 Instruction.md；通过时为空。
    """

    status: Literal["passed", "failed", "degraded"]
    message: str
    used_heuristic: bool = False
    code: str = ""


# sqlglot 环境错误码 —— 原因与解决方法记录在 Instruction.md「错误代码」一节。
SQLG_NOT_INSTALLED = "SQLG-001"   # sqlglot 未安装
SQLG_PARSE_FAILED = "SQLG-002"    # sqlglot 无法解析该 SQL（方言差异）

# 无论如何都绝不能出现在我们执行的任何 SQL 中的函数。
# 这些是真正的"危险"函数：扩展管理、外部数据库、网络、写入文件、元命令。
# 注意：read_csv / read_parquet 等"文件读取"函数不再在此列表 —— 它们受
# _FILE_READ_FUNCTIONS 路径白名单控制（A4）。
_BANNED_FUNCTIONS = {
    # 文件系统写入
    "copy_to",
    # 扩展管理（可加载任意原生代码）
    "install", "load",
    # 挂载外部数据库
    "attach", "detach",
    # 元命令
    "pragma",
    # 网络访问（httpfs 扩展）
    "http_get", "httpget", "http_post",
}

# 受路径白名单控制的文件读取函数。
# 这些函数的"第一个参数"必须是字面量字符串（或字面量列表），resolve 后必须在
# workspace 的 allowed_roots 内。非字面量参数（@var / 列引用 / 拼接）一律拒绝。
# sqlglot 对部分函数有专用节点（ReadCSV/ReadParquet/ReadJSON），其余解析为 Anonymous。
_FILE_READ_FUNCTIONS = {
    "read_csv", "read_csv_auto",
    "read_parquet", "read_parquet_auto",
    "read_json", "read_json_auto",
    "read_text", "read_text_auto",
    "read_blob", "read_blob_auto",
}

# sqlglot 的专用文件读取节点类型名（小写）。
# ReadCSV / ReadParquet / ReadJSON 由 sqlglot 专门识别；其余在 Anonymous 里。
_FILE_READ_NODE_TYPES = {"readcsv", "readparquet", "readjson"}

# 通配符字符（用于 read_csv('data/*.csv') 形式）
_GLOB_CHARS = ("*", "?", "[", "]")

# 禁止的网络协议前缀（任何路径参数带这些前缀一律拒绝，防止 SSRF）
_BLOCKED_URL_SCHEMES = (
    "http://", "https://", "ftp://", "ftps://",
    "s3://", "gs://", "gcs://", "azure://", "abfs://", "abfss://",
    "hdfs://", "webhdfs://", "sftp://", "scp://",
)


def _is_file_read_anonymous(node) -> bool:
    """Anonymous 节点是否是文件读取函数。"""
    if type(node).__name__ != "Anonymous":
        return False
    return (node.name or "").lower() in _FILE_READ_FUNCTIONS


def _extract_path_literals(node) -> Tuple[List[str], bool]:
    """从文件读取函数节点提取字面量路径参数。

    返回 (paths, all_literal)：
      - paths: 字面量字符串路径列表（可能多个，如 read_csv(['a.csv','b.csv'])）
      - all_literal: True 表示所有路径参数都是字面量；False 表示存在非字面量参数
        （@var / 列引用 / 拼接表达式等），调用方应拒绝整条 SQL。
    """
    paths: List[str] = []
    all_literal = True

    # 找出"第一个参数"的位置：对 ReadCSV/ReadParquet，是 node.this；
    # 对 Anonymous，是 node.expressions[0]。
    # 但实际上 read_csv 的第一个参数既可以是字面量，也可以是 Array of literals。
    candidates = []

    # ReadCSV/ReadParquet/ReadJSON：this 字段是第一个参数
    if hasattr(node, "this") and node.this is not None:
        candidates.append(node.this)
    # Anonymous：expressions 列表是所有参数，第一项是路径
    if type(node).__name__ == "Anonymous":
        # node.expressions 是所有参数（路径 + 命名参数如 header=true）
        # 只取第一个作为路径参数
        if node.expressions:
            candidates = [node.expressions[0]]

    for cand in candidates:
        _extract_from_expr(cand, paths)

    # 检查路径参数是否都是字面量：如果 candidates 非空但 paths 空，说明非字面量
    if candidates and not paths:
        all_literal = False

    return paths, all_literal


def _extract_from_expr(expr, paths: List[str]) -> None:
    """从单个表达式节点提取字面量路径，追加到 paths。"""
    # 单个字符串字面量
    try:
        from sqlglot import expressions as exp
    except ImportError:
        return

    if isinstance(expr, exp.Literal) and expr.is_string:
        paths.append(expr.this)
        return

    # 字面量数组：read_csv(['a.csv', 'b.csv'])
    if isinstance(expr, exp.Array):
        for item in expr.expressions or []:
            if isinstance(item, exp.Literal) and item.is_string:
                paths.append(item.this)
            else:
                # 列表里有非字面量
                pass
        return

    # 其他类型（Column / Parameter / Abs / Binary 操作等）→ 非字面量，不追加
    # 调用方通过 paths 为空判断


def _validate_file_read_paths(stmt, allowed_roots: List[Path]) -> Optional[str]:
    """扫描 SQL AST，对所有文件读取函数做路径白名单校验。

    返回错误字符串或 None。
    """
    try:
        from sqlglot import expressions as exp
    except ImportError:
        return None  # sqlglot 不可用，跳过路径白名单（heuristic fallback 会兜底）

    if not allowed_roots:
        # 无白名单根（固定但不可用的 Workspace）—— 一律拒绝文件读取；
        # 调用方未传白名单时，validate_sql_structured 已补上默认根
        # uploads/Information（见 _default_allowed_roots）
        allowed_roots = []

    # 标准化白名单根（resolve）
    norm_roots: List[Path] = []
    for r in allowed_roots:
        try:
            norm_roots.append(r.expanduser().resolve())
        except (OSError, RuntimeError):
            continue

    # 遍历所有节点，找文件读取函数
    for node in stmt.walk():
        is_read_node = False
        paths: List[str] = []

        # 专用节点：ReadCSV / ReadParquet / ReadJSON
        node_type = type(node).__name__.lower()
        if node_type in _FILE_READ_NODE_TYPES:
            is_read_node = True
            paths, all_lit = _extract_path_literals(node)
            if not all_lit:
                return (f"禁止非字面量路径参数：{node_type}() 的路径参数必须是"
                        "字符串字面量，不接受变量/列引用/拼接表达式。")

        # Anonymous 节点：read_csv_auto / read_text / read_blob 等
        elif _is_file_read_anonymous(node):
            is_read_node = True
            paths, all_lit = _extract_path_literals(node)
            if not all_lit:
                return (f"禁止非字面量路径参数：{node.name}() 的路径参数必须是"
                        "字符串字面量，不接受变量/列引用/拼接表达式。")

        # DuckDB 接受 SELECT * FROM 'file.csv' 作为文件扫描。sqlglot 会把它
        # 解析成带引号的 Table 标识符而非 ReadCSV，因此它必须走同一套
        # Workspace 白名单。
        elif isinstance(node, exp.Table):
            identifier = getattr(node, "this", None)
            quoted = bool(getattr(identifier, "args", {}).get("quoted"))
            name = str(getattr(node, "name", "") or "")
            if quoted and _looks_like_file_table(name):
                is_read_node = True
                paths = [name]

        if not is_read_node:
            continue

        # 校验每个路径
        for path_str in paths:
            err = _check_single_path(path_str, norm_roots)
            if err:
                return err

    return None


def _looks_like_file_table(value: str) -> bool:
    lowered = str(value or "").strip().lower()
    return (
        "/" in lowered
        or "\\" in lowered
        or lowered.endswith((
            ".csv", ".tsv", ".parquet", ".json", ".jsonl",
            ".xlsx", ".xls", ".txt",
        ))
    )


def _check_single_path(path_str: str, norm_roots: List[Path]) -> Optional[str]:
    """校验单个路径字符串是否在白名单根目录内。"""
    if not path_str:
        return "文件读取函数的路径参数为空。"

    # ── 网络 URL 一律拒绝（SSRF 防护）──────────────────────────────────────
    path_lower = path_str.lower().strip()
    for scheme in _BLOCKED_URL_SCHEMES:
        if path_lower.startswith(scheme):
            return (f"禁止网络路径：{path_str}（仅允许本地工作目录/上传目录内文件，"
                    "不接受 http/https/s3/gs/azure/hdfs 等 URL）。")

    # ── 路径解析 ────────────────────────────────────────────────────────────
    # 相对路径：相对第一个白名单根解析（通常是 workdir，未挂载时是 uploads）
    # 绝对路径：直接 resolve
    try:
        candidate = Path(path_str)
        if candidate.is_absolute():
            resolved = candidate.expanduser().resolve(strict=False)
        else:
            # 相对路径：依次尝试每个根，第一个存在的为准；都不存在则用第一个根解析
            resolved = None
            for root in norm_roots:
                trial = (root / path_str).expanduser().resolve(strict=False)
                if trial.exists():
                    resolved = trial
                    break
            if resolved is None:
                # 文件不存在，用第一个根解析做白名单校验
                if norm_roots:
                    resolved = (norm_roots[0] / path_str).expanduser().resolve(strict=False)
                else:
                    resolved = candidate.expanduser().resolve(strict=False)
    except (OSError, RuntimeError) as e:
        return f"路径解析失败：{path_str}（{e}）"

    # 通配符路径：检查父目录（去掉通配符部分后）是否在白名单内
    # 例如 read_csv('data/*.csv') —— 检查 data/ 目录是否在白名单
    has_glob = any(c in path_str for c in _GLOB_CHARS)
    check_path = resolved
    if has_glob:
        # 取 resolved 的 parent 作为校验目标
        check_path = resolved.parent

    # 白名单校验：必须在某个根目录下
    in_whitelist = False
    for root in norm_roots:
        try:
            check_path.relative_to(root)
            in_whitelist = True
            break
        except ValueError:
            continue

    if not in_whitelist:
        return (f"路径不在允许的工作目录/上传目录内：{path_str} "
                f"(resolved: {check_path})。允许的根目录："
                + ", ".join(str(r) for r in norm_roots))

    return None


def _validate_sql_ast_body(sqlglot_module, statements, exp, allowed_roots: List[Path]) -> Optional[str]:
    """对已解析好的 sqlglot 语句执行 AST 级检查。

    若 SQL 不被允许则返回错误字符串，否则返回 None。之所以从
    ``_validate_sql_ast`` 中拆出，是为了让 ``validate_sql_structured`` 能区分
    真正的 AST 通过与启发式兜底。

    A6 策略 —— 允许写，执行层把它们保持在内存中：
      允许的语句：Query（SELECT/WITH/UNION）、kind 为
      TABLE/VIEW 的 Create、Insert、Update、Delete、kind 为 TABLE/VIEW 的 Drop、
      Alter、TruncateTable、Merge。
      仍然拦截：PRAGMA / Install / Attach / Detach / Copy / Set /
      Transaction / Command、对 FUNCTION、MACRO、INDEX、
      SCHEMA、SEQUENCE、TYPE 的 Create/Drop —— 另外还有多语句、被禁函数、
      网络 URL 与非白名单文件读取路径（均不变）。
    """
    # ── 多语句检查 ─────────────────────────────────────────────────────────────
    if len(statements) > 1:
        return "不允许多语句 SQL（检测到分号分隔的多条语句）。"
    if not statements:
        return "SQL 语句为空。"

    stmt = statements[0]

    # ── 顶层语句类型 ───────────────────────────────────────────────────────────
    if isinstance(stmt, exp.Query):
        pass  # 只读：SELECT / WITH / UNION / CTE
    elif isinstance(stmt, exp.Create):
        kind = str(stmt.args.get("kind") or "").upper()
        if kind not in ("TABLE", "VIEW"):
            return (
                f"只允许 CREATE TABLE / CREATE VIEW，检测到 CREATE {kind or '?'}。"
                "函数、宏、索引、模式等对象不允许创建。"
            )
    elif isinstance(stmt, exp.Drop):
        kind = str(stmt.args.get("kind") or "").upper()
        if kind not in ("TABLE", "VIEW"):
            return f"只允许 DROP TABLE / DROP VIEW，检测到 DROP {kind or '?'}。"
    elif isinstance(stmt, (exp.Insert, exp.Update, exp.Delete, exp.Alter, exp.TruncateTable, exp.Merge)):
        pass  # 内存中的数据变更 —— A6 下允许
    else:
        stmt_type = type(stmt).__name__
        return (
            f"不允许的语句类型: {stmt_type}。"
            "允许 SELECT/WITH 查询与 CREATE/INSERT/UPDATE/DELETE/DROP/ALTER/"
            "TRUNCATE/MERGE 数据操作；禁止 PRAGMA/INSTALL/ATTACH/COPY/SET/"
            "BEGIN 等系统级语句。"
        )

    # ── 被禁函数扫描（递归，非 file-read 类）─────────────────────────────────
    for node in stmt.walk():
        # Anonymous 函数（例如 sqlglot 可能识别不了的 read_csv_auto）
        if isinstance(node, exp.Anonymous):
            fname = (node.name or "").lower()
            if fname in _BANNED_FUNCTIONS:
                return f"禁止使用函数 {fname}()：该函数可访问文件系统写入/网络/扩展。"

        # 具名函数节点
        if isinstance(node, exp.Func):
            fname = type(node).__name__.lower()
            # 若可用也检查 sql_name
            sql_name = getattr(node, "sql_name", lambda: "")()
            for candidate in (fname, sql_name.lower()):
                if candidate in _BANNED_FUNCTIONS:
                    return f"禁止使用函数 {candidate}()：该函数可访问文件系统写入/网络/扩展。"

    # ── COPY 语句扫描 ──────────────────────────────────────────────────────────
    for node in stmt.walk():
        if isinstance(node, exp.Copy):
            return "禁止 COPY 操作：不允许将数据写入文件。"

    # ── 文件读取路径白名单（A4）───────────────────────────────────────────────
    err = _validate_file_read_paths(stmt, allowed_roots)
    if err:
        return err

    return None  # 全部通过


def _validate_sql_ast(sql: str, allowed_roots: Optional[List[Path]] = None) -> Optional[str]:
    """用 sqlglot 做 AST 级 SQL 校验。

    若 SQL 不被允许则返回错误字符串，否则返回 None。
    未安装 sqlglot 时回退到轻量启发式。

    Args:
        sql: 待校验的 SQL 字符串。
        allowed_roots: 文件读取函数（read_csv 等）允许读取的 Path 根目录列表。
            若为 None 或为空，则完全拒绝文件读取（调用方应传入
            uploads/Information 作为默认值）。
    """
    return validate_sql_structured(sql, allowed_roots=allowed_roots).message


def validate_sql_structured(
    sql: str, allowed_roots: Optional[List[Path]] = None
) -> SqlValidationResult:
    """带结构化三态结果的 AST 级 SQL 校验。

    与 ``_validate_sql_ast`` 类似，但会区分完整的 AST 通过与启发式兜底，使 UI 在
    高可信的 sqlglot 路径不可用时能显示 "sqlglot 错误" 徽标。

    Args:
        sql: 待校验的 SQL 字符串。
        allowed_roots: 文件读取白名单的 Path 根目录列表。若为 None，默认使用
            [uploads/, Information/]（见 ``_default_allowed_roots``）。
    """
    try:
        import sqlglot
        import sqlglot.expressions as exp
    except ImportError:
        # 未安装 sqlglot —— 回退到保守的启发式
        log.debug("[validate] sqlglot not available, using heuristic fallback")
        err = _validate_sql_heuristic(sql)
        if err:
            return SqlValidationResult("failed", err, used_heuristic=True)
        return SqlValidationResult(
            "degraded",
            f"sqlglot 未安装，SQL 仅经过关键字级校验（错误代码：{SQLG_NOT_INSTALLED}）",
            used_heuristic=True,
            code=SQLG_NOT_INSTALLED,
        )

    # ── 解析 ───────────────────────────────────────────────────────────────────
    try:
        statements = sqlglot.parse(sql, dialect="duckdb", error_level=sqlglot.ErrorLevel.RAISE)
    except Exception as exc:
        # 解析错误 —— 可能是合法 DuckDB 但 sqlglot 解析不了。
        # 回退到启发式，而不是拦截合法查询。
        log.debug("[validate] sqlglot parse error (%s), falling back to heuristic", exc)
        err = _validate_sql_heuristic(sql)
        if err:
            return SqlValidationResult("failed", err, used_heuristic=True)
        return SqlValidationResult(
            "degraded",
            f"sqlglot 无法解析该 SQL，仅经过关键字级校验（错误代码：{SQLG_PARSE_FAILED}）",
            used_heuristic=True,
            code=SQLG_PARSE_FAILED,
        )

    # 默认根目录：即使未挂载 workspace，也允许读 uploads/Information
    if allowed_roots is None:
        allowed_roots = _default_allowed_roots()

    err = _validate_sql_ast_body(sqlglot, statements, exp, allowed_roots)
    if err:
        return SqlValidationResult("failed", err, used_heuristic=False)
    return SqlValidationResult("passed", "", used_heuristic=False)


def _default_allowed_roots() -> List[Path]:
    """默认白名单根目录（未挂载 workspace 时用）。

    包含 uploads/ 和 Information/，让 read_csv 能读已上传文件。
    不包含工作目录（未挂载时不存在）。
    """
    from infrastructure.paths import content_data_path, resource_path
    return [content_data_path("uploads"), resource_path("Information")]


def _strip_sql_comments_for_prefix(sql: str) -> str:
    """在启发式前缀/关键词检查之前去掉 SQL 注释。"""
    text = str(sql or "")
    text = re.sub(r"/\*[\s\S]*?\*/", " ", text)
    text = re.sub(r"(?m)^\s*--.*$", " ", text)
    return text


def _validate_sql_heuristic(sql: str) -> Optional[str]:
    """sqlglot 不可用时使用的轻量关键词兜底校验。

    精度不如 AST 校验（在列名/字符串字面量上可能误报），但在这个可选依赖缺失
    时仍能维持安全保证。

    A6：写关键词（CREATE/INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/MERGE）
    被允许 —— 执行层把写操作保持在内存中。启发式无法区分 CREATE TABLE 与
    CREATE FUNCTION，因此凡是只能在这里通过的语句，都返回 degraded 的
    "sqlglot 错误"（SQLG-002）结果。

    注意：heuristic 模式下无法做路径白名单（拿不到 AST 节点），所以一律拒绝
    file-read 函数（保守策略，回到 A4 之前的行为）。
    """
    sql_for_checks = _strip_sql_comments_for_prefix(sql)
    sql_stripped = sql_for_checks.strip()
    sql_lower = sql_stripped.lower()

    if not sql_lower:
        return "SQL 语句为空。"

    # ── 多语句检查（按未加引号的分号切分）────────────────────────────────────
    sql_no_trail = sql_stripped.rstrip(";").strip()
    _no_quotes = re.sub(r"'[^']*'|\"[^\"]*\"", "", sql_no_trail)
    if ";" in _no_quotes:
        return "不允许多语句 SQL（检测到分号分隔的多条语句）。"

    # ── Banned DuckDB extension/network keywords (heuristic 模式仍禁) ─────────
    _BANNED_TOKENS = [
        r"\binstall\b", r"\bload\b", r"\battach\b", r"\bdetach\b",
        r"\bcopy\b", r"\bpragma\b", r"\bset\b", r"\bbegin\b",
        r"\bcommit\b", r"\brollback\b",
        r"\bhttp_get\b", r"\bhttp_post\b",
    ]
    for pattern in _BANNED_TOKENS:
        if re.search(pattern, sql_lower):
            token = pattern.replace(r"\b", "").strip()
            return f"禁止使用 {token}：该操作可访问文件系统写入/网络/扩展/会话状态。"

    # ── File-read 函数：heuristic 模式下一律拒绝（无法做路径白名单）──────────
    _FILE_READ_TOKENS = [
        r"\bread_csv\b", r"\bread_csv_auto\b", r"\bread_json\b", r"\bread_json_auto\b",
        r"\bread_parquet\b", r"\bread_parquet_auto\b",
        r"\bread_text\b", r"\bread_text_auto\b",
        r"\bread_blob\b", r"\bread_blob_auto\b",
    ]
    for pattern in _FILE_READ_TOKENS:
        if re.search(pattern, sql_lower):
            token = pattern.replace(r"\b", "").strip()
            return (f"heuristic 模式下禁止 {token}（sqlglot 不可用时无法做路径白名单校验）。"
                    "请安装 sqlglot 或改用已注册表查询。")

    return None


def validate_tool_args(
    name: str,
    args: Dict[str, Any],
    allowed_roots: Optional[List[Path]] = None,
    workspace_authorization: Optional["WorkspacePathAuthorization"] = None,
) -> Optional[str]:
    """若参数明显非法则返回错误字符串，否则返回 None。

    策略：
      - SQL_TOOLS：`sql` 必填；做 AST 级校验（仅 SELECT/WITH、
        无被禁函数、无多语句、文件读取路径白名单）
      - run_analysis：analysis_name + target_column 必填
      - propose_ppt_outline / generate_ppt：`slides`（若存在）必须是 list
      - propose_dashboard_outline / generate_dashboard：`widgets`（若存在）必须是 list

    Args:
        name: 工具名。
        args: 工具参数字典。
        allowed_roots: 兼容旧调用的可选根目录列表，供没有 Workspace 身份的
            调用方使用。
        workspace_authorization: 不可变、绑定 workspace_id 的路径能力。
            存在时它是 SQL 文件读取根目录的唯一来源。
            若为 None，默认使用 [uploads/, Information/]。传入 workspace 的
            允许根目录（workdir + uploads + Information + artifacts + cache）
            即可从挂载的 workdir 中 read_csv('file.xlsx')。
    """
    if workspace_authorization is not None:
        allowed_roots = list(workspace_authorization.allowed_roots)
    if name in SQL_TOOLS:
        sql = (args.get("sql") or "").strip()
        if not sql:
            return f"'{name}' requires a non-empty 'sql' argument."
        validation = validate_sql_structured(sql, allowed_roots=allowed_roots)
        if validation.status == "failed":
            return f"'{name}' SQL validation failed: {validation.message}"

    if name == "run_analysis":
        if not args.get("analysis_name"):
            return "'run_analysis' requires 'analysis_name'."
        if not args.get("target_column"):
            return "'run_analysis' requires 'target_column'."

    if name == "ask_user":
        ask_user_error = validate_ask_user_args(args)
        if ask_user_error:
            return ask_user_error[1]

    if name in ("propose_ppt_outline", "generate_ppt"):
        slides = args.get("slides")
        if slides is not None and not isinstance(slides, list):
            return f"'{name}': 'slides' must be a list."

    if name in ("propose_dashboard_outline", "generate_dashboard"):
        widgets = args.get("widgets")
        if widgets is not None and not isinstance(widgets, list):
            return f"'{name}': 'widgets' must be a list."

    if name in ("propose_report_outline", "export_report"):
        if not str(args.get("title") or "").strip():
            return f"'{name}' requires a non-empty 'title'."
        sections = args.get("sections")
        if not isinstance(sections, list) or not sections:
            return f"'{name}' requires a non-empty 'sections' list."
        if any(not isinstance(section, dict) for section in sections):
            return f"'{name}': every section must be an object."
        for index, section in enumerate(sections, 1):
            if not str(section.get("heading") or "").strip():
                return f"'{name}': section {index} requires a non-empty 'heading'."
            content = section.get("content")
            if not isinstance(content, str) or not content.strip():
                return f"'{name}': section {index} requires non-empty string 'content'."

    return None


def normalize_report_outline_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """把各 provider 常见的别名统一成 report section 字段的规范名。"""
    normalized = dict(args or {})
    raw_sections = normalized.get("sections")
    if not isinstance(raw_sections, list):
        return normalized

    sections = []
    for raw_section in raw_sections:
        if not isinstance(raw_section, dict):
            sections.append(raw_section)
            continue
        heading = raw_section.get("heading")
        if not isinstance(heading, str) or not heading.strip():
            heading = raw_section.get("title")
        content = raw_section.get("content")
        if not isinstance(content, str) or not content.strip():
            content = raw_section.get("body")
        sections.append({"heading": heading, "content": content})
    normalized["sections"] = sections
    return normalized


def normalize_ask_user_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """把各 provider 的常见变体统一到 ask_user 的字符串约定。

    有些 OpenAI 兼容 provider 偶尔会输出 option 对象，尽管 JSON schema 声明的
    是字符串数组。在这个边界上接受常见的展示字段，随后仍由
    ``validate_tool_args`` 拒绝任何格式依然错误的输入。
    """
    normalized = dict(args or {})
    question = normalized.get("question")
    normalized["question"] = question.strip() if isinstance(question, str) else ""

    raw_options = normalized.get("options")
    options: List[str] = []
    if isinstance(raw_options, list):
        for raw_option in raw_options:
            text: Any = raw_option
            if isinstance(raw_option, dict):
                text = next(
                    (
                        raw_option.get(key)
                        for key in ("label", "text", "title", "name", "value")
                        if isinstance(raw_option.get(key), str)
                        and raw_option.get(key).strip()
                    ),
                    "",
                )
            if not isinstance(text, str):
                continue
            text = text.strip()
            if text and text not in options:
                options.append(text)
            if len(options) == 6:
                break
    normalized["options"] = options
    return normalized


def validate_ask_user_args(args: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """对非法的 ``ask_user`` 调用返回稳定的错误码与消息。"""
    question = args.get("question")
    if not isinstance(question, str) or not question.strip():
        return (
            ASK_USER_INVALID_ARGUMENT,
            "'ask_user' requires a non-empty string 'question' "
            f"(error code: {ASK_USER_INVALID_ARGUMENT}).",
        )

    options = args.get("options")
    if not isinstance(options, list):
        return (
            ASK_USER_INVALID_ARGUMENT,
            "'ask_user': 'options' must be a list "
            f"(error code: {ASK_USER_INVALID_ARGUMENT}).",
        )
    if not options:
        return (
            ASK_USER_EMPTY_OPTIONS,
            "'ask_user': 'options' cannot be empty; provide 2-6 items "
            f"(error code: {ASK_USER_EMPTY_OPTIONS}).",
        )
    if not 2 <= len(options) <= 6:
        return (
            ASK_USER_OPTION_COUNT,
            "'ask_user': 'options' must contain 2-6 items "
            f"(error code: {ASK_USER_OPTION_COUNT}).",
        )
    if any(not isinstance(option, str) or not option.strip() for option in options):
        return (
            ASK_USER_INVALID_ARGUMENT,
            "'ask_user': every option must be a non-empty string "
            f"(error code: {ASK_USER_INVALID_ARGUMENT}).",
        )
    return None
