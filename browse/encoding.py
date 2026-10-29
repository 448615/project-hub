# -*- coding: utf-8 -*-
"""browse.encoding — 上游响应的字符编码识别（兼容 GBK 老站）"""
from __future__ import annotations

import re

_CHARSET_HDR = re.compile(r"charset\s*=\s*[\"']?([\w\-]+)", re.I)
_CHARSET_META = re.compile(rb"<meta[^>]+charset\s*=\s*[\"']?([\w\-]+)", re.I)


def decode_text(data: bytes, content_type: str = "") -> str:
    """按 响应头 → <meta charset> → utf-8 的顺序解码，兼容 GBK 老站。"""
    candidates = []
    m = _CHARSET_HDR.search(content_type or "")
    if m:
        candidates.append(m.group(1))
    m2 = _CHARSET_META.search(data[:4096] or b"")
    if m2:
        candidates.append(m2.group(1).decode("ascii", "ignore"))
    candidates += ["utf-8", "gb18030"]
    for enc in candidates:
        e = (enc or "").strip().lower()
        if not e or e in ("gb2312", "gbk"):
            e = "gb18030"
        try:
            return data.decode(e)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", "replace")
