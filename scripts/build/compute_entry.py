"""PyInstaller 入口：与 ``python -m compute`` 等价。

Bun 的 ComputeClient 默认给解释器传 ``["-m", "compute"]``；冻结后的可执行文件没有解释器，这些参数会被
原样传进来，所以这里忽略所有命令行参数，只跑 ``compute`` 的 RPC 循环。
"""
import logging
import os
import sys

from compute.methods import METHODS
from compute.rpc import run

logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("DW_COMPUTE_LOG", "WARNING"),
    format="[compute %(process)d] %(levelname)s %(name)s: %(message)s",
)

if __name__ == "__main__":
    run(METHODS)
