"""Business tool implementations shared by the old agent and the compute worker.

``data`` and ``export`` hold the tool mixins; ``dispatch`` maps a tool call
(name + model-facing args) onto them. The chart and PPT engines are imported by
bare module name (``chart_generate``, ``PPT``), so their directories must be on
``sys.path`` before any tool runs.
"""
import sys
from pathlib import Path

from infrastructure.paths import resource_root

_ROOT = Path(resource_root())
for _path in (_ROOT, _ROOT / "Function" / "Charts_generation", _ROOT / "Function" / "Output"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
