"""Workspace 数据文件 -> Workspace 的持久化 DuckDB。

挂载的 Workspace 把表存放在 ``<workdir>/.zhixi/workspace.duckdb``。旁边的
``registry.json`` 记录每个已导入文件的 sha256，因此未变化的文件不会再次解析
（大 Excel 秒开），重启后表也依然存在。``workspace.sync`` RPC 方法与旧的
mount 路由共用此模块。
"""
import logging
import re
import traceback
from pathlib import Path

from .i18n import say
from .rpc import Cancelled

log = logging.getLogger(__name__)

# 可注册为 DataSource 的文件后缀
REGISTERABLE_SUFFIXES = {".csv", ".xlsx", ".xls"}

# 超过该大小的 Workbooks 通过可取消的 job 导入。
EXCEL_JOB_BYTES = 5_000_000


def safe_table_name(filename: str) -> str:
    """从文件名生成合法的 DuckDB 表名。"""
    # 去扩展名
    stem = re.sub(r'\.(csv|xlsx|xls)$', '', filename, flags=re.IGNORECASE)
    # 清理为合法标识符
    cleaned = re.sub(r'[^\w]', '_', stem)
    cleaned = re.sub(r'_+', '_', cleaned).strip('_')
    if cleaned and cleaned[0].isdigit():
        cleaned = '_' + cleaned
    return cleaned or 'data'


def select_files(runtime, paths) -> tuple[list[dict], list[str]]:
    """把界面给的一组相对路径变成导入清单：只接受工作区内的可注册数据文件。

    返回 ``(files, errors)``；``files`` 的元素与 ``runtime.list_data_files()`` 的形状一致
    （``name``/``size``/``suffix``），所以后面的导入逻辑不用分情况处理。
    """
    from compute.data.workspace import _is_blocked_path

    root = runtime.workdir.resolve()
    files: list[dict] = []
    errors: list[str] = []
    for raw in paths:
        rel = str(raw).replace("\\", "/").strip()
        if not rel or rel.startswith("/") or any(part in {"..", ""} for part in rel.split("/")):
            errors.append(say(f"{raw}: not a path inside the workspace", f"{raw}: 不是工作区内的路径"))
            continue
        candidate = (root / rel)
        try:
            resolved = candidate.resolve(strict=False)
            if resolved != root and root not in resolved.parents:
                errors.append(say(f"{rel}: outside the workspace", f"{rel}: 在工作区之外"))
                continue
            if _is_blocked_path(resolved) or candidate.is_symlink():
                errors.append(say(f"{rel}: blocked path", f"{rel}: 不允许导入的路径"))
                continue
            suffix = candidate.suffix.lower()
            if suffix not in REGISTERABLE_SUFFIXES:
                errors.append(say(f"{rel}: not a data file", f"{rel}: 不是可导入的数据文件"))
                continue
            size = candidate.stat().st_size
        except OSError:
            errors.append(say(f"{rel}: cannot read file", f"{rel}: 无法读取文件"))
            continue
        files.append({"name": rel, "size": size, "suffix": suffix})
    return files, errors


