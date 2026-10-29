# -*- coding: utf-8 -*-
"""ds_store.read — 只读查询（账号清单、按邮箱/ID 查找、密码校验）"""
from __future__ import annotations

import sqlite3

from . import crypto, paths
from .schema import cursor
from .text import norm as _norm


def count() -> int:
    try:
        with cursor() as con:
            row = con.execute("SELECT COUNT(*) FROM accounts").fetchone()
            return int(row[0]) if row else 0
    except (sqlite3.Error, TypeError) as exc:
        paths.log.warning("统计账号数失败：%s", exc)
        return 0


def get_by_email(email: str):
    try:
        with cursor() as con:
            return con.execute(
                "SELECT * FROM accounts WHERE email=?", (_norm(email),)
            ).fetchone()
    except sqlite3.Error as exc:
        paths.log.warning("按邮箱查询失败：%s", exc)
        return None


def get_by_id(uid: int):
    try:
        with cursor() as con:
            return con.execute("SELECT * FROM accounts WHERE id=?", (int(uid),)).fetchone()
    except (sqlite3.Error, TypeError, ValueError) as exc:
        paths.log.warning("按 ID 查询失败：%s", exc)
        return None


def verify(email: str, pwd: str):
    """校验邮箱 + 密码，成功返回行对象，失败返回 None。"""
    row = get_by_email(email)
    if row and crypto.check_pwd(pwd, row["pwd_hash"], row["email"]):
        return row
    return None


def raw_hash(email: str) -> str:
    """取出可用的 pbkdf2 哈希明文段（供云端副本使用；blob 本身已加密）。"""
    row = get_by_email(email)
    return crypto.open_hash(row["pwd_hash"], row["email"]) if row else ""


def list_accounts(reveal: bool = False) -> list[dict]:
    """账号清单。

    出于最小权限原则，账号报表**永远不返回明文密码**，也不再维护可逆的明文副本
    （pwd_enc 列自本版本起留空）。登录校验走不可逆的 pwd_hash（pbkdf2+盐），
    可逆明文只会放大「密钥泄露 → 全部密码可读」的爆炸半径，故移除。

    ``reveal`` 参数保留仅为接口兼容，不再有任何效果（历史上它控制是否回显明文）。
    """
    rows: list[dict] = []
    try:
        with cursor() as con:
            for r in con.execute("SELECT * FROM accounts ORDER BY id").fetchall():
                rows.append({
                    "id": r["id"],
                    "username": r["username"],
                    "email": r["email"],
                    "role": r["role"] or "user",
                    "created_at": r["created_at"] or 0,
                    "updated_at": r["updated_at"] or 0,
                    # 不再持有可逆明文副本，故没有「可查看明文」这一说
                    "has_plain": False,
                })
    except sqlite3.Error as exc:
        paths.log.warning("读取账号清单失败：%s", exc)
    return rows
