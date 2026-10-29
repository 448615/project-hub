# -*- coding: utf-8 -*-
"""audit — 命令执行审计日志（独立于 diag：即便 HUB_DIAG=0 也始终记录）

为什么单独一套
--------------
``/api/exec`` 是整套系统里权限最高、风险最大的接口——它直接以 hub 进程的身份
跑一条 shell 命令。一旦云端 owner 账号失陷，这里就是 RCE 入口。因此它的每一次
调用（无论成功失败、无论放行与否）都必须留下不可抵赖的记录，且不能因为“诊断日志被
关闭”“写日志本身失败”而一起消失。所以它独立于 diag，默认常开、写入失败静默吞掉
但绝不影响业务。

写入位置：``.data/exec-audit.log``，每行一条 JSON（追加写，便于按时间顺序 tail）。
"""
from __future__ import annotations

import json
import os
import threading
import time

# 单文件锁：审计可能来自多个工作线程（BoundedHTTPServer 已并发封顶，但仍是多线程）。
# 用一把锁串行化追加写，避免半行交叉。
_LOCK = threading.Lock()

# 测试可临时覆盖此变量以把日志写到临时目录；正常为 None 表示走默认路径。
_OVERRIDE_PATH = None


def _log_path() -> str:
    if _OVERRIDE_PATH:
        return _OVERRIDE_PATH
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(here, ".data", "exec-audit.log")


def set_log_path(path: str) -> None:
    """仅供测试使用：把审计日志重定向到指定文件。"""
    global _OVERRIDE_PATH
    _OVERRIDE_PATH = path


def log_exec(*, ip: str, user: str, role: str, cmd: str, code, out_len: int,
             allowed: bool, note: str = "") -> None:
    """记录一次 /api/exec 调用。

    code：返回码（超时记为 -1，执行异常记为 None）；allowed：是否通过闸门放行；
    note：超时为 "timeout"、异常为 "error:..."。
    """
    try:
        record = {
            "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "ip": ip or "",
            "user": user or "?",
            "role": role or "?",
            "cmd": (cmd or "")[:4000],
            "code": code,
            "out_len": out_len,
            "allowed": bool(allowed),
            "note": note or "",
        }
        line = json.dumps(record, ensure_ascii=False)
        parent = os.path.dirname(_log_path())
        if parent:
            os.makedirs(parent, exist_ok=True)
        with _LOCK, open(_log_path(), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:  # noqa: BLE001  审计失败绝不能影响业务
        pass
