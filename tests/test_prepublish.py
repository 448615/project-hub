#!/usr/bin/env python3
"""发布前隔离工具的闭环测试。

不碰真实数据：全部在临时目录里造一份同构结构再跑 apply/restore。
重点验证「只移动、不删除」这条底线——任何一步失败后，文件都必须还能找回来。
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath("."))
sys.path.insert(0, os.path.join(os.path.abspath("."), "tools"))
import prepublish  # noqa: E402


class TestPrepublish(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        os.makedirs(os.path.join(self.root, ".data"))
        os.makedirs(os.path.join(self.root, "starshu", "data", "backups"))
        os.makedirs(os.path.join(self.root, "demo-scripts"))
        # 造几个探针文件
        self.files = {
            ".data/secret.key": b"K" * 64,
            ".data/hub.log": b"log line\n",
            "starshu/data/jwt.secret": b"J" * 96,
            "demo-scripts/hub_accounts.db": b"SQLite format 3\x00",
            "users.db": b"legacy",
            "starshu/data/backups/s1.db": b"backup",
        }
        for rel, data in self.files.items():
            p = os.path.join(self.root, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
        self.hold = os.path.join(self.root, ".publish-hold")
        self._patches = [
            mock.patch.object(prepublish, "HERE", self.root),
            mock.patch.object(prepublish, "HOLD_ROOT", self.hold),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._tmp.cleanup()

    def _read(self, rel):
        with open(os.path.join(self.root, rel.replace("/", os.sep)), "rb") as f:
            return f.read()

    def _exists(self, rel):
        return os.path.isfile(os.path.join(self.root, rel.replace("/", os.sep)))

    def test_collect_finds_all_probes(self):
        got = {it["rel"] for it in prepublish.collect()}
        self.assertEqual(got, set(self.files))

    def test_apply_moves_not_deletes(self):
        items = prepublish.collect()
        batch = prepublish.apply(items)
        # 原位已不存在
        for rel in self.files:
            self.assertFalse(self._exists(rel), f"{rel} 应已被移走")
        # 但文件完整躺在隔离目录里（不是删除）
        for rel, data in self.files.items():
            held = os.path.join(batch, rel.replace("/", os.sep))
            self.assertTrue(os.path.isfile(held), f"{rel} 应存在于隔离目录")
            with open(held, "rb") as f:
                self.assertEqual(f.read(), data, f"{rel} 内容应保持不变")

    def test_restore_brings_everything_back(self):
        batch = prepublish.apply(prepublish.collect())
        n = prepublish.restore(batch)
        self.assertEqual(n, len(self.files))
        for rel, data in self.files.items():
            self.assertTrue(self._exists(rel), f"{rel} 应已还原")
            self.assertEqual(self._read(rel), data)

    def test_restore_does_not_overwrite_existing(self):
        """本地已重建的同名文件不能被旧快照覆盖（如 secret.key 已自动重新生成）。"""
        batch = prepublish.apply(prepublish.collect())
        # 模拟服务启动后重建了 secret.key
        os.makedirs(os.path.join(self.root, ".data"), exist_ok=True)
        newkey = b"N" * 64
        with open(os.path.join(self.root, ".data", "secret.key"), "wb") as f:
            f.write(newkey)
        prepublish.restore(batch)
        self.assertEqual(self._read(".data/secret.key"), newkey, "不应覆盖新生成的密钥")

    def test_collect_empty_when_nothing_present(self):
        for rel in self.files:
            os.remove(os.path.join(self.root, rel.replace("/", os.sep)))
        self.assertEqual(prepublish.collect(), [])

    def test_manifest_written(self):
        batch = prepublish.apply(prepublish.collect())
        self.assertTrue(os.path.isfile(os.path.join(batch, prepublish.MANIFEST)))
        self.assertIn(batch, prepublish.list_batches())


if __name__ == "__main__":
    unittest.main()
