"""旧 agent 与 compute worker 共用的业务工具实现。

``data`` 与 ``export`` 存放工具的 mixin；``dispatch`` 把一次工具调用（名称 +
面向模型的参数）映射到这些 mixin。图表与 PPT 引擎以裸模块名（``chart_generate``、
``PPT``）导入，因此它们所在目录必须在任何工具运行之前进入 ``sys.path``。
"""
import sys
from pathlib import Path

from compute.infrastructure.paths import resource_root

_ROOT = Path(resource_root())
for _path in (_ROOT, _ROOT / "Function" / "Charts_generation", _ROOT / "Function" / "Output"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
