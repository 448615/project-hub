"""health — 健康检查：版本、运行时长、账号库与子应用的就绪状态

为什么单独一个模块而不是塞进 routes_get：健康报告要读账号库、探测子应用端口，
属于「跨层汇总」，放在路由里会让路由既做分发又做诊断；这里只负责**采集事实**，
鉴权与脱敏由路由层决定（免登录只给最小信息，管理员才看详情）。
"""
from __future__ import annotations

import os
import sys
import threading
import time

#: 版本号唯一来源见 hub/version.py，这里仅做转发，避免两处硬编码漂移。
from .version import __version__ as VERSION

#: 进程启动时刻（main() 之前就被记录，uptime 包含初始化耗时）
STARTED_AT = time.time()


def _accounts_state() -> dict:
    try:
        from .store import DS
    except Exception as e:  # noqa: BLE001
        return {"ready": False, "reason": f"数据层导入失败：{type(e).__name__}: {e}"}
    if DS is None:
        return {"ready": False, "reason": "数据层未加载（demo-scripts 缺失或被裁剪）"}
    try:
        return {"ready": True, "users": int(DS.count())}
    except Exception as e:  # noqa: BLE001
        # 账号库读不出来等于登录/注册全废，这是真正的「不健康」，要让监控看见
        return {"ready": False, "reason": f"{type(e).__name__}: {e}"}


def _subapps_state() -> dict:
    from .config import SUBAPPS
    if SUBAPPS is None:
        return {"ready": False, "items": [], "reason": "子应用托管模块未加载"}
    status_of = getattr(SUBAPPS, "app_status", None)
    items = []
    for app in getattr(SUBAPPS, "APPS", []):
        try:
            info = status_of(app) if callable(status_of) else {}
        except Exception as e:  # noqa: BLE001
            info = {"phase": "unknown", "note": f"{type(e).__name__}: {e}"}
        items.append({
            "prefix": app.get("prefix", ""),
            "name": app.get("name", ""),
            "kind": app.get("kind", ""),
            # 只读展示：不调用 app_port()，避免健康检查顺手分配端口改变运行态
            "port": int(app.get("_port") or app.get("port") or 0),
            "phase": info.get("phase", "idle"),
            "listening": bool(info.get("listening")),
            "note": info.get("note", ""),
        })
    return {"ready": True, "items": items}


def _deps_state() -> dict:
    """运行依赖就绪度：Node 主体、npm、星枢的四个运行期包。

    只做静态判定（which / 目录存在），不触发任何安装——健康检查必须廉价且无副作用。
    """
    from .config import HERE, SUBAPPS
    out = {"node": False, "npm": False}
    try:
        import shutil
        out["node"] = bool(shutil.which("node"))
        out["npm"] = bool(shutil.which("npm.cmd" if os.name == "nt" else "npm"))
    except Exception:  # noqa: BLE001
        pass
    missing = []
    try:
        required = getattr(SUBAPPS, "REQUIRED_NODE_DEPS", ())
        for app in getattr(SUBAPPS, "APPS", []):
            if app.get("kind") != "node":
                continue
            mods = os.path.join(HERE, app.get("dir", ""), "node_modules")
            missing += [d for d in required if not os.path.isdir(os.path.join(mods, d))]
    except Exception:  # noqa: BLE001
        pass
    out["missingNodeDeps"] = sorted(set(missing))
    return out


#: 结果缓存 TTL（秒）。健康端点免登录、可被外部任意轮询，而每次采集都要查一次
#: 账号库 + 逐个探测子应用端口。不缓存的话它就变成了「一个请求换一次 sqlite 查询」
#: 的放大器。3 秒足够监控使用，又不会让状态明显滞后。
_CACHE_TTL = 3.0
_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()


def build(include_detail: bool) -> dict:
    """返回健康报告。include_detail=False 时只给「能不能用」的最小字段（免登录可看）。"""
    key = "full" if include_detail else "min"
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _CACHE_TTL:
            return dict(hit[1])

    accounts = _accounts_state()
    subapps = _subapps_state()
    ok = bool(accounts.get("ready")) and bool(subapps.get("ready"))
    rep = {
        "ok": ok,
        "version": VERSION,
        "uptime": round(time.time() - STARTED_AT, 1),
        "startedAt": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(STARTED_AT)),
        "accounts": bool(accounts.get("ready")),
        "subapps": bool(subapps.get("ready")),
    }
    if include_detail:
        rep["detail"] = {
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "accounts": accounts,
            "subapps": subapps,
            "deps": _deps_state(),
        }
    with _CACHE_LOCK:
        _CACHE[key] = (now, rep)
    return rep


def invalidate() -> None:
    """丢掉缓存（子应用状态变化、账号库改动后调用，让健康检查立即反映真实情况）。"""
    with _CACHE_LOCK:
        _CACHE.clear()
