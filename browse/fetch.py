# -*- coding: utf-8 -*-
"""browse.fetch — 上游抓取（手动跟随重定向，顺便收集 Set-Cookie）

DNS 重绑定（TOCTOU）防护：先解析并校验一次，连接时把套接字钉死到该 IP，
但保持 self.host 为原始域名（SNI / Host 头按原始域名，TLS 证书才能对上）。
这样「校验时返回公网 IP、连接时翻转为 169.254.169.254 / 127.0.0.1」的攻击失效。
"""
from __future__ import annotations

import gzip
import http.client
import ipaddress
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import zlib

from .state import MAX_ASSET, MAX_REDIRECTS, TIMEOUT, UA, _HAS_PROXY, _cookies, logger
from .urlsafe import is_allowed
from .state import note as _note


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """关闭 urllib 的自动重定向，改为自己跟，才能逐跳收集 Cookie。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        pin_ip = getattr(self, "_pin_ip", None)
        pin_port = getattr(self, "_pin_port", None)
        if pin_ip and not _HAS_PROXY:
            # 无代理：钉死到解析出的公网 IP 直连（SNI 用原始域名 self.host）
            self.sock = socket.create_connection(
                (pin_ip, pin_port or self.port), timeout=self.timeout)
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        else:
            # 有代理：交给基类走代理隧道（SNI 由隧道目标域名决定，证书才对得上）
            super().connect()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def connect(self):
        pin_ip = getattr(self, "_pin_ip", None)
        pin_port = getattr(self, "_pin_port", None)
        if pin_ip and not _HAS_PROXY:
            sock = socket.create_connection(
                (pin_ip, pin_port or self.port), timeout=self.timeout)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # server_hostname 用原始域名（self.host），SNI 才正确
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        else:
            # 有代理：交给基类走代理隧道，SNI 按目标域名设置，避免证书主机名不匹配
            super().connect()


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        def factory(host, **kw):
            c = _PinnedHTTPConnection(host, **kw)
            # 有代理时不钉 IP（交给代理），否则钉死本次解析出的公网 IP
            c._pin_ip = None if _HAS_PROXY else getattr(req, "_pin_ip", None)
            c._pin_port = None if _HAS_PROXY else getattr(req, "_pin_port", None)
            return c
        return self.do_open(factory, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        def factory(host, **kw):
            c = _PinnedHTTPSConnection(host, context=self._context, **kw)
            c._pin_ip = None if _HAS_PROXY else getattr(req, "_pin_ip", None)
            c._pin_port = None if _HAS_PROXY else getattr(req, "_pin_port", None)
            return c
        return self.do_open(factory, req)


_OPENER = urllib.request.build_opener(
    _NoRedirect, _PinnedHTTPHandler, _PinnedHTTPSHandler)


def _resolve_pin(url: str) -> tuple[str, int]:
    """解析一次并校验，返回 ``(公网 IP, 端口)``。

    调用方必须把此 IP 钉死到连接上，防止连接时 DNS 被翻成内网地址
    （DNS 重绑定 / TOCTOU）。校验逻辑复用 ``is_allowed``。
    """
    p = urllib.parse.urlsplit(url)
    host = (p.hostname or "").strip().lower().rstrip(".")
    port = p.port or (443 if p.scheme.lower() == "https" else 80)
    ok, reason = is_allowed(url)
    if not ok:
        raise ValueError("目标地址被拒绝：" + reason)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception as e:  # noqa: BLE001
        raise ValueError("域名解析失败：" + str(e))
    for info in infos:
        ip_txt = info[4][0].split("%")[0]
        try:
            ip = ipaddress.ip_address(ip_txt)
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            continue
        return str(ip), port
    raise ValueError("无可用的公网地址（仅解析到内网/保留地址）")


def _jar_for(url: str) -> dict:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return dict(_cookies().get(host) or {})


def _store_cookies(url: str, headers) -> None:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    if not host:
        return
    raw_list = []
    try:
        raw_list = headers.get_all("Set-Cookie") or []
    except Exception as exc:  # noqa: BLE001
        _note("browse/fetch.py::_store_cookies", exc)
    if not raw_list:
        return
    jar = _cookies().setdefault(host, {})
    if len(_cookies()) > 400 and host not in _cookies():   # 简单上限，防内存膨胀
        for k in list(_cookies())[:100]:
            _cookies().pop(k, None)
    for sc in raw_list:
        first = sc.split(";", 1)[0]
        if "=" not in first:
            continue
        name, val = first.split("=", 1)
        name, val = name.strip(), val.strip()
        if not name:
            continue
        if val == "" or re.search(r"max-age\s*=\s*0\b", sc, re.I):
            jar.pop(name, None)
        else:
            jar[name] = val
        if len(jar) > 80:
            jar.pop(next(iter(jar)), None)


def _decode_body(data: bytes, headers) -> bytes:
    enc = (headers.get("Content-Encoding") or "").strip().lower()
    try:
        if enc == "gzip":
            return gzip.decompress(data)
        if enc == "deflate":
            return zlib.decompress(data, -zlib.MAX_WBITS)
    except Exception:  # noqa: BLE001
        return data
    return data


def fetch(url: str, method: str = "GET", referer: str = "",
          accept: str = "", limit: int = MAX_ASSET, body: bytes | None = None,
          extra_headers: dict | None = None):
    """抓取上游资源，返回 (状态码, 响应头, 响应体, 最终网址)。"""
    cur = url
    for _ in range(MAX_REDIRECTS + 1):
        # 解析并钉死 IP（防 DNS 重绑定）：校验通过后才连接，连接用的是刚解析出的
        # 公网 IP，连接时 DNS 即使被翻成内网也影响不到本次请求。
        try:
            pin_ip, pin_port = _resolve_pin(cur)
        except ValueError as e:
            logger.warning("代理目标解析/校验失败：%s -> %s", cur, e)
            return 403, {}, ("目标不可访问：" + str(e)).encode("utf-8"), cur
        req = urllib.request.Request(cur, data=body, method=method)
        req._pin_ip = pin_ip
        req._pin_port = pin_port
        req.add_header("User-Agent", UA)
        req.add_header(
            "Accept",
            accept or ("text/html,application/xhtml+xml,application/xml;q=0.9,"
                       "image/avif,image/webp,image/apng,*/*;q=0.8"))
        req.add_header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        req.add_header("Accept-Encoding", "identity")
        if referer:
            req.add_header("Referer", referer)
        # 代理页的 AJAX：原样带上站点的 Content-Type / Accept，否则接口会 415/400
        for hk, hv in (extra_headers or {}).items():
            if hv:
                try:
                    req.add_header(hk, hv)
                except Exception as e:  # noqa: BLE001
                    logger.debug("跳过无法添加的代理请求头 %s: %s", hk, e)
        jar = _jar_for(cur)
        if jar:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in jar.items()))
        resp = None
        try:
            resp = _OPENER.open(req, timeout=TIMEOUT)
        except urllib.error.HTTPError as e:
            resp = e                          # 3xx / 4xx / 5xx 也带 headers
        except urllib.error.URLError as e:
            raise RuntimeError(str(getattr(e, "reason", e))[:120]) from e
        except socket.timeout as e:
            raise RuntimeError("请求超时") from e

        status = int(getattr(resp, "status", None) or getattr(resp, "code", 0) or 0)
        headers = resp.headers
        _store_cookies(cur, headers)

        if status in (301, 302, 303, 307, 308):
            loc = (headers.get("Location") or "").strip()
            try:
                resp.close()
            except Exception as exc:  # noqa: BLE001
                _note("browse/fetch.py::fetch", exc)
            if not loc:
                return status, headers, b"", cur
            nxt = urllib.parse.urljoin(cur, loc)
            ok, _reason = is_allowed(nxt)
            if not ok:                        # 重定向到内网也一并拦下
                return 403, headers, b"", nxt
            cur = nxt
            if status == 303:
                method = "GET"
                body = None                   # 303 语义是 GET，不应再带请求体
            continue

        try:
            data = resp.read(limit)
        finally:
            try:
                resp.close()
            except Exception as exc:  # noqa: BLE001
                _note("browse/fetch.py::fetch", exc)
        return status, headers, _decode_body(data, headers), cur
    return 508, {}, b"", cur
