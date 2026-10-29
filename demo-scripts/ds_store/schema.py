# -*- coding: utf-8 -*-
"""ds_store.schema — 连接、建表与加密迁移（库结构相关的唯一入口）"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

from . import crypto, paths


def connect() -> sqlite3.Connection:
    """打开连接（Row 工厂 + 10s 忙等待，容忍枢纽与脚本并发访问）。"""
    con = sqlite3.connect(paths.DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    return con


@contextmanager
def cursor():
    """连接上下文：无论成功失败都关闭连接（避免长驻脚本泄漏句柄）。"""
    con = connect()
    try:
        yield con
    finally:
        con.close()


def init_db() -> bool:
    """建表（幂等）+ 触发加密迁移。返回是否可写；只读磁盘下返回 False 但不抛异常。"""
    try:
        with cursor() as con:
            con.execute(paths.SCHEMA)
            con.commit()
    except sqlite3.Error as exc:
        paths.log.warning("账号库不可写（%s）：%s", paths.DB_PATH, exc)
        return False
    migrate_crypto()
    return True


def migrate_crypto() -> int:
    """把历史明文 / v1 密文升级为 v2 认证加密（幂等，失败不影响启动）。

    - ``pwd_hash`` 为明文 ``salt$hash``  → 加密封存
    - ``pwd_enc``  为 v1 密文            → 解密后按 v2 重新加密
    - 密钥不可用（只读盘 / 无 secret.key）→ 直接跳过，保持原样
    """
    if not crypto.master():
        return 0
    migrated = 0
    try:
        with cursor() as con:
            rows = con.execute("SELECT id,email,pwd_hash,pwd_enc FROM accounts").fetchall()
            for row in rows:
                email = row["email"]
                new_hash, new_enc = None, None

                current_hash = row["pwd_hash"] or ""
                if current_hash and not current_hash.startswith("v2:"):
                    sealed = crypto.seal_hash(current_hash, email)
                    if sealed:
                        new_hash = sealed

                current_enc = row["pwd_enc"] or ""
                if current_enc.startswith("v1:"):
                    plain = crypto.legacy_decrypt(current_enc)
                    if plain:
                        sealed = crypto.encrypt_pwd(plain, email)
                        if sealed:
                            new_enc = sealed

                if new_hash or new_enc:
                    con.execute(
                        "UPDATE accounts SET pwd_hash=COALESCE(?,pwd_hash),"
                        " pwd_enc=COALESCE(?,pwd_enc) WHERE id=?",
                        (new_hash, new_enc, row["id"]),
                    )
                    migrated += 1
            con.commit()
        if migrated:
            paths.log.info("加密迁移完成：%d 条记录升级为 v2 密文", migrated)
    except sqlite3.Error as exc:
        paths.log.warning("加密迁移跳过：%s", exc)
    return migrated
