"""项目枢纽（Project Hub）核心包。

对外只暴露 main()，保持 `from hub import main` 的既有用法可用。
"""
from __future__ import annotations

from .main import main
from .handlers import HubHandler

__all__ = ["main", "HubHandler"]
