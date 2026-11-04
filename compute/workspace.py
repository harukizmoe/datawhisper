"""Workspace data files -> the Workspace's persistent DuckDB.

A mounted Workspace keeps its tables in ``<workdir>/.zhixi/workspace.duckdb``.
``registry.json`` beside it records each imported file's sha256, so files that
did not change are not parsed again (大 Excel 秒开) and the tables survive
restarts. Shared by the ``workspace.sync`` RPC method and the old mount route.
"""
import logging
import re
import traceback
from pathlib import Path

from .rpc import Cancelled

log = logging.getLogger(__name__)

# 可注册为 DataSource 的文件后缀
REGISTERABLE_SUFFIXES = {".csv", ".xlsx", ".xls"}

# Workbooks above this size import through a cancellable job.
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


def import_workdir_files(runtime, source, run_job, check_canceled=None) -> dict:
    """Import the new or changed data files of *runtime*'s workdir into its
    persistent DuckDB, which *source* (a ``WorkspacePersistentSource``) has open.

    Large workbooks and CSVs go through ``run_job(job_type, label, worker)``,
    ``worker(ctx)`` being the cancellable import job: it returns the job result
    when the job ran to completion, or None when it was queued to run later
    (the caller reports queued jobs; they count as skipped here).
    ``check_canceled`` runs before each file.

    Returns ``{"added": [{"source_name", "tables"}], "errors", "skipped", "reused"}``.
    """
    from data.sources.workspace_persistent import (
        csv_requires_job, parse_workspace_csv_job, parse_workspace_excel_job,
    )

    added = []
    errors = []
    reused = 0

    registry = runtime.load_registry()
    files = runtime.list_data_files(max_files=50)

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
            errors.append(f"{name}: 无法读取文件")
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
                    errors.append(f"{name}: CSV 注册失败")
                    continue
            else:
                with runtime.db_lock:
                    tables = source._register_excel(file_path, base_table)
                if not tables:
                    errors.append(f"{name}: Excel 无可注册的 sheet")
                    continue

            # 更新 registry
            entry = {
                "sha256": current_hash,
                "tables": tables,
                "source_type": suffix.lstrip("."),
                "file_path": file_path,
            }
            # Merge and persist under the same writer lock.  A large Excel job
            # may complete while this request is still walking later files;
            # writing the original snapshot at function exit would lose it.
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
