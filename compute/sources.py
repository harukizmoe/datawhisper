"""compute worker 保持打开的数据源。

Source 是有状态的（内存 DuckDB 加运行时分析表），因此 worker 按 id 保持它们
打开。descriptor 由 Node 持有，并在 worker 重启后重新打开；内存中的派生表不会
跨重启存活，持久化的 workspace 表会。

一次工具调用会租用一组有序的 source（``SourceRegistry.lease``）：它在整个调用
期间持有每个 source 的锁，并对该 id 元组使用缓存的 ``SourceView``
（合并 schema + 跨源 ``MergedDataSource``）。
"""
from __future__ import annotations

import logging
import re
import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator, Sequence
from urllib.parse import quote

from data.feishu_bitable_service import FeishuBitableError, read_bitable_records
from data.sources import (
    CSVDataSource,
    DataSource,
    ExcelDataSource,
    FeishuBitableDataSource,
    GoogleSheetsDataSource,
    HTTPAPIDataSource,
    SQLDataSource,
)
from data.sources.workspace_persistent import WorkspacePersistentSource

from .i18n import say
from .rpc import INVALID_PARAMS, RpcError

log = logging.getLogger(__name__)


def combined_schema(sources: Sequence[DataSource]) -> str:
    """按顺序返回活动 source 的合并 schema。

    当多个 source 同时活动且任意两个存在同名表时，每张表都加上
    ``src{N}__``（从 1 开始）前缀，使 LLM 能无歧义地引用它。单 source 的行为
    保持不变。

    该前缀由 ``DataToolsMixin._route_query`` 识别，它会在把 SQL 交给具体
    DataSource 之前去掉前缀。
    """
    if not sources:
        return ""
    if len(sources) == 1:
        return sources[0].get_schema()

    # 收集所有 source 的表名以检测重名。
    all_table_names: list[str] = []
    for src in sources:
        try:
            all_table_names.extend(src.list_tables())
        except Exception:
            pass
    collision = len(all_table_names) != len(set(all_table_names))

    parts = []
    for idx, src in enumerate(sources, start=1):
        raw_schema = src.get_schema()
        if collision:
            # 给每行 "Table: <name>" 加上 src{N}__ 前缀，使 LLM
            # （以及 router）能跨 source 区分不同表。
            raw_schema = re.sub(
                r"Table:\s+(\S+)",
                lambda m, idx=idx: f"Table: src{idx}__{m.group(1)}",
                raw_schema,
            )
            note = (
                f"  [NOTE: prefix all table names with src{idx}__ when writing SQL, "
                f"e.g. SELECT * FROM \"src{idx}__<table_name>\"]"
            )
        else:
            note = ""
        header = f"=== {say('Source', '数据源')} {idx}: {getattr(src, 'name', say('Unnamed', '未命名'))} ==="
        parts.append(f"{header}{note}\n{raw_schema}")
    return "\n\n".join(parts)


def build_merged_source(sources: Sequence[DataSource]):
    """用于跨源 SQL 的 MergedDataSource（单个 DuckDB 连接覆盖所有 source，表
    注册为 ``src{N}__<table>``）；少于两个 source 或构建失败时返回 None。"""
    if len(sources) < 2:
        return None
    try:
        from data.merged_source import MergedDataSource
        return MergedDataSource(list(sources))
    except Exception as exc:
        log.warning("[sources] MergedDataSource build failed: %s", exc)
        return None


def encode_conn_secret(conn_str: str) -> str:
    """对连接字符串中的密码部分做 URL 编码，处理 @ # 等特殊字符。"""
    # 匹配 scheme://user:<secret>@host 格式，密码可能含多个 @
    # 贪婪匹配密码部分（.+），确保最后一个 @ 才是 host 分隔符
    m = re.match(r'^([a-zA-Z][a-zA-Z0-9+\-.]*://[^:@/]+):(.+)@([^@].*)', conn_str)
    if not m:
        return conn_str
    prefix, secret, rest = m.group(1), m.group(2), m.group(3)
    # 若密码已含 % 编码则跳过，避免二次编码
    if re.search(r'%[0-9A-Fa-f]{2}', secret):
        return conn_str
    encoded = quote(secret, safe='-._~!*')
    return f"{prefix}:{encoded}@{rest}"


