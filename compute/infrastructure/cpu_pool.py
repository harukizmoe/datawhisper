#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Process-isolated CPU-bound task executor.

Why this exists
---------------
Python's GIL prevents ThreadPoolExecutor from delivering real parallelism
for CPU-heavy workloads (matrix math, time-series fitting, embedding
inference). ``multiprocessing`` has historically been banned in this project
because of fork-semantics traps on Windows, but ``ProcessPoolExecutor`` with
an explicit ``spawn`` context is safe: child processes re-import modules
fresh, no fork, no inherited state.

When to use
-----------
- Prophet rolling backtest (n_folds independent fits, pure numpy)
- Future CPU-heavy analyses (clustering on large frames, batch embedding
  inference when not using the cloud endpoint)

When NOT to use
----------------
- LLM/MCP calls → ``ThreadPoolExecutor`` (IO-bound, GIL released during waits)
- DuckDB writes → serialized behind ``WorkspaceRuntime.db_lock``
- Small data (<1000 points) → sync call is faster than process spawn overhead

Safety
------
- Lazy init: the pool is created on first ``get_cpu_pool()`` call, not at
  import. This keeps startup fast and tests that monkeypatch the pool
  deterministic.
- Graceful degradation: if spawn fails (rare, e.g. frozen exe without
  proper multiprocessing support), ``run_cpu_bound`` falls back to a
  synchronous call so the analysis still completes, just slower.
- atexit hook ensures workers are joined on interpreter exit.
"""
from __future__ import annotations

import atexit
import logging
import multiprocessing
import os
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Callable, Optional, Sequence, TypeVar

log = logging.getLogger(__name__)

T = TypeVar("T")

# Cap workers: CPU-bound parallelism beyond physical cores is pure overhead.
# 4 is a safe default that balances speed (Prophet 3-fold backtest) against
# memory pressure (each worker re-imports numpy/pandas ~80MB).
_MAX_WORKERS = min(4, os.cpu_count() or 2)

# Explicit spawn context — bypasses fork on Linux/macOS to match Windows
# semantics and avoid the fork-related traps documented in conventions.md.
_CTX = multiprocessing.get_context("spawn")

_pool: Optional[ProcessPoolExecutor] = None
_disabled = False  # set True if pool creation ever fails, to stop retrying


def get_cpu_pool() -> ProcessPoolExecutor:
    """Return the process-wide CPU pool (lazy-init, thread-safe via GIL).

    Raises ``RuntimeError`` if the pool cannot be created; callers should
    catch and fall back to synchronous execution.
    """
    global _pool, _disabled
    if _pool is not None:
        return _pool
    if _disabled:
        raise RuntimeError("cpu_pool is disabled (previous init failure)")
    try:
        # NOTE: ProcessPoolExecutor does NOT accept ``thread_name_prefix``
        # (that's ThreadPoolExecutor-only). ``mp_context=spawn`` is what
        # makes this safe on Windows — no fork, no inherited state.
        _pool = ProcessPoolExecutor(
            max_workers=_MAX_WORKERS,
            mp_context=_CTX,
        )
        atexit.register(shutdown_cpu_pool)
        log.info("[cpu_pool] ProcessPoolExecutor started (workers=%d, ctx=spawn)", _MAX_WORKERS)
        return _pool
    except Exception as exc:
        # Frozen exe / restricted env / spawn failure → disable permanently
        # so we don't retry on every call. Raise RuntimeError so callers
        # can catch a single exception type to trigger sync fallback.
        _disabled = True
        log.warning("[cpu_pool] spawn failed (%s); CPU tasks will run sync", exc)
        raise RuntimeError(f"cpu_pool unavailable: {exc}") from exc


def shutdown_cpu_pool() -> None:
    """Join workers on exit. Safe to call multiple times."""
    global _pool
    if _pool is None:
        return
    try:
        _pool.shutdown(wait=False, cancel_futures=True)
        log.info("[cpu_pool] shutdown complete")
    except Exception as exc:
        log.warning("[cpu_pool] shutdown error: %s", exc)
    finally:
        _pool = None


def run_cpu_bound(
    fn: Callable[..., T],
    *args: Any,
    timeout: Optional[float] = None,
    **kwargs: Any,
) -> T:
    """Submit a single CPU-bound task, block for result.

    Falls back to synchronous ``fn(*args, **kwargs)`` if the pool is
    unavailable or the worker dies, so callers never need a try/except for
    the common case. Use this for one-shot CPU work; for batch parallelism
    use ``get_cpu_pool().map(fn, iterable)`` directly.
    """
    if _disabled:
        return fn(*args, **kwargs)
    try:
        pool = get_cpu_pool()
        future = pool.submit(fn, *args, **kwargs)
        return future.result(timeout=timeout)
    except Exception as exc:
        log.warning("[cpu_pool] run_cpu_bound failed (%s), running sync", exc)
        return fn(*args, **kwargs)


def map_cpu_bound(
    fn: Callable[..., T],
    iterable: Sequence,
    timeout: Optional[float] = None,
) -> list[T]:
    """Parallel map for CPU-bound work. Returns results in input order.

    Falls back to sequential ``[fn(x) for x in iterable]`` on pool failure
    (init error, broken pool, worker crash). This is a safe degradation —
    results are identical, just slower.
    """
    items = list(iterable)
    if not items:
        return []
    # Single-item or disabled → sync is faster than IPC round-trip
    if _disabled or len(items) == 1:
        return [fn(item) for item in items]
    try:
        pool = get_cpu_pool()
        return list(pool.map(fn, items, timeout=timeout))
    except Exception as exc:
        log.warning("[cpu_pool] map failed (%s), falling back to sync", exc)
        return [fn(item) for item in items]
