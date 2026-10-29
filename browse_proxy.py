# -*- coding: utf-8 -*-
"""内置浏览器 · 站点反向代理内核（零依赖，仅标准库）
=====================================================

为什么需要它
------------
浏览器里的 <iframe> 想直接嵌入外部网站，会被目标站点的
``X-Frame-Options`` / ``Content-Security-Policy: frame-ancestors`` 拒绝
（limestart.cn、Bing、必应结果页、百度结果页、绝大多数新闻站都这样）。
表现为「主页能开，点任何链接就空白 / 拒绝连接」——这不是前端写错，
而是浏览器强制执行的嵌入策略，前端无解。

方案
----
由枢纽服务端把目标页面取回来，改写其中的链接后再输出给 <iframe>，
于是 iframe 始终只加载「本站同源」的资源，嵌入限制不再生效。

两种打开模式（由 /api/browse/check 预检决定）：
  * 直连模式：站点允许被嵌入（无 XFO / 允许 * ）→ iframe 直接加载真实网址，
    速度最快、站点功能 100% 完整。
  * 代理模式：站点禁止被嵌入 → 走本模块的 /browse/<真实网址>，保证能看、能点。

URL 形态（关键）
----------------
    /browse/https://www.example.com/a/b.html?x=1
以「路径式」承载目标网址，而不是 ``?u=`` 查询参数，原因是相对链接：
站点里 ``./c.js`` 会按当前路径解析成 ``/browse/https://.../a/c.js``，
天然落回本代理；换成查询参数形态就会解析成 ``/c.js`` 直接 404。

安全边界（本模块对外只做「取网页」，但取哪里必须受限）
  * 只允许 http / https，只允许 80 / 443 / 8080 / 8443 端口；
  * 拒绝 localhost、.local/.internal、以及解析到内网/环回/保留地址的域名
    （防 SSRF：不能被用来探内网、打云元数据接口 169.254.169.254）；
  * 拒绝把枢纽自己再代理一遍（防自环）；
  * 上游响应体设大小上限，避免被超大文件撑爆内存。

拆分说明（2026-10-27）
----------------------
本文件原为 837 行单文件，现按职责拆到 ``browse/`` 包（state / urlsafe / fetch /
encoding / shim / rewrite / embed）。为避免改动调用方与测试，这里保留原模块名与
全部原有符号（含下划线开头的内部符号），仅做 re-export。**改代码请改 browse/ 下的模块。**
"""
from __future__ import annotations

from browse import (  # noqa: F401
    # 常量与进程级状态
    MAX_ASSET, MAX_HTML, MAX_REDIRECTS, PROXY_PREFIX, SHIM_JS, TIMEOUT, UA,
    _CHECK_CACHE, _CHECK_TTL, _CTX, _HAS_PROXY, _cookies, logger,
    # URL 形态与安全校验
    _HS_PARAM, _SHARE_PARAM, _attr_escape, _share_suffix, _strip_share,
    ctx_key, ctx_share, is_allowed, key_of, origin_of, proxy_url,
    set_key, set_share, target_of,
    # 抓取
    _OPENER, _NoRedirect, _PinnedHTTPConnection, _PinnedHTTPSConnection,
    _PinnedHTTPHandler, _PinnedHTTPSHandler, _decode_body, _jar_for,
    _resolve_pin, _store_cookies, fetch,
    # 编码 / 改写 / 嵌入预检
    _inject_shim, _proxify, _rewrite_srcset, decode_text,
    rewrite_css, rewrite_html, rewrite_js, embeddable,
)

# 兼容旧名：注入脚本原叫 _SHIM，现改名 SHIM_JS
_SHIM = SHIM_JS