def friendly_conn_error(exc: Exception, service: str) -> str:
    """把底层的连接异常转成用户可读的消息。

    `service` 是简短标签，如 'Google Sheets' / '外部 API' / '数据库'。
    当错误不属于已知网络情形时，回退为原始消息。
    """
    # 沿异常 cause 链遍历，让被包了一层的错误也能被识别。
    chain = []
    cur: BaseException | None = exc
    seen = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        chain.append(cur)
        cur = cur.__cause__ or cur.__context__
    text = "  ".join(f"{type(c).__name__}: {c}" for c in chain).lower()

    if service in _DATABASE_LABELS:
        # 数据库的常见失败按原因分开说，并指出该检查哪一项；顺序要先于下面的通用网络/认证文案。
        if any(k in text for k in (
            "password authentication failed", "access denied for user", "login failed for user",
            "authentication failed",
        )):
            return say(
                "Database authentication failed: the username or password is incorrect, or the user has no permission to access this database.",
                "数据库认证失败：用户名或密码不正确，或该用户没有权限访问这个数据库。",
            )
        if any(k in text for k in (
            "unknown database", "cannot open database", "does not exist", "no such database",
        )) and "database" in text:
            return say("Database does not exist: check that the database name is correct.", "数据库不存在：请检查数据库名是否正确。")
        if "unable to open database file" in text:
            return say("Cannot open the database file: check the path and read permission.", "无法打开数据库文件：请检查路径和读取权限。")
        if "pg_hba.conf" in text:
            return say(
                "The server rejected the connection (pg_hba.conf does not allow this host, or SSL is required or not allowed): check the server's access rules and SSL setting.",
                "服务器拒绝了这次连接（pg_hba.conf 没有放行此主机，或要求/不允许 SSL）：请检查服务器的访问规则和 SSL 开关。",
            )
        if any(k in text for k in (
            "connection refused", "could not connect to server", "can't connect to mysql server",
            "name or service not known", "nodename nor servname", "getaddrinfo failed",
            "timeout expired", "timed out", "no route to host", "network is unreachable",
        )):
            return say(
                "Cannot connect to the database server: check that the host and port are correct, the database service is running, and the firewall allows the connection.",
                "无法连接到数据库服务器：请检查主机和端口是否正确，数据库服务是否已启动，防火墙是否放行。",
            )
        if "no module named" in text and "pyodbc" not in text:
            return say(
                "Missing database driver: this is an application packaging problem, please report it to the developers; your configuration is not at fault.",
                "缺少数据库驱动：这是应用打包的问题，请反馈给开发者，不是你的配置有误。",
            )

    # — SQL Server 客户端依赖 —
    if "no module named 'pyodbc'" in text or "no module named \"pyodbc\"" in text:
        return (
            say(
                "SQL Server driver is not installed: upgrade or rerun this program to install pyodbc, "
                "and install Microsoft ODBC Driver 17 or 18 for SQL Server on this computer, then retry.",
                "SQL Server 驱动未安装：请升级或重新运行本程序以安装 pyodbc，"
                "并在此电脑安装 Microsoft ODBC Driver 17 或 18 for SQL Server 后重试。",
            )
        )
    if any(k in text for k in (
        "data source name not found", "no default driver specified",
        "can't open lib 'odbc driver", "cannot open lib 'odbc driver",
    )):
        return (
            say(
                "SQL Server ODBC driver not found: install Microsoft ODBC Driver 17 or 18 for SQL Server, "
                "and specify the installed driver name in the connection string.",
                "未找到 SQL Server ODBC 驱动：请安装 Microsoft ODBC Driver 17 或 18 for SQL Server，"
                "并在连接串中指定已安装的驱动名称。",
            )
        )

    # — SQL Server 可达性 / 实例发现 —
    if any(k in text for k in (
        "server is not found or not accessible", "named pipes provider",
        "tcp provider", "sql server does not exist", "error: 258", "10060",
        "08001", "08s01",
    )):
        return (
            say(
                "Cannot connect to SQL Server: confirm the server address/instance name and port are correct, TCP/IP is enabled on SQL Server, "
                "the firewall allows the port (usually 1433), and the client network can reach the server.",
                "无法连接 SQL Server：请确认服务器地址/实例名和端口正确，SQL Server 已启用 TCP/IP，"
                "防火墙已放行端口（通常为 1433），且客户端网络可访问该服务器。",
            )
        )

    # — 网络不可达 / 连接被重置（代理、GFW、离线） —
    if any(k in text for k in (
        "10054", "connection aborted", "connection reset", "connectionreseterror",
        "connection refused", "10061", "max retries", "failed to establish",
        "name or service not known", "getaddrinfo failed", "11001",
        "transporterror", "ssl", "handshake", "timed out", "timeout",
        "remotedisconnected", "connectionerror",
    )):
        return (
            say(
                f"Cannot connect to \"{service}\": the network request was interrupted or timed out. "
                "Check that the network can reach the target service"
                + (" (Google services need a proxy on some networks)" if "google" in service.lower() else "")
                + ", make sure the proxy / VPN is on and the Python process goes through it, then retry.",
                f"无法连接「{service}」：网络请求被中断或超时。"
                f"请检查网络是否可正常访问目标服务"
                + ("（Google 服务在部分网络下需要代理）" if "google" in service.lower() else "")
                + "，确认代理 / VPN 已开启且 Python 进程已走代理后重试。",
            )
        )
    # — 认证 / 授权 —
    if any(k in text for k in (
        "401", "403", "unauthorized", "forbidden", "permission",
        "invalid_grant", "invalid_client", "authentication",
        "access_denied", "credential",
    )):
        return (
            say(
                f"{service} authentication failed: the credentials are invalid or lack access. "
                "Check that the service account / key is correct and that the account is authorized to access the target resource.",
                f"{service} 认证失败：凭证无效或没有访问权限。"
                "请检查服务账号 / 密钥是否正确，以及该账号是否已被授权访问目标资源。",
            )
        )
    # — 未找到 —
    if any(k in text for k in ("404", "not found", "does not exist")):
        return say(
            f"{service}: target resource not found. Check that the URL / ID / table name is correct.",
            f"{service} 目标资源不存在：请检查 URL / ID / 表名是否正确。",
        )

    # — 未知情形 — 保留原始消息，但要保持简短 —
    raw = str(exc).strip() or type(exc).__name__
    if len(raw) > 200:
        raw = raw[:200] + "…"
    return say(f"{service} connection failed: {raw}", f"{service} 连接失败：{raw}")


