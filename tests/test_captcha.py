#!/usr/bin/env python3
"""图形验证码（hub.captcha）单元测试。

这里断言的重点不是「验证码能生出来」，而是三个**失效即等于没有**的点：

  1. SVG 里不能出现明文答案 —— 用 <text> 渲染的验证码，正则一抓即得；
  2. 令牌必须自证真伪 —— 答案不存内存，冷启动/多进程都不影响；
  3. 令牌一次性，且**校验失败也作废** —— 否则一张图可被穷举到命中。

第 3 条最容易漏：只写「成功后标记已用」的实现看起来能跑通，
但攻击者拿一张图连发 71 万次就能拿到正确结果，验证码形同虚设。
"""
import json
import os
import random
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from hub import captcha                            # noqa: E402
from hub.captcha import (                          # noqa: E402
    CHARSET,
    CODE_LEN,
    _GLYPHS,
    issue_token,
    new_challenge,
    render_svg,
    reset_used_for_test,
    verify_token,
)


class 字符集与字形(unittest.TestCase):
    def test_不含易混字符(self):
        # 0/O、1/I/L、5/S 在 5×7 点阵里几乎同形，放进去只有「人看错」的收益，没有熵的收益
        for bad in "01OILS":
            self.assertNotIn(bad, CHARSET, f"{bad} 易与其他字符混淆")

    def test_每个字符都有合法字形(self):
        for ch in CHARSET:
            self.assertIn(ch, _GLYPHS, f"字符 {ch} 缺少字形")
            rows = _GLYPHS[ch]
            self.assertEqual(len(rows), 7, f"{ch} 应为 7 行")
            for row in rows:
                self.assertEqual(len(row), 5, f"{ch} 每行应为 5 列")
                self.assertTrue(set(row) <= {"0", "1"}, f"{ch} 只能由 0/1 组成")

    def test_字形不留空(self):
        # 全 0 的字形会渲染成「什么都没画」，用户看到空白无法输入
        for ch, rows in _GLYPHS.items():
            self.assertIn("1", "".join(rows), f"{ch} 字形是空的")

    def test_四位长度(self):
        self.assertEqual(CODE_LEN, 4)


class SVG渲染(unittest.TestCase):
    def test_不含text标签(self):
        svg = render_svg("AB2C", random.Random(1))
        self.assertNotIn("<text", svg)
        self.assertNotIn("</text", svg)

    def test_不含transform属性(self):
        # transform 会把「哪几段属于同一字符」直接告诉解析者，逐组求逆即可还原字形
        svg = render_svg("AB2C", random.Random(2))
        self.assertNotIn("transform", svg)

    def test_源码里没有明文答案(self):
        for code in ("AB2C", "XY9Z", "HJKM"):
            svg = render_svg(code, random.Random(3))
            self.assertNotIn(code, svg, "验证码明文出现在响应里")
            # 更强的断言：不存在「>单字符<」这种裸文本节点
            for ch in code:
                self.assertNotIn(">" + ch + "<", svg)

    def test_同种子输出稳定(self):
        a = render_svg("AB2C", random.Random(7))
        b = render_svg("AB2C", random.Random(7))
        self.assertEqual(a, b)

    def test_不同种子输出不同(self):
        a = render_svg("AB2C", random.Random(7))
        b = render_svg("AB2C", random.Random(8))
        self.assertNotEqual(a, b, "随机扰动失效会让 OCR 变容易")

    def test_是合法svg且有底色(self):
        svg = render_svg("AB2C", random.Random(4))
        self.assertTrue(svg.startswith("<svg"))
        self.assertTrue(svg.endswith("</svg>"))
        self.assertIn('fill="#f4f7fb"', svg)   # 固定浅底：深色主题下才不会看不见字
        self.assertIn('viewBox="0 0 132 44"', svg)

    def test_含干扰元素(self):
        svg = render_svg("AB2C", random.Random(5))
        self.assertGreaterEqual(svg.count("<circle"), 20, "噪点太少，易被切割识别")
        self.assertGreaterEqual(svg.count("Q"), 3, "缺少干扰曲线")

    def test_空字符不炸(self):
        self.assertIn("<svg", render_svg(""))


