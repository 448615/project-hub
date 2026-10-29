#!/usr/bin/env python3
"""base._serve_static 回归测试：大文件流式、HEAD 无体、Range 三种形式、目录穿越拦截。

覆盖 P2 的「静态文件整块读入内存」「HEAD/Range 缺失」两项整改：
- 大文件（>256KB）走分块流式，不再把整文件塞内存；
- 新增 do_HEAD 复用 do_GET 路由，HEAD 返回与 GET 相同头部且无响应体；
- Range 三形式（中间段 / 后缀 / 越界）按 RFC 9110 返回 206 / 416；
- 目录穿越仍 404。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath("."))

from hub.handlers.base import BaseMixin, STATIC_STREAM_THRESHOLD  # noqa: E402


class _CaptureWfile:
    def __init__(self):
        self.data = b""

    def write(self, chunk):
        if isinstance(chunk, str):
            chunk = chunk.encode("utf-8")
        self.data += chunk


class StaticHandler(BaseMixin):
    """最小化 HTTP 处理器替身：复用 BaseMixin 真实的 _send_asset/_not_modified/_sec_headers，
    仅把响应状态/头部/响应体捕获到内存，便于断言。"""

    def __init__(self, headers=None, command="GET"):
        self.headers = headers or {}
        self.command = command
        self._status = None
        self._out_headers = []
        self.wfile = _CaptureWfile()
        self.close_connection = False
        self.root = os.path.abspath(".")

    def send_response(self, code, message=None):
        self._status = code

    def send_response_only(self, code, message=None):
        self._status = code

    def send_header(self, k, v):
        self._out_headers.append((k, v))

    def end_headers(self):
        pass

    def _sec_headers(self):
        pass

    def header(self, name):
        for k, v in self._out_headers:
            if k.lower() == name.lower():
                return v
        return None


class TestBaseStaticServing(unittest.TestCase):
    BG = os.path.join("static", "bg.jpg")

    def _h(self, headers=None, command="GET"):
        return StaticHandler(headers, command)

    def test_head_large_has_no_body(self):
        # 大文件 HEAD：代码显式在 command==HEAD 时跳过流式写出，不应有响应体
        h = self._h(command="HEAD")
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 200)
        self.assertEqual(h.wfile.data, b"", "HEAD 不应返回响应体")
        self.assertEqual(h.header("Content-Length"), str(os.path.getsize(self.BG)))

    def test_get_large_streams_full_and_accepts_ranges(self):
        size = os.path.getsize(self.BG)
        h = self._h()
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 200)
        self.assertEqual(len(h.wfile.data), size, "大文件应整段流式返回")
        self.assertEqual(h.header("Accept-Ranges"), "bytes")

    def test_get_small_file_gzips_via_send_asset(self):
        # 小文件仍走 _send_asset（含 ETag/可能 gzip），整体逻辑不回归
        h = self._h({"Accept-Encoding": "gzip"})
        h._serve_static("sw.js")
        self.assertEqual(h._status, 200)
        self.assertIsNotNone(h.header("ETag"))

    def test_range_middle(self):
        h = self._h({"Range": "bytes=100-200"})
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 206)
        self.assertEqual(len(h.wfile.data), 101)
        self.assertTrue(h.header("Content-Range").startswith("bytes 100-200/"))

    def test_range_suffix(self):
        full = os.path.getsize(self.BG)
        h = self._h({"Range": "bytes=-500"})
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 206)
        self.assertEqual(len(h.wfile.data), 500)
        self.assertEqual(h.header("Content-Range"),
                         f"bytes {full - 500}-{full - 1}/{full}")

    def test_range_open_ended(self):
        full = os.path.getsize(self.BG)
        h = self._h({"Range": "bytes=10-"})
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 206)
        self.assertEqual(h.header("Content-Range"), f"bytes 10-{full - 1}/{full}")
        self.assertEqual(len(h.wfile.data), full - 10)

    def test_range_out_of_bounds_returns_416(self):
        h = self._h({"Range": "bytes=99999999-"})
        h._serve_static("bg.jpg")
        self.assertEqual(h._status, 416)
        self.assertTrue(h.header("Content-Range").startswith("bytes */"))

    def test_traversal_blocked(self):
        h = self._h()
        h._serve_static("../hub.py")
        self.assertEqual(h._status, 404)

    def test_threshold_constant_reasonable(self):
        # 阈值应在合理区间，避免「小文件也流式（丧失 gzip）」或「大文件仍整块读」
        self.assertGreater(STATIC_STREAM_THRESHOLD, 64 * 1024)
        self.assertLess(STATIC_STREAM_THRESHOLD, 4 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