# 打开失败时需要给出可读原因的远程 source。
_DATABASE_LABELS = ("Database", "数据库")


def _connection_label(kind: str) -> str | None:
    return {
        "sql": say("Database", "数据库"),
        "gsheets": "Google Sheets",
        "http": say("External API", "外部 API"),
        "feishu": say("Feishu Bitable", "飞书多维表格"),
    }.get(kind)


def open_failed(descriptor: dict, exc: Exception) -> RpcError:
    """打开 source 失败时的错误（``data.kind == "open_failed"``）：远程连接给出
    可读原因，文件则保留原始消息。"""
    label = _connection_label(str(descriptor.get("kind") or ""))
    if label and not isinstance(exc, FeishuBitableError):
        message = friendly_conn_error(exc, label)
    else:
        message = str(exc) or type(exc).__name__
    return RpcError(message, data={"kind": "open_failed", "error": f"{type(exc).__name__}: {exc}"})


def pdf_source(file_path: str, name: str) -> DataSource:
    """把文本型 PDF 中的表作为内存 source 返回。"""
    from data.sources.extracted import ExtractedTableDataSource
    from data.table_extract import MAX_PDF_BYTES, normalize_grids, parse_pdf_tables

    pdf_bytes = Path(file_path).read_bytes()
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ValueError(say(
            f"PDF file exceeds the {MAX_PDF_BYTES // (1024 * 1024)}MB limit; split it and upload again",
            f"PDF 文件超过 {MAX_PDF_BYTES // (1024 * 1024)}MB 上限，请拆分后再上传",
        ))
    grids = parse_pdf_tables(pdf_bytes)
    if not grids:
        raise ValueError(say(
            "No tables detected in the PDF (scanned/image-based PDFs are not supported); convert it to a text-based PDF first",
            "未在 PDF 中检测到表格（扫描件/图片型 PDF 不支持），请先转换为文本型 PDF",
        ))
    tables, _meta = normalize_grids(grids)
    if not tables:
        raise ValueError(say("All PDF tables have fewer than 2 rows/2 columns; nothing to import", "PDF 表格均少于 2 行/2 列，无可导入内容"))
    return ExtractedTableDataSource(name, tables)


