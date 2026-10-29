# -*- coding: utf-8 -*-
"""diag — 统一诊断日志

为什么需要它
------------
项目里大量使用「宽泛捕获 + 静默忽略」：``except Exception: pass``。
这些地方多数是有意降级（客户端断开、可选的系统集成、写日志本身失败……），
控制流没问题，但**出故障时一点线索都没有**——用户说"有时候打不开"，
日志里空空如也，只能靠猜。

本模块把这类吞掉的异常变成「一行可追溯记录」，并且：

* **不改变控制流**：调用方仍然是 pass / continue / return，行为完全不变；
* **不刷屏**：默认只记 ``类型: 消息``，异常堆栈要显式 ``tb=True`` 才打；
* **不拖慢**：日志写入失败会被自己吞掉，绝不影响业务；
* **可关闭**：``HUB_DIAG=0`` 环境变量或 ``setup(enabled=False)``。

日志位置：``.data/hub.log``（1MB × 3 滚动），与账号密钥同目录，不入库不入代码。
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import sys

LOGGER = logging.getLogger("hub")
_configured = False
_enabled = os.environ.get("HUB_DIAG", "1") not in ("0", "false", "False")


def setup(log_path: str = "", level: int = logging.INFO) -> None:
    """配置一次即可（重复调用无副作用）。默认写 ``.data/hub.log``。

    刻意不往控制台输出：这是「排障用」的日志，不该混进正常的启动输出里。
    """
    global _configured
    if _configured:
        return
    _configured = True
    if not _enabled:
        LOGGER.addHandler(logging.NullHandler())
        return
    LOGGER.setLevel(level)
    # 不向 root 冒泡：命令行脚本会 basicConfig()，不隔离的话同一条记录会打两遍
    LOGGER.propagate = False
    if not log_path:
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        log_path = os.path.join(here, ".data", "hub.log")
    log_path = os.path.abspath(log_path)
    try:
        parent = os.path.dirname(log_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=1024 * 1024, backupCount=3, encoding="utf-8"
        )
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)-7s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
        ))
        LOGGER.addHandler(handler)
    except OSError:
        # 只读盘 / 无权限：退化为不记录，但绝不让调用方感知
        LOGGER.addHandler(logging.NullHandler())


def access(msg: str) -> None:
    """记录一条访问日志（请求方法/路径/状态码/大小/来源）。

    与 note 区分：note 记「被吞掉的异常」，access 记「正常请求的出入」。两者都只写
    ``.data/hub.log``（不刷控制台），让线上部署可观测又不干扰本地开发。
    """
    if not _enabled:
        return
    try:
        LOGGER.info("[access] %s", msg)
    except Exception:  # noqa: BLE001  日志本身失败绝不能影响业务
        pass


def note(where: str, exc=None, level: int = logging.INFO, tb: bool = False) -> None:
    """记录一处「被有意吞掉」的异常。

    ``where`` 写清位置（``模块.函数``），排查时一眼能定位；
    ``exc`` 省略时取当前正在处理的异常。
    """
    if not _enabled:
        return
    err = exc if exc is not None else (sys.exc_info()[1] if sys.exc_info() else None)
    if err is None:
        return
    try:
        LOGGER.log(level, "[%s] %s: %s", where, type(err).__name__, err,
                   exc_info=err if tb else None)
    except Exception:  # noqa: BLE001  日志本身失败绝不能影响业务
        pass
