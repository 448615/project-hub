# -*- coding: utf-8 -*-
"""ds_store.cli — 独立命令行（兼容旧用法）

    python demo-scripts/data_store.py --init          # 建表 + 迁移旧 users.db
    python demo-scripts/data_store.py --export        # 输出账号 JSON
    python demo-scripts/data_store.py --check EMAIL   # 查单条
"""
from __future__ import annotations

import json
import logging
import sys

from . import paths
from .migrate import migrate_legacy
from .read import count, get_by_email
from .report import build_report
from .schema import init_db


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    init_db()
    if "--init" in argv:
        n = migrate_legacy()
        print(json.dumps(
            {"ok": True, "db": paths.DB_PATH, "migrated": n, "total": count()},
            ensure_ascii=False,
        ))
        return 0
    if "--export" in argv:
        print(json.dumps(
            build_report(reveal=("--reveal" in argv)), ensure_ascii=False, indent=2
        ))
        return 0
    if "--check" in argv:
        idx = argv.index("--check")
        target = argv[idx + 1] if len(argv) > idx + 1 else ""
        if not target:
            print("[错误] --check 需要一个邮箱参数", file=sys.stderr)
            return 2
        row = get_by_email(target)
        print(json.dumps(dict(row) if row else None, ensure_ascii=False, indent=2))
        return 0 if row else 1
    print(__doc__)
    return 0
