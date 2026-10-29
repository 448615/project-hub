#!/usr/bin/env python3
"""注册接口接入图形验证码的回归测试。

注册是本项目**唯一能凭空产生账号**的免登录接口，所以这里断言的是接入顺序与副作用：

  1. 没有验证码 / 验证码错 → 直接 400，账号库一次都不碰；
  2. 失败响应带 captcha:true —— 前端据此换图（令牌已作废，不换就是死图）；
  3. 令牌一次性：同一张图第二次提交必被拒 —— 防穷举；
  4. 格式校验排在验证码之前 —— 邮箱写错不该浪费掉用户已认对的那张图；
  5. 注册成功即签发会话 Cookie（自动登录），不需要再调一次登录接口；
  6. 注册频率闸门：超限返回 429 且带 Retry-After。
"""
import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

from hub.captcha import issue_token, reset_used_for_test   # noqa: E402
from hub.handlers import auth_post                          # noqa: E402
from hub.security import reset_rate_for_test                # noqa: E402

from fakehub import FakeHub                                 # noqa: E402

GOOD_CODE = "AB2C"


def _register(**body):
    """发一次注册请求；_create_user 打桩，避免真的落库。

    强制走「未配置云服务」分支：本文件守的是**退路**——离线或自托管环境下没有
    邮件通道，注册只能靠图形验证码。主路径（邮箱验证码）见 test_register_email.py。
    """
    hub = FakeHub(body=body)
    with patch.object(auth_post.cloudauth, "configured", return_value=False):
        with patch.object(auth_post, "_create_user", return_value=True) as create:
            hub._post_register()
    hub.create_called = create.called
    return hub


class 验证码闸门(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def test_缺少验证码直接拒绝(self):
        r = _register(email="new@example.com", password="secret1")
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("captcha"))
        self.assertFalse(r.create_called, "没有验证码时不该进入创建账号流程")

    def test_验证码错误(self):
        tok = issue_token(GOOD_CODE)
        r = _register(email="new@example.com", password="secret1",
                      captchaId=tok, captcha="XXXX")
        self.assertEqual(r.status, 400)
        self.assertTrue(r.json.get("captcha"))
        self.assertFalse(r.create_called)

    def test_令牌一次性(self):
        tok = issue_token(GOOD_CODE)
        first = _register(email="a@example.com", password="secret1",
                          captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(first.status, 200)
        # 同一令牌（同一张图）再来一次：答案完全正确也必须被拒，否则可被穷举
        second = _register(email="b@example.com", password="secret1",
                           captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(second.status, 400)
        self.assertFalse(second.create_called)

    def test_输错一次后同一张图失效(self):
        # 穷举防线的实际形态：脚本拿一张图，第一次随便猜，猜错就该换图。
        # 如果实现只在「成功」后才作废，这张图就能被反复提交直到命中。
        tok = issue_token(GOOD_CODE)
        wrong = _register(email="c@example.com", password="secret1",
                          captchaId=tok, captcha="ZZZZ")
        self.assertEqual(wrong.status, 400)
        again = _register(email="c@example.com", password="secret1",
                          captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(again.status, 400, "输错一次后仍能用同一张图提交正确答案")
        self.assertFalse(again.create_called)

    def test_格式错误不消耗验证码(self):
        tok = issue_token(GOOD_CODE)
        bad = _register(email="not-an-email", password="secret1",
                        captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(bad.status, 400)
        self.assertIn("邮箱", bad.json.get("error", ""))
        # 同一个令牌仍应可用：格式校验必须排在验证码校验之前
        good = _register(email="ok@example.com", password="secret1",
                         captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(good.status, 200, "邮箱格式错误白白消耗了一张验证码")

    def test_密码过短(self):
        tok = issue_token(GOOD_CODE)
        r = _register(email="short@example.com", password="123",
                      captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(r.status, 400)
        self.assertIn("6", r.json.get("error", ""))


class 注册即登录(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def test_成功后签发会话Cookie(self):
        tok = issue_token(GOOD_CODE)
        r = _register(email="auto@example.com", password="secret1",
                      captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(r.status, 200)
        self.assertTrue(r.json.get("ok"))
        self.assertEqual(r.json.get("email"), "auto@example.com")
        cookie = r.header("Set-Cookie") or ""
        self.assertIn("hub_sess=", cookie, "注册成功必须直接下发会话，否则用户还得再登一次")
        self.assertIn("HttpOnly", cookie)

    def test_响应不含密码(self):
        tok = issue_token(GOOD_CODE)
        r = _register(email="leak@example.com", password="secret1",
                      captchaId=tok, captcha=GOOD_CODE)
        self.assertNotIn("secret1", r.body_bytes.decode("utf-8", "ignore"))


class 注册频率闸门(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()
        reset_rate_for_test()

    def test_超过次数返回429(self):
        last = None
        for _ in range(11):
            tok = issue_token(GOOD_CODE)
            last = _register(email="spam@example.com", password="secret1",
                             captchaId=tok, captcha=GOOD_CODE)
        self.assertEqual(last.status, 429)
        self.assertTrue(last.header("Retry-After"), "429 必须带 Retry-After，否则客户端只能盲猜")
        self.assertFalse(last.create_called)


if __name__ == "__main__":
    unittest.main(verbosity=2)
