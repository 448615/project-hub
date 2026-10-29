"""projects — 项目侧：运行中进程登记、端口探测、目录扫描、预览地址推导

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import os
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import RUNNING
from .util import auto_description

def _preview_url(cfg: dict) -> str:
    # 决定「桌面内预览」窗口要加载的地址：
    #   1) 优先用 config.port 拼本机地址（一键启动后 dev server 就监听这个端口）；
    #   2) 否则取第一个指向 localhost / 127.0.0.1 的外链（本地预览类链接）；
    #   3) 都没有 → 空串，前端据此不显示预览按钮。
    port = (cfg or {}).get("port")
    if port:
        try:
            return f"http://127.0.0.1:{int(port)}"
        except (TypeError, ValueError):
            pass
    for lk in (cfg or {}).get("links", []) or []:
        u = (lk or {}).get("url", "")
        if u.startswith("http://127.0.0.1") or u.startswith("http://localhost"):
            return u
    return ""


# 端口探测结果缓存：桌面每次刷新都会问一遍"哪些项目在跑"，而 connect 探测要建
# TCP 连接（超时 0.3s）。项目多、有端口不通时，一次刷新就能明显卡顿。
# 缓存 4 秒：既让连续刷新几乎零成本，也不至于让「刚点启动」等太久看不到状态变化。
_PORT_TTL = 4.0
_PORT_CACHE: dict = {}
_PORT_LOCK = threading.Lock()


def _probe_port(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        # connect_ex 返回 0 表示端口通，非 0 表示连不上
        return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:  # noqa: BLE001
        return False
    finally:
        s.close()


def detect_port(port) -> bool:
    # 探测某个端口是否已被监听，用来显示子项目"运行中 / 离线"
    if not port:
        return False
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    now = time.time()
    with _PORT_LOCK:
        hit = _PORT_CACHE.get(port)
        if hit and now - hit[0] < _PORT_TTL:
            return hit[1]
    ok = _probe_port(port)
    with _PORT_LOCK:
        # 顺手清掉过期项，避免长期运行后字典无限增长
        if len(_PORT_CACHE) > 256:
            _PORT_CACHE.clear()
        _PORT_CACHE[port] = (time.time(), ok)
    return ok


def invalidate_ports() -> None:
    """启动/停止子项目后调用，让下一次查询立刻反映真实状态（不等 TTL 到期）。"""
    with _PORT_LOCK:
        _PORT_CACHE.clear()


# --------------------------------------------------------------------------
# 扫描子项目：列出根目录下的一级子目录，拼成卡片数据
# --------------------------------------------------------------------------


def invalidate_projects() -> None:
    """新增项目后调用，让下一次 /api/projects 立即反映新目录（不等 TTL）。"""
    with _PROJECTS_LOCK:
        _PROJECTS_CACHE.clear()


# /api/projects 的结果缓存：os.listdir + 端口探测 + auto_description 在目录多时
# 有可观开销，但目录结构很少秒级突变。缓存 15s 让连续刷新几乎零成本，又不会让
# "刚新建项目"等太久才出现。键含 config.json 的 mtime——新建项目会改写 config.json，
# mtime 一变缓存自动失效，不必额外清。
_PROJECTS_TTL = 15.0
_PROJECTS_CACHE: dict = {}
_PROJECTS_LOCK = threading.Lock()


def scan_projects(root: str, config: dict) -> list:
    """返回仪表盘项目列表；结果按 (root, config mtime) 缓存，详见上方说明。"""
    cfg_path = os.path.join(root, "config.json")
    try:
        mtime = os.path.getmtime(cfg_path)
    except OSError:
        mtime = 0.0
    key = (root, mtime)
    now = time.time()
    with _PROJECTS_LOCK:
        hit = _PROJECTS_CACHE.get(key)
        if hit and now - hit[0] < _PROJECTS_TTL:
            return hit[1]
    data = _scan_projects_uncached(root, config)
    with _PROJECTS_LOCK:
        if len(_PROJECTS_CACHE) > 64:   # 顺手清掉过期项，避免长期运行字典无限增长
            _PROJECTS_CACHE.clear()
        _PROJECTS_CACHE[key] = (time.time(), data)
    return data


def _scan_projects_uncached(root: str, config: dict) -> list:
    # 这些目录不展示在仪表盘上
    excludes = set(config.get("exclude", []))
    excludes.update(
        {".git", ".workbuddy", "static", "node_modules", ".venv", "venv",
         "__pycache__", ".idea", ".vscode", ".husky"}
    )
    cfg_projects = config.get("projects", {})
    # 先收集候选目录，记录各自需要探测的端口
    candidates = []
    for name in sorted(os.listdir(root)):
        full = os.path.join(root, name)
        if not os.path.isdir(full):
            continue
        if name in excludes or name.startswith("."):
            continue
        cfg = cfg_projects.get(name, {})
        candidates.append((name, full, cfg, cfg.get("port")))
    # 端口探测串行时每个 0.3s 超时，项目多会拖慢 /api/projects；改用线程池并发探测
    ports = {p for (_, _, _, p) in candidates if p}
    running_map = {}
    if ports:
        with ThreadPoolExecutor(max_workers=min(8, len(ports))) as ex:
            for port, ok in zip(ports, ex.map(detect_port, ports)):
                running_map[port] = ok
    projects = []
    for name, full, cfg, port in candidates:
        desc = cfg.get("description") or auto_description(full)
        projects.append({
            "name": name,
            "display_name": cfg.get("display_name") or name,
            "description": desc,
            "icon": cfg.get("icon") or "📁",
            "tags": cfg.get("tags", []),
            "port": port,
            "running": running_map.get(port, False) if port else False,
            # started：本枢纽是否确实拉起了该项目的进程（与 running 不同，
            # running 看端口是否通，started 看进程是否还活着，二者可组合出"启动中"状态）
            "started": name in RUNNING and RUNNING[name].poll() is None,
            # 子链接跳转 / 一键启动 / 文档 / 预览：前端据此渲染按钮
            "run": cfg.get("run"),
            "links": cfg.get("links", []),
            "docs": cfg.get("docs"),
            # app：桌面图标双击时直接打开的「应用地址」（同源子应用挂载点，如 /apps/starshu/）。
            # 有它就跳过「信息卡片」直接进应用；没有则维持原来的项目详情窗口。
            "app": cfg.get("app"),
            "preview_url": _preview_url(cfg),
            # panel：声明「一键运行」时改为打开专用面板（目前仅 accounts = 账号数据）
            "panel": cfg.get("panel"),
        })
    return projects


# 访客（未登录）可见的项目字段。**必须用白名单而非黑名单**：
# scan_projects 返回的 run（启动命令）、docs（文档路径）、port、preview_url、
# started 都是内部实现细节，任何一个匿名可见都等于把部署结构公网化。
# 将来 projects 里新增字段时，白名单让默认结果是「访客看不到」（漏配的代价是少显示），
# 黑名单则会让默认结果是「泄露」（漏配的代价是信息外泄）——两者失败方向相反。
PUBLIC_FIELDS = ("name", "display_name", "description", "icon", "tags")


def public_cards(items: list) -> list:
    """把 scan_projects 的结果裁剪成访客卡片（只保留 PUBLIC_FIELDS）。

    刻意不做深拷贝：tags 重新包一层 list，其余都是不可变标量，
    调用方改返回值不会波及 scan_projects 的缓存对象。
    """
    out = []
    for p in items or []:
        if not isinstance(p, dict):
            continue
        card = {k: p[k] for k in PUBLIC_FIELDS if k in p}
        tags = p.get("tags")
        card["tags"] = list(tags) if isinstance(tags, (list, tuple)) else []
        out.append(card)
    return out


# --------------------------------------------------------------------------
# HTTP 处理：主系统只提供 页面 + 项目列表 两类接口
# --------------------------------------------------------------------------
