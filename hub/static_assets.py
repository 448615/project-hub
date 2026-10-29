"""static_assets — 静态资源性能层：gzip 压缩缓存 + 前端脚本合并包

两个决定都刻意「不做构建步骤」：

1) gzip 结果按 (路径, mtime, size) 缓存。
   静态 JS/CSS 每次请求都现压一遍的话，CPU 成本反而超过传输收益；缓存后同一版本
   只压一次，之后走内存直接发。

2) 前端仍然是一堆裸 <script>，服务端在请求 /static/js/bundle.js 时按
   static/js/bundle.order 的顺序把它们拼成一个响应。
   为什么不引入 Vite/esbuild：本项目没有构建链，一旦加进来就会反复出现
   「改了源码忘了构建，线上还是旧逻辑」的事故。服务端按 mtime 拼接既省了 31 个
   请求，又保持「改完刷新即生效」的开发手感。

本模块不 import 任何 hub 内部模块，subapps.py 也能安全复用。
"""
from __future__ import annotations

import gzip
import hashlib
import os
import threading

# 值得压缩的类型（文本类；图片/音频已经压过，再压只浪费 CPU）
COMPRESSIBLE_EXTS = {
    ".js", ".mjs", ".css", ".html", ".htm", ".svg", ".json", ".txt",
    ".xml", ".map", ".md", ".ico",
}
# 小于这个体积压了不划算（gzip 头就有 18 字节，且会打断 TCP 小包合并）
MIN_GZIP_BYTES = 1024
# 缓存上限，超了就整体清空（静态资源版本有限，清空代价可控）
_MAX_CACHE_ENTRIES = 512

BUNDLE_URL = "/static/js/bundle.js"
ORDER_REL = "js/bundle.order"
BUNDLE_SEP = b"\n;\n"   # 文件之间插一个空语句，规避「上文没分号」引发的 ASI 粘连

_LOCK = threading.Lock()
_GZIP_CACHE: dict[str, bytes] = {}
_BUNDLE_CACHE: dict[tuple, tuple[bytes, str]] = {}


def is_compressible(path_or_mime: str) -> bool:
    """按扩展名或 MIME 判断是否值得 gzip。"""
    s = (path_or_mime or "").lower()
    if "/" in s:   # 传进来的是 MIME
        if s.startswith("text/"):
            return True
        base = s.split(";", 1)[0].strip()
        return base in ("application/javascript", "application/json", "application/xml",
                        "image/svg+xml", "application/manifest+json")
    return os.path.splitext(s)[1] in COMPRESSIBLE_EXTS


def gzip_bytes(key: str, data: bytes) -> bytes:
    """压缩并缓存。key 需包含内容版本（mtime/size），内容一变 key 就变。"""
    with _LOCK:
        hit = _GZIP_CACHE.get(key)
    if hit is not None:
        return hit
    # mtime=0：不把时间戳写进 gzip 头，保证同内容产出同字节（利于排查与缓存比对）
    out = gzip.compress(data, compresslevel=6, mtime=0)
    with _LOCK:
        if len(_GZIP_CACHE) >= _MAX_CACHE_ENTRIES:
            _GZIP_CACHE.clear()
        _GZIP_CACHE[key] = out
    return out


def _read_order(static_root: str) -> list[str]:
    """读取合并顺序清单（相对 static/ 的路径，每行一个，# 开头为注释）。"""
    p = os.path.join(static_root, ORDER_REL)
    with open(p, "r", encoding="utf-8") as f:
        out = []
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            out.append(s.lstrip("/"))
    return out


def bundle_bytes(static_root: str) -> tuple[bytes, str]:
    """返回 (合并后的 JS 字节, 版本指纹)。

    版本指纹由每个源文件的 (路径, size, mtime_ns) 组成，任一文件改动都会让缓存
    与 ETag 一起失效——不存在"改了没生效"的中间态。
    """
    rels = _read_order(static_root)
    stamp_parts = []
    sizes = []
    # 清单文件自身的 mtime 也进指纹：改了顺序但文件内容没动时，缓存也必须失效
    try:
        _ost = os.stat(os.path.join(static_root, ORDER_REL))
        stamp_parts.append(f"{ORDER_REL}:{_ost.st_mtime_ns:x}")
    except OSError:
        pass
    for rel in rels:
        full = os.path.join(static_root, rel.replace("/", os.sep))
        try:
            st = os.stat(full)
        except OSError:
            # 清单里点了名却不存在：跳过而不是整包失败，避免一个笔误让首页白屏
            continue
        stamp_parts.append(f"{rel}:{st.st_size:x}:{st.st_mtime_ns:x}")
        sizes.append((full, rel))
    stamp = "|".join(stamp_parts)
    key = (stamp,)
    with _LOCK:
        hit = _BUNDLE_CACHE.get(key)
    if hit is not None:
        return hit

    chunks: list[bytes] = [b"/* Project Hub bundle: "
                           + stamp.encode("utf-8", "replace")
                           + b" */\n"]
    for full, rel in sizes:
        try:
            with open(full, "rb") as f:
                src = f.read()
        except OSError:
            continue
        if src.startswith(b"\xef\xbb\xbf"):     # 去掉 UTF-8 BOM，避免拼在中间变乱码
            src = src[3:]
        chunks.append(b"/* ---- " + rel.encode("utf-8", "replace") + b" ---- */\n")
        chunks.append(src)
        chunks.append(BUNDLE_SEP)
    data = b"".join(chunks)
    # 指纹用内容摘要（不能用内置 hash：它带进程随机种子，重启就变，浏览器白丢缓存）
    ver = "%x-%s" % (len(data), hashlib.sha256(data).hexdigest()[:16])
    result = (data, ver)
    with _LOCK:
        if len(_BUNDLE_CACHE) >= 8:
            _BUNDLE_CACHE.clear()
        _BUNDLE_CACHE[key] = result
    return result


def check_order(static_root: str) -> list[str]:
    """自检：清单与实际文件是否对得上。

    服务端合并最容易踩两个坑，症状都是「新代码静默不生效」：
      - 新增了 static/js/*.js，忘了加进 bundle.order；
      - 清单里写了路径，但文件其实不在那儿（拼错/挪了位置）。
    启动时各打一条告警，比事后排查便宜得多。
    """
    try:
        listed = [p.replace("\\", "/") for p in _read_order(static_root)]
    except OSError:
        return []
    problems = []
    # 清单里点了名却找不到文件
    for rel in listed:
        if not os.path.isfile(os.path.join(static_root, rel.replace("/", os.sep))):
            problems.append(rel + "（清单里有，文件不存在）")
    js_dir = os.path.join(static_root, "js")
    try:
        for fn in sorted(os.listdir(js_dir)):
            if fn.endswith(".js") and ("js/" + fn) not in listed:
                problems.append("js/" + fn + "（文件存在，清单里没有）")
    except OSError:
        pass
    return problems
