"""search_index — 全局文件名索引（内存缓存）

原先 /api/search 每次都 os.walk 整棵项目树。项目一多、workbench/www 里存着音乐和
图片，单次查询就要几百毫秒；而前端是"边输边搜"的交互，等于每敲一个字全盘扫一遍。

这里把「项目 → 文件相对路径」摊平成一份清单放进内存（TTL 90s），查询只在内存里做
子串匹配。写操作（新建/上传/删除/还原）会调用 invalidate() 主动失效，保证刚建的
文件马上能搜到，不会出现「明明有这个文件却搜不出来」的怪现象。
"""
from __future__ import annotations

import os
import threading
import time

# 跳过依赖/缓存/版本控制/构建产物：既避免结果被淹没，也避免索引被超大目录撑爆
SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv",
    ".idea", ".vscode", ".husky", ".next", ".nuxt", "dist",
    "build", "target", "__pycache__", ".mypy_cache", ".pytest_cache",
    "static", ".hub-trash", "cursors",
}

TTL = 90.0           # 索引有效期：到期后下一次查询重建
MAX_ENTRIES = 300_000  # 索引硬上限，防极端目录把内存吃光

_LOCK = threading.Lock()
_STATE = {"root": None, "ts": 0.0, "items": []}


def _build(root: str) -> list[tuple]:
    """扫描一遍，产出 (项目名, 相对路径, 文件名, 小写文件名)。"""
    items: list[tuple] = []
    try:
        names = os.listdir(root)
    except OSError:
        return items
    for name in names:
        pdir = os.path.join(root, name)
        if name.startswith(".") or name in SKIP_DIRS or not os.path.isdir(pdir):
            continue
        for dirpath, dirnames, filenames in os.walk(pdir):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), pdir).replace("\\", "/")
                items.append((name, rel, fn, fn.lower()))
                if len(items) >= MAX_ENTRIES:
                    return items
    return items


def _items(root: str) -> list[tuple]:
    now = time.time()
    with _LOCK:
        if _STATE["root"] == root and _STATE["items"] and now - _STATE["ts"] < TTL:
            return _STATE["items"]
    items = _build(root)     # 扫描放在锁外：重建期间旧索引仍可被读，互不阻塞
    with _LOCK:
        _STATE.update({"root": root, "ts": time.time(), "items": items})
    return items


def invalidate() -> None:
    """内容变更后调用，让下一次查询重建索引。"""
    with _LOCK:
        _STATE["items"] = []
        _STATE["ts"] = 0.0


def search(root: str, q: str, limit: int = 60) -> list[dict]:
    """按文件名子串匹配（不区分大小写），语义与原先的 os.walk 版本一致。"""
    q = (q or "").strip().lower()
    if not q:
        return []
    out: list[dict] = []
    for project, rel, name, low in _items(root):
        if q in low:
            out.append({"project": project, "path": rel, "name": name})
            if len(out) >= limit:
                break
    return out
