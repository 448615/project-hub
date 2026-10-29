#!/usr/bin/env python3
"""数据处理脚本回归测试（零依赖，仅标准库 unittest）。

覆盖范围
--------
1. 配置层：邮箱/密码/角色/格式/上限的校验，环境变量降级
2. 处理层：脏数据规范化、过滤、排序、截断、统计口径
3. 输出层：中英混排对齐、三种格式渲染、原子写盘
4. 数据层：临时库全流程（建表→建号→验密→改密→改角色→删除），密钥隔离
5. 命令行：退出码语义（0 成功 / 1 业务失败 / 2 参数错误 / 3 权限不足）

运行
----
    python tests/test_data_scripts.py -v

说明：数据层测试会 ``ds.configure()`` 改模块级路径，所以用 setUpClass 备份、
tearDownClass 还原；每个用例前重建临时目录，互不影响，也不会碰真实账号库。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(ROOT, "demo-scripts")
for path in (SCRIPTS, ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

import data_store as ds          # noqa: E402
from ds_store import paths as ds_paths   # noqa: E402  可变状态的唯一宿处
import ds_config as cfgmod       # noqa: E402
import ds_output as out          # noqa: E402
import ds_report as report       # noqa: E402

RUN_ALL = os.path.join(SCRIPTS, "run_all.py")


# ---------------------------------------------------------------------------
# 1. 配置层
# ---------------------------------------------------------------------------
class ConfigTests(unittest.TestCase):
    def test_valid_email(self):
        self.assertEqual(cfgmod.validate_email("  A@B.COM "), "A@B.COM")

    def test_invalid_emails(self):
        for bad in ("", "   ", "no-at-sign", "a@b", "a b@c.com", "a@.com"):
            with self.subTest(bad=bad), self.assertRaises(cfgmod.ConfigError):
                cfgmod.validate_email(bad)

    def test_password_rules(self):
        self.assertEqual(cfgmod.validate_password("123456"), "123456")
        for bad in ("", None, "12345"):
            with self.subTest(bad=bad), self.assertRaises(cfgmod.ConfigError):
                cfgmod.validate_password(bad)
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.validate_password("x" * (cfgmod.MAX_FIELD_LEN + 1))

    def test_role_and_format_and_sort(self):
        self.assertEqual(cfgmod.normalize_role(" ADMIN "), "admin")
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.normalize_role("root")
        self.assertEqual(cfgmod.normalize_format("CSV"), "csv")
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.normalize_format("xml")
        self.assertEqual(cfgmod.normalize_sort_key("created_at"), "created_at")
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.normalize_sort_key("password")

    def test_limit(self):
        self.assertEqual(cfgmod.validate_limit(10), 10)
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.validate_limit(-1)
        with self.assertRaises(cfgmod.ConfigError):
            cfgmod.validate_limit("abc")

    def test_env_override_and_graceful_degrade(self):
        cfg = cfgmod.Config.from_env({
            "DATA_SCRIPTS_DB": "/tmp/x.db",
            "DATA_SCRIPTS_LOG_LEVEL": "debug",
            "HUB_OPERATOR_ROLE": "Admin",
            "HUB_OPERATOR_EMAIL": "A@B.com",
        })
        self.assertEqual(cfg.db_path, "/tmp/x.db")
        self.assertEqual(cfg.log_level, "DEBUG")
        self.assertEqual(cfg.operator_role, "admin")
        self.assertEqual(cfg.operator_email, "a@b.com")
        self.assertTrue(cfg.is_admin)

        bad = cfgmod.Config.from_env({"DATA_SCRIPTS_LOG_LEVEL": "LOUD"})
        self.assertEqual(bad.log_level, "INFO")            # 非法值降级
        self.assertTrue(bad.env_problems())                # 但要留下说明
        self.assertFalse(bad.is_admin)

    def test_with_changes_ignores_none(self):
        cfg = cfgmod.Config()
        changed = cfg.with_changes(limit=None, sort_key="email")
        self.assertEqual(changed.limit, 0)
        self.assertEqual(changed.sort_key, "email")


# ---------------------------------------------------------------------------
# 2. 处理层
# ---------------------------------------------------------------------------
def _raw_rows():
    return [
        {"id": 1, "email": "zoe@example.com", "username": "zoe", "role": "ADMIN",
         "created_at": 1700000000, "updated_at": 0},
        {"id": 2, "email": "amy@example.com", "username": "", "role": "weird",
         "created_at": "not-a-number", "updated_at": None},
        {"id": 3, "email": "bob@test.org", "username": "  bob  ", "role": "user",
         "created_at": 0, "updated_at": 1700000123},
    ]


class ReportTests(unittest.TestCase):
    def test_normalize_dirty_rows(self):
        rows = report.normalize_rows(_raw_rows() + ["junk", None])
        self.assertEqual(len(rows), 3)                     # 非字典项被跳过
        self.assertEqual(rows[0]["role"], "admin")          # 角色归一
        self.assertEqual(rows[1]["role"], "user")           # 脏角色按 user
        self.assertEqual(rows[1]["username"], "amy")        # 空用户名回退邮箱前缀
        self.assertEqual(rows[2]["username"], "bob")        # 去空白
        self.assertEqual(rows[1]["created_at_text"], "-")   # 脏时间显示 -
        self.assertEqual(rows[2]["created_at_text"], "-")   # 0 视为无效

    def test_filter_and_sort_and_limit(self):
        rows = report.normalize_rows(_raw_rows())

        by_mail = report.filter_rows(rows, report.AccountFilter(email_contains="EXAMPLE"))
        self.assertEqual([r["id"] for r in by_mail], [1, 2])   # 保持原顺序

        by_role = report.filter_rows(rows, report.AccountFilter(role="admin"))
        self.assertEqual([r["id"] for r in by_role], [1])

        by_kw = report.filter_rows(rows, report.AccountFilter(keyword="bob"))
        self.assertEqual([r["id"] for r in by_kw], [3])

        self.assertEqual([r["id"] for r in report.sort_rows(rows, "email")], [2, 3, 1])
        self.assertEqual([r["id"] for r in report.sort_rows(rows, "email", True)], [1, 3, 2])
        self.assertEqual([r["id"] for r in report.apply_limit(rows, 2)], [1, 2])
        self.assertEqual(len(report.apply_limit(rows, 0)), 3)  # 0 = 不限

    def test_unknown_sort_key_falls_back(self):
        rows = report.normalize_rows(_raw_rows())
        self.assertEqual([r["id"] for r in report.sort_rows(rows, "pwd_hash")], [1, 2, 3])

    def test_summarize(self):
        rows = report.normalize_rows(_raw_rows())
        stats = report.summarize(rows, now=1700000000)
        self.assertEqual(stats["total"], 3)
        self.assertEqual(stats["admins"], 1)
        self.assertEqual(stats["users"], 2)
        self.assertEqual(stats["recent_7d"], 1)            # 只有 id=1 在窗口内
        self.assertEqual(stats["newest"], "2023-11-15 06:13:20")

    def test_build_view_meta(self):
        view = report.build_view(_raw_rows(), flt=report.AccountFilter(role="user"), limit=1)
        self.assertEqual(view.stats["total"], 1)
        self.assertEqual(view.total_before_filter, 3)      # 过滤前总数
        self.assertTrue(view.meta["limit"])


# ---------------------------------------------------------------------------
# 3. 输出层
# ---------------------------------------------------------------------------
class OutputTests(unittest.TestCase):
    def setUp(self):
        self.view = report.build_view(_raw_rows(), source="mem://test")

    def test_display_width_and_pad(self):
        self.assertEqual(out.display_width("abc"), 3)
        self.assertEqual(out.display_width("中文"), 4)
        self.assertEqual(out.pad("中文", 6), "中文  ")       # 补 2 个空格到 6 列

    def test_render_table_contains_key_info(self):
        text = out.render_table(self.view)
        for expected in ("账号数据报表", "zoe@example.com", "统计：", "生成时间"):
            self.assertIn(expected, text)

    def test_render_json_structure(self):
        import json
        payload = json.loads(out.render_json(self.view))
        self.assertEqual(payload["total"], 3)
        self.assertEqual(payload["admins"], 1)
        self.assertIn("accounts", payload)
        self.assertEqual(payload["accounts"][0]["email"], "zoe@example.com")
        self.assertNotIn("pwd_hash", payload["accounts"][0])   # 不泄露内部字段

    def test_render_csv(self):
        lines = out.render_csv(self.view).strip().splitlines()
        self.assertEqual(lines[0], "id,email,username,role,created_at,updated_at")
        self.assertEqual(len(lines), 4)

    def test_render_unknown_format_falls_back(self):
        self.assertIn("账号数据报表", out.render(self.view, "xml"))

    def test_atomic_write_overwrites(self):
        tmpdir = tempfile.mkdtemp()
        try:
            path = os.path.join(tmpdir, "a.json")
            out.atomic_write_text(path, "first")
            out.atomic_write_text(path, "second")
            with open(path, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "second")
            self.assertEqual(
                [n for n in os.listdir(tmpdir) if n.startswith(".tmp_")], []  # 无残留临时文件
            )
        finally:
            shutil.rmtree(tmpdir)


# ---------------------------------------------------------------------------
# 4. 数据层（临时库 + 临时密钥，不碰真实账号）
# ---------------------------------------------------------------------------
class StoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 可变状态（库路径/密钥路径/主密钥缓存）都住在 ds_store.paths 里，
        # 备份与还原必须打在 paths 上：给 data_store 模块赋值只会造出一个
        # 影子属性，真正的读写路径不受影响（这类"看着还原了其实没还原"
        # 的坑由 tests/test_datastore_contract.py 守着）。
        cls._orig = (ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB)
        cls._orig_master = (ds_paths._MASTER, ds_paths._MASTER_LOADED)

    @classmethod
    def tearDownClass(cls):
        ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB = cls._orig
        ds_paths._MASTER, ds_paths._MASTER_LOADED = cls._orig_master

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        ds.configure(
            db_path=os.path.join(self.tmpdir, "t.db"),
            key_path=os.path.join(self.tmpdir, "secret.key"),
            legacy_db=os.path.join(self.tmpdir, "none.db"),
        )
        self.assertTrue(ds.init_db())

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_full_lifecycle(self):
        self.assertEqual(ds.count(), 0)

        ok, err = ds.create("Alice", "Alice@Example.com ", "pw123456", role="admin")
        self.assertTrue(ok, err)
        self.assertEqual(ds.count(), 1)

        row = ds.get_by_email("alice@example.com")          # 大小写不敏感
        self.assertIsNotNone(row)
        self.assertEqual(row["role"], "admin")
        self.assertTrue(ds.check_pwd("pw123456", row["pwd_hash"], row["email"]))
        self.assertFalse(ds.check_pwd("wrong", row["pwd_hash"], row["email"]))
        self.assertIsNotNone(ds.verify("alice@example.com", "pw123456"))
        self.assertIsNone(ds.verify("alice@example.com", "bad"))

        self.assertTrue(ds.set_password("alice@example.com", "newpw999"))
        self.assertTrue(ds.verify("alice@example.com", "newpw999"))

        self.assertTrue(ds.set_role(int(row["id"]), "user"))
        self.assertEqual(ds.get_by_email("alice@example.com")["role"], "user")

        self.assertTrue(ds.delete(int(row["id"])))
        self.assertEqual(ds.count(), 0)

    def test_duplicate_and_invalid_input(self):
        self.assertTrue(ds.create("a", "dup@x.com", "pw123456")[0])
        ok, err = ds.create("a", "DUP@x.com", "pw123456")
        self.assertFalse(ok)
        self.assertIn("已注册", err)

        self.assertEqual(ds.create("a", "", "pw")[0], False)
        self.assertFalse(ds.set_password("nosuch@x.com", "pw123456"))
        self.assertFalse(ds.set_role(9999, "admin"))
        self.assertFalse(ds.delete(9999))

    def test_role_sanitized(self):
        ds.create("b", "b@x.com", "pw123456", role="root")
        self.assertEqual(ds.get_by_email("b@x.com")["role"], "user")

    def test_report_shape_compatible(self):
        ds.create("c", "c@x.com", "pw123456", role="admin")
        rep = ds.build_report()
        for key in ("generated_at", "db_path", "total", "admins", "accounts"):
            self.assertIn(key, rep)
        self.assertEqual(rep["total"], 1)
        self.assertEqual(rep["accounts"][0]["email"], "c@x.com")
        self.assertIn("has_plain", rep["accounts"][0])

    def test_aead_tamper_rejected(self):
        token = ds.encrypt_pwd("secret", "a@b.com")
        self.assertEqual(ds.decrypt_pwd(token, "a@b.com"), "secret")
        self.assertEqual(ds.decrypt_pwd(token, "other@b.com"), "")   # aad 绑定邮箱
        self.assertEqual(ds.decrypt_pwd(token[:-3] + "AAA", "a@b.com"), "")


# ---------------------------------------------------------------------------
# 5. 命令行（独立进程，避免污染本进程的模块状态）
# ---------------------------------------------------------------------------
class CliTests(unittest.TestCase):
    def _run(self, *args, env_extra=None):
        env = dict(os.environ)
        env.pop("HUB_OPERATOR_ROLE", None)
        env.pop("HUB_OPERATOR_EMAIL", None)
        env.update(env_extra or {})
        return subprocess.run(
            [sys.executable, RUN_ALL, *args],
            cwd=ROOT, env=env, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=120,
        )

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = os.path.join(self.tmpdir, "cli.db")
        self.exports = os.path.join(self.tmpdir, "exports")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_stats_allowed_without_admin(self):
        res = self._run("--stats", "--db", self.db)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("账号总数", res.stdout)

    def test_report_denied_without_admin(self):
        res = self._run("--db", self.db)
        self.assertEqual(res.returncode, 3)
        self.assertIn("管理员", res.stderr)

    def test_report_as_admin_without_export(self):
        res = self._run("--db", self.db, "--no-export",
                        env_extra={"HUB_OPERATOR_ROLE": "admin"})
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("账号数据报表", res.stdout)
        self.assertFalse(os.path.exists(self.exports))

    def test_export_creates_file(self):
        res = self._run("--db", self.db, "--export", "--export-dir", self.exports,
                        env_extra={"HUB_OPERATOR_ROLE": "admin"})
        self.assertEqual(res.returncode, 0, res.stderr)
        files = os.listdir(self.exports)
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".json"))

    def test_export_csv(self):
        res = self._run("--db", self.db, "--export", "--format", "csv",
                        "--export-dir", self.exports,
                        env_extra={"HUB_OPERATOR_ROLE": "admin"})
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(os.listdir(self.exports)[0].endswith(".csv"))

    def test_invalid_args_exit_2(self):
        self.assertEqual(self._run("--sort", "bogus").returncode, 2)
        self.assertEqual(self._run("--nope").returncode, 2)
        self.assertEqual(self._run("--stats", "--export").returncode, 2)

    def test_validation_errors_exit_2(self):
        env = {"HUB_OPERATOR_ROLE": "admin"}
        self.assertEqual(self._run("--reset-password", "bad-email", "123456",
                                   "--db", self.db, env_extra=env).returncode, 2)
        self.assertEqual(self._run("--reset-password", "a@b.com", "123",
                                   "--db", self.db, env_extra=env).returncode, 2)

    def test_missing_account_exit_1(self):
        res = self._run("--delete", "ghost@x.com", "--db", self.db,
                        env_extra={"HUB_OPERATOR_ROLE": "admin"})
        self.assertEqual(res.returncode, 1)

    def test_dry_run_skips_export(self):
        """dry-run 承诺：不改账号数据、不写导出文件。"""
        res = self._run("--db", self.db, "--dry-run", "--export",
                        "--export-dir", self.exports,
                        env_extra={"HUB_OPERATOR_ROLE": "admin"})
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertFalse(os.path.exists(self.exports))

    def test_mutating_flow(self):
        env = {"HUB_OPERATOR_ROLE": "admin"}
        res = self._run("--db", self.db, "--init", env_extra=env)
        self.assertEqual(res.returncode, 0, res.stderr)

        # 用数据层造一个账号，再走 CLI 改密/改角色/删除。
        # 注意：只切 db_path，密钥沿用项目默认——CLI 子进程读的也是同一把密钥。
        ds.configure(db_path=self.db, legacy_db=os.path.join(self.tmpdir, "none.db"))
        ds.init_db()
        self.assertTrue(ds.create("t", "t@x.com", "pw123456")[0])

        self.assertEqual(self._run("--reset-password", "t@x.com", "newpw123456",
                                   "--db", self.db, env_extra=env).returncode, 0)
        self.assertEqual(self._run("--set-role", "t@x.com", "admin",
                                   "--db", self.db, env_extra=env).returncode, 0)
        self.assertEqual(self._run("--delete", "t@x.com",
                                   "--db", self.db, env_extra=env).returncode, 0)
        self.assertEqual(ds.count(), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