def preview_tables(source_id: str, source: DataSource) -> list[dict]:
    """某个 source 供数据预览用的表元信息（不含行数据），每项都标注 source，
    对 SQL source 还标注分析表选择情况。"""
    selectable = isinstance(source, SQLDataSource)
    selected = set(source.get_analysis_tables()) if selectable else set()
    tables = []
    for table in source.get_preview():
        table.update({
            "source_id": source_id,
            "source_name": getattr(source, "name", ""),
            # 只有远程 SQL catalog 才需要选择分析范围，它们可能暴露成千上万张
            # 很大的表。上传/本地文件本身已是有限且刻意的选择。
            "selectable_for_analysis": selectable,
            "selected_for_analysis": selectable and table.get("name") in selected,
        })
        tables.append(table)
    return tables


def restore_source(info: dict) -> DataSource:
    """由持久化的 descriptor 构建 source。"""
    kind = str(info.get("kind") or "")
    name = str(info.get("name") or "").strip()
    if kind == "csv":
        file_path = str(info.get("file_path") or "")
        if not Path(file_path).is_file():
            raise FileNotFoundError(file_path or say("CSV file does not exist", "CSV 文件不存在"))
        return CSVDataSource(file_path, name or Path(file_path).name)
    if kind == "excel":
        file_path = str(info.get("file_path") or "")
        if not Path(file_path).is_file():
            raise FileNotFoundError(file_path or say("Excel file does not exist", "Excel 文件不存在"))
        db_path = str(info.get("db_path") or "")
        if db_path and Path(db_path).is_file():
            return ExcelDataSource.from_database(file_path, name or Path(file_path).name, db_path)
        return ExcelDataSource(file_path, name or Path(file_path).name)
    if kind == "sql":
        conn = encode_conn_secret(str(info.get("connection_string") or "").strip())
        if not conn:
            raise ValueError(say("SQL connection string is empty", "SQL 连接字符串为空"))
        source = SQLDataSource(conn, name)
        # 之前选过的表可能已被删掉，或连接改指到了别的库：只恢复仍然存在的，否则整个来源都打不开。
        saved = [str(item) for item in (info.get("analysis_tables") or [])]
        if saved:
            catalog = set(source.list_catalog_tables())
            tables = [item for item in saved if item in catalog]
            if tables:
                source.set_analysis_tables(tables)
        return source
    if kind == "gsheets":
        creds = info.get("creds_dict")
        spreadsheet = str(info.get("spreadsheet") or "")
        if not isinstance(creds, dict) or not spreadsheet:
            raise ValueError(say("Google Sheets credentials or spreadsheet address is empty", "Google Sheets 凭证或表格地址为空"))
        return GoogleSheetsDataSource(creds, spreadsheet, name)
    if kind == "http":
        url = str(info.get("url") or "")
        if not url:
            raise ValueError(say("API URL is empty", "API URL 为空"))
        auth_type = str(info.get("auth_type") or "none")
        if auth_type not in ("none", "bearer", "api_key"):
            raise ValueError(say("Invalid auth type; supported: none / bearer / api_key", "认证方式无效，支持: none / bearer / api_key"))
        return HTTPAPIDataSource(url, auth_type, str(info.get("auth_value") or ""), name)
    if kind == "feishu":
        app_token = str(info.get("app_token") or "")
        table_id = str(info.get("table_id") or "")
        if not app_token or not table_id:
            raise ValueError(say("Feishu Bitable app_token or table_id is empty", "飞书多维表格 app_token 或 table_id 为空"))
        result = read_bitable_records(bitable=app_token, table_id=table_id)
        source = FeishuBitableDataSource(result["records"], name or say("Feishu Bitable", "飞书多维表格"))
        source._feishu_app_token = app_token
        source._feishu_table_id = table_id
        return source
    if kind == "workspace_persistent":
        db_path = str(info.get("db_path") or "")
        if not Path(db_path).is_file():
            raise FileNotFoundError(db_path or say("Workspace DuckDB does not exist", "工作目录 DuckDB 不存在"))
        return WorkspacePersistentSource(db_path, name or say("Workspace", "工作目录"))
    if kind == "pdf":
        file_path = str(info.get("file_path") or "")
        if not Path(file_path).is_file():
            raise FileNotFoundError(file_path or say("PDF file does not exist", "PDF 文件不存在"))
        return pdf_source(file_path, name or f"PDF {Path(file_path).name}")
    raise ValueError(say(f"Unsupported data source type: {kind or 'unknown'}", f"不支持的数据源类型：{kind or 'unknown'}"))


