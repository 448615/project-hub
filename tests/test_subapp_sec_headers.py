#!/usr/bin/env python3
"""子应用响应的安全头回归测试。

背景（为什么这些头必须由枢纽补，而不是让子应用自己发）：
  · 进程型子应用（星枢）经 proxy 转发时，上游的 X-Frame-Options 与 CSP 会被
    _DROP_HEADERS 丢弃——不丢的话枢纽用同源 iframe 嵌它就会被自己拦掉；
  · 静态型子应用（工作台）页面里仍有大量内联 onclick/onchange，
    套 script-src 'self' 会把交互全打死，所以不能套用枢纽那套完整 CSP；
  · 结果是：这两头在「上游已丢弃 + 枢纽没补」的夹缝里，谁都没发出去。

本测试锁定「枢纽统一兜底」这一行为，防止后续重构再把它们丢回夹缝里。
"""
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath("."))
import subapps  # noqa: E402

WORKBENCH_HTML = "/apps/workbench/"
WORKBENCH_JS = "/apps/workbench/assets/index-k3Vt9Qmd.js"
WORKBENCH_MP3 = "/apps/workbench/music/bgm.mp3"
STARSHU = "/apps/starshu/"


class Resp:
    """可同时充当 serve_static 与 proxy 的 handler 替身。

    真实 handler 的 headers 是 email.message.Message（既可 .get 也可 .items），
    这里用 dict 近似；客户端请求头单独放 req_headers（_req_header 优先读它）。
    """

    def __init__(self, req_headers=None, method="GET"):
        self.status = None
        self.out = []                      # [(k, v)] 保序、允许重名
        self.headers = {}                  # 供 proxy 的 headers.items() 遍历
        self.req_headers = dict(req_headers or {})
        self.method = method
        self.wfile = io.BytesIO()

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.out.append((k, v))

    def end_headers(self):
        pass

    def _send_error(self, code, title, detail=""):
        self.status = code

    def header(self, name):
        """取该响应头最后一次出现的值（后发覆盖先发）。"""
        got = self.values(name)
        return got[-1] if got else None

    def values(self, name):
        return [v for k, v in self.out if k.lower() == name.lower()]


def serve(path, req_headers=None):
    h = Resp(req_headers)
    app, sub = subapps.match(path)
    assert app is not None, f"未匹配到子应用: {path}"
    subapps.serve_static(h, app, sub, os.path.abspath("."))
    return h


class TestServeStaticSecHeaders(unittest.TestCase):
    """静态型子应用：各响应分支都必须带齐 4 个安全头。"""

    def _assert_sec_headers(self, h, label):
        self.assertEqual(h.header("X-Content-Type-Options"), "nosniff", label)
        self.assertEqual(h.header("X-Frame-Options"), "SAMEORIGIN", label)
        self.assertEqual(h.header("Content-Security-Policy"), "frame-ancestors 'self'", label)
        self.assertEqual(h.header("Referrer-Policy"), "no-referrer", label)

    def test_index_html_200(self):
        h = serve(WORKBENCH_HTML)
        self.assertEqual(h.status, 200)
        self._assert_sec_headers(h, "index.html")

    def test_asset_200_streaming(self):
        h = serve(WORKBENCH_JS)
        self.assertEqual(h.status, 200)
        self._assert_sec_headers(h, "asset js")

    def test_asset_gzip_bypasses_gzip_for_range(self):
        # 带 Range 时不压缩，走 206 分支
        h = serve(WORKBENCH_MP3, {"Range": "bytes=0-1023"})
        self.assertEqual(h.status, 206)
        self._assert_sec_headers(h, "range 206")

    def test_range_invalid_416(self):
        h = serve(WORKBENCH_MP3, {"Range": "bytes=99999999-"})
        self.assertEqual(h.status, 416)
        self._assert_sec_headers(h, "range 416")

    def test_not_modified_304(self):
        first = serve(WORKBENCH_JS)
        etag = first.header("ETag")
        self.assertTrue(etag)
        h = serve(WORKBENCH_JS, {"If-None-Match": etag})
        self.assertEqual(h.status, 304)
        self._assert_sec_headers(h, "304")

    def test_gzip_branch(self):
        h = serve(WORKBENCH_JS, {"Accept-Encoding": "gzip"})
        self.assertEqual(h.status, 200)
        self.assertEqual(h.header("Content-Encoding"), "gzip")
        self._assert_sec_headers(h, "gzip 200")


class TestProxySecHeaders(unittest.TestCase):
    """进程型子应用：上游发的 XFO/CSP 被丢弃后，必须由枢纽重新发一份。"""

    def setUp(self):
        self.app = {"prefix": STARSHU, "kind": "node", "_port": 13000, "name": "starshu"}
        self.upstream = mock.MagicMock()
        self.upstream.__enter__.return_value = self.upstream
        self.upstream.__exit__ = mock.MagicMock(return_value=False)
        self.upstream.status = 200
        self.upstream.read.return_value = b"<html>starshu</html>"
        # 故意让上游声明 DENY + 严格 CSP，验证它们确实被丢弃、再被枢纽替换
        self.upstream.headers = {
            "Content-Type": "text/html; charset=utf-8",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'",
        }

    def _run(self):
        h = Resp()
        with mock.patch.object(subapps.urllib.request, "urlopen", return_value=self.upstream):
            subapps.proxy(h, self.app, "", "GET", None)
        return h

    def test_returns_upstream_body(self):
        h = self._run()
        self.assertEqual(h.status, 200)
        self.assertEqual(h.wfile.getvalue(), b"<html>starshu</html>")

    def test_upstream_frame_options_dropped_and_replaced(self):
        h = self._run()
        # 关键：不能出现上游那个 DENY（否则枢纽自己 iframe 嵌不进去）
        self.assertNotIn("DENY", h.values("X-Frame-Options"))
        self.assertEqual(h.header("X-Frame-Options"), "SAMEORIGIN")

    def test_upstream_csp_dropped_and_replaced(self):
        h = self._run()
        self.assertNotIn("default-src 'none'", h.values("Content-Security-Policy"))
        self.assertEqual(h.header("Content-Security-Policy"), "frame-ancestors 'self'")

    def test_referrer_policy_present(self):
        h = self._run()
        self.assertEqual(h.header("Referrer-Policy"), "no-referrer")
        self.assertEqual(h.header("X-Content-Type-Options"), "nosniff")


if __name__ == "__main__":
    unittest.main()
