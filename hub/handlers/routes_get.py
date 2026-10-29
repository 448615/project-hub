"""handlers.routes_get — GET 路由分发：仪表盘、配置、项目列表、文档与预览

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import os
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import parse_qs, urlparse

from ..config import BP, SUBAPPS
from ..security import _BROWSE_KEY_TTL, _browse_key
from ..accounts import _accounts_report
from ..projects import public_cards, scan_projects
from ..search_index import search as indexed_search
from ..static_assets import BUNDLE_URL
from ..files import _load_trash_manifest, _safe_trash_name, _trash_root
from .. import diag

class GetMixin:


    def do_GET(self):
        # 兜底异常保护（S5）：扫描子项目、读文件等任何意外都不再让连接被裸奔关闭
        # （异常穿透 socketserver 时浏览器收不到任何 HTTP 响应，服务却仍在跑），
        # 而是统一返回带安全头的 500，让前端拿到明确错误。
        try:
            self._do_get_inner()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # 客户端提前断开（切页/取消下载/curl 提前退出）：正常网络事件，
            # 既不必回 500，也回不出去——回写只会再抛一次异常、刷一屏 traceback。
            pass
        except Exception as exc:  # noqa: BLE001
            # P1 修复：GET 请求走到 500 时，必须把真实异常（含堆栈）记下来，
            # 否则排障时只能看到一个没有上下文的 500 页面。
            diag.note("hub/handlers/routes_get.py::do_GET", exc, tb=True)
            try:
                self._send_error(500, "Internal Error", "服务内部错误，详情见 hub-error.log。")
            except Exception as exc2:  # noqa: BLE001
                diag.note("hub/handlers/routes_get.py::do_GET.send", exc2)


    def _do_get_inner(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path in ("/", "/index.html"):
            self._serve_static("index.html")
            return
        if path == BUNDLE_URL:
            # 前端脚本合并包（虚拟路径，磁盘上不存在）：按 bundle.order 顺序现场拼接。
            # 必须在通用 /static/ 分支之前拦下，否则会走文件读取直接 404。
            self._serve_bundle()
            return
        if path.startswith("/static/"):
            # 去掉 "/static/" 前缀，把剩下的 "xxx" 当成 static 目录内的相对路径
            self._serve_static(path[len("/static/"):])
            return
        # 内置浏览器 · 站点代理（路径式承载目标网址，相对链接才能正确回落到代理）
        if path == "/browse" or path.startswith("/browse/"):
            self._handle_browse()
            return
        # 子应用托管：/apps/starshu/*（Node 反代）与 /apps/workbench/*（静态）
        if SUBAPPS is not None and SUBAPPS.is_app_path(path):
            self._handle_subapp(parsed, method="GET")
            return
        # 健康检查必须排在 /api/ 鉴权闸门之前：部署自检与外部监控拿不到登录态。
        # 免登录只回「能用/不能用 + 版本」，用户数、依赖缺失、端口这类细节仅管理员可见。
        if path == "/api/health":
            from ..health import build
            _u, _err = self._auth_user()
            _admin = bool(_u) and self._role_of(_u) == "admin"
            rep = build(include_detail=_admin)
            self._send_json(rep, status=200 if rep["ok"] else 503)
            return
        # 访客模式：未登录只能看到「脱敏后的项目卡片」。
        # 与上面的 /api/health 同理，必须排在下面的鉴权闸门之前。
        # 刻意不复用 /api/projects：它的返回里带 run（启动命令）、docs（文件路径）、
        # port、preview_url，属于内部部署结构，只该给已登录用户看。
        if path == "/api/public/projects":
            _g = self.config.get("global", {}) or {}
            self._send_json({
                "ok": True,
                "title": _g.get("title", "项目枢纽"),
                "subtitle": _g.get("subtitle", ""),
                "projects": public_cards(scan_projects(self.root, self.config)),
            })
            return
        # 图形验证码：注册前必须先取一张。免登录是必然的（注册的人还没有账号），
        # 所以这里补一道取图频率限制，免得接口被当成免费的 SVG 生成器刷 CPU。
        if path == "/api/captcha":
            from ..captcha import new_challenge
            from ..security import rate_hit
            _wait = rate_hit("captcha:" + self._client_ip(), 40, 60.0)
            if _wait > 0:
                self._send_json({"ok": False, "error": "验证码请求过于频繁，请稍后再试。"},
                                status=429, headers={"Retry-After": str(max(1, int(_wait)))})
                return
            ch = new_challenge()
            # no-store 是必要条件而不是优化：同一张图被浏览器/中间层缓存后反复提交，
            # 会把「一次性令牌」变成可重复使用的固定答案。
            self._send_json({"ok": True, "token": ch["token"], "svg": ch["svg"]},
                            headers={"Cache-Control": "no-store, no-cache, max-age=0"})
            return
        # 账号体系：所有 /api/* 数据接口都必须登录后访问（静态资源除外）。
        # GET 只读接口普通用户即可访问；写接口在 POST 侧单独要求管理员。
        # 身份在每个请求入口解析一次，后续 handler 复用。
        if path.startswith("/api/"):
            if not self._gate_api(parsed, admin_only=False):
                return
            if path == "/api/auth/me":
                # 前端登录后拿身份用：邮箱 + 角色（admin/user）+ 是否云端模式
                # terminal_enabled 让前端在「云端且未开启终端」时隐藏/禁用终端，避免 403 困惑
                from ..handlers.project_post import exec_enabled
                self._send_json({"ok": True, "email": self.user.get("email", ""),
                                 "role": self.role, "cloud": self.cloud,
                                 "terminal_enabled": exec_enabled(self.cloud)})
                return
            if path == "/api/browse/key":
                # 代理页是不透明源、不带 Cookie，前端先把代理密钥取走再拼 /browse 地址
                self._send_json({"ok": True, "key": _browse_key(), "ttl": int(_BROWSE_KEY_TTL)})
                return
            if path == "/api/rss":
                # 桓梦工作台「实时资讯」用：原实现打在星枢 Node 的 /api/rss 上，
                # 拆成独立子项目后同样受限（同源才能省代理配置），故枢纽侧也提供一份，
                # 白名单与星枢保持一致，避免变成任意地址抓取（SSRF）。
                target = (parse_qs(parsed.query).get("url") or [""])[0]
                _RSS_ALLOW = {
                    "https://sspai.com/feed",
                    "https://36kr.com/feed",
                    "https://news.cctv.com/rss/scrolla.xml",
                    "https://www.v2ex.com/index.xml",
                }
                if target not in _RSS_ALLOW:
                    self._send_json({"ok": False, "error": "订阅源不在白名单内。"}, status=400)
                    return
                try:
                    rq = urllib.request.Request(target, headers={
                        "User-Agent": "Mozilla/5.0 (compatible; ProjectHubRSS/1.0)",
                        "Accept": "application/rss+xml, application/xml, text/xml, */*",
                    })
                    with urllib.request.urlopen(rq, timeout=8) as r:
                        xml = r.read(2 * 1024 * 1024)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/xml; charset=utf-8")
                    self.send_header("Content-Length", str(len(xml)))
                    self.send_header("Cache-Control", "public, max-age=600")
                    self._sec_headers()
                    self.end_headers()
                    self.wfile.write(xml)
                except Exception as e:  # noqa: BLE001
                    diag.note("hub/handlers/routes_get.py::rss", e)
                    self._send_json({"ok": False, "error": f"订阅源抓取失败：{e}"}, status=502)
                return
            if path == "/api/browse/check":
                # 内置浏览器预检：该站点能否被 iframe 直接嵌入？
                # 能 → 直连（站点功能完整）；不能 → 前端改走 /browse 代理。
                u = (parse_qs(parsed.query).get("u") or [""])[0].strip()
                if BP is None or not u:
                    self._send_json({"ok": False, "embeddable": False,
                                     "reason": "缺少网址参数或代理内核未加载"})
                    return
                res = BP.embeddable(u, self._browse_self_hosts())
                self._send_json(dict(res, ok=bool(res.get("ok"))))
                return
            if path == "/api/admin/accounts":                # 数据处理脚本 · 账号报表：仅管理员。服务端强制校验，不依赖前端隐藏。
                if self.role != "admin":
                    self._send_json({"ok": False, "error": "需要管理员权限。"}, status=403)
                    return
                q = parse_qs(parsed.query)
                src = (q.get("source") or ["local"])[0]
                reveal = (q.get("reveal") or ["1"])[0] != "0"
                self._send_json(_accounts_report(src, reveal))
                return
        if path == "/api/projects":
            # 主系统核心接口：返回标题 + 扫描到的子项目列表
            self._send_json({
                "root": os.path.basename(os.path.abspath(self.root)),  # 只返回目录名，不泄露绝对路径
                "title": self.config.get("global", {}).get("title", "项目枢纽"),
                "subtitle": self.config.get("global", {}).get("subtitle", ""),
                "cloud": self.cloud,
                "projects": scan_projects(self.root, self.config),
            })
            return
        if path == "/api/docs":
            # 桌面内文档查看器数据源：只读返回该项目 config 中 docs 指向的文件内容
            self._handle_docs(parsed)
            return
        if path == "/api/files":
            # 桌面内文件管理器：目录列表
            self._handle_files(parsed)
            return
        if path == "/api/file":
            # 桌面内文件管理器：项目内任意文本文件内容（文档查看器预览）
            self._handle_file(parsed)
            return
        if path == "/api/raw":
            # 桌面内文件管理器：图片字节流（内嵌预览，仅图片扩展名）
            self._handle_raw(parsed)
            return
        if path == "/api/trash":
            # 服务器回收站列表（文件管理器里被删除的文件/目录）
            q = parse_qs(parsed.query)
            name = (q.get("project") or [""])[0]
            if not self._is_valid_project(name):
                self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
                return
            manifest = _load_trash_manifest(self.root)
            items = []
            for it in manifest:
                # 回收站清单按项目隔离：仅返回本项目条目；
                # 老版本写入的条目没有 project 字段，视为本项目（向后兼容）
                if it.get("project", name) != name:
                    continue
                tname = _safe_trash_name(it.get("name"))
                trash_file = os.path.join(_trash_root(self.root), tname) if tname else ""
                items.append({
                    "id": it.get("id"),
                    "name": it.get("name"),
                    "orig": it.get("orig"),
                    "deletedAt": it.get("deletedAt", ""),
                    "size": os.path.getsize(trash_file) if trash_file and os.path.isfile(trash_file) else None,
                    "isDir": os.path.isdir(trash_file) if trash_file and os.path.exists(trash_file) else False,
                })
            self._send_json({"ok": True, "items": items})
            return
        if path == "/api/search":
            # 全局文件搜索：文件名含 q（不区分大小写）即命中。
            # 走内存索引（hub/search_index.py）而不是每次 os.walk：索引 90s 一刷新，
            # 文件写操作会主动失效，既快又不会搜不到刚建的文件。
            q = (parse_qs(parsed.query).get("q") or [""])[0].strip().lower()
            self._send_json({"ok": True, "items": indexed_search(self.root, q)})
            return
        # 浏览器会自动请求 /favicon.ico，直接返回 204 避免刷一堆 404
        if path == "/favicon.ico":
            self.send_response(204)
            self._sec_headers()
            self.end_headers()
            return
        # 其余路径一律 404
        self._send_error(404, "Not Found", "页面不存在。")
