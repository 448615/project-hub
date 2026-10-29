#!/usr/bin/env python3
"""auth / 权限 / 健康检查回归测试。

覆盖的是「没有任何测试、但出问题最致命」的几条路径：
  1. 会话令牌：签名、篡改、过期、字段非法（失败关闭）
  2. 密码哈希：盐随机、错误密码拒绝
  3. 登录限流：连续失败后封禁，成功即清零
  4. 角色判定与注册策略：谁能成为管理员（公网抢注是重点防护对象）
  5. 鉴权闸门：未登录 401、普通用户写操作 403、管理员放行
  6. 项目路径校验：`..`、绝对路径、隐藏目录一律拒绝
  7. /api/health 的最小信息 / 详情分级

测试全部跑在临时库与临时密钥上，绝不碰真实 hub_accounts.db。
"""
import base64
import hashlib
import hmac
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (os.path.join(ROOT, "demo-scripts"), ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

import ds_store as ds                 # noqa: E402
import ds_store.paths as ds_paths     # noqa: E402
from hub import accounts, config, health, security   # noqa: E402
from fakehub import FakeHub           # noqa: E402


class TempStoreCase(unittest.TestCase):
    """把数据层整体指向临时目录，并在每个用例后还原（含主密钥缓存）。"""

    @classmethod
    def setUpClass(cls):
        cls._orig = (ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB)
        cls._orig_master = (ds_paths._MASTER, ds_paths._MASTER_LOADED)
        cls._orig_admins = set(config.ADMINS)

    @classmethod
    def tearDownClass(cls):
        ds_paths.DB_PATH, ds_paths.KEY_PATH, ds_paths.LEGACY_DB = cls._orig
        ds_paths._MASTER, ds_paths._MASTER_LOADED = cls._orig_master
        config.ADMINS.clear()
        config.ADMINS.update(cls._orig_admins)

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        ds.configure(
            db_path=os.path.join(self.tmpdir, "t.db"),
            key_path=os.path.join(self.tmpdir, "secret.key"),
            legacy_db=os.path.join(self.tmpdir, "none.db"),
        )
        self.assertTrue(ds.init_db())
        config.ADMINS.clear()
        security._LOGIN_FAILS.clear()
        health.invalidate()      # 健康报告有 3s 缓存，用例之间必须清掉

    def tearDown(self):
        security._LOGIN_FAILS.clear()
        config.ADMINS.clear()
        shutil.rmtree(self.tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# 1. 会话令牌
# ---------------------------------------------------------------------------
class SessionTests(TempStoreCase):

    def _forge(self, payload: dict) -> str:
        """用真实会话密钥签一个自定义 payload（模拟「签名对但字段非法」的攻击面）。"""
        body = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")).rstrip(b"=").decode("ascii")
        sig = hmac.new(security._session_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()
        return body + "." + sig

    def test_roundtrip(self):
        tok = security._mint_session("Me@Example.com ", "42")
        p = security._verify_session(tok)
        self.assertIsNotNone(p)
        self.assertEqual(p["email"], "me@example.com")   # 邮箱归一化
        self.assertEqual(p["sub"], "42")

    def test_tampered_signature_rejected(self):
        tok = security._mint_session("a@b.com", "1")
        body, sig = tok.rsplit(".", 1)
        bad = sig[:-2] + ("00" if sig[-2:] != "00" else "11")
        self.assertIsNone(security._verify_session(body + "." + bad))

    def test_tampered_payload_rejected(self):
        """改邮箱但沿用旧签名 → 必须拒绝（否则任何用户都能把自己改成管理员）。"""
        tok = security._mint_session("user@b.com", "1")
        body, sig = tok.rsplit(".", 1)
        p = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        p["email"] = "admin@b.com"
        nb = base64.urlsafe_b64encode(
            json.dumps(p, separators=(",", ":")).encode()).rstrip(b"=").decode()
        self.assertIsNone(security._verify_session(nb + "." + sig))

    def test_expired_rejected(self):
        now = int(time.time())
        self.assertIsNone(security._verify_session(
            self._forge({"v": 2, "email": "a@b.com", "sub": "1", "iat": now - 100, "exp": now - 1})))

    def test_overlong_ttl_rejected(self):
        now = int(time.time())
        self.assertIsNone(security._verify_session(
            self._forge({"v": 2, "email": "a@b.com", "sub": "1", "iat": now,
                         "exp": now + int(config._SESSION_TTL) * 3})))

    def test_future_iat_rejected(self):
        now = int(time.time())
        self.assertIsNone(security._verify_session(
            self._forge({"v": 2, "email": "a@b.com", "sub": "1", "iat": now + 3600,
                         "exp": now + 7200})))

    def test_missing_email_or_garbage_rejected(self):
        now = int(time.time())
        self.assertIsNone(security._verify_session(
            self._forge({"v": 2, "email": "", "sub": "1", "iat": now, "exp": now + 60})))
        for junk in ("", "nodot", ".", "a.b.c", "!!!.???"):
            self.assertIsNone(security._verify_session(junk), junk)


# ---------------------------------------------------------------------------
# 2. 密码哈希
# ---------------------------------------------------------------------------
class PasswordTests(TempStoreCase):

    def test_salt_is_random(self):
        h1 = ds.hash_pwd("pw123456")
        h2 = ds.hash_pwd("pw123456")
        self.assertNotEqual(h1, h2, "同一密码两次哈希相同 → 没有加盐")
        self.assertTrue(ds.check_pwd("pw123456", h1))
        self.assertTrue(ds.check_pwd("pw123456", h2))

    def test_wrong_password_and_empty(self):
        ok, err = ds.create("u", "u@x.com", "pw123456", role="user")
        self.assertTrue(ok, err)
        row = ds.get_by_email("u@x.com")
        self.assertFalse(ds.check_pwd("pw123457", row["pwd_hash"], row["email"]))
        self.assertFalse(ds.check_pwd("", row["pwd_hash"], row["email"]))
        self.assertFalse(ds.check_pwd("pw123456", "", row["email"]))
        # aad 绑邮箱：拿 A 的哈希配 B 的邮箱解不开
        self.assertFalse(ds.check_pwd("pw123456", row["pwd_hash"], "other@x.com"))


# ---------------------------------------------------------------------------
# 3. 登录限流
# ---------------------------------------------------------------------------
class LoginRateLimitTests(TempStoreCase):

    def test_blocks_after_repeated_failures(self):
        key = "pair:1.2.3.4|a@b.com"
        for _ in range(security._LOGIN_MAX_FAILS):
            self.assertEqual(security._login_gate(key), 0.0)
            security._login_note(key, False)
        wait = security._login_gate(key)
        self.assertGreater(wait, 0.0, "连续失败达到上限后应进入封禁")
        self.assertLessEqual(wait, security._LOGIN_BLOCK + 1)

    def test_success_clears_counter(self):
        key = "pair:1.2.3.4|a@b.com"
        for _ in range(security._LOGIN_MAX_FAILS - 1):
            security._login_note(key, False)
        security._login_note(key, True)
        for _ in range(security._LOGIN_MAX_FAILS - 1):
            security._login_note(key, False)
        self.assertEqual(security._login_gate(key), 0.0, "成功登录应清零失败计数")

    def test_keys_are_independent(self):
        k1, k2 = "ip:1.1.1.1", "ip:2.2.2.2"
        for _ in range(security._LOGIN_MAX_FAILS):
            security._login_note(k1, False)
        self.assertGreater(security._login_gate(k1), 0.0)
        self.assertEqual(security._login_gate(k2), 0.0)


# ---------------------------------------------------------------------------
# 4. 角色判定与注册策略
# ---------------------------------------------------------------------------
class RoleTests(TempStoreCase):

    def test_admin_list_wins(self):
        config.ADMINS.add("boss@x.com")
        self.assertEqual(accounts._role_for_email("Boss@X.com"), "admin")

    def test_admin_role_from_db(self):
        ds.create("a", "dbadmin@x.com", "pw123456", role="admin")
        self.assertEqual(accounts._role_for_email("dbadmin@x.com"), "admin")

    def test_plain_user(self):
        ds.create("u", "plain@x.com", "pw123456", role="user")
        self.assertEqual(accounts._role_for_email("plain@x.com"), "user")
        self.assertEqual(accounts._role_for_email(""), "user")
        self.assertEqual(accounts._role_for_email(None), "user")

    def test_register_role_never_admin_in_cloud(self):
        h = FakeHub(client=("127.0.0.1", 1234))
        h.cloud = True
        self.assertEqual(accounts._register_role(h), "user")

    def test_register_role_never_admin_when_admin_configured(self):
        config.ADMINS.add("boss@x.com")
        h = FakeHub(client=("127.0.0.1", 1234))
        self.assertEqual(accounts._register_role(h), "user")

    def test_register_role_never_admin_from_remote(self):
        h = FakeHub(client=("203.0.113.9", 1234))
        self.assertEqual(accounts._register_role(h), "user")

    def test_register_role_first_local_user_is_admin(self):
        """本地空库 + 无管理员 + 回环来源：开箱即用，第一个账号成为管理员。"""
        h = FakeHub(client=("127.0.0.1", 1234))
        self.assertEqual(accounts._register_role(h), "admin")
        ds.create("someone", "first@x.com", "pw123456", role="user")
        self.assertEqual(accounts._register_role(h), "user")


# ---------------------------------------------------------------------------
# 5. 鉴权闸门
# ---------------------------------------------------------------------------
class GateTests(TempStoreCase):

    def test_no_cookie_401(self):
        h = FakeHub()
        self.assertFalse(h._gate_api(urlparse("/api/projects"), admin_only=False))
        self.assertEqual(h.status, 401)
        self.assertFalse(h.json["ok"])

    def test_bad_cookie_401(self):
        h = FakeHub(cookie="hub_sess=forged.value")
        self.assertFalse(h._gate_api(urlparse("/api/projects"), admin_only=False))
        self.assertEqual(h.status, 401)

    def test_user_can_read_but_not_write(self):
        ds.create("u", "u@x.com", "pw123456", role="user")
        cookie = "hub_sess=" + security._mint_session("u@x.com", "1")

        h = FakeHub(cookie=cookie)
        self.assertTrue(h._gate_api(urlparse("/api/projects"), admin_only=False))
        self.assertEqual(h.role, "user")

        h2 = FakeHub(cookie=cookie)
        self.assertFalse(h2._gate_api(urlparse("/api/exec"), admin_only=True))
        self.assertEqual(h2.status, 403)
        self.assertIn("管理员", h2.json["error"])

    def test_admin_passes_write_gate(self):
        config.ADMINS.add("boss@x.com")
        cookie = "hub_sess=" + security._mint_session("boss@x.com", "9")
        h = FakeHub(cookie=cookie)
        self.assertTrue(h._gate_api(urlparse("/api/exec"), admin_only=True))
        self.assertEqual(h.role, "admin")
        self.assertEqual(h.user["email"], "boss@x.com")

    def test_cookie_parsing_tolerates_other_cookies(self):
        cookie = "hub_sess=" + security._mint_session("x@y.com", "1")
        h = FakeHub(req_headers={"Cookie": "a=1; " + cookie + "; b=2"})
        user, err = h._auth_user()
        self.assertIsNone(err)
        self.assertEqual(user["email"], "x@y.com")


# ---------------------------------------------------------------------------
# 6. 项目路径校验
# ---------------------------------------------------------------------------
class ProjectPathTests(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmpdir, "proj", "sub"))
        os.makedirs(os.path.join(self.tmpdir, ".hidden"))
        os.makedirs(os.path.join(self.tmpdir, "skipme"))
        with open(os.path.join(self.tmpdir, "proj", "a.txt"), "w", encoding="utf-8") as f:
            f.write("hi")
        with open(os.path.join(self.tmpdir, "outside.txt"), "w", encoding="utf-8") as f:
            f.write("secret")
        self.h = FakeHub(root=self.tmpdir, config={"exclude": ["skipme"]})

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_valid_project_name(self):
        self.assertTrue(self.h._is_valid_project("proj"))
        self.assertFalse(self.h._is_valid_project(".."))
        self.assertFalse(self.h._is_valid_project("."))
        self.assertFalse(self.h._is_valid_project("proj/../proj"))
        self.assertFalse(self.h._is_valid_project("a\\b"))
        self.assertFalse(self.h._is_valid_project(".hidden"))
        self.assertFalse(self.h._is_valid_project("skipme"))       # 被 exclude
        self.assertFalse(self.h._is_valid_project("nope"))
        self.assertFalse(self.h._is_valid_project(""))

    def test_resolve_inside_project(self):
        p = self.h._resolve_in_project("proj", "a.txt")
        self.assertIsNotNone(p)
        self.assertTrue(p.endswith("a.txt"))
        # 项目根本身
        self.assertIsNotNone(self.h._resolve_in_project("proj", ""))

    def test_resolve_rejects_escape(self):
        for bad in ("../outside.txt", "sub/../../outside.txt",
                    os.path.join(self.tmpdir, "outside.txt"), "..", "../"):
            self.assertIsNone(self.h._resolve_in_project("proj", bad), bad)

    def test_resolve_rejects_bad_project(self):
        self.assertIsNone(self.h._resolve_in_project("../", "a.txt"))
        self.assertIsNone(self.h._resolve_in_project(".hidden", ""))

    def test_file_preview_extension_whitelist(self):
        with open(os.path.join(self.tmpdir, "proj", "x.bin"), "wb") as f:
            f.write(b"\x00\x01")
        parsed = urlparse("/api/file?project=proj&path=x.bin")
        h = FakeHub(root=self.tmpdir, config={"exclude": ["skipme"]})
        h._handle_file(parsed)
        self.assertEqual(h.status, 403)
        self.assertFalse(h.json["ok"])

    def test_file_preview_ok(self):
        parsed = urlparse("/api/file?project=proj&path=a.txt")
        h = FakeHub(root=self.tmpdir, config={"exclude": ["skipme"]})
        h._handle_file(parsed)
        self.assertEqual(h.status, 200)
        self.assertEqual(h.json["content"], "hi")


# ---------------------------------------------------------------------------
# 7. 健康检查
# ---------------------------------------------------------------------------
class HealthTests(TempStoreCase):

    def test_minimal_report_has_no_detail(self):
        rep = health.build(include_detail=False)
        self.assertIn("ok", rep)
        self.assertIn("version", rep)
        self.assertTrue(rep["accounts"])
        self.assertTrue(rep["subapps"])
        self.assertNotIn("detail", rep, "免登录视图不能泄露用户数/依赖/端口")

    def test_detail_report(self):
        rep = health.build(include_detail=True)
        d = rep["detail"]
        self.assertIn("python", d)
        self.assertEqual(d["accounts"]["users"], 0)
        self.assertIn("node", d["deps"])
        self.assertIsInstance(d["subapps"]["items"], list)

    def test_reports_unhealthy_when_store_missing(self):
        """数据层不可用 = 登录/注册全废，必须报不健康（让部署自检与监控能发现）。"""
        # health 每次调用都从 hub.store 取 DS（唯一数据源），所以补丁要打在 store 上
        from hub import store
        orig = store.DS
        try:
            store.DS = None
            rep = health.build(include_detail=False)
            self.assertFalse(rep["accounts"])
            self.assertFalse(rep["ok"])
        finally:
            store.DS = orig


if __name__ == "__main__":
    unittest.main(verbosity=2)
