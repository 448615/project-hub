# -*- coding: utf-8 -*-
"""ds_store.write — 写入（建号、改密、改角色、删除）

所有写操作都返回 bool / (bool, str)，不向上抛 sqlite 异常：
调用方是 Web 请求线程，异常会把 500 直接甩给用户。
"""
from __future__ import annotations

import sqlite3
import time

from . import crypto, paths
from .read import get_by_email, get_by_id
from .schema import cursor
from .text import clean_role, clean_text, norm as _norm


def create(username: str, email: str, pwd: str, role: str = "user") -> tuple[bool, str]:
    """新建账号，返回 ``(是否成功, 错误说明)``。

    role 由调用方决定（默认普通用户），本函数不再自行判定管理员。
    历史实现是「库里没有账号 → 首个自动 admin」，那是 fail-open：账号库被清空/
    重建（云端 serverless 冷启动会回收本地盘）的一刻，公网上第一个注册的人就
    成了管理员。现在角色只认显式传入值，调用方以 config.json 的 admins 白名单为准。
    """
    email = _norm(email)
    if not email or not pwd:
        return False, "邮箱和密码不能为空。"
    if len(str(pwd)) > paths.MAX_FIELD_LEN:
        return False, "密码过长。"

    role = clean_role(role)
    now = time.time()
    username = clean_text(username, email.split("@")[0])
    try:
        with cursor() as con:
            con.execute(
                "INSERT INTO accounts (username,email,pwd_hash,pwd_enc,role,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?,?)",
                # pwd_hash 是 pbkdf2+盐的不可逆哈希，登录校验只认它。
                # 不再写 pwd_enc 可逆明文副本：拿到 secret.key 就能解出所有密码，
                # 只会放大「密钥泄露 → 全库密码可读」的爆炸半径。
                (username, email, crypto.seal_hash(crypto.hash_pwd(pwd), email), "",
                 role, now, now),
            )
            con.commit()
        paths.log.info("已创建账号：%s（%s）", email, role)
        return True, ""
    except sqlite3.IntegrityError:
        return False, "该邮箱已注册。"
    except sqlite3.Error as exc:
        paths.log.error("写入账号库失败：%s", exc)
        return False, f"写入账号库失败：{exc}"


def set_password(uid_or_email, pwd: str) -> bool:
    """设置新密码（按 ID 或邮箱定位）。空密码直接拒绝。"""
    if not pwd:
        return False
    if len(str(pwd)) > paths.MAX_FIELD_LEN:
        paths.log.warning("拒绝设置密码：长度超过 %d", paths.MAX_FIELD_LEN)
        return False
    # 先定位邮箱：v2 密文的 aad 绑定邮箱，加密前必须知道是哪个账号
    row = get_by_id(uid_or_email) if isinstance(uid_or_email, int) else get_by_email(uid_or_email)
    if not row:
        paths.log.warning("设置密码失败：账号不存在（%r）", uid_or_email)
        return False
    email = row["email"]
    try:
        with cursor() as con:
            cur = con.execute(
                "UPDATE accounts SET pwd_hash=?, pwd_enc=?, updated_at=? WHERE id=?",
                # pwd_enc 不再维护可逆明文副本（见 create 注释）
                (crypto.seal_hash(crypto.hash_pwd(pwd), email), "", time.time(), int(row["id"])),
            )
            con.commit()
            ok = cur.rowcount > 0
        if ok:
            paths.log.info("已重置密码：%s", email)
        return ok
    except sqlite3.Error as exc:
        paths.log.error("重置密码失败：%s", exc)
        return False


def set_role(uid: int, role: str) -> bool:
    role = clean_role(role)
    try:
        with cursor() as con:
            cur = con.execute(
                "UPDATE accounts SET role=?, updated_at=? WHERE id=?",
                (role, time.time(), int(uid)),
            )
            con.commit()
            ok = cur.rowcount > 0
        if ok:
            paths.log.info("已更新角色：id=%s → %s", uid, role)
        return ok
    except (sqlite3.Error, TypeError, ValueError) as exc:
        paths.log.error("更新角色失败：%s", exc)
        return False


def delete(uid: int) -> bool:
    try:
        with cursor() as con:
            cur = con.execute("DELETE FROM accounts WHERE id=?", (int(uid),))
            con.commit()
            ok = cur.rowcount > 0
        if ok:
            paths.log.info("已删除账号：id=%s", uid)
        return ok
    except (sqlite3.Error, TypeError, ValueError) as exc:
        paths.log.error("删除账号失败：%s", exc)
        return False
