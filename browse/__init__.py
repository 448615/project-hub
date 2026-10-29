# -*- coding: utf-8 -*-
"""browse — 内置浏览器 · 站点反向代理内核（由原单文件 browse_proxy.py 拆分）

模块划分（自上而下单向依赖，无环）：

    state.py     进程级状态与常量：thread-local 上下文、Cookie 罐、预检缓存
    urlsafe.py   URL 形态转换 + 分享码拼接剥离 + 出站白名单校验（防 SSRF）
    fetch.py     上游抓取：手动跟随重定向、收集 Set-Cookie、钉 IP 抗 DNS 重绑定
    encoding.py  字符编码识别（兼容 GBK 老站）
    shim.py      注入到代理页里的那段脚本（原 _SHIM）
    rewrite.py   HTML / CSS / JS 里的链接改写
    embed.py     嵌入预检：决定直连还是走代理

对外入口仍是 ``browse_proxy.py``（薄壳 re-export），保持 ``import browse_proxy as BP``
以及 ``BP.xxx`` 的全部调用不变。改代码时请改这里，不要改薄壳。
"""
from __future__ import annotations

from .state import (
    MAX_ASSET,
    MAX_HTML,
    MAX_REDIRECTS,
    PROXY_PREFIX,
    TIMEOUT,
    UA,
    _CHECK_CACHE,
    _CHECK_TTL,
    _CTX,
    _HAS_PROXY,
    _cookies,
    logger,
)
from .urlsafe import (
    _HS_PARAM,
    _SHARE_PARAM,
    _attr_escape,
    _share_suffix,
    _strip_share,
    ctx_key,
    ctx_share,
    is_allowed,
    key_of,
    origin_of,
    proxy_url,
    set_key,
    set_share,
    target_of,
)
from .fetch import (
    _OPENER,
    _NoRedirect,
    _PinnedHTTPConnection,
    _PinnedHTTPSConnection,
    _PinnedHTTPHandler,
    _PinnedHTTPSHandler,
    _decode_body,
    _jar_for,
    _resolve_pin,
    _store_cookies,
    fetch,
)
from .encoding import decode_text
from .shim import SHIM_JS
from .rewrite import (
    _inject_shim,
    _proxify,
    _rewrite_srcset,
    rewrite_css,
    rewrite_html,
    rewrite_js,
)
from .embed import embeddable

__all__ = [
    # 常量与状态
    "PROXY_PREFIX", "UA", "TIMEOUT", "MAX_HTML", "MAX_ASSET", "MAX_REDIRECTS",
    "logger", "_CTX", "_cookies", "_CHECK_CACHE", "_CHECK_TTL", "_HAS_PROXY",
    # URL 与安全
    "set_key", "ctx_key", "set_share", "ctx_share",
    "_SHARE_PARAM", "_HS_PARAM", "_share_suffix", "_strip_share",
    "proxy_url", "target_of", "key_of", "origin_of", "is_allowed",
    "_attr_escape",
    # 抓取
    "fetch", "_resolve_pin", "_jar_for", "_store_cookies", "_decode_body",
    "_OPENER", "_NoRedirect", "_PinnedHTTPConnection", "_PinnedHTTPSConnection",
    "_PinnedHTTPHandler", "_PinnedHTTPSHandler",
    # 编码 / 改写 / 预检
    "decode_text", "SHIM_JS", "_inject_shim", "_proxify", "_rewrite_srcset",
    "rewrite_css", "rewrite_js", "rewrite_html", "embeddable",
]
