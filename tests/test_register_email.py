#!/usr/bin/env python3
"""注册接入邮箱验证码的回归测试。

这套测试守的是一条「真伪分界线」：注册必须证明**邮箱归属**，而不是只证明
「这是人点的」。所以断言分三层：

  1. cloudauth 模块：发码/验码的响应映射与失败语义
     （拿不到 id 不能假装成功；网络失败不能放行、也不该消耗重试次数）；
  2. 发码接口：图形验证码先于发信、已注册不发信、限流生效；
  3. 注册接口：没有「验过的码」一律不建号，云端不可用时不能降级放行。
"""
import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

from hub import cloudauth                                     # noqa: E402
from hub.captcha import issue_token, reset_used_for_test        # noqa: E402
from hub.handlers import auth_post                             # noqa: E402
from hub.security import reset_rate_for_test                    # noqa: E402

from fakehub import FakeHub                                    # noqa: E402

FAKE_CFG = {"base": "https://example.test", "key": "wbpk_test"}
GOOD_CAP = "AB2C"
EMAIL = "new@example.com"


def _cfg_on():
    return patch.object(cloudauth, "_cfg", return_value=dict(FAKE_CFG))


class 发码模块(unittest.TestCase):
    def setUp(self):
        cloudauth.reset_for_test()

    def test_成功后返回id并记住邮箱(self):
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_id": "v1", "is_user": False})):
            ok, vid, why, st = cloudauth.request_code("A@Example.com")
        self.assertTrue(ok)
        self.assertEqual(vid, "v1")
        self.assertEqual(why, "")
        self.assertEqual(st, 200)
        # 邮箱统一小写存下来，否则 "A@X.com" 与 "a@x.com" 会被当成两个地址
        self.assertEqual(cloudauth._peek("v1")[0], "a@example.com")

    def test_云端没返回id时不能假装成功(self):
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(200, {"is_user": False})):
            ok, vid, why, st = cloudauth.request_code(EMAIL)
        self.assertFalse(ok)
        self.assertEqual(vid, "")
        self.assertEqual(st, 502)
        self.assertIn("异常", why)

    def test_网络失败是503(self):
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(0, "URLError")):
            ok, _vid, why, st = cloudauth.request_code(EMAIL)
        self.assertFalse(ok)
        self.assertEqual(st, 503)
        self.assertIn("不可用", why)

    def test_限流与邮箱非法分别透传(self):
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(429, {})):
            self.assertEqual(cloudauth.request_code(EMAIL)[3], 429)
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(400, {})):
            self.assertEqual(cloudauth.request_code(EMAIL)[3], 400)

    def test_未配置云服务时不可用(self):
        with patch.object(cloudauth, "_cfg", return_value=None):
            self.assertFalse(cloudauth.configured())


class 验码模块(unittest.TestCase):
    def setUp(self):
        cloudauth.reset_for_test()
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_id": "v1"})):
            cloudauth.request_code(EMAIL)

    def _verify(self, code="123456", email=EMAIL, vid="v1"):
        return cloudauth.confirm_code(vid, code, email)

    def test_正确后返回成功(self):
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_token": "vt"})):
            ok, why, st = self._verify()
        self.assertTrue(ok)
        self.assertEqual((why, st), ("", 200))

    def test_成功后该id作废(self):
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_token": "vt"})):
            self.assertTrue(self._verify()[0])
        # 第二次：id 已被丢弃，不该再放行
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_token": "vt"})):
            ok, why, st = self._verify()
        self.assertFalse(ok)
        self.assertEqual(st, 400)
        self.assertIn("过期", why)

    def test_换邮箱不算数(self):
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_token": "vt"})) as post:
            ok, why, st = self._verify(email="other@example.com")
        self.assertFalse(ok)
        self.assertEqual(st, 400)
        self.assertFalse(post.called, "邮箱不匹配时不该去问云端")
        # 不能把「这张码原本发给谁」回显出来，否则等于泄露别人的地址
        self.assertNotIn("example.com", why)

    def test_错码可重试但次数有限(self):
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(400, {})):
            for _ in range(cloudauth.MAX_TRIES):
                ok, _why, st = self._verify(code="000000")
                self.assertFalse(ok)
                self.assertEqual(st, 400)
            # 次数用尽：id 作废，此后连正确码也进不去
            ok, why, st = self._verify(code="123456")
        self.assertFalse(ok)
        self.assertEqual(st, 400)
        self.assertIn("过期", why)

    def test_网络失败不消耗重试次数(self):
        with _cfg_on(), patch.object(cloudauth, "_post", return_value=(0, "URLError")):
            ok, _why, st = self._verify()
            self.assertFalse(ok)
            self.assertEqual(st, 503)
        # 网络恢复后同一个码仍应可用（失败是我们这边的问题，不该记在用户账上）
        with _cfg_on(), patch.object(cloudauth, "_post",
                                     return_value=(200, {"verification_token": "vt"})):
            ok, _why, st = self._verify()
        self.assertTrue(ok)
        self.assertEqual(st, 200)

    def test_过期后拒绝(self):
        with _cfg_on(), patch.object(cloudauth, "CODE_TTL", -1):
            ok, why, st = self._verify()
        self.assertFalse(ok)
        self.assertEqual(st, 400)
        self.assertIn("过期", why)


