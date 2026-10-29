# -*- coding: utf-8 -*-
"""ds_store.paths — 路径、常量与进程级可变状态

**本模块是数据访问层唯一允许存放可变状态的地方**：库路径、密钥路径、旧库路径
（``configure()`` 会改），以及缓存的主密钥。

其他模块请一律写 ``paths.DB_PATH``，不要 ``from .paths import DB_PATH`` ——
那会把路径快照进自己的命名空间，``configure()`` 之后再读就是旧值，
症状是「测试指向临时库、实际却写进了生产库」这类事故。
"""
from __future__ import annotations

import logging
import os

# 包位于 demo-scripts/ds_store/，数据文件仍在 demo-scripts/ 下（与历史位置一致）
DS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_DIR = os.path.dirname(DS_DIR)

DB_PATH = os.path.join(DS_DIR, "hub_accounts.db")
KEY_PATH = os.path.join(ROOT_DIR, ".data", "secret.key")
LEGACY_DB = os.path.join(ROOT_DIR, "users.db")

#: 单字段长度上限：只作为安全边界（防止异常输入撑爆库），不是业务规则
MAX_FIELD_LEN = 1024

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS accounts ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " username TEXT NOT NULL,"
    " email TEXT NOT NULL UNIQUE,"
    " pwd_hash TEXT NOT NULL,"
    " pwd_enc TEXT NOT NULL DEFAULT '',"
    " role TEXT NOT NULL DEFAULT 'user',"
    " created_at REAL NOT NULL,"
    " updated_at REAL NOT NULL DEFAULT 0)"
)

#: 库内只有这两种角色，其它值一律按 user 处理（与 hub 账号层的判定保持一致）
VALID_ROLES = ("admin", "user")

log = logging.getLogger("hub.datastore")

# 主密钥缓存：由 crypto 模块读写，这里只负责「存放」与 configure 时失效
_MASTER = b""
_MASTER_LOADED = False


def configure(db_path: str = "", key_path: str = "", legacy_db=None) -> None:
    """覆盖默认路径（供 CLI 的 ``--db`` 等参数使用）。

    参数约定：
    * ``db_path`` / ``key_path``：空串表示"不改动"；
    * ``legacy_db``：``None`` 表示"不改动"，空串表示"禁用旧库迁移"
      （用 ``--db`` 指向别的库时不该把项目根的 users.db 也搬过去）。

    为何不在导入时读环境变量：hub/store.py 从自己的目录加载本模块，环境变量属于
    「调用方」，由调用方显式调用本函数才最可控；不调用则一切保持默认。

    改动密钥路径时会让已缓存的子密钥失效（下次访问重新读取），这是刻意的：
    换库就该换密钥，不能让旧密钥继续为新房数据服务。
    """
    global DB_PATH, KEY_PATH, LEGACY_DB, _MASTER, _MASTER_LOADED
    if db_path:
        DB_PATH = os.path.abspath(db_path)
    if key_path:
        KEY_PATH = os.path.abspath(key_path)
        _MASTER, _MASTER_LOADED = b"", False
    if legacy_db is not None:
        LEGACY_DB = os.path.abspath(legacy_db) if legacy_db else ""
