"""store — 数据存储层：加载 ds_store（密码哈希与加密由它提供）、用户表初始化与基础查询

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。

与 ``demo-scripts/`` 的关系
---------------------------
账号数据层是一个独立包 ``demo-scripts/ds_store/``，命令行脚本（run_all.py）和
枢纽共用同一份实现。目录名 ``demo-scripts`` 带连字符、不能当常规包名导入，
所以**在本模块集中做一次路径解析**，其余代码只认 ``DS.xxx``：

    DS.configure / DS.create / DS.get_by_email / DS.check_pwd ...

这就是 hub 与数据层之间的**唯一接口**。接口清单见
``demo-scripts/ds_store/__init__.py`` 的 ``__all__``，由
``tests/test_datastore_contract.py`` 逐项校验 —— 数据层改名/改签名会当场报红，
而不是等到线上登录失败才发现。
"""
from __future__ import annotations

import sys

from .config import _DS_DIR


def _load_data_store():
    """把 demo-scripts/ 加入 sys.path 后 ``import ds_store``。

    为什么不再用 ``spec_from_file_location`` 按文件加载：那样加载出来的模块
    （名为 hub_data_store）与 ``import ds_store`` 是**两个不同的模块对象**，
    各自缓存主密钥与路径，``configure()`` 只对其中一个生效。现在统一走
    正常导入，模块注册进 sys.modules，全进程只有一份状态。
    """
    try:
        if _DS_DIR not in sys.path:
            sys.path.insert(0, _DS_DIR)
        import ds_store  # noqa: PLC0415  延迟导入：要在 sys.path 就绪之后
        return ds_store
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 账号数据模块加载失败：{e}")
        return None


DS = _load_data_store()


def _user_count() -> int:
    return DS.count() if DS else 0


def _get_user_by_email(email: str):
    """返回 (id, username, email, pwd_hash, role)；不存在返回 None。"""
    if DS is None:
        return None
    row = DS.get_by_email(email)
    if not row:
        return None
    return (row["id"], row["username"], row["email"], row["pwd_hash"], row["role"])
