# -*- coding: utf-8 -*-
"""数据处理脚本 · 数据访问层（零依赖，仅标准库）。

定位
----
本包是「项目枢纽」账号数据的**唯一读写入口**：

* 枢纽进程（hub/store.py）把 ``demo-scripts/`` 加入 sys.path 后 ``import ds_store``；
* 命令行脚本（run_all.py）同样复用这里，两边共用同一份 ``hub_accounts.db``。

历史上这里是一个 708 行的单文件 ``data_store.py``，四件事混在一起。现按依赖
顺序拆成单向依赖的模块（改上层不会影响下层）：

    paths.py    路径、常量、configure 与**唯一存放可变状态的地方**
    text.py     输入规范化（邮箱/文本/角色）
    crypto.py   主密钥 → 子密钥派生（HKDF）→ AEAD / 密码哈希
    schema.py   连接、建表、加密迁移
    read.py     只读查询
    write.py    写入（建号/改密/改角色/删除）
    migrate.py  旧 users.db 迁移
    report.py   报表
    cli.py      独立命令行

改动约定
--------
1. 需要库路径/密钥路径时写 ``paths.DB_PATH``、``paths.KEY_PATH``，
   **不要** ``from .paths import DB_PATH``：``configure()`` 换库后快照就是旧值。
2. 本包不许依赖 ``hub`` 或 ``ds_config``／``ds_output``／``ds_report``，
   保证「命令行脚本单独拿走 demo-scripts/ 也能跑」。

公开 API 契约
-------------
hub/store.py 与 hub/accounts.py 依赖下列符号，**改动签名会直接让登录/账号面板失效**：
``subkey`` ``aead_encrypt`` ``aead_decrypt`` ``hash_pwd`` ``check_pwd``
``create`` ``get_by_email`` ``get_by_id`` ``count`` ``set_password``
``set_role`` ``delete`` ``list_accounts`` ``raw_hash`` ``init_db``
``migrate_legacy`` ``build_report`` ``configure``

另外 ``DB_PATH`` ``KEY_PATH`` ``LEGACY_DB`` ``_MASTER`` ``_MASTER_LOADED``
是**可变状态**，通过模块级 ``__getattr__`` 实时转发到 ``paths``，保证
``ds.DB_PATH`` 读到的永远是当前值（测试会用它做备份/还原）。
"""
from __future__ import annotations

from . import paths
from .cli import main
from .crypto import (
    aead_decrypt,
    aead_encrypt,
    check_pwd,
    decrypt_pwd,
    encrypt_pwd,
    hash_pwd,
    subkey,
)
from .migrate import migrate_legacy
from .paths import (
    MAX_FIELD_LEN,
    SCHEMA,
    VALID_ROLES,
    configure,
    log,
)
from .read import count, get_by_email, get_by_id, list_accounts, raw_hash, verify
from .report import build_report
from .schema import connect, init_db, migrate_crypto
from .write import create, delete, set_password, set_role

#: 这些名字的真实值存放在 paths 里，必须实时读取，不能在这里 import 成快照
_LIVE_STATE = ("DB_PATH", "KEY_PATH", "LEGACY_DB", "_MASTER", "_MASTER_LOADED")

__all__ = [
    # 配置与常量
    "configure", "DB_PATH", "KEY_PATH", "LEGACY_DB", "MAX_FIELD_LEN",
    "SCHEMA", "VALID_ROLES", "log",
    # 加密与哈希
    "subkey", "aead_encrypt", "aead_decrypt", "hash_pwd", "check_pwd",
    "encrypt_pwd", "decrypt_pwd",
    # 库结构
    "connect", "init_db", "migrate_crypto",
    # 读
    "count", "get_by_email", "get_by_id", "verify", "raw_hash", "list_accounts",
    # 写
    "create", "set_password", "set_role", "delete",
    # 迁移与报表
    "migrate_legacy", "build_report",
    # CLI
    "main",
]


def __getattr__(name: str):
    """把可变状态转发到 paths，避免「导入即快照」的坑（PEP 562）。"""
    if name in _LIVE_STATE:
        return getattr(paths, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(set(__all__) | set(_LIVE_STATE))
