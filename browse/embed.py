# -*- coding: utf-8 -*-
"""browse.embed — 嵌入预检：探测目标站点是否允许被 <iframe> 直接嵌入

只看两个权威信号：X-Frame-Options 与 CSP frame-ancestors。
允许 → 直连（速度快、功能完整）；禁止 → 走本代理（保证能看、能点）。
"""
from __future__ import annotations

import re
import time
import urllib.parse

from .fetch import fetch
from .state import _CHECK_CACHE, _CHECK_TTL
from .urlsafe import is_allowed

def embeddable(url: str, self_hosts=()) -> dict:
    """探测目标站点是否允许被 <iframe> 直接嵌入。

    只看两个权威信号：X-Frame-Options 与 CSP frame-ancestors。
    返回 {"ok":bool, "embeddable":bool, "reason":str, "final":str}
    """
    ok, reason = is_allowed(url, self_hosts)
    if not ok:
        return {"ok": False, "embeddable": False, "reason": reason, "final": url}

    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    now = time.time()
    hit = _CHECK_CACHE.get(host)
    if hit and now - hit[0] < _CHECK_TTL:
        cached = dict(hit[1])
        cached["cached"] = True
        return cached

    try:
        status, headers, data, final = fetch(url, method="GET", limit=4096)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "embeddable": False,
                "reason": "无法访问该网址：" + str(e)[:80], "final": url}

    xfo = (headers.get("X-Frame-Options") or "").strip().lower()
    csp = headers.get("Content-Security-Policy") or ""
    fa = ""
    m = re.search(r"frame-ancestors([^;]*)", csp, re.I)
    if m:
        fa = m.group(1).strip().lower()

    reason = ""
    if xfo:
        if "deny" in xfo:
            reason = "站点禁止被嵌入（X-Frame-Options: DENY）"
        elif "sameorigin" in xfo:
            reason = "站点只允许同源嵌入（X-Frame-Options: SAMEORIGIN）"
        else:
            reason = "站点限制了嵌入来源（X-Frame-Options）"
    elif fa:
        toks = fa.split()
        if not ("*" in toks or "http:" in toks or "https:" in toks):
            reason = "站点的 frame-ancestors 不允许本站嵌入"

    res = {"ok": True, "embeddable": not bool(reason), "reason": reason,
           "status": status, "final": final or url}
    _CHECK_CACHE[host] = (now, dict(res))
    if len(_CHECK_CACHE) > 500:
        for k in list(_CHECK_CACHE)[:100]:
            _CHECK_CACHE.pop(k, None)
    return res
