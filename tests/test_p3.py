#!/usr/bin/env python3
"""P3 回归测试：云端密钥环境变量化。

覆盖审计 P3 #11：云端密钥优先读环境变量 HUB_SECRET_KEY / SECRET_KEY，
无状态沙箱冷启动不再因 .data/secret.key 丢失而让所有会话失效。
"""
import base64
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath("."))

from hub import security  # noqa: E402


class TestCloudSecretKey(unittest.TestCase):
    def _hex64(self):
        import secrets
        return secrets.token_hex(32)  # 64 hex chars -> 32 bytes

    def test_env_hex_preferred(self):
        key_hex = self._hex64()
        with mock.patch.dict(os.environ, {"HUB_SECRET_KEY": key_hex}):
            got = security._load_secret_key()
        self.assertEqual(got, bytes.fromhex(key_hex))
        self.assertEqual(len(got), 32)

    def test_env_b64_accepted(self):
        raw = os.urandom(64)
        b64 = base64.b64encode(raw).decode()
        with mock.patch.dict(os.environ, {"SECRET_KEY": b64}):
            got = security._load_secret_key()
        self.assertEqual(got, raw)

    def test_invalid_env_falls_through(self):
        # 非法值不应抛异常，应回落到文件/生成（返回可用密钥）
        with mock.patch.dict(os.environ, {"HUB_SECRET_KEY": "???not-a-key???"}):
            got = security._load_secret_key()
        self.assertIsInstance(got, bytes)
        self.assertGreaterEqual(len(got), 32)


if __name__ == "__main__":
    unittest.main()
