"""面向用户与模型的文案语言。

服务把当前界面语言放在每个请求的 `_lang` 参数里（英文 `en` 或中文 `zh`），`rpc` 在派发前
取出并存进线程局部量；方法里用 `say(英文, 中文)` 成对给出文案。默认英文：
没有 `_lang`（测试、直接调用）时不应出现中文。
"""

from __future__ import annotations

import threading

_local = threading.local()


def set_language(lang: object) -> None:
    """只接受 `en` / `zh`；其他值回到英文。"""
    _local.lang = lang if lang in ("en", "zh") else "en"


def language() -> str:
    return getattr(_local, "lang", "en")


def say(en: str, zh: str) -> str:
    """按当前请求的语言取文案；两份文案各自带插值，调用点不要放有副作用的表达式。"""
    return zh if language() == "zh" else en
