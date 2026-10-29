"""config — 配置与常量：路径、限额、端口白名单无关的通用常量、config.json 加载

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import json
import os
import sys
import threading

from . import diag

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 保证能以「脚本所在目录」为基准 import 同目录模块（云端 / start.py 拉起时 cwd 可能不同）
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 内置浏览器的站点代理内核（零依赖标准库实现，详见 browse_proxy.py）
try:
    import browse_proxy as BP
except Exception as _bp_err:  # noqa: BLE001
    BP = None
    print(f"[warn] 浏览器代理内核加载失败，内置浏览器将只能直连：{_bp_err}")

# 子应用托管（星枢 CMS / 桓梦工作台，详见 subapps.py）
try:
    import subapps as SUBAPPS
except Exception as _sa_err:  # noqa: BLE001
    SUBAPPS = None
    print(f"[warn] 子应用托管模块加载失败，桌面内的星枢/工作台将不可用：{_sa_err}")

ADMINS = set()   # 管理员邮箱集合（main() 启动时填充；集中放在此处避免与 HTTP 层循环依赖）


_REASON_PHRASE = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 408: "Request Timeout", 429: "Too Many Requests",
    500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
    508: "Loop Detected",
}

# 记录当前由本枢纽拉起、仍在运行的子进程。键为项目名，值为 subprocess.Popen 对象。
# 用于「一键启动 / 停止」以及退出时统一清理。
# 安全说明：启动命令只来自 config.json 的 run 字段（作者自己维护的可信配置），
# 绝不拼接任何用户输入，因此不存在命令注入风险。


DOC_MAX_BYTES = 512 * 1024


DOC_ALLOW_EXTS = (".md", ".markdown", ".txt")

# 桌面内「文件管理器」（访达式窗口）限制


FM_MAX_ENTRIES = 1000             # 单目录最多返回的条目数，防止超大目录拖垮前端


FILE_MAX_BYTES = 512 * 1024       # 文本预览上限（与文档查看器一致）


FILE_TEXT_EXTS = (                # 可在桌面内预览的文本类型
    ".md", ".markdown", ".txt", ".json", ".js", ".css", ".html", ".py",
    ".csv", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".sh", ".bat", ".xml", ".log",
)


RAW_MAX_BYTES = 5 * 1024 * 1024   # 图片预览上限


RAW_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg")

# 服务器端文件回收站：删除的文件/目录移到项目根下 .hub-trash（隐藏目录，扫描/列表自动排除）


TRASH_DIR = ".hub-trash"


TRASH_MANIFEST = "manifest.json"


_DS_DIR = os.path.join(HERE, "demo-scripts")


DB_PATH = os.path.join(_DS_DIR, "hub_accounts.db")


_KEY_DIR = os.path.join(HERE, ".data")


KEY_PATH = os.path.join(_KEY_DIR, "secret.key")


_SESSION_TTL = 7 * 24 * 3600.0   # 会话有效期 7 天


def load_config(root: str) -> dict:
    path = os.path.join(root, "config.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        # P1 修复：config.json 损坏时全站静默降级为默认值（空配置），仅 print 在云端不可见。
        # 记录到诊断日志，否则排障时完全不知道是配置问题还是代码问题。
        print(f"[warn] 读取 config.json 失败：{e}")
        diag.note("hub/config.py::load_config", e)
        return {}


# --------------------------------------------------------------------------
# 账号体系：自托管本地账号库（邮箱 + 密码；注册需「图形验证码 + 邮箱验证码」）
# --------------------------------------------------------------------------
# 登录只用密码，由本机验密（hub/handlers/auth_post.py）；注册多一道「邮箱所有权」
# 证明：hub/cloudauth.py 让平台邮件服务发真邮件，验码通过才建号。云端只承担发信
# 与验码，不碰账号、密码与会话；没配云服务时自动退回只认图形验证码。
# 登录态由「仅服务端持有的 SECRET_KEY」签名的会话 Cookie 承载：
#   登录成功 → 服务端本地验密 → 签 HttpOnly Cookie → 后续请求本地验签放行，永不回源。
# 用途：个人/局域网自托管场景，账号与密码哈希落在本机磁盘，跨重启保持。
# 边界说明：无状态云端沙箱不保证磁盘持久，部署到云端时 users.db 可能随容器回收
# 而丢失（需另行做持久化）；本地 127.0.0.1 运行不受影响。
# 账号数据统一落在「数据处理脚本」项目内（demo-scripts/hub_accounts.db），
# 由 demo-scripts/data_store.py 管理；枢纽与脚本共享同一份数据，脚本可独立运行。


RUNNING = {}
# ThreadingHTTPServer 下请求是并发处理的，用一把锁保证
# 「检查是否已运行 → 启动 → 写入 RUNNING」是原子操作。
# 否则两个并发 start 会同时通过检查、各拉起一个进程，后写入的覆盖前一个，
# 前一个进程脱离管控（停不掉、退出时不清理、继续占端口）。


RUNNING_LOCK = threading.Lock()

# 桌面内「文档查看器」读取限制：只放行纯文本文档、限制单文件大小，
# 避免接口被当成任意文件读取器（读大文件/二进制耗尽内存）。
