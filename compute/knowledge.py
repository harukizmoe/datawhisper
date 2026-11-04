"""Knowledge base and embedder methods (``knowledge.*``, ``embed.*``).

The desktop knowledge base is ``Function.Knowledge.KnowledgeBase`` in its
default scope: a SQLite store plus the kept source files beside it
(``<data>/uploads/knowledge``). Records and document chunks are embedded by
``neural_embedder`` (local BGE model, cloud endpoint or hash fallback), whose
state lives in this process, so its settings are methods here as well.

Parsing never calls a model: ``knowledge.parse`` returns the records of
template sheets plus the prompts for the rest of the file; the caller sends
each prompt to the user's model and passes the replies to ``knowledge.extract``.
"""
from __future__ import annotations

import os
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .rpc import INVALID_PARAMS, MethodContext, RpcError, int_param, str_param

KNOWLEDGE_FILE_SUFFIXES = {".xlsx", ".xls", ".docx"}

# Record kinds: (singular, plural) of their KnowledgeBase method names.
_KINDS = {
    "category": ("category", "categories"),
    "metric": ("metric", "metrics"),
    "rule": ("rule", "rules"),
    "note": ("note", "notes"),
}
# The fields ``knowledge.add`` passes to ``KnowledgeBase.add_<kind>``, with defaults.
_ADD_FIELDS = {
    "category": {"name": ""},
    "metric": {"name": "", "alias": "", "definition": "", "sql_template": "", "notes": "",
               "category_id": None},
    "rule": {"rule_id": "", "description": "", "condition": "", "severity": "warning",
             "category_id": None},
    "note": {"topic": "", "content": "", "tags": "", "category_id": None},
}

_EMBED_MODES = ("auto", "cloud", "local", "hash")

BGE_REPO = "BAAI/bge-small-zh-v1.5"
BGE_FILES = [
    "config.json",
    "pytorch_model.bin",
    "special_tokens_map.json",
    "tokenizer.json",
    "vocab.txt",
]


def bge_model_dir() -> Path:
    """Return the snapshot directory where BGE model files are expected."""
    cache = Path(
        os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
    ) / "baa_models" / "models--BAAI--bge-small-zh-v1.5" / "snapshots"
    if cache.exists():
        dirs = [d for d in cache.iterdir() if d.is_dir()]
        if dirs:
            return dirs[0]
    return cache / "7999e1d3359715c523056ef9478215996d"


def bge_files_complete() -> bool:
    """Check whether all required BGE model files exist on disk."""
    d = bge_model_dir()
    return all((d / f).exists() for f in BGE_FILES)


def stored_filename(original_name: str) -> str:
    """The knowledge-folder name of an uploaded file: its stem made safe,
    behind a random prefix that avoids collisions."""
    path = Path(original_name)
    safe_stem = "".join(c if c.isalnum() or c in "-_." else "_" for c in path.stem)[:60]
    return f"{uuid.uuid4().hex[:8]}_{safe_stem}{path.suffix.lower()}"


def list_knowledge_files(scope_dir: Path) -> list[dict]:
    """Kept source files of a knowledge scope, newest first."""
    scope_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for p in sorted(scope_dir.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True):
        if p.suffix.lower() in KNOWLEDGE_FILE_SUFFIXES:
            stat = p.stat()
            files.append({"filename": p.name, "size": stat.st_size, "mtime": stat.st_mtime})
    return files


def _knowledge_dir() -> Path:
    from Function.Knowledge.knowledge_base import knowledge_scope_dir

    return knowledge_scope_dir()


@contextmanager
def _knowledge_base() -> Iterator:
    """A short-lived KnowledgeBase (own SQLite connection) per call."""
    from Function.Knowledge.knowledge_base import KnowledgeBase

    kb = KnowledgeBase()
    try:
        yield kb
    finally:
        kb.close()


def _kind(params: dict) -> str:
    kind = str_param(params, "kind")
    if kind not in _KINDS:
        raise RpcError(f"'kind' must be one of: {', '.join(_KINDS)}", INVALID_PARAMS)
    return kind


def _object(params: dict, key: str) -> dict:
    value = params.get(key)
    if not isinstance(value, dict):
        raise RpcError(f"'{key}' must be an object", INVALID_PARAMS)
    return value


def _not_found(kind: str, item_id: int) -> RpcError:
    return RpcError(f"{kind} {item_id} not found", data={"kind": "not_found"})


