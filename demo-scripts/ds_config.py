"""数据处理脚本 · 配置层（零依赖，仅标准库）。

职责
----
集中管理脚本的全部可调参数，让「路径、日志、输出格式、权限来源」不再散落在
各个文件里。任何模块都不应该硬编码路径或阈值，一律从这里取。

取值优先级
----------
    命令行参数  >  环境变量  >  内置默认值

环境变量
--------
===========================  ==================================================
DATA_SCRIPTS_DB              账号库路径（默认 demo-scripts/hub_accounts.db）
DATA_SCRIPTS_EXPORT_DIR      导出目录（默认 demo-scripts/exports/）
DATA_SCRIPTS_LOG_LEVEL       DEBUG / INFO / WARNING / ERROR / CRITICAL（默认 INFO）
DATA_SCRIPTS_LOG_FILE        日志文件路径（追加写入；留空则只输出到 stderr）
HUB_OPERATOR_EMAIL           操作者邮箱（枢纽「一键运行」时自动注入）
HUB_OPERATOR_ROLE            操作者角色（只有 admin 能看账号明细）
===========================  ==================================================

说明：``HUB_OPERATOR_*`` 沿用枢纽既有约定，改名会破坏 hub.py 的注入，故保留。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace

# ---------------------------------------------------------------------------
# 默认路径：全部相对于本脚本所在目录推导，脚本复制到别处也能自洽运行
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)

DEFAULT_DB_PATH = os.path.join(HERE, "hub_accounts.db")
DEFAULT_KEY_PATH = os.path.join(PROJECT_ROOT, ".data", "secret.key")
DEFAULT_LEGACY_DB = os.path.join(PROJECT_ROOT, "users.db")
DEFAULT_EXPORT_DIR = os.path.join(HERE, "exports")

# ---------------------------------------------------------------------------
# 取值范围（CLI 校验与文档共用同一份定义，避免两处各写一套）
# ---------------------------------------------------------------------------
LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")
ROLES = ("admin", "user")
OUTPUT_FORMATS = ("table", "json", "csv")
SORT_KEYS = ("id", "email", "username", "role", "created_at", "updated_at")

# 密码最小长度：与 hub.py 的注册/改密校验保持一致（6 位）
MIN_PASSWORD_LEN = 6
# 单字段长度上限：防御异常输入撑爆数据库/日志（不是业务规则，只是安全边界）
MAX_FIELD_LEN = 1024


class ConfigError(ValueError):
    """配置项非法（取值不在允许范围内、路径不可用等）。"""


@dataclass(frozen=True)
class Config:
    """一次运行所需的全部参数（不可变，改值用 :meth:`with_changes`）。"""

    # 路径
    db_path: str = DEFAULT_DB_PATH
    key_path: str = DEFAULT_KEY_PATH
    legacy_db: str = DEFAULT_LEGACY_DB
    export_dir: str = DEFAULT_EXPORT_DIR

    # 日志
    log_level: str = "INFO"
    log_file: str = ""

    # 权限
    operator_email: str = ""
    operator_role: str = ""

    # 输出
    output_format: str = "table"
    sort_key: str = "id"
    descending: bool = False
    limit: int = 0

    # 过滤
    filter_email: str = ""
    filter_role: str = ""
    filter_keyword: str = ""

    # 行为
    dry_run: bool = False
    quiet: bool = False

    # 环境变量降级说明（由 from_env 填充，不参与比较/打印）
    env_notes: tuple = field(default=(), compare=False, repr=False)

    # -- 派生属性 ----------------------------------------------------------
    @property
    def is_admin(self) -> bool:
        """当前操作者是否为管理员。命令行未注入身份时一律按非管理员处理。"""
        return self.operator_role == "admin"

    @property
    def operator_label(self) -> str:
        """给日志/提示用的操作者描述。"""
        if not self.operator_email and not self.operator_role:
            return "未登录 / 命令行"
        return f"{self.operator_email or '未知邮箱'}（{self.operator_role or '未知角色'}）"

    # -- 构造与覆盖 --------------------------------------------------------
    def with_changes(self, **kwargs) -> "Config":
        """返回叠加改动后的新配置；忽略值为 ``None`` 的项（表示"未指定"）。"""
        patch = {k: v for k, v in kwargs.items() if v is not None}
        return replace(self, **patch)

    @classmethod
    def from_env(cls, environ: dict | None = None) -> "Config":
        """读取环境变量构造配置；非法值降级为默认并记录原因，不抛异常。

        设计取舍：环境变量是外部输入，写错一个日志级别不该让整个报表跑不起来，
        所以这里"容错降级"；命令行参数才严格报错（用户当场能看到并改正）。
        """
        env = os.environ if environ is None else environ
        cfg = cls()
        problems: list[str] = []

        db = (env.get("DATA_SCRIPTS_DB") or "").strip()
        if db:
            cfg = replace(cfg, db_path=db)

        export_dir = (env.get("DATA_SCRIPTS_EXPORT_DIR") or "").strip()
        if export_dir:
            cfg = replace(cfg, export_dir=export_dir)

        level = (env.get("DATA_SCRIPTS_LOG_LEVEL") or "").strip().upper()
        if level:
            if level in LOG_LEVELS:
                cfg = replace(cfg, log_level=level)
            else:
                problems.append(f"DATA_SCRIPTS_LOG_LEVEL={level!r} 非法，已回退 INFO")

        log_file = (env.get("DATA_SCRIPTS_LOG_FILE") or "").strip()
        if log_file:
            cfg = replace(cfg, log_file=log_file)

        cfg = replace(
            cfg,
            operator_email=(env.get("HUB_OPERATOR_EMAIL") or "").strip().lower(),
            operator_role=(env.get("HUB_OPERATOR_ROLE") or "").strip().lower(),
        )

        # 把降级原因挂在配置上，由调用方在初始化日志后打印
        return replace(cfg, env_notes=tuple(problems))

    def env_problems(self) -> tuple[str, ...]:
        """环境变量解析过程中的降级说明（供 CLI 打印告警）。"""
        return tuple(self.env_notes)


# ---------------------------------------------------------------------------
# 校验工具：CLI 与测试共用，避免"校验规则只写在 argparse 里"
# ---------------------------------------------------------------------------
def normalize_log_level(value: str) -> str:
    level = str(value or "").strip().upper()
    if level not in LOG_LEVELS:
        raise ConfigError(f"日志级别必须是 {'/'.join(LOG_LEVELS)} 之一，收到 {value!r}")
    return level


def normalize_role(value: str) -> str:
    role = str(value or "").strip().lower()
    if role not in ROLES:
        raise ConfigError(f"角色必须是 {'/'.join(ROLES)} 之一，收到 {value!r}")
    return role


def normalize_format(value: str) -> str:
    fmt = str(value or "").strip().lower()
    if fmt not in OUTPUT_FORMATS:
        raise ConfigError(f"输出格式必须是 {'/'.join(OUTPUT_FORMATS)} 之一，收到 {value!r}")
    return fmt


def normalize_sort_key(value: str) -> str:
    key = str(value or "").strip().lower()
    if key not in SORT_KEYS:
        raise ConfigError(f"排序字段必须是 {'/'.join(SORT_KEYS)} 之一，收到 {value!r}")
    return key


def validate_email(email: str) -> str:
    """宽松但够用的邮箱校验（不引入第三方库，也不追求 RFC 完备）。

    只挡明显错误：空串、无 ``@``、域名不含点/以点开头结尾/连续点、含空白、超长。
    """
    value = str(email or "").strip()
    if not value:
        raise ConfigError("邮箱不能为空")
    if len(value) > MAX_FIELD_LEN:
        raise ConfigError(f"邮箱过长（>{MAX_FIELD_LEN} 字符）")
    if any(ch.isspace() for ch in value):
        raise ConfigError(f"邮箱不能包含空白字符：{value!r}")
    local, _, domain = value.partition("@")
    if not local or not domain:
        raise ConfigError(f"邮箱格式不正确：{value!r}")
    if "." not in domain or domain.startswith(".") or domain.endswith(".") or ".." in domain:
        raise ConfigError(f"邮箱域名不合法：{value!r}")
    return value


def validate_password(pwd: str, *, min_len: int = MIN_PASSWORD_LEN) -> str:
    value = "" if pwd is None else str(pwd)
    if not value:
        raise ConfigError("密码不能为空")
    if len(value) < min_len:
        raise ConfigError(f"密码至少 {min_len} 位")
    if len(value) > MAX_FIELD_LEN:
        raise ConfigError(f"密码过长（>{MAX_FIELD_LEN} 字符）")
    return value


def validate_limit(value: int) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        raise ConfigError(f"条数上限必须是整数，收到 {value!r}") from None
    if limit < 0:
        raise ConfigError("条数上限不能为负数")
    return limit


def ensure_dir(path: str) -> str:
    """确保目录存在（幂等）；不可创建时抛出带路径的明确错误。"""
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"目录不可用：{path}（{exc}）") from exc
    return path
