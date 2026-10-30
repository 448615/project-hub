#!/usr/bin/env python3
"""找回密码（邮箱验证码重置）的回归测试。

这套测试守的是一条**接管防线**：重设密码必须证明「这个邮箱是你的」。

  · 图形验证码只能证明「这是人」，证明不了「邮箱归属」。所以没配云服务时，
    重设接口必须明确拒绝，**绝不能**像注册那样降级成只认图形码——否则任何知道
    你邮箱的人都能把密码改掉，那不是找回，是接管。
  · 密码长度这类格式校验要发生在验码**之前**：邮件码一张只能试 5 次，让格式错误
    去消耗次数，用户会莫名其妙被锁。
  · 改密必须同步云端副本。serverless 冷启动后登录靠回查云端，不同步的话，
    用户重设完密码、下次冷启动又变回旧密码——比不改还糟。
"""
import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

from hub import accounts                                      # noqa: E402
from hub import cloudauth                                     # noqa: E402
from hub.captcha import issue_token, reset_used_for_test        # noqa: E402
from hub.handlers import auth_post                             # noqa: E402
from hub.security import reset_rate_for_test                    # noqa: E402

from fakehub import FakeHub                                    # noqa: E402

GOOD_CAP = "AB2C"
EMAIL = "u@example.com"


class FakeDS:
    """最小账号库替身：只实现 _reset_password 真正用到的那几个方法。

    为什么不直接用真库：这些用例会**改密码**，跑在 demo-scripts/hub_accounts.db
    上等于拿真实账号做实验。替身还顺带让「本地库是空的」这种冷启动状态变得可构造。
    """

    def __init__(self, rows=None):
        self.rows = [dict(r) for r in (rows or [])]
        self.creates = []
        self.sets = []

    def get_by_email(self, email):
        for r in self.rows:
            if r["email"] == email:
                return dict(r)
        return None

    def create(self, username, email, pwd, role="user"):
        self.creates.append((username, email, pwd, role))
        if any(r["email"] == email for r in self.rows):
            return False, "已存在"
        self.rows.append({"id": len(self.rows) + 1, "username": username,
                          "email": email, "pwd": pwd, "role": role})
        return True, ""

    def set_password(self, uid, pwd):
        for r in self.rows:
            if r["id"] == uid:
                self.sets.append((uid, pwd))
                r["pwd"] = pwd
                return True
        return False


class 存储层改密(unittest.TestCase):
    def _run(self, fake, email, pwd, cloud_row=None):
        with patch.object(accounts, "DS", fake), \
             patch.object(accounts, "_cloud_find_account", return_value=cloud_row), \
             patch.object(accounts, "_cloud_async") as sync:
            ok, err = accounts._reset_password(email, pwd)
        return ok, err, sync

    def test_本地有账号直接改密并同步云端(self):
        fake = FakeDS([{"id": 7, "username": "u", "email": EMAIL, "pwd": "old", "role": "user"}])
        ok, err, sync = self._run(fake, EMAIL, "newpass")
        self.assertTrue(ok)
        self.assertEqual(err, "")
        self.assertEqual(fake.rows[0]["pwd"], "newpass")
        # 不同步云端 = 下次冷启动回查云端又拿到旧密码
        sync.assert_called_once_with("upsert", EMAIL)

    def test_本地没有时用云端副本落回本地再改密(self):
        fake = FakeDS()
        cloud = {"username": "boss", "email": EMAIL, "role": "admin"}
        ok, _err, _sync = self._run(fake, EMAIL, "newpass", cloud_row=cloud)
        self.assertTrue(ok)
        self.assertEqual(len(fake.rows), 1)
        self.assertEqual(fake.rows[0]["role"], "admin", "管理员找回密码后不能被降级")
        self.assertEqual(fake.rows[0]["pwd"], "newpass")

    def test_两边都没有则明确拒绝(self):
        fake = FakeDS()
        ok, err, _sync = self._run(fake, "nobody@example.com", "newpass")
        self.assertFalse(ok)
        self.assertIn("尚未注册", err)

    def test_密码太短不发同步也不改库(self):
        fake = FakeDS([{"id": 1, "username": "u", "email": EMAIL, "pwd": "old", "role": "user"}])
        ok, err, sync = self._run(fake, EMAIL, "123")
        self.assertFalse(ok)
        self.assertIn("6 位", err)
        self.assertFalse(sync.called)
        self.assertEqual(fake.rows[0]["pwd"], "old")


