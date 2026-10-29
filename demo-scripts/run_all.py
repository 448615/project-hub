"""数据处理脚本 · 入口（零依赖，仅标准库）。

项目枢纽的数据层：账号数据全部落在 ``demo-scripts/hub_accounts.db``，
并由枢纽同步一份密文到云端。本文件负责「命令行编排」——校验参数、调度
数据访问层、把结果交给输出层。

分层
----
===================  ==========================================================
ds_config.py         配置：路径 / 日志 / 输出格式 / 权限来源
data_store.py        数据访问：SQLite 读写、密码哈希、AEAD 加密（枢纽也用它）
ds_report.py         处理：规范化 → 过滤 → 排序 → 统计（纯函数）
ds_output.py         输出：表格 / JSON / CSV 渲染，原子写盘
run_all.py（本文件）  编排：解析参数 → 校验 → 调用 → 退出码
===================  ==========================================================

用法（详细说明见 README.md）
---------------------------
    python demo-scripts/run_all.py                      # 账号报表（管理员）
    python demo-scripts/run_all.py --stats              # 只看统计（任何人）
    python demo-scripts/run_all.py --export             # 导出 JSON
    python demo-scripts/run_all.py --format csv --export
    python demo-scripts/run_all.py --role admin --limit 10
    python demo-scripts/run_all.py --reset-password <邮箱> <新密码>
    python demo-scripts/run_all.py --set-role <邮箱> admin|user
    python demo-scripts/run_all.py --delete <邮箱>

退出码
------
0 成功 ｜ 1 业务失败（账号不存在、写库失败等）｜ 2 参数/配置错误 ｜ 3 权限不足
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import data_store as ds          # noqa: E402  数据访问层（枢纽共用）
import ds_config as cfgmod       # noqa: E402  配置与校验
import ds_output as out          # noqa: E402  输出层
import ds_report as report       # noqa: E402  处理层

__version__ = "2.0.0"

LOG = logging.getLogger("hub.datascripts")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_FORBIDDEN = 3


# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
def setup_logging(cfg: cfgmod.Config) -> None:
    """初始化日志：结果走 stdout，诊断走 stderr，互不污染管道。

    ``--log-file`` 会额外追加写文件（排障用）；文件不可写时降级为只输出
    stderr 并告警，绝不让"日志写不了"阻断真正的业务。
    """
    level = getattr(logging, cfg.log_level, logging.INFO)
    if cfg.quiet:
        level = max(level, logging.WARNING)

    handlers: list[logging.Handler] = [logging.StreamHandler(stream=sys.stderr)]
    if cfg.log_file:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(cfg.log_file)), exist_ok=True)
            handlers.append(logging.FileHandler(cfg.log_file, encoding="utf-8"))
        except OSError as exc:
            print(f"[warn] 日志文件不可写，已跳过：{cfg.log_file}（{exc}）", file=sys.stderr)

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
        force=True,
    )


# ---------------------------------------------------------------------------
# 权限
# ---------------------------------------------------------------------------
def require_admin(cfg: cfgmod.Config, action: str) -> None:
    """非管理员直接拒绝（抛 PermissionError，由 main 统一转成退出码 3）。"""
    if cfg.is_admin:
        return
    raise PermissionError(
        f"{action}需要管理员权限。当前操作者：{cfg.operator_label}。\n"
        "        在枢纽中用管理员账号点「一键运行」；"
        "命令行可先设置 HUB_OPERATOR_ROLE=admin。"
    )


# ---------------------------------------------------------------------------
# 视图构建（读取 + 处理）
# ---------------------------------------------------------------------------
def load_view(cfg: cfgmod.Config) -> report.ReportView:
    """读取账号并加工成视图。读取失败会记日志并返回空视图，不中断流程。"""
    rows = ds.list_accounts(reveal=cfg.is_admin)
    LOG.debug("读取到 %d 条原始记录", len(rows))
    return report.build_view(
        rows,
        flt=report.AccountFilter(
            email_contains=cfg.filter_email,
            role=cfg.filter_role,
            keyword=cfg.filter_keyword,
        ),
        sort_key=cfg.sort_key,
        descending=cfg.descending,
        limit=cfg.limit,
        source=ds.DB_PATH,
    )


def print_view(view: report.ReportView, fmt: str) -> None:
    """把视图打到 stdout（终端 / 枢纽一键运行面板看到的内容）。"""
    print(out.render(view, fmt))


def maybe_export(view: report.ReportView, cfg: cfgmod.Config, fmt: str) -> str:
    """导出报表文件，返回路径；dry-run 时只报告不落盘。"""
    if cfg.dry_run:
        LOG.info("[dry-run] 将导出到 %s（%s）", cfg.export_dir, fmt)
        return ""
    cfgmod.ensure_dir(cfg.export_dir)
    path = out.export_view(view, cfg.export_dir, fmt)
    LOG.info("已导出：%s", path)
    return path


# ---------------------------------------------------------------------------
# 各动作
# ---------------------------------------------------------------------------
def action_stats(cfg: cfgmod.Config) -> int:
    """统计摘要：不含任何敏感字段，普通用户也可执行。"""
    view = load_view(cfg)
    stats = view.stats
    print(
        f"账号总数：{stats['total']}（管理员 {stats['admins']} · 普通用户 {stats['users']}）\n"
        f"近 7 天新增：{stats['recent_7d']}    最早注册：{stats['oldest']}    "
        f"最新注册：{stats['newest']}\n"
        f"数据文件：{ds.DB_PATH}"
    )
    return EXIT_OK


def action_export(cfg: cfgmod.Config, fmt: str) -> int:
    require_admin(cfg, "导出账号报表")
    view = load_view(cfg)
    path = maybe_export(view, cfg, fmt)
    if path:
        print(f"[完成] 已导出：{path}")
    return EXIT_OK


def action_report(cfg: cfgmod.Config, auto_export: bool = True) -> int:
    """默认动作：打印报表 + 自动导出一份快照（与原脚本行为一致）。"""
    require_admin(cfg, "账号数据报表")
    view = load_view(cfg)
    print_view(view, cfg.output_format)
    if not auto_export:
        return EXIT_OK
    try:
        path = maybe_export(view, cfg, "json")
        if path:
            print(f"\n[完成] 报表已同时导出：{path}")
    except (OSError, cfgmod.ConfigError) as exc:
        # 导出失败不该让已经打印出来的报表白跑，降级为告警
        LOG.warning("自动导出失败：%s", exc)
    return EXIT_OK


def action_reset_password(cfg: cfgmod.Config, email: str, pwd: str) -> int:
    require_admin(cfg, "重置密码")
    email = cfgmod.validate_email(email)
    pwd = cfgmod.validate_password(pwd)
    if cfg.dry_run:
        LOG.info("[dry-run] 将重置 %s 的密码（不写库）", email)
        return EXIT_OK
    ok = ds.set_password(email, pwd)
    print(f"{'[完成]' if ok else '[失败]'} {'已重置密码' if ok else '重置失败（账号不存在或库不可写）'}：{email}")
    return EXIT_OK if ok else EXIT_FAILED


def action_set_role(cfg: cfgmod.Config, email: str, role: str) -> int:
    require_admin(cfg, "修改角色")
    email = cfgmod.validate_email(email)
    role = cfgmod.normalize_role(role)
    if cfg.dry_run:
        LOG.info("[dry-run] 将把 %s 设为 %s（不写库）", email, role)
        return EXIT_OK
    row = ds.get_by_email(email)
    if not row:
        print(f"[失败] 账号不存在：{email}")
        return EXIT_FAILED
    ok = ds.set_role(int(row["id"]), role)
    print(f"{'[完成]' if ok else '[失败]'} {email} → {role}")
    return EXIT_OK if ok else EXIT_FAILED


def action_delete(cfg: cfgmod.Config, email: str) -> int:
    require_admin(cfg, "删除账号")
    email = cfgmod.validate_email(email)
    if cfg.dry_run:
        LOG.info("[dry-run] 将删除 %s（不写库）", email)
        return EXIT_OK
    row = ds.get_by_email(email)
    if not row:
        print(f"[失败] 账号不存在：{email}")
        return EXIT_FAILED
    ok = ds.delete(int(row["id"]))
    print(f"{'[完成]' if ok else '[失败]'} 已删除：{email}")
    return EXIT_OK if ok else EXIT_FAILED


def action_init(cfg: cfgmod.Config) -> int:
    """建表 + 迁移旧库（幂等）。"""
    writable = ds.init_db()
    if not writable:
        print(f"[失败] 账号库不可写：{ds.DB_PATH}", file=sys.stderr)
        return EXIT_FAILED
    moved = 0 if cfg.dry_run else ds.migrate_legacy()
    if cfg.dry_run:
        LOG.info("[dry-run] 将迁移旧库 %s（不写库）", ds.LEGACY_DB)
    print(f"[完成] 账号库就绪：{ds.DB_PATH}\n        现有 {ds.count()} 个账号，本次迁移 {moved} 个")
    return EXIT_OK


# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_all.py",
        description="项目枢纽 · 数据处理脚本（账号数据报表与维护）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例：
  run_all.py                                 账号报表（需管理员）+ 自动导出 JSON
  run_all.py --stats                         只看统计（任何人可跑）
  run_all.py --export --format csv           导出 CSV
  run_all.py --role admin --sort created_at --desc
  run_all.py --reset-password a@b.com 123456 重置密码
  run_all.py --set-role a@b.com admin        提升为管理员
  run_all.py --delete a@b.com                删除账号
  run_all.py --init                          建表并迁移旧库

退出码：0 成功 / 1 业务失败 / 2 参数错误 / 3 权限不足""",
    )
    # argparse 默认把内置参数分组标题写成 "options"（英文），这里统一成中文
    parser._optionals.title = "基础参数"

    act = parser.add_mutually_exclusive_group()
    act.add_argument("--stats", action="store_true", help="只输出统计摘要（任何人可执行）")
    act.add_argument("--export", action="store_true", help="只导出报表文件，不打印表格")
    act.add_argument("--init", action="store_true", help="建表并迁移旧 users.db")
    act.add_argument("--reset-password", nargs=2, metavar=("EMAIL", "PASSWORD"),
                     help="重置指定邮箱的密码（管理员）")
    act.add_argument("--set-role", nargs=2, metavar=("EMAIL", "ROLE"),
                     help="修改角色：admin 或 user（管理员）")
    act.add_argument("--delete", metavar="EMAIL", help="删除账号（管理员）")

    grp_out = parser.add_argument_group("输出")
    grp_out.add_argument("--format", default=None, choices=cfgmod.OUTPUT_FORMATS,
                         help="输出格式（默认 table；导出默认 json）")
    grp_out.add_argument("--export-dir", default=None, metavar="DIR",
                         help="导出目录（默认 demo-scripts/exports）")
    grp_out.add_argument("--no-export", action="store_true",
                         help="报表模式下不自动导出快照")

    grp_data = parser.add_argument_group("数据与筛选")
    grp_data.add_argument("--db", default=None, metavar="PATH", help="账号库路径")
    grp_data.add_argument("--filter-email", default=None, metavar="KW", help="邮箱包含该子串")
    grp_data.add_argument("--role", default=None, choices=cfgmod.ROLES, help="只看某角色")
    grp_data.add_argument("--keyword", default=None, metavar="KW", help="邮箱或用户名包含该关键词")
    grp_data.add_argument("--sort", default=None, choices=cfgmod.SORT_KEYS,
                          help="排序字段（默认 id）")
    grp_data.add_argument("--desc", action="store_true", help="倒序")
    grp_data.add_argument("--limit", type=int, default=None, metavar="N",
                          help="最多显示 N 条")

    grp_run = parser.add_argument_group("运行")
    grp_run.add_argument("--log-level", default=None, choices=cfgmod.LOG_LEVELS,
                         help="日志级别（默认 INFO）")
    grp_run.add_argument("--log-file", default=None, metavar="PATH", help="日志追加写入该文件")
    grp_run.add_argument("--dry-run", action="store_true", help="只显示将做什么，不改数据/不写文件")
    grp_run.add_argument("--quiet", action="store_true", help="只输出结果，不输出过程日志")
    grp_run.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def config_from_args(args: argparse.Namespace) -> cfgmod.Config:
    """环境变量打底，命令行覆盖；命令行里的非法值直接报 ConfigError。"""
    cfg = cfgmod.Config.from_env()

    updates: dict = {
        "db_path": args.db,
        "export_dir": args.export_dir,
        "log_file": args.log_file,
        "filter_email": args.filter_email,
        "filter_role": args.role,
        "filter_keyword": args.keyword,
        "descending": True if args.desc else None,
        "dry_run": True if args.dry_run else None,
        "quiet": True if args.quiet else None,
    }
    if args.log_level is not None:
        updates["log_level"] = cfgmod.normalize_log_level(args.log_level)
    if args.sort is not None:
        updates["sort_key"] = cfgmod.normalize_sort_key(args.sort)
    if args.limit is not None:
        updates["limit"] = cfgmod.validate_limit(args.limit)
    if args.format is not None:
        updates["output_format"] = cfgmod.normalize_format(args.format)

    return cfg.with_changes(**updates)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def dispatch(args: argparse.Namespace, cfg: cfgmod.Config) -> int:
    """按参数选择动作。互斥组保证同一时间只有一个动作。"""
    if args.stats:
        return action_stats(cfg)
    if args.export:
        # 旧版 --export 固定导出 JSON；只有显式 --format 才改格式
        return action_export(cfg, args.format or "json")
    if args.init:
        return action_init(cfg)
    if args.reset_password:
        return action_reset_password(cfg, *args.reset_password)
    if args.set_role:
        return action_set_role(cfg, *args.set_role)
    if args.delete:
        return action_delete(cfg, args.delete)
    return action_report(cfg, auto_export=not args.no_export)


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)

    try:
        cfg = config_from_args(args)
    except cfgmod.ConfigError as exc:
        print(f"[参数错误] {exc}", file=sys.stderr)
        return EXIT_USAGE

    setup_logging(cfg)
    for note in cfg.env_problems():
        LOG.warning("%s", note)

    LOG.debug("配置：db=%s export=%s format=%s sort=%s desc=%s limit=%s",
              cfg.db_path, cfg.export_dir, cfg.output_format,
              cfg.sort_key, cfg.descending, cfg.limit)

    # 应用路径配置（必须在任何读写之前）。
    # 用 --db 指向自定义库时禁用旧库自动迁移：否则会把项目根的 users.db 也搬进去。
    legacy = cfg.legacy_db if os.path.abspath(cfg.db_path) == os.path.abspath(cfgmod.DEFAULT_DB_PATH) else ""
    ds.configure(db_path=cfg.db_path, legacy_db=legacy)

    if not ds.init_db():
        LOG.warning("账号库初始化失败，将在只读状态下继续（结果可能为空）")

    try:
        code = dispatch(args, cfg)
    except PermissionError as exc:
        print(f"[拒绝] {exc}", file=sys.stderr)
        return EXIT_FORBIDDEN
    except cfgmod.ConfigError as exc:
        print(f"[参数错误] {exc}", file=sys.stderr)
        return EXIT_USAGE
    except KeyboardInterrupt:
        print("\n[中断] 已取消", file=sys.stderr)
        return EXIT_FAILED
    except Exception as exc:  # noqa: BLE001  兜底：不让脚本以 traceback 形式崩给用户
        LOG.exception("未预期的错误")
        print(f"[错误] 执行失败：{exc}", file=sys.stderr)
        return EXIT_FAILED

    LOG.debug("退出码：%s", code)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