def import_workdir_files(runtime, source, run_job, check_canceled=None, paths=None) -> dict:
    """把 *runtime* 的 workdir 中新增或有变化的数据文件导入其持久化 DuckDB，
    该 DuckDB 已由 *source*（一个 ``WorkspacePersistentSource``）打开。

    大工作簿与 CSV 通过 ``run_job(job_type, label, worker)`` 执行，其中
    ``worker(ctx)`` 是可取消的导入 job：job 完整跑完时返回其结果，被排入稍后
    执行时返回 None（调用方会报告排队的 job；这里把它们算作 skipped）。
    ``check_canceled`` 在每个文件之前调用。

    返回 ``{"added": [{"source_name", "tables"}], "errors", "skipped", "reused"}``。
    """
    from compute.data.sources.workspace_persistent import (
        csv_requires_job, parse_workspace_csv_job, parse_workspace_excel_job,
    )

    added = []
    errors = []
    reused = 0

    registry = runtime.load_registry()
    # paths 给出时只导入这几项（界面里的「Import」）；否则整理目录（挂载时的行为）。
    if paths is None:
        files = runtime.list_data_files(max_files=50)
    else:
        files, path_errors = select_files(runtime, paths)
        errors.extend(path_errors)

    for f in files:
        if check_canceled:
            check_canceled()
        name = f["name"]
        suffix = f["suffix"]

        if suffix not in REGISTERABLE_SUFFIXES:
            continue

        file_path = str(runtime.workdir / name)
        file_key = name  # registry 用文件名作 key（工作目录内唯一）

        # 算 sha256 检测变化
        current_hash = runtime.compute_file_hash(Path(file_path))
        if not current_hash:
            errors.append(say(f"{name}: cannot read file", f"{name}: 无法读取文件"))
            continue

        old_entry = registry.get(file_key)
        if old_entry and old_entry.get("sha256") == current_hash:
            # 文件未变化，表已在 .duckdb 里，跳过解析
            reused += 1
            log.debug("[workspace] reuse cached: %s (sha256 match)", name)
            continue

        # 新文件或内容变化，注册到持久化连接
        base_table = safe_table_name(name)
        previous_tables = (old_entry or {}).get("tables", [])
        try:
            job_type = worker = None
            if suffix in {".xlsx", ".xls"} and f.get("size", 0) > EXCEL_JOB_BYTES:
                job_type = "excel_parse"
                worker = (
                    lambda ctx, fp=file_path, table=base_table, key=file_key,
                           digest=current_hash, previous=previous_tables:
                        parse_workspace_excel_job(
                            ctx, ctx.runtime or runtime, fp, table, key, digest, previous
                        )
                )
            elif suffix == ".csv" and csv_requires_job(file_path):
                job_type = "csv_import"
                worker = (
                    lambda ctx, fp=file_path, table=base_table, key=file_key,
                           digest=current_hash, previous=previous_tables:
                        parse_workspace_csv_job(
                            ctx, ctx.runtime or runtime, fp, table, key, digest, previous
                        )
                )
            if worker is not None:
                result = run_job(job_type, name, worker)
                if result is not None:
                    added.append({"source_name": name, "tables": result["tables"]})
                continue
            if suffix == ".csv":
                with runtime.db_lock:
                    ok = source._register_csv(file_path, base_table)
                if ok:
                    tables = [base_table]
                else:
                    errors.append(say(f"{name}: CSV registration failed", f"{name}: CSV 注册失败"))
                    continue
            else:
                with runtime.db_lock:
                    tables = source._register_excel(file_path, base_table)
                if not tables:
                    errors.append(say(f"{name}: no Excel sheet could be registered", f"{name}: Excel 无可注册的 sheet"))
                    continue

            # 更新 registry
            entry = {
                "sha256": current_hash,
                **runtime.file_signature(Path(file_path)),
                "tables": tables,
                "source_type": suffix.lstrip("."),
                "file_path": file_path,
            }
            # 在同一个写锁下合并并持久化。一个大的 Excel job 可能在本次请求
            # 还在遍历后续文件时完成；若在函数退出时写回最初的快照，就会丢失它。
            with runtime.db_lock:
                registry = runtime.load_registry()
                registry[file_key] = entry
                runtime.save_registry(registry)
            added.append({
                "source_name": name,
                "tables": tables,
            })
            log.info("[workspace] registered %s → tables=%s", name, tables)
        except Cancelled:
            raise
        except Exception as exc:
            log.error("[workspace] FAILED to register %s: %s\n%s",
                      name, exc, traceback.format_exc())
            errors.append(f"{name}: {exc}")

    return {
        "added": added,
        "errors": errors,
        "skipped": len(files) - len(added) - len(errors) - reused,
        "reused": reused,
    }
