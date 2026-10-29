"""handlers.api_post — POST 路由入口：只做分流，具体实现见同目录各 *_post 模块

分流顺序**不可调换**：
  1. 子应用托管（星枢的登录、建文章等）——必须最先，否则会落到枢纽的 /api 逻辑
  2. /browse/ 代理页的 AJAX 转发
  3. 免登录闸门：/api/auth/login|register-code|register|logout（自带校验与限流）
  4. 写接口统一闸门：已登录 + 管理员角色 + 同源校验
  5. 管理接口 → admin_post.py
  6. 项目 / 文件写操作 → project_post.py
  7. 文件管理器与回收站 → files_write.py
  8. 项目动作 /api/projects/<name>/(start|stop|open|docs)
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlparse

from ..config import SUBAPPS
from .. import diag


class ApiPostMixin:

    def do_POST(self):
        parsed = urlparse(self.path)
        if self._reject_chunked():
            return
        try:
            self._do_post_impl(parsed)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:  # noqa: BLE001
            # 兜底：任意未捕获异常都转成 JSON 500，避免连接裸死导致前端只收到网络错误
            try:
                self._send_json({"ok": False, "error": f"服务器错误：{e}"}, status=500)
            except Exception as exc:  # noqa: BLE001
                diag.note("hub/handlers/api_post.py::do_POST", exc)

    def _do_post_impl(self, parsed):
        path = parsed.path

        # 1. 子应用托管：星枢的登录、建文章等都是 POST，必须最先分流
        if SUBAPPS is not None and SUBAPPS.is_app_path(path):
            self._handle_subapp(parsed, method="POST")
            return

        # 2. 内置浏览器 · 代理页的 AJAX 转发（站点跨域接口被 CORS 拦住时走这里）
        if path.startswith("/browse/"):
            self._handle_browse(method="POST")
            return

        # 3. 账号体系·登录 / 注册 / 发码 / 登出（免登录闸门，实现见 auth_post.py）
        if path == "/api/auth/login":
            self._post_login()
            return
        if path == "/api/auth/register-code":
            self._post_register_code()
            return
        if path == "/api/auth/register":
            self._post_register()
            return
        if path == "/api/auth/logout":
            self._post_logout()
            return

        # 4. 账号体系：所有写接口要求「已登录 + 管理员角色」。
        # 这一条同时替代了旧的「云端一刀切只读」策略——现在公网上管理员（拥有者）
        # 登录后可用全功能；普通用户在任何环境（本地/云端）只有 GET 只读能力。
        # 邮箱 → 角色的判定在 _gate_api 内完成（config.json 的 admins 名单）。
        if not self._gate_api(parsed, admin_only=True):
            return
        # 同源校验（纵深防御）：写请求带自定义 Authorization 头，跨站页面发请求会
        # 触发 CORS 预检且拿不到用户令牌；这里再兜一层，挡住同机恶意网页盲打。
        if not self._is_same_origin():
            self._send_json({"ok": False, "error": "拒绝跨域请求（同源校验未通过）。"}, status=403)
            return

        # 5. 管理员账号维护（云端同步 / 改密改角色删除），实现见 admin_post.py
        if path == "/api/admin/accounts/sync":
            self._post_accounts_sync()
            return
        if path == "/api/admin/accounts/update":
            self._post_accounts_update()
            return

        # 6. 项目与文件写操作（终端 / 保存文件 / 新建项目），实现见 project_post.py
        if path == "/api/exec":
            self._post_exec()
            return
        if path == "/api/file/write":
            self._post_file_write()
            return
        if path == "/api/project/create":
            self._post_project_create()
            return

        # 7. 文件管理器与服务器回收站，实现见 files_write.py
        if path == "/api/fs":
            self._handle_fs(parsed)
            return
        if path == "/api/trash/restore":
            self._handle_trash_restore(parsed)
            return
        if path == "/api/trash/empty":
            self._handle_trash_empty(parsed)
            return
        if path == "/api/trash/remove":
            self._handle_trash_remove(parsed)
            return

        # 8. 项目动作：/api/projects/<name>/(start|stop|open|docs)
        m = re.match(r"^/api/projects/([^/]+)/(start|stop|open|docs)$", path)
        if not m:
            self._send_error(404, "Not Found", "接口不存在。")
            return
        self._post_project_action(parsed, unquote(m.group(1)), m.group(2))
