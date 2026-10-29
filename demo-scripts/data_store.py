# -*- coding: utf-8 -*-
"""data_store — 数据访问层的**兼容入口**（真正的实现在同目录 ``ds_store/`` 包里）

为什么要保留这个文件：
1. ``import data_store as ds`` 的旧写法（run_all.py、tests）不能断；
2. ``python demo-scripts/data_store.py --init/--export/--check`` 的旧命令不能断。

实现方式：本模块**不复制任何名字**，所有属性访问都通过 ``__getattr__`` 转发给
``ds_store``。这样 ``ds.DB_PATH`` 读到的永远是当前值，不会出现「导入时快照」
导致换库后路径仍是旧值的问题。

这里只做转发，不放任何业务逻辑。**新代码请直接 ``import ds_store``**。
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import ds_store  # noqa: E402

__all__ = list(ds_store.__all__)


def __getattr__(name: str):
    """全部转发：函数、常量、可变状态都从 ds_store 实时取。"""
    try:
        return getattr(ds_store, name)
    except AttributeError:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from None


def __dir__():
    return sorted(set(__all__))


if __name__ == "__main__":
    sys.exit(ds_store.main(sys.argv[1:]))
