# -*- coding: utf-8 -*-
"""ds_store.report — 报表（run_all.py / CLI 共用，结构与历史版本保持一致）"""
from __future__ import annotations

import time

from . import paths
from .read import list_accounts


def build_report(reveal: bool = False) -> dict:
    """构建报表字典（供 hub 账号面板直接消费）。

    ``db_path`` 取 ``paths.DB_PATH`` 的**当前值**（不是导入时快照），
    这样 ``configure()`` 换了库，报表里标的也是新库。
    """
    rows = list_accounts(reveal=reveal)
    admins = [r for r in rows if r["role"] == "admin"]
    return {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "db_path": paths.DB_PATH,
        "total": len(rows),
        "admins": len(admins),
        "accounts": rows,
    }
