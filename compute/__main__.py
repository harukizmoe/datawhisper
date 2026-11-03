"""Entry point: ``python -m compute`` (spawned by the Node server)."""
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
