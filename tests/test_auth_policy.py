#!/usr/bin/env python3
"""认证限流策略：单一真源、「枢纽↔星枢」一致性、以及登录桶维度。

这一组测试守的是三件「看起来对、实际上静默失效」的事：

1. **同一份策略两端真的读到同样的值**。枢纽是 Python、星枢是 Node，只能靠
   auth-policy.json 这一份文件连起来；跨语言用例会真的拉起 node 去读，而不是
   假定 JS 侧读到的和 Python 一样。
2. **文件丢了不能变成另一套策略**。两侧都内置了回退默认值，如果回退值和 JSON
   不一致，「发布时漏带文件」就会静默换成另一套阈值，而且没有任何报错。
3. **登录限流必须真有账号维度**。历史上枢纽只有 pair(IP+邮箱) 与 ip 两个桶，
   而 `_client_ip()` 取的是 X-Forwarded-For 首跳——那是客户端自己能写的字段。
   换个 IP 就能把 pair 桶打散、ip 桶每个新 IP 各攒一次，等于「盯住一个账号
   反复猜」这件事在账号维度上从未被计数。补上 email: 桶后这条路才被堵住。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (os.path.join(ROOT, "demo-scripts"), ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

import ds_store as ds                 # noqa: E402
import ds_store.paths as ds_paths     # noqa: E402
from hub import accounts, config, health, security   # noqa: E402
from hub.handlers.auth_post import _login_keys       # noqa: E402
from fakehub import FakeHub           # noqa: E402

POLICY_FILE = os.path.join(ROOT, "auth-policy.json")
SECTIONS = ("loginAccount", "loginIpCoarse", "register")


def _read_policy_file():
    with open(POLICY_FILE, "r", encoding="utf-8") as f:
        raw = json.load(f)
    out = {}
    for k in SECTIONS:
        sec = raw[k]
        out[k] = {
            "windowSec": sec["windowSec"],
            "maxFails": sec["maxFails"],
            "blockSec": sec.get("blockSec", 0),
        }
    return out


class PolicyFileTests(unittest.TestCase):

    def test_policy_file_exists_and_valid(self):
        self.assertTrue(os.path.isfile(POLICY_FILE), "缺少 auth-policy.json（限流策略的唯一真源）")
        for k, sec in _read_policy_file().items():
            self.assertGreater(sec["windowSec"], 0, f"{k}.windowSec 必须为正")
            self.assertGreaterEqual(sec["maxFails"], 1, f"{k}.maxFails 必须 ≥1")
            self.assertGreaterEqual(sec["blockSec"], 0, f"{k}.blockSec 必须 ≥0")

    def test_hub_loads_values_from_file(self):
        """枢纽运行时用的值必须真的来自文件，而不是恰好在代码里写了同样的数。"""
        self.assertEqual(security.AUTH_POLICY, _read_policy_file())
        self.assertEqual(security._LOGIN_MAX_FAILS, _read_policy_file()["loginAccount"]["maxFails"])
        self.assertEqual(security._LOGIN_WINDOW, float(_read_policy_file()["loginAccount"]["windowSec"]))
        self.assertEqual(security._LOGIN_BLOCK, float(_read_policy_file()["loginAccount"]["blockSec"]))

    def test_fallback_defaults_match_file(self):
        """回退默认值必须与文件一致：否则「发布漏带 auth-policy.json」会静默换阈值。"""
        self.assertEqual(security._DEFAULT_POLICY, _read_policy_file(),
                         "security._DEFAULT_POLICY 与 auth-policy.json 不一致")

    def test_missing_file_falls_back(self):
        policy = security.load_auth_policy(os.path.join(tempfile.gettempdir(), "no-such-policy.json"))
        self.assertEqual(policy, security._DEFAULT_POLICY)

    def test_bad_json_falls_back(self):
        tmp = tempfile.mkdtemp()
        try:
            path = os.path.join(tmp, "bad.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write('{ "loginAccount": { "windowSec": 600,,, }')
            self.assertEqual(security.load_auth_policy(path), security._DEFAULT_POLICY)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_invalid_section_falls_back_alone(self):
        """单节写坏只回退那一节，其余照用文件值——不做"一处错、全盘回默认"。"""
        tmp = tempfile.mkdtemp()
        try:
            path = os.path.join(tmp, "part.json")
            payload = {
                "loginAccount": {"windowSec": 0, "maxFails": 6, "blockSec": 300},   # 窗口非法
                "loginIpCoarse": {"windowSec": 120, "maxFails": 50, "blockSec": 0},  # 合法且非默认
                "register": {"windowSec": 3600, "maxFails": 5},
            }
            with open(path, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            policy = security.load_auth_policy(path)
            self.assertEqual(policy["loginAccount"], security._DEFAULT_POLICY["loginAccount"])
            self.assertEqual(policy["loginIpCoarse"], {"windowSec": 120, "maxFails": 50, "blockSec": 0},
                             "合法那节应按文件生效")
            self.assertEqual(policy["register"]["blockSec"], 0, "省略 blockSec 时按 0 处理")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class CrossLanguagePolicyTests(unittest.TestCase):
    """真的拉起 node 读一遍星枢侧的策略，与枢纽侧逐字段比对。"""

    def test_starshu_and_hub_agree(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("未安装 node，跳过跨语言一致性校验")
        script = "process.stdout.write(JSON.stringify(require('./starshu/src/lib/authPolicy.js').policy))"
        proc = subprocess.run([node, "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, f"node 读取策略失败：{proc.stderr[:300]}")
        js_policy = json.loads(proc.stdout)
        self.assertEqual(js_policy, _read_policy_file(),
                         "星枢从 auth-policy.json 读到的值与文件不一致")
        self.assertEqual(js_policy, security.AUTH_POLICY,
                         "星枢与枢纽的限流策略不一致——两端各读一份策略就失去意义了")


class TempStoreCase(unittest.TestCase):
    """把数据层指向临时目录；不碰真实 hub_accounts.db。"""

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
        health.invalidate()

    def tearDown(self):
        security._LOGIN_FAILS.clear()
        config.ADMINS.clear()
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class LoginKeyDimensionTests(TempStoreCase):

    def test_keys_include_account_dimension(self):
        keys = _login_keys("203.0.113.7", "victim@x.com")
        self.assertEqual(len(keys), 3, "登录限流应有三个维度：pair / email / ip")
        self.assertIn("email:victim@x.com", keys,
                      "缺少仅按邮箱计数的桶：伪造 X-Forwarded-For 就能绕过账号维度的限流")

    def test_ip_rotation_cannot_bypass_account_bucket(self):
        """换 IP 盯同一个账号：旧的两个桶全被稀释，email 桶必须兜住。"""
        email = "victim@x.com"
        max_fails = security._LOGIN_MAX_FAILS
        for i in range(max_fails):
            ip = f"198.51.100.{i + 1}"
            for key in _login_keys(ip, email):
                security._login_note(key, False)

        # 旧实现的两个桶：每个都是新的空桶（这正是漏洞所在）
        for i in range(max_fails):
            ip = f"198.51.100.{i + 1}"
            self.assertEqual(security._login_gate("pair:" + ip + "|" + email), 0.0,
                             "pair 桶在轮换 IP 下必然被稀释")
            self.assertEqual(security._login_gate("ip:" + ip), 0.0,
                             "ip 桶在轮换 IP 下必然被稀释")
        # 账号维度：必须已经封禁
        self.assertGreater(security._login_gate("email:" + email), 0.0,
                           "轮换 IP 后账号维度的桶必须仍然触发封禁")

    def test_success_clears_all_dimensions(self):
        email = "ok@x.com"
        keys = _login_keys("203.0.113.9", email)
        for _ in range(security._LOGIN_MAX_FAILS - 1):
            for key in keys:
                security._login_note(key, False)
        for key in keys:
            security._login_note(key, True)
        for key in keys:
            self.assertEqual(security._login_gate(key), 0.0, "登录成功应清零该账号所有维度的失败计数")


class LoginHttpTests(TempStoreCase):
    """走真实的 _post_login：伪造 X-Forwarded-For 轮换 IP，验证 429 与 Retry-After。"""

    def _login(self, email, xff):
        h = FakeHub(body={"email": email, "password": "definitely-wrong"},
                    req_headers={"X-Forwarded-For": xff})
        h._post_login()
        return h

    def test_429_carries_retry_after_and_survives_ip_rotation(self):
        email = "target@x.com"
        max_fails = security._LOGIN_MAX_FAILS
        for i in range(max_fails):
            h = self._login(email, f"192.0.2.{i + 1}")
            self.assertEqual(h.status, 401, f"第 {i + 1} 次失败应返回 401（密码错误）")
        blocked = self._login(email, "192.0.2.250")   # 全新 IP，仍应被拦
        self.assertEqual(blocked.status, 429, "换 IP 不能绕过账号维度的限流")
        self.assertEqual(blocked.json.get("ok"), False)
        retry_after = blocked.header("Retry-After")
        self.assertIsNotNone(retry_after, "429 响应必须带 Retry-After（与星枢一致）")
        self.assertGreater(int(retry_after), 0)


if __name__ == "__main__":
    unittest.main()
