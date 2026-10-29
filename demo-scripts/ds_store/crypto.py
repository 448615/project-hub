# -*- coding: utf-8 -*-
"""ds_store.crypto — 本机密钥、子密钥派生、认证加密与密码哈希

顺序即依赖顺序：主密钥 → 子密钥（HKDF）→ AEAD / 密码哈希。
密钥不可用时一律降级为「空串 / 不可查看」，绝不回落到明文。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets

from . import paths
from .text import norm as _norm

_KDF_SALT = b"hub-kdf-v2"


# ---------------------------------------------------------------------------
# 1. 本机密钥与子密钥派生
# ---------------------------------------------------------------------------
def _load_key() -> bytes:
    """读取本机主密钥；不存在则创建（600 权限）。失败返回空串 = 只读降级。"""
    try:
        if os.path.isfile(paths.KEY_PATH):
            with open(paths.KEY_PATH, "rb") as f:
                data = f.read(64)
                if data:
                    return data
    except OSError as exc:
        paths.log.warning("读取密钥失败（%s），将尝试重新生成：%s", paths.KEY_PATH, exc)
    try:
        os.makedirs(os.path.dirname(paths.KEY_PATH), exist_ok=True)
        key = secrets.token_bytes(64)
        with open(paths.KEY_PATH, "wb") as f:
            f.write(key)
        try:
            os.chmod(paths.KEY_PATH, 0o600)
        except OSError:
            pass
        paths.log.info("已生成新的本机密钥：%s", paths.KEY_PATH)
        return key
    except OSError as exc:
        paths.log.warning("密钥不可用（%s）：可逆字段降级为不可查看", exc)
        return b""


def master() -> bytes:
    """主密钥（64 字节随机，权限 600）。读取结果缓存，避免每次加解密都碰磁盘。"""
    if not paths._MASTER_LOADED:
        paths._MASTER = _load_key()
        paths._MASTER_LOADED = True
    return paths._MASTER


def subkey(label: str, length: int = 32) -> bytes:
    """HKDF-SHA256 派生子密钥。

    为什么不直接用主密钥：同一把密钥同时用于「加密」和「认证」在密码学上会引入
    跨用途风险（密钥复用）。这里每个用途（本地账号 / 云端副本 / 会话签名 / 邮箱
    索引）各取独立子密钥，任一子密钥泄露不牵连其他用途。
    """
    master_key = master()
    if not master_key:
        return b""
    prk = hmac.new(_KDF_SALT, master_key, hashlib.sha256).digest()
    info = label.encode("utf-8")
    out, prev, i = b"", b"", 1
    while len(out) < length:
        prev = hmac.new(prk, prev + info + bytes([i]), hashlib.sha256).digest()
        out += prev
        i += 1
    return out[:length]


# ---------------------------------------------------------------------------
# 2. 加密：AEAD（Encrypt-then-MAC）
# ---------------------------------------------------------------------------
def _keystream(key: bytes, nonce: bytes, n: int) -> bytes:
    """HMAC-SHA256 计数器模式密钥流（PRF-CTR，与 AES-CTR 同构的构造）。"""
    if n <= 0:
        return b""
    out, ctr = bytearray(), 0
    while len(out) < n:
        out += hmac.new(key, nonce + ctr.to_bytes(8, "big"), hashlib.sha256).digest()
        ctr += 1
    return bytes(out[:n])


def aead_encrypt(plain: str, aad: bytes = b"", label: str = "account") -> str:
    """认证加密（Encrypt-then-MAC，加密与认证密钥独立）。

    线上格式：``v2:`` + base64url(nonce(12) | 密文 | tag(32))
    - nonce 每条随机，绝不重用（重用会直接泄露密钥流）。
    - MAC 覆盖 ``版本 | aad 长度 | aad | nonce | 密文``：aad 把密文绑定到具体记录
      （例如邮箱），防止攻击者把 A 行的密文搬到 B 行复用。
    - ``label`` 决定用哪组子密钥，本地库与云端副本互不通用。
    密钥不可用时返回空串（降级为不可查看，绝不返回明文）。
    """
    if not plain:
        return ""
    ke, km = subkey(label + ":enc"), subkey(label + ":mac")
    if not ke or not km:
        return ""
    pt = plain.encode("utf-8")
    nonce = secrets.token_bytes(12)
    ct = bytes(a ^ b for a, b in zip(pt, _keystream(ke, nonce, len(pt))))
    tag = hmac.new(
        km,
        b"hub-aead-v2" + len(aad).to_bytes(4, "big") + aad + nonce + ct,
        hashlib.sha256,
    ).digest()
    return "v2:" + base64.urlsafe_b64encode(nonce + ct + tag).decode("ascii")


def aead_decrypt(token: str, aad: bytes = b"", label: str = "account") -> str:
    """认证解密。任何异常（篡改、编码错误、密钥不符）一律返回空串。

    先验 MAC 再解密：密文被改动时根本不进入解密路径，杜绝「先解出垃圾再报错」
    这类会泄露信息的行为。
    """
    if not token or not token.startswith("v2:"):
        return ""
    ke, km = subkey(label + ":enc"), subkey(label + ":mac")
    if not ke or not km:
        return ""
    try:
        raw = base64.urlsafe_b64decode(token[3:].encode("ascii"))
        if len(raw) < 12 + 32:
            return ""
        nonce, ct, tag = raw[:12], raw[12:-32], raw[-32:]
        calc = hmac.new(
            km,
            b"hub-aead-v2" + len(aad).to_bytes(4, "big") + aad + nonce + ct,
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(calc, tag):
            return ""
        pt = bytes(a ^ b for a, b in zip(ct, _keystream(ke, nonce, len(ct))))
        return pt.decode("utf-8")
    except (ValueError, UnicodeDecodeError, TypeError):
        return ""


# ---- 旧版 v1 密文（仅用于读迁移，不再产生）-------------------------------
def _legacy_privacy_key() -> bytes:
    raw = master()
    return hmac.new(raw, b"hub-account-privacy-v1", hashlib.sha256).digest() if raw else b""


def legacy_decrypt(stored: str) -> str:
    if not stored.startswith("v1:"):
        return ""
    key = _legacy_privacy_key()
    if not key:
        return ""
    try:
        raw = base64.urlsafe_b64decode(stored[3:].encode("ascii"))
        nonce, body, tag = raw[:12], raw[12:-16], raw[-16:]
        calc = hmac.new(key, nonce + body, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(calc, tag):
            return ""
        out, i = bytearray(), 0
        while len(out) < len(body):
            block = hmac.new(key, nonce + i.to_bytes(8, "big"), hashlib.sha256).digest()
            chunk = body[len(out):len(out) + len(block)]
            out.extend(b ^ s for b, s in zip(chunk, block))
            i += 1
        return bytes(out).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return ""


# ---------------------------------------------------------------------------
# 3. 密码哈希（登录校验用，不可逆）
# ---------------------------------------------------------------------------
PBKDF2_ROUNDS = 600000


def hash_pwd(pwd: str) -> str:
    """``salt$hash``（salt 16 字节、PBKDF2-HMAC-SHA256 600k 轮）。"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt, PBKDF2_ROUNDS)
    return salt.hex() + "$" + dk.hex()


