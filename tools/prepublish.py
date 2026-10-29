#!/usr/bin/env python3
"""发布前敏感文件隔离工具。

## 为什么需要它

发布工具是**整目录上传**，不读 `.gitignore`。所以 `.data/secret.key`、
`demo-scripts/hub_accounts.db`、`starshu/data/jwt.secret` 这些本地运行时文件
会一起被打进云端容器，造成两类问题：

1. **跨环境密钥复用**——本地和线上共用同一把会话主密钥。任何一边泄露，两边同时失守；
   而且云端密文副本（AEAD）解密的也是这同一把钥匙。
2. **用户数据外泄**——本地账号库、星枢数据库、历史备份被上传到云端磁盘。

`.gitignore` 挡得住 git，挡不住发布。

## 设计原则

- **只移动，不删除**。默认 dry-run 只报告；`--apply` 把文件挪到 `.publish-hold/<时间戳>/`；
  `--restore` 原样挪回。任何一步都不做 `rm`。
- **区分后果等级**。密钥被挪走会自动重建（代价：重新登录）；账号库被挪走则本地暂时
  无法登录——必须发布后立刻 `--restore`。脚本会把这条提示打到最显眼的位置。
- **幂等**。重复 `--apply` 不会破坏已有隔离；文件不存在就跳过。

## 已知局限（重要）

发布是**增量覆盖**，不会删除云端已有文件。所以本脚本只能保证「这次不传上去」，
无法撤回历史上已经传上去的密钥。若之前已经发布过，正确做法是在云端轮换：
设置环境变量 `HUB_SECRET_KEY`（见 `hub/security.py::_load_secret_key`），
使云端密钥与本地彻底不同。

用法：
    python tools/prepublish.py              # 只检查（默认）
    python tools/prepublish.py --apply      # 隔离（移动）
    python tools/prepublish.py --restore    # 还原最近一次隔离
    python tools/prepublish.py --status     # 看当前有哪些隔离批次
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOLD_ROOT = os.path.join(HERE, ".publish-hold")
MANIFEST = "manifest.json"

# 分类 → (标签, 隔离后的本地影响)
LEVELS = {
    "key": ("密钥", "会自动重建新密钥；本地已登录会话失效，重新登录即可"),
    "log": ("日志", "无影响（诊断/审计日志，删了会重新生成）"),
    "data": ("用户数据", "本地登录与业务数据会暂时不可用，发布完必须立刻 --restore"),
    "backup": ("备份", "无影响（历史快照）"),
    "legacy": ("历史遗留", "无影响（旧库，账号已迁移到 hub_accounts.db）"),
}

# (glob 相对路径, 分类)  —— 顺序即输出顺序
RULES = [
    (".data/secret.key", "key"),
    ("starshu/data/jwt.secret", "key"),
    (".data/hub.log", "log"),
    (".data/exec-audit.log", "log"),
    ("starshu/data/hub-app.log", "log"),
    ("demo-scripts/hub_accounts.db", "data"),
    ("demo-scripts/hub_accounts.db-wal", "data"),
    ("demo-scripts/hub_accounts.db-shm", "data"),
    ("starshu/data/starshu.db", "data"),
    ("starshu/data/starshu.db-wal", "data"),
    ("starshu/data/starshu.db-shm", "data"),
    ("users.db", "legacy"),
    ("starshu/data/backups/*.db", "backup"),
]


def _rel(path: str) -> str:
    return os.path.relpath(path, HERE).replace("\\", "/")


def _size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def collect() -> list[dict]:
    """按规则扫描实际存在的敏感文件。"""
    found: list[dict] = []
    for pattern, level in RULES:
        for path in sorted(glob.glob(os.path.join(HERE, pattern))):
            if not os.path.isfile(path):
                continue
            found.append({
                "rel": _rel(path),
                "abs": path,
                "level": level,
                "size": os.path.getsize(path),
            })
    return found


def _print_report(items: list[dict], title: str) -> None:
    print(f"\n{title}")
    print("=" * 74)
    if not items:
        print("  （无）")
        return
    by_level: dict[str, list[dict]] = {}
    for it in items:
        by_level.setdefault(it["level"], []).append(it)
    for level, label in LEVELS.items():
        group = by_level.get(level)
        if not group:
            continue
        tag = label[0]
        for it in group:
            print(f"  [{tag:<4}] {it['rel']:<42} {_size(it['size']):>9}")
        print(f"         → 隔离后：{label[1]}")
    print("-" * 74)
    total = sum(it["size"] for it in items)
    print(f"  合计 {len(items)} 个文件，{_size(total)}")


def _warn_data(items: list[dict]) -> None:
    risky = [it for it in items if it["level"] in ("data", "key")]
    if not risky:
        return
    print("\n" + "!" * 74)
    print("  注意：下列文件被隔离后，本地会立刻受影响：")
    for it in risky:
        print(f"    · {it['rel']:<42} {LEVELS[it['level']][1]}")
    print("  发布完成后请立刻执行：python tools/prepublish.py --restore")
    print("!" * 74)


def _new_batch_dir() -> str:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = os.path.join(HOLD_ROOT, stamp)
    n = 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(HOLD_ROOT, f"{stamp}-{n}")
    return path


def apply(items: list[dict]) -> str:
    """把文件移动到新的隔离目录，返回该目录。"""
    batch = _new_batch_dir()
    os.makedirs(batch, exist_ok=True)
    moved = []
    for it in items:
        dest = os.path.join(batch, it["rel"].replace("/", os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(it["abs"], dest)
        moved.append({"rel": it["rel"], "level": it["level"]})
        print(f"  已隔离：{it['rel']}")
    with open(os.path.join(batch, MANIFEST), "w", encoding="utf-8") as f:
        json.dump({
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
            "root": HERE,
            "files": moved,
        }, f, ensure_ascii=False, indent=2)
    return batch


def list_batches() -> list[str]:
    if not os.path.isdir(HOLD_ROOT):
        return []
    out = []
    for name in sorted(os.listdir(HOLD_ROOT)):
        p = os.path.join(HOLD_ROOT, name)
        if os.path.isfile(os.path.join(p, MANIFEST)):
            out.append(p)
    return out


def restore(batch: str | None = None) -> int:
    """按 manifest 把文件挪回原位，返回还原数量。"""
    batches = list_batches()
    if not batches:
        print("没有可还原的隔离批次。")
        return 0
    batch = batch or batches[-1]
    with open(os.path.join(batch, MANIFEST), encoding="utf-8") as f:
        man = json.load(f)
    print(f"\n从 {_rel(batch)} 还原（创建于 {man.get('created', '?')}）")
    print("=" * 74)
    n = 0
    for entry in man["files"]:
        src = os.path.join(batch, entry["rel"].replace("/", os.sep))
        dst = os.path.join(HERE, entry["rel"].replace("/", os.sep))
        if not os.path.isfile(src):
            print(f"  跳过（隔离目录里没有）：{entry['rel']}")
            continue
        if os.path.exists(dst):
            # 不覆盖：本地可能已经重建了（如 secret.key），新文件更合规
            print(f"  跳过（本地已存在，未覆盖）：{entry['rel']}")
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        print(f"  已还原：{entry['rel']}")
        n += 1
    print("-" * 74)
    print(f"  还原 {n} 个文件。隔离目录保留在 {_rel(batch)}，确认无误后可手动删除。")
    return n


def status() -> None:
    batches = list_batches()
    if not batches:
        print("当前没有隔离批次（.publish-hold 为空或不存在）。")
        return
    print("\n隔离批次")
    print("=" * 74)
    for b in batches:
        with open(os.path.join(b, MANIFEST), encoding="utf-8") as f:
            man = json.load(f)
        print(f"  {os.path.basename(b)}  创建于 {man.get('created', '?')}  "
              f"{len(man['files'])} 个文件")
    print("\n还原最近一次：python tools/prepublish.py --restore")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="发布前隔离本地敏感文件（只移动，不删除）")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true", help="执行隔离（移动文件）")
    g.add_argument("--restore", action="store_true", help="还原最近一次隔离")
    g.add_argument("--status", action="store_true", help="查看隔离批次")
    args = ap.parse_args(argv)

    if args.status:
        status()
        return 0
    if args.restore:
        restore()
        return 0

    items = collect()
    if not items:
        print("\n未发现需要隔离的敏感文件。可以直接发布。")
        return 0

    if not args.apply:
        _print_report(items, "发布前敏感文件检查（dry-run，未改动任何文件）")
        _warn_data(items)
        print("\n确认无误后执行：python tools/prepublish.py --apply")
        return 0

    _print_report(items, "发布前敏感文件隔离")
    batch = apply(items)
    _warn_data(items)
    print(f"\n隔离目录：{_rel(batch)}")
    print("现在可以发布。发布完成后务必执行：python tools/prepublish.py --restore")
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    sys.exit(main())
