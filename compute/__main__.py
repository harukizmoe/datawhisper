"""入口：``python -m compute``（由 Node 服务端拉起）。"""
import logging
import os
import sys

from .methods import METHODS
from .rpc import run

logging.basicConfig(
    stream=sys.stderr,
    level=os.environ.get("DW_COMPUTE_LOG", "WARNING"),
    format="[compute %(process)d] %(levelname)s %(name)s: %(message)s",
)
run(METHODS)