def probe_source(info: dict) -> dict:
    """按 descriptor 试连一次并立即关闭，不登记也不保留任何状态；供界面「测试连接」使用。

    ``tables`` 是目录里的表数（远程 SQL 看完整目录，其余看 source 自己列出的表），
    ``server`` 只有 SQL 来源才有（产品与版本）。
    """
    source = restore_source(info)
    try:
        if isinstance(source, SQLDataSource):
            tables = source.list_catalog_tables()
            server = source.describe_server()
        else:
            tables = source.list_tables()
            server = ""
        return {"name": getattr(source, "name", ""), "tables": len(tables), "server": server}
    finally:
        close = getattr(source, "close", None)
        if close is not None:
            close()


class _Entry:
    __slots__ = ("source", "lock")

    def __init__(self, source: DataSource):
        self.source = source
        # DuckDB 连接不是并发安全的；按 source 串行化。
        self.lock = threading.Lock()


class SourceView:
    """一组有序 source 的合并 schema 与合并 source。

    两者都懒构建，且只在持有者掌握所有 source 的锁时使用，因此构建本身无需额外加锁。
    """

    def __init__(self, sources: Sequence[DataSource]):
        self.sources = list(sources)
        self._schema: str | None = None
        self._merged = None
        self._merged_built = False

    def combined_schema(self) -> str:
        if self._schema is None:
            self._schema = combined_schema(self.sources)
        return self._schema

    def merged_source(self):
        if not self._merged_built:
            self._merged = build_merged_source(self.sources)
            self._merged_built = True
        return self._merged

    def close(self) -> None:
        if self._merged is not None:
            _close(self._merged)
            self._merged = None


class Lease:
    """一次调用涉及的 source，全部已加锁，顺序与调用方给出的顺序一致。"""

    def __init__(self, registry: "SourceRegistry", ids: tuple[str, ...], sources: dict[str, DataSource]):
        self._registry = registry
        self.ids = ids
        self._by_id = sources
        self.sources = [sources[sid] for sid in ids]

    def source(self, source_id: str) -> DataSource:
        return self._by_id[source_id]

    def view(self) -> SourceView:
        return self._registry._view(self.ids, self.sources)

    def invalidate(self, source_ids: Sequence[str] | None = None) -> None:
        """表变化后，丢弃包含 *source_ids* 中任一（默认：本次租用的全部）的缓存
        视图。这类视图的每个使用者都持有被改动 source 的锁，而这把锁归本次租用
        持有，因此合并 source 可以立刻关闭。"""
        for view in self._registry._drop_views(set(source_ids if source_ids is not None else self.ids)):
            view.close()


