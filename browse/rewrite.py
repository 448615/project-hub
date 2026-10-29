# -*- coding: utf-8 -*-
"""browse.rewrite — 把上游页面里的链接改写成代理地址

HTML 属性 / 内联 style / <style> 块 / CSS 里的 url() 与 @import / 站点脚本里的
绝对网址跳转，全部改回本代理，这样 iframe 始终只加载同源资源，嵌入限制不再生效。
"""
from __future__ import annotations

import json
import re
import urllib.parse

from .shim import SHIM_JS
from .urlsafe import ctx_key, ctx_share, proxy_url


_SKIP_SCHEMES = ("#", "data:", "blob:", "javascript:", "mailto:", "tel:", "sms:",
                 "about:", "file:", "chrome-extension:", "moz-extension:",
                 "intent:", "market:")

_META_CSP = re.compile(
    r"<meta\b[^>]*http-equiv\s*=\s*[\"']?content-security-policy[\"']?[^>]*>", re.I)
_BASE_TAG = re.compile(r"<base\b[^>]*>", re.I)
# 完整性校验（SRI）在经过代理后必然不符，会让脚本被丢弃；crossorigin 同理
_SRI = re.compile(
    r"\s(?:integrity|crossorigin)(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+))?", re.I)
_ATTR = re.compile(
    r"(\s)(href|src|action|formaction|poster|data-src|data-original|srcset)"
    r"(\s*=\s*)(\"[^\"]*\"|'[^']*')", re.I)
_STYLE_ATTR = re.compile(r"(\sstyle\s*=\s*)(\"[^\"]*\"|'[^']*')", re.I)
_STYLE_TAG = re.compile(r"(<style\b[^>]*>)([\s\S]*?)(</style>)", re.I)
_CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.I)
_CSS_IMPORT = re.compile(r"@import\s+(['\"])([^'\"]+)\1", re.I)

def _proxify(val: str, base: str) -> str:
    """把单个 URL 转成代理地址；无法转换的（data:、#锚点等）原样返回。"""
    v = (val or "").strip()
    if not v:
        return val
    low = v.lower()
    if low.startswith(_SKIP_SCHEMES):
        return val
    if v.startswith("//"):
        v = ("https:" if base.lower().startswith("https://") else "http:") + v
    absu = urllib.parse.urljoin(base, v)
    if not re.match(r"^https?://", absu, re.I):
        return val
    return proxy_url(absu)


def _rewrite_srcset(raw: str, base: str) -> str:
    out = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        seg = p.split()
        seg[0] = _proxify(seg[0], base)
        out.append(" ".join(seg))
    return ", ".join(out)


def rewrite_css(css: str, base: str) -> str:
    css = _CSS_URL.sub(lambda m: "url(" + _proxify(m.group(2), base) + ")", css)
    css = _CSS_IMPORT.sub(
        lambda m: "@import url(" + _proxify(m.group(2), base) + ")", css)
    return css


# 站点脚本里的「跳转到绝对网址」会被浏览器当成离开代理（随后撞上站点的
# 反嵌入策略，整页变成 🚫）。这里把字面量绝对网址的赋值/调用改成走父窗口导航，
# 永远留在代理里。只匹配 `http(s)://字面量`，相对路径与表达式一律不动，
# 最大限度避免误伤站点自身的路由逻辑。
_LIT = r"(`https?://[^`]*`|\"https?://[^\"]*\"|'https?://[^']*')"
_JS_NAV_ASSIGN = re.compile(r"location\.href\s*=\s*" + _LIT)
_JS_NAV_CALL = re.compile(r"location\.(?:replace|assign)\(\s*" + _LIT + r"\s*\)")


def rewrite_js(js: str) -> str:
    # window.location.href="…" → window.__hubGo("…")；location.href="…" → __hubGo("…")
    js = _JS_NAV_CALL.sub(lambda m: "__hubGo(" + m.group(1) + ")", js)
    js = _JS_NAV_ASSIGN.sub(lambda m: "__hubGo(" + m.group(1) + ")", js)
    return js

def _inject_shim(html: str, base: str) -> str:
    cur = json.dumps(base, ensure_ascii=False).replace("</", "<\\/")
    js = (SHIM_JS.replace("__CUR__", cur)
                .replace("__KEY__", json.dumps(ctx_key()))
                .replace("__SHARE__", json.dumps(ctx_share())))
    tag = "<script data-hub-browse='1'>" + js + "</script>"
    m = re.search(r"<head\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + tag + html[m.end():]
    m = re.search(r"<html\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + tag + html[m.end():]
    return tag + html


def rewrite_html(html: str, base: str) -> str:
    """改写 HTML 里的全部外链，使 iframe 内所有请求都回到本代理。"""
    html = _META_CSP.sub("", html)   # 站点自带 CSP 会拦掉我们的注入脚本，去掉
    html = _BASE_TAG.sub("", html)   # <base> 会把相对链接指向别处，去掉
    html = _SRI.sub("", html)

    def _attr_sub(m):
        space, name, eq, val = m.group(1), m.group(2), m.group(3), m.group(4)
        quote, raw = val[0], val[1:-1]
        low = name.lower()
        if low == "srcset":
            raw = _rewrite_srcset(raw, base)
        elif low in ("href", "src", "action", "formaction", "poster",
                     "data-src", "data-original"):
            raw = _proxify(raw, base)
        return f"{space}{name}{eq}{quote}{raw}{quote}"

    html = _ATTR.sub(_attr_sub, html)
    html = _STYLE_ATTR.sub(
        lambda m: m.group(1) + '"' + rewrite_css(m.group(2)[1:-1], base) + '"', html)
    html = _STYLE_TAG.sub(
        lambda m: m.group(1) + rewrite_css(m.group(2), base) + m.group(3), html)
    return _inject_shim(html, base)
