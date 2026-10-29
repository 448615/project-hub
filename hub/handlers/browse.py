"""handlers.browse — 内置浏览器代理路由

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlparse

from ..config import BP, _REASON_PHRASE
from ..security import _browse_key, _browse_key_ok
from .. import diag

class BrowseMixin:


    def _browse_self_hosts(self) -> set:
        """枢纽自身的域名集合：禁止把枢纽代理进自己（防自环）。"""
        hosts = set()
        h = (self.headers.get("Host") or "").split(":")[0].strip().lower()
        if h:
            hosts.add(h)
        try:
            for o in (self.config.get("allowed_origins") or []):
                hn = (urlparse(str(o)).hostname or "").lower()
                if hn:
                    hosts.add(hn)
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/handlers/browse.py::_browse_self_hosts", exc)
        return hosts


    def _browse_error_page(self, code: int, title: str, msg: str, detail: str = ""):
        """代理错误页：展示在 iframe 内部，因此**不能**带 X-Frame-Options: DENY。

        页面末尾会把错误码 postMessage 给父窗口（内置浏览器），前端据此区分
        「站点拒绝代理 / 上游无响应 / 登录失效」，而不是一律显示「打不开」。
        """
        safe = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;")
                          .replace(">", "&gt;").replace('"', "&quot;"))
        notify = (
            "<script>try{parent.postMessage({__hubBrowse:1,err:%d,msg:%s},'*')}catch(e){}</script>"
            % (int(code), json.dumps(title, ensure_ascii=False).replace("</", "<\\/"))
        )
        body = (
            "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
            f"<title>{code} · {safe(title)}</title><style>"
            "html,body{margin:0;height:100%;background:#f5f8ff;color:#1e2a3f;"
            "font:15px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}"
            ".b{max-width:520px;margin:12vh auto;padding:28px 30px;background:#fff;"
            "border-radius:16px;box-shadow:0 12px 36px rgba(40,70,130,.12)}"
            ".c{font-size:34px;font-weight:700;color:#5B8CFF;letter-spacing:1px}"
            "h2{font-size:16px;margin:10px 0 6px}p{margin:6px 0;color:#5d6c85}"
            ".d{margin-top:14px;padding:10px 12px;background:#f2f6ff;border-radius:9px;"
            "color:#5d6c85;font-size:12.5px;word-break:break-all}"
            "</style></head><body><div class='b'>"
            f"<div class='c'>{code}</div><h2>{safe(title)}</h2><p>{safe(msg)}</p>"
            + (f"<div class='d'>{safe(detail)}</div>" if detail else "") +
            f"</div>{notify}</body></html>"
        ).encode("utf-8")
        # 状态行只能是 ASCII（HTTP 规范），中文标题只放在页面正文里
        self.send_response_only(code, _REASON_PHRASE.get(code, "Error"))
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


    def _handle_browse(self, method: str = "GET"):
        """/browse/<真实网址>：取回目标页面 → 改写链接 → 回给 iframe。

        method="POST" 时用于代理页发起的 AJAX（跨域接口被 CORS 拦住的情况），
        请求体与 Content-Type 原样转发给上游。
        """
        if BP is None:
            self._browse_error_page(503, "代理内核不可用",
                                    "服务端未能加载 browse_proxy.py，内置浏览器暂不可用。")
            return
        # 代理是出站请求通道：必须已登录后才可用（避免被当成公开开放代理）。
        # 两种凭证任取其一：
        #   1) URL 里的代理密钥 —— 代理页被降级为不透明源后浏览器不再带 Cookie，
        #      子资源/子请求只能靠它；密钥由 /api/browse/key 发给登录用户，短期有效。
        #   2) Cookie 会话 —— 兼容旧链接与「直接在新标签打开 /browse/…」的场景。
        bk = BP.key_of(self.path)
        key_ok = _browse_key_ok(bk)
        if not key_ok:
            user, _err = self._auth_user()
            if not user:
                self._browse_error_page(401, "需要登录",
                                        "内置浏览器仅登录后可用，请回到枢纽页面登录后再试。")
                return
            # 顶层请求靠 Cookie 过关（旧链接 / 新标签直接打开），但沙箱 iframe 里的
            # 子资源请求不会再带 Cookie。此时必须补一个当期密钥去改写页面，
            # 否则 CSS/JS/图片全 401，用户看到的是「一片黑/白」而不是完整页面。
            bk = _browse_key()
        # 让本请求内所有链接改写都带上同一个密钥
        BP.set_key(bk)
        # 云端平台网关按分享码放行；沙箱 iframe 的子资源请求带不上 Cookie，
        # 所以把 sharecode 透传到改写出的每一个地址上（本地无此参数，透传空串即可）。
        # 注意：网关放行后会把自己认的 sharecode 从转发请求里剔掉，故优先取 _hs 副本。
        try:
            _q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            _share = ((_q.get("_hs") or _q.get("sharecode") or [""])[0] or "").strip()
            BP.set_share(_share)
        except Exception:  # noqa: BLE001
            BP.set_share("")
        target = BP.target_of(self.path)
        if not target:
            self._browse_error_page(400, "网址无效",
                                    "请在地址栏输入完整网址（需 http:// 或 https:// 开头）。")
            return
        ok, reason = BP.is_allowed(target, self._browse_self_hosts())
        if not ok:
            self._browse_error_page(403, "已拦下该请求", reason)
            return

        req_body = None
        extra = {}
        if method != "GET":
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            req_body = self.rfile.read(min(n, 4 * 1024 * 1024)) if n > 0 else b""
            ct = (self.headers.get("Content-Type") or "").strip()
            if ct:
                extra["Content-Type"] = ct
        # 上游接口常按 Referer 校验来源：优先用代理页上报的真实页面地址
        ref = (self.headers.get("X-Hub-Ref") or "").strip()
        referer = ref if re.match(r"^https?://", ref) else BP.origin_of(target)
        try:
            status, headers, data, final = BP.fetch(
                target, method=method, referer=referer, body=req_body,
                extra_headers=extra)
        except Exception as exc:  # noqa: BLE001
            self._browse_error_page(502, "无法访问该网站",
                                    "目标站点无响应、超时或拒绝连接，可点右上角 ↗ 用系统浏览器打开。",
                                    str(exc)[:160])
            return

        ctype = (headers.get("Content-Type") or "").strip()
        low = ctype.lower()
        body = data
        is_html = ("text/html" in low or "application/xhtml" in low
                   or (not low and data[:200].lstrip().lower().startswith(b"<!doctype html")))
        if is_html:
            text = BP.decode_text(data, ctype)
            body = BP.rewrite_html(text, final).encode("utf-8")
            ctype = "text/html; charset=utf-8"
        elif "text/css" in low:
            text = BP.decode_text(data, ctype)
            body = BP.rewrite_css(text, final).encode("utf-8")
            ctype = "text/css; charset=utf-8"
        elif ("javascript" in low or "ecmascript" in low):
            # 站点脚本里指向官方域名的 location 跳转要改成走父窗口，
            # 否则浏览器会真的离开代理页面，被目标站的嵌入策略拦成空白。
            text = BP.decode_text(data, ctype)
            body = BP.rewrite_js(text).encode("utf-8")
            ctype = "application/javascript; charset=utf-8"
        elif not low:
            ctype = "application/octet-stream"

        self.send_response(status if 200 <= status < 600 else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # 关键：这里不发 X-Frame-Options、不发本站严格 CSP。
        # 前者会让 iframe 直接拒绝显示，后者会连带禁掉目标站点自己的脚本/图片。
        # 安全边界靠下面这条 CSP sandbox：把代理页强制降级成「不透明源」，
        # 站点 JS 因此拿不到父窗口、也带不上 Cookie（否则它能直接调 /api/exec）。
        # 注意：绝不能加 allow-same-origin，否则整条防线失效。
        self.send_header("Content-Security-Policy",
                         "sandbox allow-scripts allow-forms allow-popups "
                         "allow-modals allow-downloads")
        # 不透明源下的 fetch 属于跨源请求，需要 CORS 头才允许读取响应；
        # 这与上面「不带 Cookie」是一套：密钥在 URL 里，不依赖凭据。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache" if is_html else "public, max-age=300")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)
