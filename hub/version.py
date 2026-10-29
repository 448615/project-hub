# -*- coding: utf-8 -*-
"""版本号唯一来源（单一事实源）。

之前版本号硬编码在 health.py:15，前后端无统一出处。
现在所有运行时取版本的地方都从这里 import，避免改了一处漏了另一处。

pyproject.toml 的 [project].version 应与此保持一致；CI 会校验两者相等。
"""
from __future__ import annotations

__version__ = "1.1.0"
