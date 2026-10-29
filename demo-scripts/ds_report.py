"""数据处理脚本 · 处理层（纯函数，零依赖）。

职责
----
只做「把原始行变成可用于展示/导出的数据」这一件事：
    规范化 → 过滤 → 排序 → 统计 → 组装视图

边界
----
* **不碰数据库**：输入是 ``data_store.list_accounts()`` 返回的 ``list[dict]``，
  这样处理逻辑可以脱离 SQLite 单独测试。
* **不碰 stdout / 文件**：输出交给 :mod:`ds_output`。
* 所有函数都是纯函数（相同输入必得相同输出、无副作用），便于回归测试。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

# 展示与导出统一使用的列顺序
COLUMNS = ("id", "email", "username", "role", "created_at", "updated_at")

# 时间列（存的是 Unix 时间戳，展示时转可读串）
_TIME_FIELDS = ("created_at", "updated_at")
_TIME_FMT = "%Y-%m-%d %H:%M:%S"
_RECENT_SECONDS = 7 * 24 * 3600


# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------
def _fmt_ts(value) -> str:
    """时间戳 → 可读字符串；脏数据（None/0/非数字/越界）一律显示 ``-``。"""
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return "-"
    if ts <= 0:
        return "-"
    try:
        return time.strftime(_TIME_FMT, time.localtime(ts))
    except (OverflowError, OSError, ValueError):
        return "-"


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_row(raw: dict) -> dict:
    """把一条原始记录规范成展示用字典。

    * 字符串字段去空白，``None`` 统一成空串（避免导出 JSON 时出现 null 混排）；
    * 角色归一为 ``admin`` / ``user``，其它脏值一律按 ``user``；
    * 时间戳补一列可读文本 ``created_at_text`` / ``updated_at_text``，
      原时间戳字段保留，供排序与程序消费。
    """
    row = dict(raw or {})
    email = str(row.get("email") or "").strip()
    role = str(row.get("role") or "").strip().lower()
    out = {
        "id": _to_int(row.get("id")),
        "email": email,
        "username": str(row.get("username") or "").strip() or email.split("@")[0],
        "role": role if role in ("admin", "user") else "user",
        "created_at": row.get("created_at") or 0,
        "updated_at": row.get("updated_at") or 0,
        "has_plain": bool(row.get("has_plain")),
    }
    for key in _TIME_FIELDS:
        out[key + "_text"] = _fmt_ts(out[key])
    return out


def normalize_rows(rows) -> list[dict]:
    """批量规范化；跳过非字典项并保持原有顺序。"""
    return [normalize_row(r) for r in (rows or []) if isinstance(r, dict)]


# ---------------------------------------------------------------------------
# 过滤
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class AccountFilter:
    """过滤条件。所有条件为"与"关系；空值表示不限。"""

    email_contains: str = ""
    role: str = ""
    keyword: str = ""

    def is_empty(self) -> bool:
        return not (self.email_contains or self.role or self.keyword)

    def describe(self) -> str:
        if self.is_empty():
            return "无（全部账号）"
        parts = []
        if self.email_contains:
            parts.append(f"邮箱包含 {self.email_contains!r}")
        if self.role:
            parts.append(f"角色={self.role}")
        if self.keyword:
            parts.append(f"关键词 {self.keyword!r}")
        return "、".join(parts)


def filter_rows(rows: list[dict], flt: AccountFilter) -> list[dict]:
    """按条件过滤（大小写不敏感）。"""
    out = list(rows)
    if flt.email_contains:
        needle = flt.email_contains.strip().lower()
        out = [r for r in out if needle in r["email"].lower()]
    if flt.role:
        want = flt.role.strip().lower()
        out = [r for r in out if r["role"] == want]
    if flt.keyword:
        needle = flt.keyword.strip().lower()
        out = [
            r for r in out
            if needle in r["email"].lower() or needle in r["username"].lower()
        ]
    return out


# ---------------------------------------------------------------------------
# 排序
# ---------------------------------------------------------------------------
def sort_rows(rows: list[dict], key: str = "id", descending: bool = False) -> list[dict]:
    """按指定字段排序；未知字段回退到 ``id``（不抛异常，保证报表总能出）。

    字符串按字典序、数字按数值；``id`` 缺省为正序，与原脚本一致。
    """
    field_name = key if key in COLUMNS else "id"

    def sort_key(item: dict):
        value = item.get(field_name)
        if field_name in _TIME_FIELDS:
            return _to_int(float(value) if isinstance(value, (int, float)) else value)
        if field_name == "id":
            return _to_int(value)
        return str(value or "").lower()

    return sorted(rows, key=sort_key, reverse=bool(descending))


def apply_limit(rows: list[dict], limit: int) -> list[dict]:
    """截断到前 ``limit`` 条；``limit <= 0`` 表示不限制。"""
    if limit and limit > 0:
        return rows[:limit]
    return rows


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------
def summarize(rows: list[dict], now: float | None = None) -> dict:
    """汇总指标。

    除了总数/管理员数，还给出「近 7 天新增」「最早/最新注册」和按角色分布，
    让报表本身就能回答"账号大概是什么时候建的、有没有异常增长"。
    """
    current = time.time() if now is None else float(now)
    total = len(rows)
    admins = sum(1 for r in rows if r["role"] == "admin")
    timestamps = [
        float(r["created_at"]) for r in rows
        if isinstance(r.get("created_at"), (int, float)) and float(r["created_at"]) > 0
    ]
    recent = sum(1 for ts in timestamps if current - ts <= _RECENT_SECONDS)
    return {
        "total": total,
        "admins": admins,
        "users": total - admins,
        "recent_7d": recent,
        "oldest": _fmt_ts(min(timestamps)) if timestamps else "-",
        "newest": _fmt_ts(max(timestamps)) if timestamps else "-",
        "by_role": {"admin": admins, "user": total - admins},
    }


# ---------------------------------------------------------------------------
# 组装视图（输出层的唯一输入）
# ---------------------------------------------------------------------------
@dataclass
class ReportView:
    """一次报表的完整结果：元信息 + 行数据 + 统计 + 过滤说明。"""

    meta: dict
    rows: list[dict]
    stats: dict
    filter_desc: str = ""
    total_before_filter: int = 0
    columns: tuple = field(default=COLUMNS)

    @property
    def all_rows(self) -> list[dict]:
        return list(self.rows)


def build_view(
    raw_rows,
    *,
    flt: AccountFilter | None = None,
    sort_key: str = "id",
    descending: bool = False,
    limit: int = 0,
    source: str = "",
    generated_at: str = "",
) -> ReportView:
    """把原始行加工成 :class:`ReportView`（规范化 → 过滤 → 排序 → 截断 → 统计）。

    统计口径说明：``total`` 是**过滤后**的行数，``total_before_filter`` 是过滤前的
    总数——两者都给出，读者才能判断"0 条"到底是库是空的还是条件太窄。
    """
    flt = flt or AccountFilter()
    normalized = normalize_rows(raw_rows)
    filtered = filter_rows(normalized, flt)
    ordered = sort_rows(filtered, sort_key, descending)
    limited = apply_limit(ordered, limit)
    meta = {
        "generated_at": generated_at or time.strftime(_TIME_FMT),
        "source": source,
        "sort": f"{sort_key}{' ↓' if descending else ' ↑'}",
        "limit": limit or 0,
        "truncated": len(limited) < len(ordered),
    }
    return ReportView(
        meta=meta,
        rows=limited,
        stats=summarize(limited),
        filter_desc=flt.describe(),
        total_before_filter=len(normalized),
    )
