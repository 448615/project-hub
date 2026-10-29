#!/usr/bin/env python3
"""serve_static 回归测试：中文文件名解码、目录穿越、缺失资源、SPA 回落。

两种跑法都能用：`python tests/test_static_serving.py`（看逐项输出）
或 `python -m unittest discover -s tests`（走下面的 TestCase 包装）。

加包装的原因：这个文件原本只有 main()，没有 TestCase，
于是 `unittest discover` 完全不会执行它——它其实早就因产物改名而失败，
却一直没人发现。
"""
import os
import sys
import unittest
import urllib.parse

sys.path.insert(0, os.path.abspath("."))
import subapps  # noqa: E402


class FakeHandler:
    def __init__(self, req_headers=None):
        self.status = None
        self.headers = []
        self.req_headers = dict(req_headers or {})   # 模拟客户端请求头
        self.body = b""

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.headers.append((k, v))

    def end_headers(self):
        pass

    def _send_error(self, code, title, detail=""):
        self.status = code

    def header(self, name):
        for k, v in self.headers:
            if k.lower() == name.lower():
                return v
        return None

    def write(self, data):
        self.body += data


def call(path, req_headers=None):
    h = FakeHandler(req_headers)
    app, sub = subapps.match(path)
    assert app is not None, f"未匹配到子应用: {path}"
    orig = subapps._safe_write
    subapps._safe_write = lambda handler, data: handler.write(data)
    try:
        subapps.serve_static(h, app, sub, os.path.abspath("."))
    finally:
        subapps._safe_write = orig
    return h


def _pick_asset_js():
    """动态挑一个实际存在的构建产物 js。

    以前这里写死了 index-OHqEWVNe.js，产物改名后测试就 404 崩掉——
    而它又是脚本式（无 TestCase），unittest discover 根本不会执行，
    于是「坏了」这件事一直没被发现。改成动态选名后不再随产物改名失效。
    """
    d = os.path.join("workbench", "www", "assets")
    try:
        names = sorted(n for n in os.listdir(d) if n.endswith(".js"))
    except OSError:
        return None, None
    if not names:
        return None, None
    return "/apps/workbench/assets/" + names[0], os.path.join(d, names[0])


