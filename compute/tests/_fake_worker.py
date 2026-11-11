"""带测试专用方法的 worker，以 ``python -m compute.tests._fake_worker`` 运行。"""
import ctypes
import os
import sys
import time

from compute.i18n import say
from compute.rpc import RpcError, run


def echo(ctx, params):
    return params


def sleep(ctx, params):
    time.sleep(float(params.get("seconds", 0)))
    return {"slept": params.get("seconds")}


def loop_until_cancelled(ctx, params):
    for i in range(400):
        ctx.check()
        ctx.progress(i, f"step {i}")
        time.sleep(0.01)
    return {"finished": True}


def noisy(ctx, params):
    print("python print to stdout")
    sys.stdout.write("direct sys.stdout write\n")
    os.write(1, b"raw fd 1 write\n")
    libc = ctypes.CDLL(None) if os.name != "nt" else None
    if libc is not None:
        libc.puts(b"C puts to stdout")
        libc.fflush(None)
    return {"ok": True}


def not_finite(ctx, params):
    import numpy as np
    return {"nan": float("nan"), "inf": float("inf"), "np_nan": np.float64("nan"), "nested": [1.5, float("-inf")]}


def app_error(ctx, params):
    raise RpcError("bad table", data={"kind": "table_not_found"})


def crash(ctx, params):
    raise KeyError("boom")


def event(ctx, params):
    ctx.event({"type": "chart", "html": "<div>图表</div>"})
    return {"sent": True}


def greet(ctx, params):
    # 返回收到的参数，证明保留参数 `_lang` 没有漏给方法。
    return {"text": say("hello", "你好"), "params": params}


run({
    "greet": greet,
    "ping": lambda ctx, params: {"pid": os.getpid()},
    "echo": echo,
    "sleep": sleep,
    "loop": loop_until_cancelled,
    "noisy": noisy,
    "not_finite": not_finite,
    "app_error": app_error,
    "crash": crash,
    "event": event,
})
