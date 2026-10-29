# -*- coding: utf-8 -*-
"""ds_store.crypto 已知答案测试（KAT）

目的
----
把**当前**密码学行为用常量钉住。这些常量一旦变化，意味着磁盘上已有的
``hub_accounts.db`` 将无法解开——不是"测试挂了"，是"用户登录不了了"。
所以本文件里的每个十六进制串和 base64 串都是**兼容性契约**，不是随便取的值：

* ``_KDF_SALT`` / ``PBKDF2_ROUNDS`` 变了 → 派生密钥不同 → 旧密文全部解不开
* HKDF 的 PRK 构造或展开计数器变了 → 同上
* 密钥流构造变了 → 同上
* AEAD 的版本前缀 / nonce 长度 / tag 长度 / MAC 覆盖范围变了 → 同上
* v1 旧格式的配方变了 → 历史 ``v1:`` 记录再也迁不出来

怎么更新（**想清楚再做**）
--------------------------
只有当「主动放弃旧数据」时才允许改这些常量，并且必须同时提供迁移脚本。
纯粹的"测试值看起来奇怪"绝不是更新理由。

覆盖边界
--------
本文件**不**验证密码学强度（那是设计评审的事，见 SECURITY.md），只锁定
「同样的输入必须得到同样的字节」与「密钥缺失时必须失败关闭」。
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest

# 允许从任意工作目录运行：把 demo-scripts/ 放进 sys.path，与 hub/store.py 的加载方式一致
_DS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _DS_DIR not in sys.path:
    sys.path.insert(0, _DS_DIR)

from ds_store import crypto, paths  # noqa: E402  （必须在 sys.path 调整之后导入）

#: 固定主密钥：64 字节 0x00..0x3f。真实环境是随机生成的，这里只需要它「固定」。
GOLDEN_MASTER = bytes(range(64))

#: 固定 nonce：12 字节 0x00..0x0b（AEAD 与 v1 旧格式共用同一串，仅为可复现）
GOLDEN_NONCE = bytes.fromhex("000102030405060708090a0b")

# ---- 黄金值（由当前实现生成一次后固化）------------------------------------
GOLDEN_SUBKEY_ENC = "cbfe3c8604b33dffe6f755c2a3aa6fc3df13fd95af0790c731387a0f02daa6f4"
GOLDEN_SUBKEY_MAC = "40536a1cf0b908a007d7fb1824020eb756321f5fde7d378de93b64990cd328d0"
GOLDEN_SUBKEY_ENC_64 = (
    "cbfe3c8604b33dffe6f755c2a3aa6fc3df13fd95af0790c731387a0f02daa6f4"
    "71fee79e70c13b1b517cbbaf3910d3a5d8b93cfd38189598eb926689ec987b42"
)
GOLDEN_KEYSTREAM_40 = (
    "4917ba8e265662e777fa2626459cf9d642f47ff58f8dc8d0b5ebf82e90c0cac5"
    "e21edd9662479414"
)
#: aead_encrypt("hello 星枢", aad=b"acct:a@b.c", label="account") + 固定 nonce
GOLDEN_TOKEN_ACCOUNT = (
    "v2:AAECAwQFBgcICQoLIXLW4kl2hH_oHLiE1ufah1dwv9mVcWdJPe16-G2o2sGWd-QvKp5XzCuhj5k="
)
#: aead_encrypt("secret", aad=b"", label="account") + 固定 nonce
GOLDEN_TOKEN_NO_AAD = "v2:AAECAwQFBgcICQoLOnLZ_EMiDFKY-nr1MyZ7ektqek8KPbj7je3EBFYZDuoGsRz18BU="
#: v1 旧格式承载 "Legacy@Pass1"（该格式只有解密实现，此串为历史数据的等价样本）
GOLDEN_TOKEN_V1 = "v1:AAECAwQFBgcICQoLyiIIEI_4ogE2kvrFbKHakyVfxXAO4RmY1-ywIg=="


class _FixedNonce:
    """把 ``secrets.token_bytes`` 临时替换成固定 nonce，让加密结果可复现。"""

    def __init__(self, nonce: bytes):
        self.nonce = nonce
        self._orig = None

    def __enter__(self):
        self._orig = crypto.secrets.token_bytes
        crypto.secrets.token_bytes = lambda n: self.nonce[:n]
        return self

    def __exit__(self, *exc):
        crypto.secrets.token_bytes = self._orig
        return False


class CryptoKATTests(unittest.TestCase):
    """固定主密钥下的字节级契约。"""

    def setUp(self):
        # 主密钥缓存住在 paths 里；直接注入，绝不触发 _load_key（那会碰真实 .data/secret.key）
        self._orig = (paths.KEY_PATH, paths._MASTER, paths._MASTER_LOADED)
        paths._MASTER = GOLDEN_MASTER
        paths._MASTER_LOADED = True

    def tearDown(self):
        paths.KEY_PATH, paths._MASTER, paths._MASTER_LOADED = self._orig

    # ---- 1. KDF 参数 ------------------------------------------------------
    def test_kdf_constants_locked(self):
        """派生参数是硬兼容边界：改了就等于把所有旧密文作废。"""
        self.assertEqual(crypto._KDF_SALT, b"hub-kdf-v2")
        self.assertEqual(crypto.PBKDF2_ROUNDS, 600000)

    def test_subkey_matches_golden(self):
        self.assertEqual(crypto.subkey("account:enc").hex(), GOLDEN_SUBKEY_ENC)
        self.assertEqual(crypto.subkey("account:mac").hex(), GOLDEN_SUBKEY_MAC)

    def test_subkey_extension_is_prefix(self):
        """长度扩展的前缀不变 → HKDF 的 expand 计数器语义没变（否则旧密文解不开）。"""
        self.assertEqual(crypto.subkey("account:enc", 64).hex(), GOLDEN_SUBKEY_ENC_64)
        self.assertTrue(GOLDEN_SUBKEY_ENC_64.startswith(GOLDEN_SUBKEY_ENC))

    def test_subkey_label_isolation(self):
        """不同用途必须得到不同子密钥，否则密钥复用风险回归。"""
        self.assertNotEqual(crypto.subkey("account:enc"), crypto.subkey("hash:enc"))
        self.assertNotEqual(crypto.subkey("account:enc"), crypto.subkey("account:mac"))

    # ---- 2. 密钥流 --------------------------------------------------------
    def test_keystream_matches_golden(self):
        ke = bytes.fromhex(GOLDEN_SUBKEY_ENC)
        self.assertEqual(crypto._keystream(ke, GOLDEN_NONCE, 40).hex(), GOLDEN_KEYSTREAM_40)

    def test_keystream_non_positive_length(self):
        self.assertEqual(crypto._keystream(b"k", GOLDEN_NONCE, 0), b"")
        self.assertEqual(crypto._keystream(b"k", GOLDEN_NONCE, -1), b"")

    # ---- 3. AEAD 加密方向：输出必须逐字节一致 ------------------------------
    def test_aead_encrypt_matches_golden(self):
        with _FixedNonce(GOLDEN_NONCE):
            self.assertEqual(
                crypto.aead_encrypt("hello 星枢", aad=b"acct:a@b.c", label="account"),
                GOLDEN_TOKEN_ACCOUNT,
            )
            self.assertEqual(
                crypto.aead_encrypt("secret", aad=b"", label="account"),
                GOLDEN_TOKEN_NO_AAD,
            )

    def test_aead_encrypt_empty_plain(self):
        self.assertEqual(crypto.aead_encrypt(""), "")

    def test_aead_layout(self):
        """nonce(12) | 密文 | tag(32)，前缀 v2: —— 布局变了旧数据就解不开。"""
        token = crypto.aead_encrypt("1234567890", aad=b"", label="account")
        self.assertTrue(token.startswith("v2:"))
        import base64

        raw = base64.urlsafe_b64decode(token[3:].encode("ascii"))
        self.assertEqual(len(raw), 12 + 10 + 32)
        self.assertNotIn("1234567890", token)  # 明文不得出现在密文里

    # ---- 4. AEAD 解密方向：历史密文必须仍能解开 ---------------------------
    def test_aead_decrypt_golden(self):
        self.assertEqual(
            crypto.aead_decrypt(GOLDEN_TOKEN_ACCOUNT, aad=b"acct:a@b.c", label="account"),
            "hello 星枢",
        )
        self.assertEqual(
            crypto.aead_decrypt(GOLDEN_TOKEN_NO_AAD, aad=b"", label="account"), "secret"
        )

    def test_aead_rejects_wrong_aad_or_label(self):
        """aad 绑定记录、label 绑定用途：任一不符都只能拿到空串。"""
        self.assertEqual(
            crypto.aead_decrypt(GOLDEN_TOKEN_ACCOUNT, aad=b"acct:x@y.z", label="account"), ""
        )
        self.assertEqual(
            crypto.aead_decrypt(GOLDEN_TOKEN_ACCOUNT, aad=b"acct:a@b.c", label="hash"), ""
        )

    def test_aead_rejects_tampered_bytes(self):
        import base64

        raw = bytearray(base64.urlsafe_b64decode(GOLDEN_TOKEN_ACCOUNT[3:].encode("ascii")))
        for idx in (0, 12, len(raw) - 1):  # 改 nonce / 改密文 / 改 tag
            bad = bytearray(raw)
            bad[idx] ^= 0x01
            token = "v2:" + base64.urlsafe_b64encode(bytes(bad)).decode("ascii")
            self.assertEqual(
                crypto.aead_decrypt(token, aad=b"acct:a@b.c", label="account"), ""
            )

    def test_aead_rejects_bad_shape(self):
        for token in ("", "v1:whatever", "v2:", "v2:!!!", "v2:AAAA"):
            self.assertEqual(crypto.aead_decrypt(token), "")

    # ---- 5. v1 旧格式：历史记录仍在用，配方不能动 -------------------------
    def test_legacy_v1_decrypts_golden(self):
        self.assertEqual(crypto.legacy_decrypt(GOLDEN_TOKEN_V1), "Legacy@Pass1")
        self.assertEqual(crypto.legacy_decrypt("v2:whatever"), "")  # 只处理 v1

    def test_decrypt_pwd_routes_both_versions(self):
        self.assertEqual(crypto.decrypt_pwd(GOLDEN_TOKEN_V1, "whatever"), "Legacy@Pass1")
        self.assertEqual(
            crypto.decrypt_pwd(GOLDEN_TOKEN_ACCOUNT, "a@b.c"), "hello 星枢"
        )

    # ---- 6. 密码哈希：格式与 PBKDF2 参数 -------------------------------
    def test_hash_format_locked(self):
        h = crypto.hash_pwd("correct horse battery staple")
        self.assertIn("$", h)  # 注意：是 salt$hash，不是 salt:hash
        salt_hex, hash_hex = h.split("$", 1)
        self.assertEqual(len(salt_hex), 32)  # 16 字节盐
        self.assertEqual(len(hash_hex), 64)  # 32 字节派生密钥（pbkdf2 默认 dklen = 摘要长度）
        bytes.fromhex(salt_hex)
        bytes.fromhex(hash_hex)
        self.assertNotIn("correct horse", h)

    def test_check_pwd_pins_pbkdf2_params(self):
        """用测试侧独立算出的 salt$hash 校验：轮数/算法一变，check_pwd 就会对不上。"""
        salt = bytes.fromhex("0f1e2d3c4b5a69788796a5b4c3d2e1f0")
        pwd = "KAT-Passw0rd"
        stored = salt.hex() + "$" + hashlib.pbkdf2_hmac(
            "sha256", pwd.encode("utf-8"), salt, 600000
        ).hex()
        self.assertTrue(crypto.check_pwd(pwd, stored, "kat@example.com"))
        self.assertFalse(crypto.check_pwd("KAT-Passw0rD", stored, "kat@example.com"))

    def test_hash_sealed_binds_email(self):
        sealed = crypto.seal_hash(crypto.hash_pwd("pw123456"), "a@b.com")
        self.assertTrue(sealed.startswith("v2:"))
        self.assertEqual(crypto.seal_hash("", "a@b.com"), "")
        opened = crypto.open_hash(sealed, "a@b.com")
        self.assertIn("$", opened)
        self.assertEqual(crypto.open_hash(sealed, "other@b.com"), "")  # aad 绑定邮箱
        self.assertEqual(crypto.open_hash("", "a@b.com"), "")
        # 历史明文哈希仍按原样返回（迁移期兼容）
        self.assertEqual(crypto.open_hash("aa$bb", "a@b.com"), "aa$bb")
        self.assertTrue(crypto.check_pwd("pw123456", sealed, "a@b.com"))
        self.assertFalse(crypto.check_pwd("pw123456", sealed, "other@b.com"))

    # ---- 7. 密钥缺失：必须失败关闭 --------------------------------------
    def test_missing_master_fails_closed(self):
        """没有密钥只能「不可查看」，绝不能回落到明文或放行。"""
        blocker = tempfile.NamedTemporaryFile(delete=False)
        self.addCleanup(os.unlink, blocker.name)
        blocker.close()
        # 把密钥路径指到「文件的下级」，使 makedirs 必然失败 → 主密钥为空
        paths.KEY_PATH = os.path.join(blocker.name, "secret.key")
        paths._MASTER, paths._MASTER_LOADED = b"", False

        self.assertEqual(crypto.master(), b"")
        self.assertEqual(crypto.subkey("account:enc"), b"")
        self.assertEqual(crypto.aead_encrypt("secret"), "")
        self.assertEqual(crypto.aead_decrypt(GOLDEN_TOKEN_NO_AAD), "")
        self.assertEqual(crypto.encrypt_pwd("secret", "a@b.com"), "")
        self.assertEqual(crypto.decrypt_pwd(GOLDEN_TOKEN_ACCOUNT, "a@b.c"), "")
        self.assertEqual(crypto.seal_hash("aa$bb", "a@b.com"), "")
        self.assertFalse(crypto.check_pwd("secret", GOLDEN_TOKEN_NO_AAD, "a@b.com"))

    def test_master_reads_exactly_64_bytes(self):
        """主密钥长度是兼容边界：换成 32 字节会让所有旧密文失效。"""
        with tempfile.TemporaryDirectory() as tmp:
            key_file = os.path.join(tmp, "secret.key")
            payload = bytes(range(64)) + b"tail-should-be-ignored"
            with open(key_file, "wb") as fh:
                fh.write(payload)
            paths.KEY_PATH = key_file
            paths._MASTER, paths._MASTER_LOADED = b"", False
            self.assertEqual(crypto.master(), GOLDEN_MASTER)


if __name__ == "__main__":
    unittest.main(verbosity=2)
