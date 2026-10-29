"""handlers.subapp — 子应用（星枢 / 桓梦工作台）转发

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations


from ..config import SUBAPPS

class SubappMixin:


    def _handle_subapp(self, parsed, method: str = "GET"):
        if SUBAPPS is None:
            self._send_error(503, "Service Unavailable", "子应用托管模块未加载。")
            return
        # 目录型挂载必须带尾斜杠：否则 <base> 变成 /apps，页面里的相对路径会全部指错一级
        # （纯导航重定向，不鉴权）
        for app in SUBAPPS.APPS:
            bare = app["prefix"].rstrip("/")
            if parsed.path == bare:
                q = ("?" + parsed.query) if parsed.query else ""
                self.send_response(301)
                self.send_header("Location", app["prefix"] + q)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        app, sub = SUBAPPS.match(parsed.path)
        if app is None:
            if parsed.path in ("/apps", "/apps/"):
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_error(404, "Not Found", "没有这个子应用。")
            return

        # 静态型子应用（如桓梦工作台：纯前端构建产物，数据存浏览器本地 IndexedDB/localStorage，
        # 无敏感后端数据）：GET/HEAD 免登录直接伺服。未登录也能打开工作台、自动加载默认音乐
        # 《勾指起誓》并播放；写方法仍走下面的鉴权（静态应用本身没有写接口，双保险）。
        if app["kind"] == "static" and method in ("GET", "HEAD"):
            SUBAPPS.serve_static(self, app, sub, self.root)
            return

        # 其余路径（星枢等 Node 进程型 + 所有写方法）一律要求已登录枢纽：
        # 桌面是唯一入口，未登录时不该能直接猜 /apps/… 打开。
        _u, _err = self._auth_user()
        if _err == "unavailable":
            self._send_error(503, "Service Unavailable", "账号服务暂时不可用，请稍后重试。")
            return
        if not _u:
            if "/api/" in parsed.path:
                self._send_json({"ok": False, "error": "未登录或登录已过期。"}, status=401)
            else:
                # 导航请求：回桌面去登录，体验上比抛一段 JSON 好
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                self.end_headers()
            return

        if app["kind"] == "static":
            SUBAPPS.serve_static(self, app, sub, self.root)
            return

        ok, note = SUBAPPS.ensure_running(app, self.root)
        if not ok:
            # 子应用自己的 AJAX（/apps/xxx/api/…）拿到 HTML 只会让前端 JSON.parse 失败，
            # 因此这类请求一律回结构化 JSON，由前端决定要不要重试。
            is_json = "/api/" in parsed.path
            starting = note == getattr(SUBAPPS, "NOTE_STARTING", "starting")
            if is_json:
                st = SUBAPPS.app_status(app) if hasattr(SUBAPPS, "app_status") else {}
                self._send_json({
                    "ok": False,
                    "starting": starting,
                    "error": (st.get("note") or "正在启动，请稍候…") if starting else note,
                }, status=503)
                return
            if starting:
                # 首次启动（尤其要装依赖）可能要几十秒。这里不再让浏览器干等：
                # 立刻回一张「正在启动」页，页面自己每 2 秒重试一次，就绪后自动进入。
                st = SUBAPPS.app_status(app) if hasattr(SUBAPPS, "app_status") else {}
                body = SUBAPPS.app_page(
                    f"「{app['name']}」正在启动",
                    st.get("note") or "正在准备运行环境，请稍候…",
                    "首次打开需要安装运行依赖，通常 30–90 秒。本页会自动重试，无需手动刷新。",
                    refresh=2,
                )
                self.send_response(503)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Retry-After", "2")
                self.end_headers()
                self.wfile.write(body)
                return
            body = SUBAPPS.app_page(
                f"「{app['name']}」没能启动", note,
                "排查顺序：① 已安装 Node.js（node -v）；② 子项目目录执行过 npm install；"
                f"③ 端口 {app.get('port')} 未被其它程序占用。日志见 {app.get('log', '')}")
            self.send_response(503)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return

        body = None
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            try:
                body = self._read_raw_body()
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": f"请求体读取失败：{e}"}, status=413)
                return
        tail = sub + (("?" + parsed.query) if parsed.query else "")
        SUBAPPS.proxy(self, app, tail, method, body)

    # 星枢的内容编辑用 PUT/PATCH/DELETE，枢纽本身不需要它们：
    # 只转发到子应用，其余方法一律 405（比 BaseHTTPRequestHandler 默认的 501 更准确）
