"""数据处理脚本 · 输出层（渲染 + 落盘，零依赖）。

职责
----
把 :class:`ds_report.ReportView` 变成人看的表格、机器读的 JSON/CSV，
并负责安全地写文件（原子替换 + UTF-8 + 权限收紧）。

设计要点
--------
1. **写盘用"临时文件 + 原子替换"**：中途崩溃/磁盘满不会留下半截 JSON，
   已有文件要么是旧的完整版、要么是新的完整版。
2. **中文对齐按显示宽度算**（East Asian Width），否则表格里中文列会歪。
3. **渲染不依赖数据库/配置**，只吃视图对象，便于单独测试。
"""
from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from unicodedata import east_asian_width

from ds_report import ReportView

# 表格版式
WIDTH = 78
_SEP = "=" * WIDTH
_THIN = "-" * WIDTH

# 导出列（内部字段不导出：has_plain / *_text 由展示层临时生成）
EXPORT_COLUMNS = ("id", "email", "username", "role", "created_at", "updated_at")


# ---------------------------------------------------------------------------
# 对齐工具
# ---------------------------------------------------------------------------
def display_width(text: str) -> int:
    """字符串在等宽终端里的显示宽度（全角字符算 2 列）。"""
    total = 0
    for ch in str(text):
        total += 2 if east_asian_width(ch) in ("W", "F") else 1
    return total


def pad(text: str, width: int, align: str = "left") -> str:
    """按显示宽度补空格（不截断，超宽时原样返回并在右侧留一格空白）。"""
    text = str(text)
    gap = width - display_width(text)
    if gap <= 0:
        return text + " "
    if align == "right":
        return " " * gap + text
    return text + " " * gap


# ---------------------------------------------------------------------------
# 表格
# ---------------------------------------------------------------------------
def render_table(view: ReportView) -> str:
    """人类可读的账号报表（终端 / 一键运行面板看的就是这段）。"""
    stats = view.stats
    meta = view.meta
    lines: list[str] = [
        _SEP,
        "项目枢纽 · 账号数据报表（数据处理脚本产出）",
        _SEP,
        f"数据来源：{meta.get('source') or '-'}",
        f"生成时间：{meta.get('generated_at') or '-'}",
        f"筛选条件：{view.filter_desc}",
        f"账号总数：{stats['total']}（管理员 {stats['admins']} · 普通用户 {stats['users']}）",
    ]
    if view.total_before_filter != stats["total"]:
        lines.append(f"过滤前共 {view.total_before_filter} 条，当前展示 {stats['total']} 条")
    if meta.get("limit"):
        lines.append(f"条数上限：{meta['limit']}{'（已截断）' if meta.get('truncated') else ''}")
    lines.append(f"排序方式：{meta.get('sort') or '-'}")
    lines.append(_THIN)

    header = (
        pad("ID", 6) + pad("邮箱", 34) + pad("角色", 8)
        + pad("用户名", 18) + "创建时间"
    )
    lines.append(header)
    lines.append(_THIN)

    if view.rows:
        for row in view.rows:
            lines.append(
                pad(f"#{row['id']}", 6)
                + pad(row["email"], 34)
                + pad(row["role"], 8)
                + pad(row["username"], 18)
                + row["created_at_text"]
            )
    else:
        lines.append("  （暂无账号）")

    lines.append(_THIN)
    lines.append(
        f"统计：近 7 天新增 {stats['recent_7d']} 条 · "
        f"最早注册 {stats['oldest']} · 最新注册 {stats['newest']}"
    )
    lines.append(_SEP)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# JSON / CSV
# ---------------------------------------------------------------------------
def view_as_dict(view: ReportView) -> dict:
    """视图 → 可序列化字典（结构与旧版 ``build_report`` 保持兼容）。"""
    stats = view.stats
    return {
        "generated_at": view.meta.get("generated_at", ""),
        "source": view.meta.get("source", ""),
        "filter": view.filter_desc,
        "total": stats["total"],
        # 顶层保留 admins，兼容按旧结构读取的脚本
        "admins": stats["admins"],
        "stats": stats,
        "accounts": [
            {key: row.get(key) for key in EXPORT_COLUMNS} for row in view.rows
        ],
    }


def render_json(view: ReportView) -> str:
    return json.dumps(view_as_dict(view), ensure_ascii=False, indent=2)


def render_csv(view: ReportView) -> str:
    """导出 CSV（带表头，UTF-8；Excel 打开需自行选择 UTF-8 编码）。"""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["id", "email", "username", "role", "created_at", "updated_at"])
    for row in view.rows:
        writer.writerow([
            row["id"],
            row["email"],
            row["username"],
            row["role"],
            row["created_at_text"],
            row["updated_at_text"],
        ])
    return buf.getvalue()


RENDERERS = {"table": render_table, "json": render_json, "csv": render_csv}


def render(view: ReportView, fmt: str = "table") -> str:
    """按格式渲染；未知格式回退到表格（不抛异常，报表总能出）。"""
    return RENDERERS.get(str(fmt or "").lower(), render_table)(view)


# ---------------------------------------------------------------------------
# 落盘
# ---------------------------------------------------------------------------
def atomic_write_text(path: str, text: str, *, mode: int | None = None) -> str:
    """原子写文本文件：先写同目录临时文件，再 ``os.replace`` 覆盖目标。

    为什么不用 ``open(path, "w")``：写到一半被中断会留下损坏文件，而这个脚本
    的产物（账号报表）会被反复覆盖，宁可多一次 rename 也不要有半个 JSON。
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", suffix=".part", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            try:
                os.chmod(tmp, mode)
            except OSError:
                pass
        os.replace(tmp, path)
        return path
    except BaseException:
        # 任何失败都清掉临时文件，避免目录里堆 .part 垃圾
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def export_view(view: ReportView, export_dir: str, fmt: str = "json") -> str:
    """把视图写入 ``export_dir``，返回实际路径。

    文件名 ``accounts_<时间戳>.<ext>``，与旧版命名一致，便于沿用既有清理习惯。
    """
    from time import strftime

    fmt_norm = str(fmt or "").lower()
    ext = {"json": "json", "csv": "csv", "table": "txt"}.get(fmt_norm, "json")
    if ext == "json":
        text = render_json(view)
    elif ext == "csv":
        text = render_csv(view)
    else:
        text = render_table(view)
    name = f"accounts_{strftime('%Y%m%d_%H%M%S')}.{ext}"
    return atomic_write_text(os.path.join(export_dir, name), text, mode=0o600)