class 令牌校验(unittest.TestCase):
    def setUp(self):
        reset_used_for_test()

    def test_正确答案通过(self):
        tok = issue_token("AB2C")
        self.assertEqual(verify_token(tok, "AB2C"), (True, "ok"))

    def test_大小写与空格不敏感(self):
        tok = issue_token("AB2C")
        self.assertEqual(verify_token(tok, "  ab2c "), (True, "ok"))

    def test_错误答案不通过(self):
        tok = issue_token("AB2C")
        ok, why = verify_token(tok, "AB2D")
        self.assertFalse(ok)
        self.assertEqual(why, "bad")

    def test_失败后令牌即作废(self):
        # 这是穷举防线的核心：输错一次就必须换图，一张图不能反复试
        tok = issue_token("AB2C")
        self.assertFalse(verify_token(tok, "ZZZZ")[0])
        ok, why = verify_token(tok, "AB2C")
        self.assertFalse(ok, "输错后仍可用同一令牌提交正确答案")
        self.assertEqual(why, "used")

    def test_成功后不能重放(self):
        tok = issue_token("AB2C")
        self.assertTrue(verify_token(tok, "AB2C")[0])
        ok, why = verify_token(tok, "AB2C")
        self.assertFalse(ok)
        self.assertEqual(why, "used")

    def test_过期(self):
        tok = issue_token("AB2C", ttl=-1)
        ok, why = verify_token(tok, "AB2C")
        self.assertFalse(ok)
        self.assertEqual(why, "expired")

    def test_令牌载荷不含明文答案(self):
        # 最容易犯的错：把 {"c":"AB2C"} 放进 payload。payload 只是 base64，**不是加密**，
        # 客户端 unbase64 就能读出答案，验证码等于不存在。载荷里只能有不可逆摘要。
        tok = issue_token("AB2C")
        body = tok.partition(".")[0]
        raw = captcha._b64d(body).decode("utf-8")
        self.assertNotIn("AB2C", raw.upper(), "令牌载荷里出现明文答案")
        payload = json.loads(raw)
        self.assertNotIn("c", payload, "不应再往载荷里放答案字段")
        for v in payload.values():
            self.assertNotIn("AB2C", str(v).upper())

    def test_摘要与答案绑定(self):
        # 同一 nonce 下不同答案必须得到不同摘要（否则换答案也能过）
        a = captcha._answer_digest("n1", "AB2C")
        b = captcha._answer_digest("n1", "AB2D")
        self.assertNotEqual(a, b)
        self.assertEqual(a, captcha._answer_digest("n1", "ab2c"))   # 大小写不敏感

    def test_篡改摘要则签名不符(self):
        tok = issue_token("AB2C")
        body, _dot, sig = tok.partition(".")
        raw = json.loads(captcha._b64d(body))
        raw["d"] = "0" * 32
        forged = captcha._b64e(json.dumps(raw).encode("utf-8")) + "." + sig
        ok, why = verify_token(forged, "AB2C")
        self.assertFalse(ok, "改摘要后签名应对不上")
        self.assertEqual(why, "malformed")

    def test_篡改签名(self):
        tok = issue_token("AB2C")
        body, _dot, _sig = tok.partition(".")
        ok, why = verify_token(body + "." + captcha._b64e(b"0" * 16), "AB2C")
        self.assertFalse(ok)
        self.assertEqual(why, "malformed")

    def test_垃圾输入(self):
        for bad in ("", None, "abc", "a.b", "....", "你好.世界"):
            ok, why = verify_token(bad, "AB2C")
            self.assertFalse(ok)
            self.assertEqual(why, "malformed", f"输入 {bad!r} 应判为格式错误")

    def test_令牌每次不同(self):
        # nonce 保证同样答案的两张图令牌也不同，否则一张图能无限复用
        self.assertNotEqual(issue_token("AB2C"), issue_token("AB2C"))

    def test_不返回明文(self):
        ch = new_challenge(random.Random(9))
        self.assertIn("token", ch)
        self.assertIn("svg", ch)
        self.assertNotIn("code", ch, "答案绝不能出现在响应里")


class 频率闸门(unittest.TestCase):
    def setUp(self):
        from hub.security import reset_rate_for_test
        reset_rate_for_test()

    def test_超过上限后拦截(self):
        from hub.security import rate_hit
        for _ in range(3):
            self.assertEqual(rate_hit("t:1", 3, 60.0), 0.0)
        wait = rate_hit("t:1", 3, 60.0)
        self.assertGreater(wait, 0, "第 4 次应被拦截")
        self.assertLessEqual(wait, 60.0)

    def test_窗口过期后恢复(self):
        from hub.security import rate_hit
        for _ in range(3):
            rate_hit("t:2", 2, 0.05)
        self.assertGreater(rate_hit("t:2", 2, 0.05), 0)
        import time
        time.sleep(0.08)
        self.assertEqual(rate_hit("t:2", 2, 0.05), 0.0, "窗口过后应重新放行")

    def test_不同键互不影响(self):
        from hub.security import rate_hit
        rate_hit("t:a", 1, 60.0)
        rate_hit("t:a", 1, 60.0)
        self.assertEqual(rate_hit("t:b", 1, 60.0), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
