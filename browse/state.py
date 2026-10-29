# -*- coding: utf-8 -*-
"""browse.state — 进程级状态与常量

为什么单独一层：thread-local 上下文、Cookie 罐、预检缓存都是**跨模块共享的可变状态**，
集中在这里，其余模块只 import 本模块，不会互相引用而形成环。
"""
from __future__ import annotations

import logging
import threading
import urllib.request

logger = logging.getLogger("browse_proxy")

PROXY_PREFIX = "/browse/"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

TIMEOUT = 20                     # 单次上游请求超时（秒）
MAX_HTML = 6 * 1024 * 1024       # HTML 上限
MAX_ASSET = 20 * 1024 * 1024     # 静态资源上限
MAX_REDIRECTS = 6
# 端口不再设白名单：普通公网站点用什么端口都放行，SSRF 防护由下面的「IP 段校验」
# （私网 / 回环 / 链路本地 / 保留地址）承担。端口本身不构成 SSRF 风险，限端口只会影响
# 正常访问（很多站点用非标端口），故放开。

# 代理页会被降级成「不透明源」（iframe sandbox 不授予 allow-same-origin），
# 因此它发出的子请求不再携带 hub_sess Cookie —— 鉴权改由 URL 里的临时密钥完成。
# 密钥由枢纽的 /api/browse/key 下发给已登录用户，只对 /browse/* 生效，
# 拿它打不了 /api/*（那些接口只认 Cookie 会话）。用 thread-local 传递，
# 避免多线程并发请求互相串号。同一条 thread-local 也存 Cookie 罐与分享码。
_CTX = threading.local()


# 进程内 Cookie 罐：host -> {name: value}
# 代理页与目标站点之间的会话（登录态、地区偏好）靠它维持；
# 不写进浏览器 Cookie，避免和枢纽自身的 hub_sess 混淆。
# 注意：必须按线程隔离（threading.local），否则并发浏览时多个用户的
# 会话 Cookie 会串到彼此请求上（跨用户凭据泄露）。
def _cookies() -> dict:
    jar = getattr(_CTX, "cookies", None)
    if jar is None:
        jar = {}
        _CTX.cookies = jar
    return jar


# 预检结果缓存：host -> (时间戳, 结果 dict)，10 分钟内不重复探测
_CHECK_CACHE: dict[str, tuple[float, dict]] = {}
_CHECK_TTL = 600.0

# 是否处于「需要走代理出网」的环境（沙箱 / 企业网常注入 HTTPS_PROXY）。
# 有代理时，DNS 解析与 TLS 隧道由代理负责，本模块**不再钉死 IP**：
#   1) 钉死 IP 会绕过代理直连，若沙箱要求经代理出网则整页打不开；
#   2) 直连时 self.host 变成代理主机，SNI 取到的是代理域名 → 证书主机名不匹配，
#      表现为「代理模式被禁用 / 浏览器空白」。
# 只有在「无代理、直连出网」（多数云端）时才钉死解析出的公网 IP，防 DNS 重绑定（TOCTOU）。
_HAS_PROXY = bool(urllib.request.getproxies())


def note(where: str, exc) -> None:
    """记录一处「被有意吞掉」的异常（代理内核专用）。

    代理链路里大量 try/except 是刻意降级（存 Cookie 失败、取不到证书信息……），
    行为不能变，但出了问题必须留痕。这里用 logging 而不是 print：
    默认级别下几乎无开销，需要排查时调 ``logging.getLogger("browse_proxy")`` 即可。
    """
    try:
        logger.info("[%s] %s: %s", where, type(exc).__name__, exc)
    except Exception:  # noqa: BLE001  日志失败绝不能影响代理主流程
        pass