class 注册必须验码(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def _register(self, **body):
        hub = FakeHub(body=body)
        with patch.object(auth_post, "_create_user", return_value=True) as create:
            hub._post_register()
        hub.create_called = create.called
        return hub

    def test_没有验证码不建号(self):
        with patch.object(cloudauth, "configured", return_value=True):
            r = self._register(email=EMAIL, password="secret1")
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("emailCode"))
        self.assertFalse(r.create_called)

    def test_验码失败不建号(self):
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "confirm_code", return_value=(False, "验证码不正确或已过期，请重新获取。", 400)):
            r = self._register(email=EMAIL, password="secret1",
                               verificationId="v1", code="000000")
        self.assertEqual(r.status, 400)
        self.assertIn("验证码", r.json.get("error", ""))
        self.assertFalse(r.create_called)

    def test_云端不可用时不放行(self):
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "confirm_code", return_value=(False, "邮箱验证服务暂时不可用，请稍后再试。", 503)):
            r = self._register(email=EMAIL, password="secret1",
                               verificationId="v1", code="123456")
        self.assertEqual(r.status, 503)
        self.assertFalse(r.create_called, "云端挂了更不能白送一个未验证的账号")

    def test_验码通过才建号并自动登录(self):
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "confirm_code", return_value=(True, "", 200)) as confirm:
            r = self._register(email=EMAIL, password="secret1",
                               verificationId="v1", code="123456")
        self.assertEqual(r.status, 200)
        self.assertTrue(r.create_called)
        confirm.assert_called_once()
        # 传给云端校验的必须是「服务端记下的这个 id + 人填的码」，
        # 而不是客户端自报的邮箱（邮箱只用于和本机记录比对）
        args = confirm.call_args[0]
        self.assertEqual(args[0], "v1")
        self.assertEqual(args[1], "123456")
        self.assertTrue(r.header("Set-Cookie"), "注册成功应当直接签发会话 Cookie")

    def test_格式错误不消耗验码机会(self):
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "confirm_code") as confirm:
            r = self._register(email="not-an-email", password="secret1",
                               verificationId="v1", code="123456")
        self.assertEqual(r.status, 400)
        self.assertFalse(confirm.called, "邮箱格式不对时不该去消耗一次验码")


class 发码接口(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def _send(self, user=None, **body):
        """user=已存在的账号行；None 表示这个邮箱还没注册。"""
        hub = FakeHub(body=body)
        with patch.object(auth_post, "_get_user_by_email", return_value=user), \
             patch.object(auth_post, "_cloud_find_account", return_value=None):
            hub._post_register_code()
        return hub

    def test_未配云服务时明确报错(self):
        with patch.object(cloudauth, "configured", return_value=False):
            r = self._send(email=EMAIL, captcha=GOOD_CAP)
        self.assertEqual(r.status, 503)

    def test_图形验证码是发信的前置条件(self):
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code") as send:
            r = self._send(email=EMAIL, captcha="ZZZZ")
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("captcha"))
        self.assertFalse(send.called, "没证明是人之前不该发信")

    def test_通过后返回id与冷却时间(self):
        token = issue_token(GOOD_CAP)
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code", return_value=(True, "v9", "", 200)) as send:
            r = self._send(email=EMAIL, captcha=GOOD_CAP, captchaId=token)
        self.assertEqual(r.status, 200)
        self.assertEqual(r.json.get("verificationId"), "v9")
        self.assertGreaterEqual(r.json.get("cooldown", 0), 1)
        send.assert_called_once_with(EMAIL)

    def test_已注册不发信(self):
        token = issue_token(GOOD_CAP)
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code") as send:
            r = self._send(user=("x",), email=EMAIL, captcha=GOOD_CAP, captchaId=token)
        self.assertEqual(r.status, 409)
        self.assertFalse(send.called)

    def test_发信限流(self):
        tokens = [issue_token(GOOD_CAP) for _ in range(5)]
        with patch.object(cloudauth, "configured", return_value=True), \
             patch.object(cloudauth, "request_code", return_value=(True, "v", "", 200)):
            last = None
            for t in tokens:
                last = self._send(email=EMAIL, captcha=GOOD_CAP, captchaId=t)
        self.assertEqual(last.status, 429, "同一个邮箱连发第 4 次就该被拦下")
        self.assertTrue(last.header("Retry-After"))


if __name__ == "__main__":
    unittest.main()