# ---- 密码哈希本身也加密存放 ----------------------------------------------
# 为什么连不可逆的 pbkdf2 哈希也要加密：脱库攻击者拿到哈希后可以离线无限次
# 爆破（本地算力即可）。再套一层本机密钥加密后，没有 secret.key 就只剩密文。
def seal_hash(h: str, email: str) -> str:
    return aead_encrypt(h, aad=("hash:" + _norm(email)).encode("utf-8"), label="hash")


def open_hash(stored: str, email: str) -> str:
    """兼容三种历史形态：v2 密文 / 明文 salt$hash / 空。"""
    if not stored:
        return ""
    if stored.startswith("v2:"):
        return aead_decrypt(stored, aad=("hash:" + _norm(email)).encode("utf-8"), label="hash")
    return stored


def check_pwd(pwd: str, stored: str, email: str = "") -> bool:
    """校验密码。stored 可以是加密哈希（v2:）或历史明文哈希（salt$hash）。

    解密失败（密钥不符 / 密文被换行搬运）→ 直接 False，不做任何"降级放行"。
    """
    real = open_hash(stored, email)
    if not real:
        return False
    try:
        salt_hex, hash_hex = real.split("$", 1)
        dk = hashlib.pbkdf2_hmac(
            "sha256", pwd.encode("utf-8"), bytes.fromhex(salt_hex), PBKDF2_ROUNDS
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def encrypt_pwd(plain: str, email: str = "") -> str:
    """明文密码 → 可逆密文；aad 绑定邮箱，密文搬行即失效。"""
    return aead_encrypt(plain, aad=("acct:" + _norm(email)).encode("utf-8"), label="account")


def decrypt_pwd(stored: str, email: str = "") -> str:
    """密文 → 明文；v2 优先，v1 兼容旧数据。失败一律空串。"""
    if not stored:
        return ""
    if stored.startswith("v2:"):
        return aead_decrypt(stored, aad=("acct:" + _norm(email)).encode("utf-8"), label="account")
    return legacy_decrypt(stored)