class 发码接口(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def _send(self, user=("1",), **body):
        hub = FakeHub(body=body)
        with patch.object(auth_post, "_get_user_by_email", return_value=user), \
             patch.object(auth_post, "_cloud_find_account", return_value=None):
            hub._post_reset_code()
        return hub

    def test_没配云服务就明说无法自助找回(self):
        with patch.object(cloudauth, "configured", return_value=False), \
             patch.object(cloudauth, "request_code") as send:
            r = self._send(email=EMAIL)
        self.assertEqual(r.status, 503)
        self.assertFalse(send.called, "没有邮件通道时不可能发出码，别假装成功")

    def test_图形码错不发信(self):
        token = issue_token(GOOD_CAP)
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code") as send:
            r = self._send(email=EMAIL, captcha="ZZZZ", captchaId=token)
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("captcha"))
        self.assertFalse(send.called, "没证明是人之前不该发信")

    def test_未注册不发信(self):
        token = issue_token(GOOD_CAP)
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code") as send:
            r = self._send(user=None, email=EMAIL, captcha=GOOD_CAP, captchaId=token)
        self.assertEqual(r.status, 404)
        self.assertFalse(send.called)

    def test_通过后返回id与冷却时间(self):
        token = issue_token(GOOD_CAP)
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code", return_value=(True, "v9", "", 200)) as send:
            r = self._send(email=EMAIL, captcha=GOOD_CAP, captchaId=token)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json.get("verificationId"), "v9")
        self.assertGreaterEqual(r.json.get("cooldown", 0), 1)
        send.assert_called_once_with(EMAIL)

    def test_同一邮箱发码有上限(self):
        codes = []
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code", return_value=(True, "v1", "", 200)):
            for _ in range(6):
                token = issue_token(GOOD_CAP)
                codes.append(self._send(email=EMAIL, captcha=GOOD_CAP, captchaId=token).status)
        self.assertIn(429, codes, "同一个邮箱连发必须被拦住")


class 重设接口(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def _reset(self, pwd="newpass", confirm=(True, "", 200), rp=(True, ""), **body):
        hub = FakeHub(body=dict(email=EMAIL, password=pwd,
                                verificationId="v1", code="123456", **body))
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "confirm_code", return_value=confirm) as cf, \
             patch.object(auth_post, "_reset_password", return_value=rp) as reset:
            hub._post_reset()
        hub.confirm_called = cf.called
        hub.reset_mock = reset
        return hub

    def test_没配云服务时不降级成图形码(self):
        hub = FakeHub(body={"email": EMAIL, "password": "newpass"})
        with patch.object(cloudauth, "configured", return_value=False), \
             patch.object(auth_post, "_reset_password") as reset:
            hub._post_reset()
        self.assertEqual(hub.status, 503)
        self.assertFalse(reset.called, "图形码证明不了邮箱归属，绝不能放行改密")

    def test_没有验证码不改密(self):
        r = self._reset(confirm=(False, "请先获取邮箱验证码。", 400))
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("emailCode"))
        self.assertFalse(r.reset_mock.called)

    def test_密码太短时不消耗验码次数(self):
        r = self._reset(pwd="12")
        self.assertEqual(r.status, 400)
        self.assertIn("6 位", r.json.get("error", ""))
        self.assertFalse(r.confirm_called, "格式错不该先拿去问云端，白扣一次试错")
        self.assertFalse(r.reset_mock.called)

    def test_验码通过才改密并直接登录(self):
        r = self._reset()
        self.assertEqual(r.status, 200)
        r.reset_mock.assert_called_once_with(EMAIL, "newpass")
        self.assertTrue(r.header("Set-Cookie"), "重设成功应当直接签发会话 Cookie")

    def test_改密失败要回错误而不是假装成功(self):
        r = self._reset(rp=(False, "密码更新失败（账号库不可写）。"))
        self.assertEqual(r.status, 400)
        self.assertIn("不可写", r.json.get("error", ""))
        self.assertFalse(r.header("Set-Cookie"))

    def test_云端不可用时不放行(self):
        r = self._reset(confirm=(False, "邮箱验证服务暂时不可用，请稍后再试。", 503))
        self.assertEqual(r.status, 503)
        self.assertFalse(r.reset_mock.called)

    def test_成功后清掉登录失败封禁(self):
        from hub import security
        for _ in range(security._LOGIN_MAX_FAILS):
            security._login_note("email:" + EMAIL, False)
        self.assertGreater(security._login_gate("email:" + EMAIL), 0)
        r = self._reset()
        self.assertEqual(r.status, 200)
        self.assertEqual(security._login_gate("email:" + EMAIL), 0,
                         "已证明邮箱归属，不该让旧的猜错记录继续封着")


if __name__ == "__main__":
    unittest.main(verbosity=2)