def knowledge_list(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.list {kind, category_id?=1}`` -> ``{"items"}``; categories list all."""
    kind = _kind(params)
    with _knowledge_base() as kb:
        if kind == "category":
            return {"items": kb.list_categories()}
        return {"items": getattr(kb, f"list_{_KINDS[kind][1]}")(int_param(params, "category_id", 1))}


def knowledge_add(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.add {kind, record}`` -> the stored record (same name/rule_id/topic: updated)."""
    kind = _kind(params)
    record = _object(params, "record")
    fields = {key: record.get(key, default) for key, default in _ADD_FIELDS[kind].items()}
    with _knowledge_base() as kb:
        try:
            return getattr(kb, f"add_{_KINDS[kind][0]}")(**fields)
        except ValueError as exc:
            raise RpcError(str(exc), INVALID_PARAMS) from exc


def knowledge_update(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.update {kind, id, fields}`` -> the updated record."""
    kind = _kind(params)
    item_id = int_param(params, "id")
    fields = _object(params, "fields")
    with _knowledge_base() as kb:
        try:
            record = getattr(kb, f"update_{_KINDS[kind][0]}")(item_id, **fields)
        except ValueError as exc:
            raise RpcError(str(exc), INVALID_PARAMS) from exc
    if record is None:
        raise _not_found(kind, item_id)
    return record


def knowledge_toggle(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.toggle {kind, id}`` -> the record with ``enabled`` flipped."""
    kind = _kind(params)
    item_id = int_param(params, "id")
    singular = _KINDS[kind][0]
    with _knowledge_base() as kb:
        record = getattr(kb, f"get_{singular}_by_id")(item_id)
        if record is None:
            raise _not_found(kind, item_id)
        return getattr(kb, f"update_{singular}")(item_id, enabled=0 if record["enabled"] else 1)


def knowledge_delete(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.delete {kind, id}`` -> ``{"deleted": true}``; deleting a category
    deletes its knowledge too and adds the ``counts`` removed per kind."""
    kind = _kind(params)
    item_id = int_param(params, "id")
    with _knowledge_base() as kb:
        if kind != "category":
            getattr(kb, f"delete_{_KINDS[kind][0]}")(item_id)
            return {"deleted": True}
        try:
            return {"deleted": True, "counts": kb.delete_category(item_id)}
        except LookupError as exc:
            raise _not_found(kind, item_id) from exc
        except ValueError as exc:
            raise RpcError(str(exc), INVALID_PARAMS) from exc


def knowledge_search(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.search {q}`` -> ``{"metrics", "rules", "notes", "documents"}``:
    hybrid-search hits among enabled knowledge (at most 5 overall)."""
    q = str_param(params, "q", required=False).strip()
    if not q:
        return {"metrics": [], "rules": [], "notes": [], "documents": []}
    with _knowledge_base() as kb:
        return kb.search(q)


def knowledge_parse(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.parse {file_path, name?}``: keep an uploaded .xlsx/.xls/.docx in
    the knowledge folder and read it without a model.

    Returns ``{"filename", "format", "preview", "prompts"}``: ``preview`` holds the
    records of template sheets; every prompt (the rest of the file, chunked)
    goes to the user's model, the replies to ``knowledge.extract``.
    """
    from Function.Knowledge.file_parser import extraction_prompts, read_knowledge_file

    source = Path(str_param(params, "file_path"))
    name = str_param(params, "name", required=False) or source.name
    suffix = Path(name).suffix.lower()
    if suffix not in KNOWLEDGE_FILE_SUFFIXES:
        raise RpcError(
            f"不支持的文件格式 {suffix}，请上传 .xlsx / .xls / .docx",
            INVALID_PARAMS, data={"kind": "unsupported_format"},
        )
    if not source.is_file():
        raise RpcError(f"文件不存在：{source}", data={"kind": "file_not_found"})
    target = _knowledge_dir() / stored_filename(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    try:
        parsed = read_knowledge_file(str(target))
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise RpcError(f"文件解析失败：{exc}", data={"kind": "parse_failed"}) from exc
    return {
        "filename": target.name,
        "format": parsed["format"],
        "preview": parsed["preview"],
        "prompts": extraction_prompts(parsed["text"]),
    }


def knowledge_extract(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.extract {replies}`` -> ``{"records"}`` from the model's replies
    to the ``knowledge.parse`` prompts, in prompt order, deduplicated."""
    from Function.Knowledge.file_parser import merge_extracted

    replies = params.get("replies")
    if not isinstance(replies, list) or not all(isinstance(reply, str) for reply in replies):
        raise RpcError("'replies' must be a list of strings", INVALID_PARAMS)
    return {"records": merge_extracted(replies)}


def knowledge_confirm(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.confirm {records?, filename?, category_id?=1}``: store the reviewed
    records, then index the kept source file for retrieval.

    Returns ``{"inserted": {"metrics", "rules", "notes"}, "rag": {"chunks", ...}}``.
    Reports progress per step; a cancel takes effect between steps, so records
    stored before it stay.
    """
    from Function.Knowledge.file_parser import extract_text

    records = params.get("records") or []
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        raise RpcError("'records' must be a list of objects", INVALID_PARAMS)
    filename = Path(str_param(params, "filename", required=False)).name
    if not records and not filename:
        raise RpcError("No records or source file provided", INVALID_PARAMS)
    category_id = int_param(params, "category_id", 1)
    inserted = {"metrics": 0, "rules": 0, "notes": 0}
    rag: dict = {"chunks": 0}
    with _knowledge_base() as kb:
        if records:
            ctx.check()
            ctx.progress(10, "正在写入知识条目")
            inserted = kb.bulk_insert(records, category_id=category_id)
        source_path = _knowledge_dir() / filename if filename else None
        if source_path and source_path.is_file() and source_path.suffix.lower() in KNOWLEDGE_FILE_SUFFIXES:
            ctx.check()
            ctx.progress(40, "正在提取文档文本")
            text = extract_text(str(source_path))
            if text.strip():
                ctx.check()
                ctx.progress(60, "正在建立检索索引")
                rag = kb.index_document(filename, text, source_type="file", category_id=category_id)
    ctx.progress(100, "知识入库完成")
    return {"inserted": inserted, "rag": rag}


def knowledge_files(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.files {}`` -> ``{"files": [{"filename", "size", "mtime"}]}``, newest first."""
    return {"files": list_knowledge_files(_knowledge_dir())}


def knowledge_delete_file(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.deleteFile {filename}``: remove a kept source file and its
    retrieval chunks -> ``{"deleted": true, "chunks"}``. Only source files: the
    knowledge database beside them cannot be named."""
    filename = Path(str_param(params, "filename")).name
    target = _knowledge_dir() / filename
    if Path(filename).suffix.lower() not in KNOWLEDGE_FILE_SUFFIXES or not target.is_file():
        raise RpcError(f"File not found: {filename}", data={"kind": "file_not_found"})
    target.unlink()
    with _knowledge_base() as kb:
        return {"deleted": True, "chunks": kb.delete_document_index(filename)}


def knowledge_rebuild_embeddings(ctx: MethodContext, params: dict) -> dict:
    """``knowledge.rebuildEmbeddings {}``: re-embed the document chunks and records
    whose vectors are stale (embedder changed) -> ``{"rebuilt", "document_chunks",
    "structured_records"}``. Skill vectors belong to the agent service."""
    ctx.progress(5, "正在重建知识库向量")
    with _knowledge_base() as kb:
        result = kb.rebuild_all_embeddings()
    ctx.progress(100, "知识库向量已重建")
    return result


def embed_status(ctx: MethodContext, params: dict) -> dict:
    """``embed.status {}``: the active embedder, plus the local BGE model files.
    A caller installing the model downloads ``model_files`` of ``model_repo``
    into ``model_dir``, then calls ``embed.reload``."""
    from Function.Knowledge.neural_embedder import get_embed_info, get_init_error, is_neural

    return {
        **get_embed_info(),
        "installed": bge_files_complete(),
        "neural_active": is_neural(),
        "init_error": get_init_error(),
        "model_dir": str(bge_model_dir()),
        "model_repo": BGE_REPO,
        "model_files": BGE_FILES,
    }


def embed_set_mode(ctx: MethodContext, params: dict) -> dict:
    """``embed.setMode {mode}`` (auto | cloud | local | hash) -> the embedder info after the switch."""
    from Function.Knowledge.neural_embedder import get_embed_info, set_embed_mode

    mode = str_param(params, "mode").strip().lower()
    if mode not in _EMBED_MODES:
        raise RpcError("Invalid mode. Use: auto, cloud, local, hash", INVALID_PARAMS)
    set_embed_mode(mode)
    return get_embed_info()


def embed_cloud_config(ctx: MethodContext, params: dict) -> dict:
    """``embed.cloudConfig {}`` -> ``{"url", "model", "token_configured"}``."""
    from Function.Knowledge.neural_embedder import get_cloud_config

    return get_cloud_config()


def embed_set_cloud_config(ctx: MethodContext, params: dict) -> dict:
    """``embed.setCloudConfig {url, model, token?, clear_token?, test?}``: store the
    cloud embedding endpoint (an absent ``token`` keeps the stored one); with
    ``test`` the endpoint is probed first and the outcome returned as ``test``
    (a failed probe stores nothing, error kind ``cloud_test_failed``)."""
    from Function.Knowledge.neural_embedder import configure_cloud

    token = params.get("token")
    if token is not None and not isinstance(token, str):
        raise RpcError("'token' must be a string", INVALID_PARAMS)
    try:
        config = configure_cloud(
            url=str_param(params, "url", required=False),
            model=str_param(params, "model", required=False),
            token=token,
            clear_token=bool(params.get("clear_token")),
            verify=bool(params.get("test")),
        )
    except ValueError as exc:
        raise RpcError(str(exc), INVALID_PARAMS) from exc
    except Exception as exc:  # the probe's network or response failure
        raise RpcError(f"云端嵌入服务测试失败：{exc}", data={"kind": "cloud_test_failed"}) from exc
    return {"test": None, **config}


def embed_reload(ctx: MethodContext, params: dict) -> dict:
    """``embed.reload {}``: pick up BGE model files installed into ``model_dir``."""
    from Function.Knowledge.neural_embedder import (
        get_init_error, is_neural, reset_for_newly_installed_model,
    )

    reset_for_newly_installed_model()
    return {"neural_active": is_neural(), "init_error": get_init_error()}
