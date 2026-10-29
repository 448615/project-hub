# -*- coding: utf-8 -*-
"""项目自动备份
================
改动前把当前工程整包快照到工作区根 .backups/vNNN_YYYYmmdd_HHMMSS_标签/。
- 序号递增（v001、v002…），便于按序回滚；
- 排除 .backups / __pycache__ / .git / node_modules / 虚拟环境 / 构建产物 及临时测试文件；
- 默认保留最近 12 份，更早的自动清理。

用法：
    python backup.py                # 自动标签
    python backup.py 接入云数据库    # 自定义标签（会规范化成文件名安全形式）
"""
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# 备份目录放在工程上一级（工作区根），与历史快照同处一地；
# 早前没走本脚本生成的快照（如 refactor_20261027_...）也在这里，不会被下面的
# KEEP 逻辑清理（那里只认本脚本的 vNNN_ 前缀），互不干扰。
BACKUP_ROOT = os.path.join(os.path.dirname(HERE), ".backups")
KEEP = 12
# 只认本脚本自己的命名（vNNN_20261028_203841_标签）。历史上手写的快照名如
# v2_before_step34_191617 也长得像 vNNN_，会被误当成自己的序号并被优先清理，
# 所以这里要求「序号后面必须紧跟 8 位日期」。
SEQ_RE = re.compile(r"^v(\d+)_\d{8}_\d{6}_")
EXCLUDE_DIRS = {".backups", "__pycache__", ".git", "node_modules",
                ".venv", "venv", "dist", "build", ".mypy_cache", ".pytest_cache"}
EXCLUDE_FILES = {".e2e_cookie.txt", ".e2e2.txt", ".cloud.txt"}


def _next_seq():
    if not os.path.isdir(BACKUP_ROOT):
        return 1
    top = 0
    for name in os.listdir(BACKUP_ROOT):
        m = SEQ_RE.match(name)
        if m:
            top = max(top, int(m.group(1)))
    return top + 1


def _ignore(dir_path, names):
    return [n for n in names if n in EXCLUDE_DIRS or n in EXCLUDE_FILES]


def main():
    label = (sys.argv[1] if len(sys.argv) > 1 else "auto").strip()
    label = re.sub(r"[^\w\-\u4e00-\u9fa5]+", "_", label).strip("_") or "auto"
    os.makedirs(BACKUP_ROOT, exist_ok=True)
    seq = _next_seq()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = os.path.join(BACKUP_ROOT, "v%03d_%s_%s" % (seq, stamp, label))
    shutil.copytree(HERE, dest, ignore=_ignore)
    print("已备份到: %s" % dest)

    # 仅保留最近 KEEP 份
    dirs = sorted(d for d in os.listdir(BACKUP_ROOT) if SEQ_RE.match(d))
    removed = 0
    while len(dirs) > KEEP:
        old = dirs.pop(0)
        shutil.rmtree(os.path.join(BACKUP_ROOT, old), ignore_errors=True)
        removed += 1
    print("现有备份 %d 份（保留上限 %d，本次清理 %d）" % (len(dirs), KEEP, removed))
    print("最新: v%03d" % seq)


if __name__ == "__main__":
    main()