def main():
    ok = True
    JS_URL, JS_PATH = _pick_asset_js()
    assert JS_URL, "workbench 构建产物缺失，无法测试静态资源分支"

    # 1) 中文文件名（百分号编码）应命中真实文件
    #    不再依赖具体某首歌：临时造一个中文名探针文件，验证 unquote 解码生效，测完删除。
    music_dir = os.path.join("workbench", "www", "music")
    probe_name = "临时校验-中文名.mp3"
    probe_path = os.path.join(music_dir, probe_name)
    probe_body = b"ID3" + b"\x00" * 2048
    with open(probe_path, "wb") as fp:
        fp.write(probe_body)
    try:
        h = call("/apps/workbench/music/" + urllib.parse.quote(probe_name))
        good = (h.status == 200 and h.header("Content-Type") == "audio/mpeg"
                and len(h.body) == len(probe_body))
        print(f"[{'PASS' if good else 'FAIL'}] 中文 mp3: status={h.status} "
              f"type={h.header('Content-Type')} bytes={len(h.body)}")
        ok &= good
    finally:
        if os.path.exists(probe_path):
            os.remove(probe_path)

    # 1b) 实际上线用的默认音乐必须存在、类型正确（改名前是勾指起誓，现为 bgm.mp3）
    h = call("/apps/workbench/music/bgm.mp3")
    good = (h.status == 200 and h.header("Content-Type") == "audio/mpeg"
            and len(h.body) > 1000000)
    print(f"[{'PASS' if good else 'FAIL'}] 默认音乐 bgm.mp3: status={h.status} "
          f"type={h.header('Content-Type')} bytes={len(h.body)}")
    ok &= good

    # 2) 目录穿越（编码的 ../）必须 404
    h = call("/apps/workbench/%2e%2e/%2e%2e/hub.py")
    good = h.status == 404
    print(f"[{'PASS' if good else 'FAIL'}] 编码穿越 %2e%2e: status={h.status}")
    ok &= good

    # 3) 缺失的静态资源必须 404，不能回落成 index.html
    h = call("/apps/workbench/music/not-exist.mp3")
    good = h.status == 404
    print(f"[{'PASS' if good else 'FAIL'}] 缺失 mp3: status={h.status}（期望 404，不再返回 HTML）")
    ok &= good

    # 4) SPA 路由（无扩展名）仍回落 index.html
    h = call("/apps/workbench/todo")
    good = h.status == 200 and "text/html" in (h.header("Content-Type") or "")
    print(f"[{'PASS' if good else 'FAIL'}] SPA 路由回落: status={h.status} "
          f"type={h.header('Content-Type')}")
    ok &= good

    # 5) 普通静态资源仍正常（构建产物 js）
    h = call(JS_URL)
    good = h.status == 200 and "javascript" in (h.header("Content-Type") or "")
    print(f"[{'PASS' if good else 'FAIL'}] js 资源: status={h.status} "
          f"type={h.header('Content-Type')} bytes={len(h.body)}")
    ok &= good

    # 6) Range 请求 → 206 + 精确字节数（音视频拖动进度的前提）
    h = call("/apps/workbench/music/bgm.mp3", {"Range": "bytes=0-1023"})
    good = (h.status == 206 and len(h.body) == 1024
            and (h.header("Content-Range") or "").startswith("bytes 0-1023/"))
    print(f"[{'PASS' if good else 'FAIL'}] Range 0-1023: status={h.status} "
          f"bytes={len(h.body)} range={h.header('Content-Range')}")
    ok &= good

    # 7) 后缀式 Range（bytes=-512 表示最后 512 字节）
    h = call("/apps/workbench/music/bgm.mp3", {"Range": "bytes=-512"})
    good = h.status == 206 and len(h.body) == 512
    print(f"[{'PASS' if good else 'FAIL'}] Range 后缀 -512: status={h.status} bytes={len(h.body)}")
    ok &= good

    # 8) 越界 Range → 416（不能让客户端拿到半个坏文件）
    h = call("/apps/workbench/music/bgm.mp3", {"Range": "bytes=99999999-"})
    good = h.status == 416 and (h.header("Content-Range") or "").startswith("bytes */")
    print(f"[{'PASS' if good else 'FAIL'}] Range 越界: status={h.status} "
          f"range={h.header('Content-Range')}")
    ok &= good

    # 9) 文本资源带 Accept-Encoding: gzip → 压缩后体积明显变小
    h = call(JS_URL, {"Accept-Encoding": "gzip"})
    raw = open(JS_PATH, "rb").read()
    good = (h.status == 200 and h.header("Content-Encoding") == "gzip"
            and len(h.body) < len(raw) * 0.8)
    print(f"[{'PASS' if good else 'FAIL'}] gzip js: {len(raw)} → {len(h.body)} bytes "
          f"encoding={h.header('Content-Encoding')}")
    ok &= good

    # 10) 带 If-None-Match → 304，不再重发文件体
    etag = h.header("ETag")
    h2 = call(JS_URL,
              {"Accept-Encoding": "gzip", "If-None-Match": etag or ""})
    good = h2.status == 304 and len(h2.body) == 0
    print(f"[{'PASS' if good else 'FAIL'}] 304 协商缓存: status={h2.status} bytes={len(h2.body)}")
    ok &= good

    print("\n结果:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


class TestServeStaticScript(unittest.TestCase):
    """把上面整套脚本式断言包进 TestCase，纳入 unittest discover。"""

    def test_all_static_cases(self):
        self.assertEqual(main(), 0, "test_static_serving.py 有失败项，见上方逐项输出")


if __name__ == "__main__":
    sys.exit(main())
