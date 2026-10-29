#!/usr/bin/env python3
"""数据层契约测试（零依赖，仅标准库）。

为什么需要它
------------
``hub/store.py`` 通过 ``DS.xxx`` 调用数据层，而数据层是 ``demo-scripts/ds_store/``
包。这层耦合是**按名字**建立的：数据层里谁把 ``get_by_email`` 改名、把
``configure`` 的参数顺序调换、或者不小心让 ``DB_PATH`` 变成"导入时快照"，
Python 都不会报错，只会在线上表现为「登录一直失败」「改密后旧密码还能进」。

本测试把这份口头契约变成可执行断言：
1. 加载链唯一：hub 与脚本拿到的是**同一个模块对象**（不会有两套主密钥/路径状态）
2. 符号齐全：约定的 19 个 API 一个都不能少
3. 关键签名稳定：参数名/顺序变了就报红
4. 可变状态是实时的：``configure()`` 之后 ``ds.DB_PATH`` 立刻跟着变
5. 兼容入口 ``data_store`` 只转发、不复制（否则又是快照）

运行
----
    python tests/test_datastore_contract.py -v
"""
import inspect
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "demo-scripts")
for path in (SCRIPTS, ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

import data_store as ds                 # noqa: E402  兼容入口（薄壳）
import ds_store                         # noqa: E402  真正的实现
from ds_store import paths as ds_paths  # noqa: E402  可变状态宿处


#: hub/store.py、hub/accounts.py、hub/security.py 实际用到的全部符号
REQUIRED = (
    "configure",
    # 加密与哈希
    "subkey", "aead_encrypt", "aead_decrypt", "hash_pwd", "check_pwd",
    # 读
    "count", "get_by_email", "get_by_id", "verify", "raw_hash", "list_accounts",
    # 写
    "create", "set_password", "set_role", "delete",
    # 结构 / 迁移 / 报表
    "init_db", "migrate_legacy", "build_report",
)

#: 参数名与顺序也算契约的一部分（位置参数调用一旦错位就是静默写错库）
SIGNATURES = {
    "create": ["username", "email", "pwd", "role"],
    "set_password": ["uid_or_email", "pwd"],
    "set_role": ["uid", "role"],
    "delete": ["uid"],
    "get_by_email": ["email"],
    "get_by_id": ["uid"],
    "check_pwd": ["pwd", "stored", "email"],
    "hash_pwd": ["pwd"],
    "subkey": ["label", "length"],
    "list_accounts": ["reveal"],
    "build_report": ["reveal"],
    "migrate_legacy": ["known_plain"],
    "configure": ["db_path", "key_path", "legacy_db"],
}


class LoadingChainTests(unittest.TestCase):
    def test_hub_gets_same_module(self):
        """枢纽加载到的必须是 sys.modules['ds_store'] 这一份，不是第二份拷贝。"""
        import hub.store as store
        self.assertIsNotNone(store.DS, "hub.store 没能加载数据层")
        self.assertIs(store.DS, sys.modules["ds_store"])
        self.assertTrue(store.DS.__file__.replace("\\", "/").endswith("ds_store/__init__.py"),
                        f"加载到了意外的文件：{store.DS.__file__}")

    def test_compat_shell_forwards(self):
        """``import data_store as ds`` 仍可用，且读的是同一份实现。"""
        self.assertEqual(ds.count(), ds_store.count())
        self.assertIs(ds.get_by_email, ds_store.get_by_email)

    def test_no_duplicate_state(self):
        """薄壳不许自己持有 DB_PATH 快照（模块 __dict__ 里不该有这份数据）。"""
        self.assertNotIn("DB_PATH", ds.__dict__,
                         "data_store 自带了 DB_PATH 副本，configure() 后会读到旧值")


class ContractTests(unittest.TestCase):
    def test_required_symbols_exist(self):
        missing = [n for n in REQUIRED if not callable(getattr(ds_store, n, None))]
        self.assertEqual(missing, [], f"数据层缺少约定符号：{missing}")

    def test_signatures_stable(self):
        bad = []
        for name, expected in SIGNATURES.items():
            fn = getattr(ds_store, name)
            actual = list(inspect.signature(fn).parameters)
            if actual != expected:
                bad.append(f"{name}: 期望 {expected}，实际 {actual}")
        self.assertEqual(bad, [], "\n".join(bad))

    def test_live_state_forwarding(self):
        """改 paths 的路径，ds 读到的必须立刻跟着变。"""
        orig = ds_paths.DB_PATH
        try:
            ds_paths.DB_PATH = os.path.join(os.sep, "tmp", "contract-probe.db")
            self.assertEqual(ds.DB_PATH, ds_paths.DB_PATH)
            self.assertEqual(ds_store.DB_PATH, ds_paths.DB_PATH)
        finally:
            ds_paths.DB_PATH = orig
        self.assertEqual(ds.DB_PATH, orig)

    def test_configure_moves_paths(self):
        """configure() 是唯一被支持的状态变更入口。"""
        orig = (ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB,
                ds_paths._MASTER, ds_paths._MASTER_LOADED)
        try:
            fake = os.path.join(os.sep, "tmp", "contract-cfg.db")
            ds.configure(db_path=fake, legacy_db="")
            self.assertEqual(ds.DB_PATH, os.path.abspath(fake))
            self.assertEqual(ds.LEGACY_DB, "", "空串应表示禁用旧库迁移")
        finally:
            (ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB,
             ds_paths._MASTER, ds_paths._MASTER_LOADED) = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
