# -*- coding: utf-8 -*-
"""browse.urlsafe — URL 形态与出站安全校验

负责三件事：代理地址 ↔ 真实网址的相互转换、分享码（sharecode/_hs）的拼接与剥离、
以及防 SSRF 的目的地白名单（私网 / 回环 / 链路本地 / 保留地址一律拒绝）。
"""
from __future__ import annotations

import ipaddress
import re
import socket
import urllib.parse

from .state import PROXY_PREFIX, _CTX
from .state import note as _note

_ATTR_ESCAPE = {'"': "%22", "<": "%3C", ">": "%3E", " ": "%20",
                "`": "%60", "'": "%27"}


def _attr_escape(u: str) -> str:
    out = u
    for k, v in _ATTR_ESCAPE.items():
        out = out.replace(k, v)
    return out


def set_key(key: str) -> None:
    _CTX.key = str(key or "")


def ctx_key() -> str:
    return getattr(_CTX, "key", "") or ""


def set_share(code: str) -> None:
    """平台分享码（云端 phub 域名才有）。

    为什么必须带：云端平台层在网关做了分享码门禁，靠 __wb_rsc Cookie 放行。
    而沙箱 iframe 是不透明源，浏览器把它发出的子资源请求当第三方请求，
    第三方 Cookie 被拦时这些请求就一路 403「链接不完整」——页面只剩一层背景色。
    实测网关同样认 URL 上的 ?sharecode=，所以把它透传到每个子资源地址上。
    """
    _CTX.share = str(code or "")


def ctx_share() -> str:
    return getattr(_CTX, "share", "") or ""


_SHARE_PARAM = "sharecode"
# 云端网关放行后会**把自己认的 sharecode 参数从转发的请求里剔掉**
# （实测：上游 httpbingo 只收到 a=1，sharecode 不见了）。
# 所以给服务端自己留一份同值参数，网关不认它、也就不会动它。
_HS_PARAM = "_hs"


def _share_suffix(url: str = "") -> str:
    s = ctx_share()
    if not s:
        return ""
    sep = "&" if "?" in (url or "") else "?"
    return sep + _SHARE_PARAM + "=" + s + "&" + _HS_PARAM + "=" + s


def _strip_share(url: str) -> str:
    """把网关用的 sharecode（以及服务端自用的 _hs）从上游网址里摘掉，不能污染目标站点。"""
    if _SHARE_PARAM not in url and _HS_PARAM not in url:
        return url
    head, sep, query = url.partition("?")
    if not sep:
        return url
    keep = [
        p for p in query.split("&")
        if p and not p.startswith(_SHARE_PARAM + "=") and not p.startswith(_HS_PARAM + "=")
    ]
    return head + ("?" + "&".join(keep) if keep else "")


def proxy_url(url: str) -> str:
    """把真实网址转成代理地址（带上当前请求的代理密钥 + 平台分享码）。"""
    k = ctx_key()
    return PROXY_PREFIX + ((k + "/") if k else "") + _attr_escape(url) + _share_suffix(url)


def target_of(raw_path: str) -> str:
    """从请求路径还原上游网址。

    ``raw_path`` 传原始 self.path（含查询串），两种形态都支持：
    ``/browse/https://a.com/s?q=1``         → ``https://a.com/s?q=1``
    ``/browse/<key>/https://a.com/s?q=1``   → ``https://a.com/s?q=1``
    这里**不做 unquote**：目标网址里可能本来就带 %E4%B8%AD 这类编码，
    解码再拼回去会破坏原义（%2F 被当成路径分隔符）。
    """
    raw = raw_path or ""
    i = raw.find(PROXY_PREFIX)
    if i >= 0:
        raw = raw[i + len(PROXY_PREFIX):]
    raw = raw.strip()
    if re.match(r"^https?://", raw, re.I):
        return _strip_share(raw)
    # 形如 <key>/https://… —— 第一段没有 "://"，说明是密钥段
    j = raw.find("/")
    if j > 0:
        cand = raw[j + 1:].strip()
        if re.match(r"^https?://", cand, re.I):
            return _strip_share(cand)
    return ""


def key_of(raw_path: str) -> str:
    """取出请求路径里的代理密钥（没有密钥段的旧形态返回空串）。"""
    raw = raw_path or ""
    i = raw.find(PROXY_PREFIX)
    if i >= 0:
        raw = raw[i + len(PROXY_PREFIX):]
    raw = raw.strip()
    if re.match(r"^https?://", raw, re.I):
        return ""
    j = raw.find("/")
    if j <= 0:
        return ""
    return raw[:j] if re.match(r"^https?://", raw[j + 1:], re.I) else ""


def origin_of(url: str) -> str:
    try:
        p = urllib.parse.urlsplit(url)
        return f"{p.scheme}://{p.netloc}/"
    except Exception:  # noqa: BLE001
        return ""


def is_allowed(url: str, self_hosts=()) -> tuple[bool, str]:
    """出站白名单校验（防 SSRF）。返回 (是否允许, 拒绝原因)。"""
    try:
        p = urllib.parse.urlsplit(url)
    except Exception:  # noqa: BLE001
        return False, "网址格式不正确"
    if p.scheme.lower() not in ("http", "https"):
        return False, "只允许 http / https 协议"
    netloc = p.netloc or ""
    if "@" in netloc:                      # 形如 http://evil@127.0.0.1/ 的混淆写法
        return False, "网址中包含不允许的字符"
    host = (p.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False, "缺少域名"
    if host == "localhost" or host.endswith(".local") or host.endswith(".internal"):
        return False, "已拒绝访问本机 / 内网地址"
    try:
        if host in {str(h).lower() for h in (self_hosts or ())}:
            return False, "已拒绝访问枢纽自身"
    except Exception as exc:  # noqa: BLE001
        _note("browse/urlsafe.py::is_allowed", exc)
    try:
        port = p.port or (443 if p.scheme.lower() == "https" else 80)
    except ValueError:
        return False, "端口不合法"
    if not (1 <= port <= 65535):
        return False, f"端口 {port} 超出合法范围（1-65535）"
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except Exception:  # noqa: BLE001
        return False, "域名解析失败"
    for info in infos:
        ip_txt = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_txt.split("%")[0])
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False, "已拒绝访问本机 / 内网地址"
    return True, ""
