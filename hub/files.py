"""files — 回收站：清单读写、重名处理、回收站根目录定位

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import json
import os

from .config import TRASH_DIR, TRASH_MANIFEST
from .util import _atomic_write_json, _with_lock

def _trash_root(root: str) -> str:
    return os.path.join(os.path.abspath(root), TRASH_DIR)


def _safe_trash_name(name) -> str:
    # 回收站条目名必须是纯 basename（不含目录分隔符），否则 join 进回收站根目录时
    # 会越界命中根目录本身（清空/还原时误删整个回收站）。返回归一化后的名称，非法则空串。
    if not isinstance(name, str):
        return ""
    base = os.path.basename(name)
    return base if base and "/" not in base and "\\" not in base else ""


def _load_trash_manifest(root: str) -> list:
    # 回收站清单：每个条目 {id, name, orig, deletedAt}（orig 是项目内相对路径）
    try:
        with open(os.path.join(_trash_root(root), TRASH_MANIFEST), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return []


def _save_trash_manifest(root: str, manifest: list):
    # 原子写 + 跨进程锁：防止两个 hub 实例（或多线程并发请求）同时改写
    # manifest 时互相覆盖、写成半截/损坏 JSON。
    trash = _trash_root(root)
    os.makedirs(trash, exist_ok=True)
    lockfile = os.path.join(trash, TRASH_MANIFEST + ".lock")
    _with_lock(lockfile, lambda: _atomic_write_json(os.path.join(trash, TRASH_MANIFEST), manifest))


def _unique_trash_name(root: str, name: str) -> str:
    # 回收站内重名时追加 -N，避免覆盖旧回收项
    base, ext = os.path.splitext(name)
    candidate = name
    n = 1
    while os.path.exists(os.path.join(_trash_root(root), candidate)):
        candidate = f"{base}-{n}{ext}"
        n += 1
    return candidate
