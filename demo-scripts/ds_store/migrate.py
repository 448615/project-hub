# -*- coding: utf-8 -*-
"""ds_store.migrate — 旧库迁移（枢纽根目录 users.db → demo-scripts/hub_accounts.db）"""
from __future__ import annotations

import os
import sqlite3
import time

from . import crypto, paths
from .read import get_by_email
from .schema import cursor
from .text import clean_role, norm as _norm
from .write import set_password


def migrate_legacy(known_plain: dict[str, str] | None = None) -> int:
    """把旧 users.db 的账号搬进来（幂等，已存在的邮箱跳过）。

    known_plain：可提供「邮箱 → 已知明文密码」，用于给历史账号补上可查看的密文副本。
    """
    known_plain = {_norm(k): v for k, v in (known_plain or {}).items()}
    if not paths.LEGACY_DB or not os.path.isfile(paths.LEGACY_DB):
        return 0
    try:
        old = sqlite3.connect(paths.LEGACY_DB, timeout=10)
        old.row_factory = sqlite3.Row
        try:
            rows = old.execute(
                "SELECT username,email,pwd_hash,role,created_at FROM users"
            ).fetchall()
        finally:
            old.close()
    except sqlite3.Error as exc:
        paths.log.warning("读取旧库失败（%s）：%s", paths.LEGACY_DB, exc)
        return 0

    moved = 0
    for r in rows:
        email = _norm(r["email"])
        if not email or get_by_email(email):
            continue
        now = time.time()
        try:
            with cursor() as con:
                con.execute(
                    "INSERT INTO accounts (username,email,pwd_hash,pwd_enc,role,created_at,updated_at)"
                    " VALUES (?,?,?,?,?,?,?)",
                    (r["username"] or email.split("@")[0], email,
                     crypto.seal_hash(r["pwd_hash"] or "", email) or (r["pwd_hash"] or ""),
                     crypto.encrypt_pwd(known_plain.get(email, ""), email),
                     clean_role(r["role"]),
                     r["created_at"] or now, now),
                )
                con.commit()
            moved += 1
        except sqlite3.Error as exc:
            paths.log.warning("迁移账号 %s 失败，已跳过：%s", email, exc)
            continue

    # 已知明文但历史库里没有的账号，补全密码
    for email, plain in known_plain.items():
        row = get_by_email(email)
        if row and not (row["pwd_enc"] or ""):
            set_password(int(row["id"]), plain)

    if moved:
        paths.log.info("已从 %s 迁移 %d 个账号", paths.LEGACY_DB, moved)
    return moved
