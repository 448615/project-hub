# -*- coding: utf-8 -*-
"""browse_proxy 安全关键路径测试（SSRF 白名单、DNS 重绑定钉 IP、sharecode 剥离）。

运行：
    python -m pytest tests/test_proxy_security.py -q
或：
    python tests/test_proxy_security.py
"""
import os
import sys

# 确保能从仓库根导入（直接 python 运行时）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import threading
import http.server

import browse_proxy as BP
# 实现层：fetch / _resolve_pin / is_allowed 实际定义在 browse.fetch，
# browse_proxy 只是 re-export 薄壳，所以打补丁必须打在实现模块上（否则不生效）。
# 注意 browse 包的 fetch 属性已被同名函数覆盖，必须用 import_module 取子模块本体。
import importlib
_fetch_mod = importlib.import_module("browse.fetch")


def test_is_allowed_blocks_internal():
    denied = [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://10.0.0.1:8080/",
        "http://192.168.1.1/",
        "ftp://example.com/",            # 非 http/https
        "http://user@127.0.0.1/",        # 混淆写法
    ]
    for u in denied:
        ok, _ = BP.is_allowed(u)
        assert not ok, f"应拒绝：{u}"


def test_is_allowed_allows_public():
    allowed = [
        "http://example.com/",
        "https://example.com/",
        "http://example.com:8080/",
        "https://example.com:8443/",
        "http://example.com:22/",        # 端口不再限白名单，公网任意端口放行
        "https://example.com:12345/",
    ]
    for u in allowed:
        ok, reason = BP.is_allowed(u)
        assert ok, f"应放行：{u} -> {reason}"


def test_strip_share_removes_sharecode_and_hs():
    assert BP.target_of("/browse/k/https://a.com/s?x=1&sharecode=Z&_hs=Z") == "https://a.com/s?x=1"
    assert BP.target_of("/browse/https://a.com/s?sharecode=Z") == "https://a.com/s"
    assert BP.target_of("/browse/https://a.com/s?a=1&sharecode=Z&_hs=Z&b=2") == "https://a.com/s?a=1&b=2"


def test_resolve_pin_denies_loopback():
    raised = False
    try:
        BP._resolve_pin("http://127.0.0.1/")
    except ValueError:
        raised = True
    assert raised, "对回环地址的钉 IP 解析必须抛 ValueError"


def _start_local(allowed_host):
    """起本地 HTTP 服务，并临时把 allowed_host 钉死到该服务，验证「连 IP 但 Host 保域名」。"""
    class _H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = ("HOST=%s|PATH=%s" % (self.headers.get("Host"), self.path)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), _H)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    orig_resolve = _fetch_mod._resolve_pin
    orig_allow = _fetch_mod.is_allowed
    orig_proxy = _fetch_mod._HAS_PROXY

    def fake_resolve(u):
        return ("127.0.0.1", port)

    def fake_allow(u, *a, **k):
        if allowed_host in (u or ""):
            return (True, "")
        return orig_allow(u, *a, **k)

    _fetch_mod._resolve_pin = fake_resolve
    _fetch_mod.is_allowed = fake_allow
    # 本用例专门验证「钉 IP 直连时 Host 仍为原域名」，只有在无代理环境下才会走钉 IP 分支。
    # CI/沙箱常注入 HTTP_PROXY（有代理时刻意不钉 IP，交给代理隧道），这里强制置 False，
    # 否则用例会随环境时通时不通。
    _fetch_mod._HAS_PROXY = False
    try:
        st, _, data, _ = BP.fetch("http://%s/hello?x=1" % allowed_host)
        assert st == 200, data
        text = data.decode(errors="replace")
        assert "HOST=%s" % allowed_host in text, "Host 头必须为原始域名（钉 IP 不影响 Host）"
        assert "/hello?x=1" in text
    finally:
        _fetch_mod._resolve_pin = orig_resolve
        _fetch_mod.is_allowed = orig_allow
        _fetch_mod._HAS_PROXY = orig_proxy
        srv.shutdown()


def test_pinned_connect_preserves_host_header():
    # 用假域名指向本地服务，模拟「域名解析到某 IP 后钉死连接」；
    # 验证请求仍带原始域名的 Host 头（SNI/虚拟主机需要）。
    _start_local("internal.example.test")


if __name__ == "__main__":
    test_is_allowed_blocks_internal()
    test_is_allowed_allows_public()
    test_strip_share_removes_sharecode_and_hs()
    test_resolve_pin_denies_loopback()
    test_pinned_connect_preserves_host_header()
    print("ALL PROXY SECURITY TESTS PASSED")