class SourceRegistry:
    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}
        self._views: dict[tuple[str, ...], SourceView] = {}
        self._lock = threading.Lock()

    def open(self, source_id: str, descriptor: dict) -> DataSource:
        try:
            source = restore_source(descriptor)
        except Exception as exc:
            raise open_failed(descriptor, exc) from exc
        self._install(source_id, source)
        return source

    def add(self, source_id: str, source: DataSource) -> None:
        """在新 id 下注册调用方自行构建的 source（例如从网页提取的表，而非来自
        descriptor）。"""
        with self._lock:
            if source_id in self._entries:
                raise RpcError(f"data source already open: {source_id}", INVALID_PARAMS)
            self._entries[source_id] = _Entry(source)

    def _install(self, source_id: str, source: DataSource) -> None:
        with self._lock:
            previous = self._entries.get(source_id)
            self._entries[source_id] = _Entry(source)
            stale = self._drop_views_locked({source_id})
        if previous is not None:
            # 等仍在用旧 source 的调用结束，再关闭它。
            with previous.lock:
                _close(previous.source)
                for view in stale:
                    view.close()

    def close(self, source_id: str) -> bool:
        with self._lock:
            entry = self._entries.pop(source_id, None)
            stale = self._drop_views_locked({source_id})
        if entry is None:
            return False
        with entry.lock:
            _close(entry.source)
            for view in stale:
                view.close()
        return True

    def ids(self) -> list[str]:
        with self._lock:
            return list(self._entries)

    @contextmanager
    def lease(self, source_ids: Sequence[str]) -> Iterator[Lease]:
        """在代码块执行期间锁定给定 source（按 id 排序加锁，使并发租用不会
        死锁）。"""
        ids = tuple(dict.fromkeys(source_ids))
        while True:
            with self._lock:
                entries = {sid: self._entries.get(sid) for sid in ids}
            missing = [sid for sid, entry in entries.items() if entry is None]
            if missing:
                raise RpcError(
                    f"data source not open: {', '.join(missing)}",
                    data={"kind": "source_not_open"},
                )
            with ExitStack() as stack:
                for sid in sorted(ids):
                    stack.enter_context(entries[sid].lock)
                with self._lock:
                    replaced = any(self._entries.get(sid) is not entries[sid] for sid in ids)
                if replaced:
                    continue  # 等待期间被重新打开或关闭了；重新解析
                yield Lease(self, ids, {sid: entry.source for sid, entry in entries.items()})
                return

    @contextmanager
    def use(self, source_id: str) -> Iterator[DataSource]:
        with self.lease([source_id]) as lease:
            yield lease.source(source_id)

    def _view(self, ids: tuple[str, ...], sources: list[DataSource]) -> SourceView:
        with self._lock:
            view = self._views.get(ids)
            if view is None:
                view = self._views[ids] = SourceView(sources)
            return view

    def _drop_views(self, source_ids: set[str]) -> list[SourceView]:
        with self._lock:
            return self._drop_views_locked(source_ids)

    def _drop_views_locked(self, source_ids: set[str]) -> list[SourceView]:
        stale = [key for key in self._views if source_ids.intersection(key)]
        return [self._views.pop(key) for key in stale]


def _close(source) -> None:
    close = getattr(source, "close", None)
    if callable(close):
        close()
        return
    invalidate = getattr(source, "invalidate", None)
    if callable(invalidate):
        invalidate()
        return
    conn = getattr(source, "_conn", None)
    if conn is not None:
        conn.close()
