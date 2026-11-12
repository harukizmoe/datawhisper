#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Workspace Runtime — 工作目录资源容器层。

用户侧模型（与上传并行，非替代）：
  - 上传：文件落 uploads/，适合临时分析。
  - 工作目录：用户挂载一个本地项目文件夹为可读根，Agent 可直接
    read_csv('销售.xlsx') 读目录内文件，无需上传。产出物写到该目录下
    的 artifacts/。
  - 两者注册到同一个 DuckDB 连接，可跨源 JOIN。

Python 侧无状态：工作区的身份与根目录由 server 在每次请求里给出，这里只负责
  - WorkspaceRuntime：由根目录推出的路径容器（artifacts/.baa_cache/.zhixi）、
    注册快照读写、数据文件枚举与 SQL 读取白名单
  - validate_workdir：根目录的黑名单校验
不保存挂载状态、会话绑定或引用计数。
"""
from __future__ import annotations

import hashlib
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from compute.infrastructure.paths import content_data_path, resource_path
from compute.i18n import say

log = logging.getLogger(__name__)

# ── 始终黑名单（无论是否在工作目录内，一律拒绝）─────────────────────────────
# 路径片段匹配，resolve 后的路径包含这些片段则拒绝。
_BLOCKED_PATH_FRAGMENTS = (
    ".env",           # 环境变量文件
    ".ssh",           # SSH 密钥
    ".git",           # Git 元数据
    "__pycache__",    # Python 缓存
)

# 文件名后缀黑名单（敏感密钥/证书）
_BLOCKED_SUFFIXES = (
    ".key", ".pem", ".crt", ".pfx", ".keystore",
)


def _detect_blocked_system_dirs() -> List[Path]:
    """收集各 OS 的系统目录，resolve 后用于黑名单校验。"""
    dirs: List[Path] = []
    home = Path.home()
    # 用户目录下的敏感子目录
    for sub in (".ssh", ".gnupg", ".aws", ".config"):
        p = home / sub
        try:
            if p.exists():
                dirs.append(p)
        except (PermissionError, OSError):
            pass
    # Windows 系统目录
    for env_var in ("SystemRoot", "windir"):
        val = os.environ.get(env_var)
        if val:
            dirs.append(Path(val))
    # Unix 系统目录
    for sys_dir in ("/etc", "/boot", "/proc", "/sys", "/dev", "/var/log"):
        try:
            p = Path(sys_dir)
            if p.exists():
                dirs.append(p)
        except Exception:
            pass
    return dirs


# 系统目录黑名单（挂载这些目录或其子目录一律拒绝）
_BLOCKED_SYSTEM_DIRS = _detect_blocked_system_dirs()


def file_signature(path: Path) -> dict:
    """文件的大小与修改时间：导入时记进 registry，列目录时只比这两个值，不重算哈希。"""
    try:
        st = os.stat(path)
    except OSError:
        return {}
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def _is_blocked_path(resolved: Path) -> bool:
    """检查 resolve 后的路径是否命中始终黑名单。"""
    # 路径片段
    parts = {p.lower() for p in resolved.parts}
    for frag in _BLOCKED_PATH_FRAGMENTS:
        if frag.lower() in parts:
            return True
    # 后缀
    if resolved.suffix.lower() in _BLOCKED_SUFFIXES:
        return True
    # 系统目录：路径本身是系统目录，或在系统目录下
    for sys_dir in _BLOCKED_SYSTEM_DIRS:
        try:
            resolved.relative_to(sys_dir)
            return True  # resolved 在 sys_dir 下
        except ValueError:
            continue
    return False


def validate_workdir(path_str: str) -> tuple[bool, str, Optional[Path]]:
    """校验工作目录路径。

    返回 (ok, message, resolved_path)：
      - ok=False 时 message 是拒绝原因，resolved_path 为 None
      - ok=True 时 message 为空，resolved_path 是 resolve 后的绝对路径
    """
    if not path_str or not path_str.strip():
        return False, say("Workspace path must not be empty.", "工作目录路径不能为空。"), None

    try:
        candidate = Path(path_str).expanduser().resolve(strict=True)
    except FileNotFoundError:
        return False, say(f"Path does not exist: {path_str}", f"路径不存在：{path_str}"), None
    except (OSError, RuntimeError) as e:
        return False, say(f"Failed to resolve path: {e}", f"路径解析失败：{e}"), None

    # 必须是目录
    if not candidate.is_dir():
        return False, say(f"Path is not a directory: {candidate}", f"路径不是目录：{candidate}"), None

    # 必须可读
    if not os.access(candidate, os.R_OK):
        return False, say(f"Directory is not readable: {candidate}", f"目录不可读：{candidate}"), None

    # 命中始终黑名单（系统目录等）
    if _is_blocked_path(candidate):
        return False, say(f"Security restriction: mounting system/sensitive directories is not allowed: {candidate}", f"安全限制：不允许挂载系统/敏感目录：{candidate}"), None

    # 不允许挂载项目根目录自身（避免 Agent 读写源码）
    proj_root = Path(__file__).parent.parent.resolve()
    try:
        candidate.relative_to(proj_root)
        return False, say(f"Mounting the project root directory is not allowed: {candidate}", f"不允许挂载项目根目录：{candidate}"), None
    except ValueError:
        pass

    return True, "", candidate


# ── WorkspaceRuntime ──────────────────────────────────────────────────────

@dataclass(frozen=True)
class WorkspacePathAuthorization:
    """Immutable SQL file-read capability bound to one Workspace identity."""

    workspace_id: str
    allowed_roots: tuple[Path, ...]
    metadata_revision: int


def _default_extra_roots() -> List[Path]:
    """SQL 文件读取在工作区之外始终允许的项目级根目录。"""
    return [content_data_path("uploads"), resource_path("Information")]


@dataclass
class WorkspaceRuntime:
    """单个工作目录的资源容器。

    A5+ 起：持持久化 DuckDB 路径 + 注册快照路径，实现"关闭后保留、下次秒开"。
    连接本身仍在 DataSource 层管理，Runtime 只提供路径和注册快照读写。
    """
    workspace_id: str                    # 稳定的工作区 id（由 server 分配，Python 不持有）
    workdir: Path                        # 工作目录（resolve 后的绝对路径）
    metadata_revision: int = 1
    artifacts_dir: Path = field(init=False)   # 产出物目录（workdir/artifacts）
    cache_dir: Path = field(init=False)       # Parquet 缓存目录（workdir/.baa_cache）
    meta_dir: Path = field(init=False)        # 元数据目录（workdir/.zhixi）—— 持久化 DB + registry
    db_path: Path = field(init=False)         # 持久化 DuckDB 文件（meta_dir/workspace.duckdb）
    registry_path: Path = field(init=False)   # 文件注册快照（meta_dir/registry.json）

    # DuckDB only allows one writer for a persistent workspace database at a
    # time.  B2 workers take this lock before opening their own read-write
    # connection; the connection itself is never shared across threads.
    db_lock: threading.RLock = field(
        default_factory=threading.RLock,
        repr=False,
        compare=False,
    )

    # 允许读取的额外根目录（uploads/Information，项目级）
    extra_roots: List[Path] = field(default_factory=lambda: _default_extra_roots())

    def __post_init__(self):
        # artifacts 和 cache 在工作目录下创建
        self.artifacts_dir = self.workdir / "artifacts"
        self.cache_dir = self.workdir / ".baa_cache"
        self.meta_dir = self.workdir / ".zhixi"
        self.db_path = self.meta_dir / "workspace.duckdb"
        self.registry_path = self.meta_dir / "registry.json"
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.meta_dir.mkdir(parents=True, exist_ok=True)

    # ── 目录浏览（A3：让 Agent 看见工作目录内容）──────────────────────────

    # Agent 可识别的数据文件后缀（小写）
    _DATA_SUFFIXES = {
        ".csv", ".tsv", ".parquet", ".json", ".jsonl",
        ".xlsx", ".xls",
        ".txt",  # 纯文本，可能是数据
    }

    def list_data_files(self, max_files: int = 50) -> List[dict]:
        """递归列出工作目录内可作为数据源候选的文件。

        返回 [{"name": "子目录/销售.xlsx", "size": 12345, "suffix": ".xlsx"}, ...]
        跳过 artifacts/、.zhixi/、.baa_cache/、隐藏目录/文件、黑名单路径。
        """
        results: List[dict] = []
        max_files = max(1, int(max_files))
        skip_dirs = {"artifacts", ".zhixi", ".baa_cache", "__pycache__", "node_modules", ".venv"}
        try:
            root = self.workdir.resolve()
            for current, dirs, filenames in os.walk(self.workdir, followlinks=False):
                current_path = Path(current)
                allowed_dirs: list[str] = []
                for dirname in dirs:
                    lower = dirname.lower()
                    child = current_path / dirname
                    if dirname.startswith(".") or dirname.startswith("~") or lower in skip_dirs:
                        continue
                    try:
                        if child.is_symlink() or _is_blocked_path(child.resolve(strict=False)):
                            continue
                    except (OSError, RuntimeError):
                        continue
                    allowed_dirs.append(dirname)
                dirs[:] = sorted(allowed_dirs, key=str.lower)

                for filename in sorted(filenames, key=str.lower):
                    if filename.startswith(".") or filename.startswith("~"):
                        continue
                    entry = current_path / filename
                    suffix = entry.suffix.lower()
                    if suffix not in self._DATA_SUFFIXES:
                        continue
                    try:
                        if entry.is_symlink() or not entry.is_file():
                            continue
                        safe = entry.resolve(strict=False)
                        safe.relative_to(root)
                    except (OSError, RuntimeError, ValueError):
                        continue
                    # 黑名单二次校验（保险）
                    if _is_blocked_path(safe):
                        continue
                    try:
                        size = safe.stat().st_size
                    except OSError:
                        size = 0
                    results.append({
                        "name": safe.relative_to(root).as_posix(),
                        "size": size,
                        "suffix": suffix,
                    })
                    if len(results) >= max_files:
                        return results
        except (OSError, PermissionError) as e:
            log.warning("[workspace] list_data_files failed: %s", e)
        return results

    def allowed_roots_for_sql(self) -> List[Path]:
        """返回 SQL 路径白名单的根目录列表（A4：给 validate.py 用）。

        顺序很重要：workdir 在最前，让相对路径优先相对 workdir 解析。
        包含：workdir / artifacts_dir / cache_dir / meta_dir / uploads / Information。
        """
        return [self.workdir, self.artifacts_dir, self.cache_dir, self.meta_dir] + list(self.extra_roots)

    def path_authorization(self) -> WorkspacePathAuthorization:
        """Build the immutable path capability used by SQL validation."""
        roots = tuple(path.expanduser().resolve() for path in self.allowed_roots_for_sql())
        return WorkspacePathAuthorization(
            workspace_id=self.workspace_id,
            allowed_roots=roots,
            metadata_revision=self.metadata_revision,
        )

    # ── 持久化注册快照（A5+）──────────────────────────────────────────────

    def load_registry(self) -> dict:
        """读取 registry.json。返回 {file_path: {sha256, tables, source_type, registered_at}}。

        文件不存在或损坏返回空 dict。
        """
        import json
        if not self.registry_path.exists():
            return {}
        try:
            return json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log.warning("[workspace] registry.json corrupted: %s", e)
            return {}

    def save_registry(self, registry: dict) -> None:
        """写入 registry.json。"""
        import json
        try:
            self.registry_path.write_text(
                json.dumps(registry, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError as e:
            log.warning("[workspace] save_registry failed: %s", e)

    @staticmethod
    def file_signature(path: Path) -> dict:
        """兼容旧的调用点：实际实现是模块级函数。"""
        return file_signature(path)

    @staticmethod
    def compute_file_hash(path: Path) -> str:
        """计算文件 sha256，用于检测内容变化。"""
        import hashlib
        h = hashlib.sha256()
        try:
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            return h.hexdigest()
        except OSError:
            return ""
