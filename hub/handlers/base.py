"""handlers.base — HTTP 基类：JSON 响应、静态资源、安全头、同源校验、身份与权限闸门

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import json
import os
from urllib.parse import urlparse

from ..config import HERE
from ..static_assets import MIN_GZIP_BYTES, bundle_bytes, gzip_bytes, is_compressible
from ..security import CSP_HEADER, _SESSION_COOKIE_NAME, _is_https_request, _verify_session
from ..accounts import _role_for_email
from .. import diag


# 静态文件超过此阈值走分块流式（避免大文件整块塞内存）；小文件仍一次性发送以保留 gzip
STATIC_STREAM_THRESHOLD = 256 * 1024


def _stream_file_local(handler, path: str, offset: int, length: int) -> None:
    """分块发送文件片段，不把整个文件读进内存（与 subapps._stream_file 同思路）。

    大文件（背景图、音视频）原来 f.read() 整块入内存，并发请求时内存尖峰明显；
    分块后常驻内存只剩 64KB 一块。客户端中途断开时关掉连接，避免半个响应体污染
    同一条 keep-alive 上的下一个请求。
    """
    remaining = length
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                try:
                    handler.wfile.write(chunk)
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
                    try:
                        handler.close_connection = True
                    except Exception:  # noqa: BLE001
                        pass
                    return
                remaining -= len(chunk)
    except OSError:
        try:
            handler.close_connection = True
        except Exception:  # noqa: BLE001
            pass


class _HeadWriter:
    """HEAD 响应体代理：转发头部块，丢弃其后所有写入（响应体）。

    让 do_HEAD 直接复用 do_GET 的全部路由与鉴权，而无需为每个接口单独写 HEAD 分支：
    end_headers 写入的头部块（含 \\r\\n\\r\\n 终止符）原样转发，之后出现的 body 写入全部丢弃。
    """
    def __init__(self, real):
        self._real = real
        self._body = False

    def write(self, b):
        if self._body:
            return None
        data = b if isinstance(b, (bytes, bytearray)) else str(b).encode("latin-1", "replace")
        if b"\r\n\r\n" in data:
            head, _, _ = data.partition(b"\r\n\r\n")
            self._real.write(head + b"\r\n\r\n")
            self._body = True
            return len(b)
        return self._real.write(b)

    def flush(self):
        return self._real.flush()


class BaseMixin:
    root = "."
    config = {}
    cloud = False   # 云端演示模式（--cloud）：绑 0.0.0.0 + 读 $PORT；写接口按「管理员角色」放行而非一刀切禁掉
    admins = set()  # 管理员邮箱集合（config.json 的 admins + 环境变量 HUB_ADMINS）

    # ---- 账号体系：请求级身份 ----


    def _auth_user(self):
        """解析并校验签名会话 Cookie。返回 (user, err_kind)。
        err_kind：None 成功 / "invalid" 未登录或过期。
        登录成功后由本端用 SECRET_KEY 签名 HttpOnly Cookie，后续请求本地验签即可
        放行，不依赖任何外部账号服务。"""
        cookie = self._session_cookie()
        if not cookie:
            return None, "invalid"
        payload = _verify_session(cookie)
        if not payload or not payload.get("sub"):
            return None, "invalid"
        email = str(payload.get("email", "")).strip().lower()
        return {"email": email, "uid": str(payload.get("sub", ""))}, None


    def _session_cookie(self):
        """从 Cookie 头取出签名会话令牌（hub_sess）。"""
        raw = self.headers.get("Cookie", "") or ""
        name = _SESSION_COOKIE_NAME + "="
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(name):
                return part[len(name):]
        return ""


    def _role_of(self, user) -> str:
        return _role_for_email((user or {}).get("email"))


    def _gate_api(self, parsed, admin_only: bool):
        """API 统一鉴权闸门（GET 读接口与 POST 写接口共用）。

        返回 True 表示已放行；返回 False 表示已直接响应错误，调用方应 return。
        - 所有 /api/* 都要求有效登录（普通用户即可访问只读接口）；
        - admin_only=True 时额外要求管理员角色（写接口 / 命令执行）。
        """
        user, err = self._auth_user()
        if err == "unavailable":
            self._send_json({"ok": False, "error": "账号服务暂时不可用，请稍后重试。"}, status=503)
            return False
        if not user:
            self._send_json({"ok": False, "error": "未登录或登录已过期，请重新登录。"}, status=401)
            return False
        self.user = user
        self.role = self._role_of(user)
        if admin_only and self.role != "admin":
            self._send_json({"ok": False, "error": "需要管理员权限（当前账号为普通用户）。"}, status=403)
            return False
        return True


    def _sec_headers(self):
        # 安全加固响应头（纵深防御，即使未来代码引入 XSS 也能被这里兜住）：
        # 1) 禁止 MIME 嗅探：防止 .js 被浏览器当成 HTML 执行
        self.send_header("X-Content-Type-Options", "nosniff")
        # 2) 禁止被 <iframe> 嵌套：防点击劫持（只限制本枢纽页面被外部框住，
        #    不影响本枢纽用 iframe 去框 localhost 开发服务）
        self.send_header("X-Frame-Options", "DENY")
        # 3) 内容安全策略：只允许同源脚本/样式/图片，禁止内联脚本与未知外部资源。
        #    script-src 'self'（纯本地，无外部 CDN）、connect-src 'self'。
        #    frame-src 额外放行本机开发服务地址，供「桌面内预览」窗口把
        #    http://127.0.0.1:<port> / http://localhost:<port> 嵌进玻璃窗口；
        #    同时放开 http:/https:，供「内置浏览器」窗口加载已改写/直连的页面。
        #    注意：预览目标本身不应再发 X-Frame-Options / frame-ancestors 限制，
        #    否则浏览器仍会拒绝嵌套（属被预览服务的设定，非本策略可解）。
        self.send_header("Content-Security-Policy", CSP_HEADER)
        # 4) 不把 URL（可能含 sharecode / 查询参数）泄露给外部站点
        self.send_header("Referrer-Policy", "no-referrer")
        # 5) 收紧浏览器能力，避免被内嵌页面滥用摄像头/麦克风/定位
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        # 6) HTTPS 下强制后续请求走 TLS（本地 http://127.0.0.1 不加，否则把自己锁死）
        if _is_https_request(self):
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")


    def _client_ip(self) -> str:
        """真实客户端 IP：云端反代在 X-Forwarded-For 里带原始来源。"""
        try:
            xff = (self.headers.get("X-Forwarded-For", "") or "").split(",")[0].strip()
            if xff:
                return xff
            return self.client_address[0] if self.client_address else ""
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/handlers/base.py::_client_ip", exc)
            return ""


    def _is_same_origin(self) -> bool:
        # 写接口同源校验：只允许来自本枢纽自身页面（同 host:port）的请求，
        # 挡住同机恶意网页对 /api/exec 等写接口的 CSRF 盲打（浏览器会因无 CORS 头
        # 隐藏响应，但命令已被「盲执行」）。
        # 绑定的真实地址取自 http server 实例，端口被自动顺延时也能正确匹配。
        try:
            host, port = self.server.server_address[:2]
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/handlers/base.py::_is_same_origin", exc)
            return False

        allowed_hosts = {str(host).lower(), "localhost", "127.0.0.1", "::1", "[::1]"}

        def _host_ok(h: str) -> bool:
            return h.lower() in allowed_hosts

        origin = self.headers.get("Origin", "")
        # 反向代理 / 云端发布：代理转发时 Host 可能被改写为内部地址，此时用配置白名单
        # （config.json 的 allowed_origins 或环境变量 HUB_ALLOWED_ORIGINS）放行发布域名。
        # 白名单是精确匹配，跨站攻击页的 Origin 不在其中，CSRF 防护不受影响。
        _extra_origins = set()
        try:
            for o in (self.config.get("allowed_origins") or []):
                _extra_origins.add(str(o).strip().rstrip("/").lower())
            for o in (os.environ.get("HUB_ALLOWED_ORIGINS", "") or "").split(","):
                if o.strip():
                    _extra_origins.add(o.strip().rstrip("/").lower())
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/handlers/base.py::_is_same_origin", exc)
        if origin:
            try:
                _op0 = urlparse(origin)
                _hdr_host = (self.headers.get("Host", "") or "").split(" ")[0].strip().lower()
                if (_op0.scheme in ("http", "https") and _op0.netloc
                        and _hdr_host and _op0.netloc.lower() == _hdr_host):
                    return True
                if origin.strip().rstrip("/").lower() in _extra_origins:
                    return True
            except Exception as exc:  # noqa: BLE001
                diag.note("hub/handlers/base.py::_is_same_origin", exc)
        if origin:
            # 同源 fetch/XHR 会带 Origin，跨域攻击页也会带（其自身站点）——据此判别
            try:
                op = urlparse(origin)
                if op.scheme not in ("http", "https"):
                    return False
                if not _host_ok(op.hostname or ""):
                    return False
                op_port = op.port or (80 if op.scheme == "http" else 443)
                return op_port == port
            except Exception as exc:  # noqa: BLE001
                diag.note("hub/handlers/base.py::_is_same_origin", exc)
                return False
        # 无 Origin（旧浏览器/非浏览器客户端）：退查 Host 头
        host_hdr = self.headers.get("Host", "")
        if host_hdr:
            raw = host_hdr.split(" ")[0].strip()
            h = raw.split(":")[0].lower()
            if not _host_ok(h):
                return False
            if ":" in raw:
                try:
                    return int(raw.rsplit(":", 1)[1]) == port
                except ValueError:
                    return False
            return True
        # 既无 Origin 也无 Host：保守拒绝写操作
        return False


    def _send_json(self, obj, status: int = 200, headers: dict | None = None):
        # 把 Python 字典变成 JSON 字符串再编码成字节发给浏览器
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for _k, _v in (headers or {}).items():
            self.send_header(_k, _v)
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)


    def _send_json_with_cookie(self, obj, cookie, status: int = 200):
        # 与 _send_json 相同，但额外写入一个 HttpOnly 会话 Cookie（用于离线放行）。
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Set-Cookie", cookie)
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)


    def _accepts_gzip(self) -> bool:
        """客户端是否接受 gzip（识别 gzip;q=0 这种显式拒绝）。"""
        ae = (self.headers.get("Accept-Encoding") or "").lower()
        if "gzip" not in ae:
            return False
        for part in ae.split(","):
            if part.strip().startswith("gzip") and "q=0" in part.replace(" ", ""):
                return False
        return True


    def _not_modified(self, etag: str) -> bool:
        """If-None-Match 是否命中（弱比较，容忍 W/ 前缀与逗号列表）。"""
        inm = (self.headers.get("If-None-Match") or "").strip()
        if not inm:
            return False
        want = etag.strip().lstrip("W/")
        for tok in inm.split(","):
            tok = tok.strip()
            if tok == "*" or tok.lstrip("W/") == want:
                return True
        return False


    def _send_asset(self, data: bytes, mime: str, version: str,
                    cache_control: str = "no-cache", extra_headers=None):
        """发送静态资产：必要时 gzip，带 ETag，命中 If-None-Match 直接 304。

        version 必须是「内容一变就变」的串（文件用 mtime+size，合并包用内容摘要）。
        ETag 里带 raw/gz 后缀：同一 URL 的两种编码是两个不同表示，不能共用一个 ETag。
        """
        zipped = None
        if len(data) >= MIN_GZIP_BYTES and is_compressible(mime) and self._accepts_gzip():
            zipped = gzip_bytes(f"{version}-gz-{len(data):x}", data)
        etag = f'"{version}-{"gz" if zipped else "raw"}"'
        if self._not_modified(etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Cache-Control", cache_control)
            self._sec_headers()
            self.end_headers()
            return
        body = zipped if zipped else data
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Cache-Control", cache_control)
        if zipped:
            self.send_header("Content-Encoding", "gzip")
        for k, v in (extra_headers or ()):
            self.send_header(k, v)
        self._sec_headers()
        self.end_headers()
        self.wfile.write(body)


    def _serve_bundle(self):
        """前端脚本合并包：按 static/js/bundle.order 顺序拼接后一次下发。

        原来首页 31 个 <script> = 31 次往返；合并成 1 个请求后，配合下面静态资源的
        gzip/ETag，首屏在网络上的开销基本只剩一个文件。
        """
        static_root = os.path.realpath(os.path.join(HERE, "static"))
        try:
            data, ver = bundle_bytes(static_root)
        except Exception:  # noqa: BLE001
            self._send_error(500, "Internal Error", "前端脚本合并失败，详情见 hub-error.log。")
            return
        self._send_asset(data, "application/javascript; charset=utf-8", ver)

    def do_HEAD(self):
        """HEAD = GET 的"只回头部"版本：复用 do_GET 的全部路由、鉴权、静态伺服逻辑。

        HTTP 规范要求 HEAD 返回与 GET 相同的头部、但不得有响应体。这里把 wfile 临时替换成
        _HeadWriter，do_GET 内部该发头的发头、该写体的写成"写空气"，结束再换回原 wfile。
        修复此前子应用静态资源（如 bgm.mp3）HEAD 返回 501 的问题。
        """
        real = self.wfile
        self.wfile = _HeadWriter(real)
        try:
            self.do_GET()
        finally:
            self.wfile = real

    def _serve_static(self, rel_path: str):
        # 防目录穿越：只允许访问 static 目录内的文件
        # static_root 用 realpath 解析成真实绝对路径（会消除 ".." 与符号链接）
        static_root = os.path.realpath(os.path.join(HERE, "static"))
        # 把用户请求的路径拼到 static_root 下，再 realpath 还原真实位置
        # 例如传入 "static/../config.json" 会被还原成 HERE/config.json，
        # 它就不在 static_root 之内，下面检查会拦掉
        full = os.path.realpath(os.path.join(static_root, rel_path))
        # 末尾加分隔符，避免把 "staticX/..." 之类误判成在 static 内
        if not full.startswith(static_root + os.sep) or not os.path.isfile(full):
            self._send_error(404, "Not Found", "请求的文件不存在。")
            return
        # 按文件后缀给浏览器说明内容类型
        ext = os.path.splitext(full)[1].lower()
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(ext, "application/octet-stream")
        try:
            st = os.stat(full)
        except OSError:
            self._send_error(500, "Internal Error", "读取文件时出错。")
            return
        # 小文件：整块读入 + gzip + ETag/304（沿用原逻辑，省内存且首屏快）
        # 大文件（背景图、音视频等）：走分块流式（见 _stream_file_local），
        # 不再把整个文件塞进内存——否则并发请求时内存尖峰明显，且可能 OOM。
        if st.st_size <= STATIC_STREAM_THRESHOLD:
            try:
                with open(full, "rb") as f:
                    data = f.read()
            except OSError:
                self._send_error(500, "Internal Error", "读取文件时出错。")
                return
            # sw.js 放在 /static/ 下但要控制整个站点：允许其 scope 提升到 /
            extra = [("Service-Worker-Allowed", "/")] if rel_path == "sw.js" else None
            # 开发期频繁改动 JS/CSS：仍然 no-cache（每次都问服务器），但带上 ETag，
            # 内容没变时服务器只回一个 304（几十字节），比每次重发 344KB 快得多。
            self._send_asset(data, mime, f"{st.st_mtime_ns:x}-{st.st_size:x}",
                             cache_control="no-cache", extra_headers=extra)
            return
        # 大文件流式分支：已知确切大小，分块写出，内存常驻只剩 64KB 一块。
        # 支持 Range（音视频拖拽/续传）；声明 Accept-Ranges 就必须真正兑现，否则客户端会误判。
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}-raw"'
        range_hdr = self.headers.get("Range")
        if range_hdr and range_hdr.startswith("bytes="):
            spec = range_hdr[len("bytes="):].split(",")[0].strip()
            try:
                a, b = spec.split("-", 1)
                if b and not a:
                    # 后缀形式 bytes=-N：取末尾 N 字节
                    n = int(b)
                    start = max(0, st.st_size - n)
                    end = st.st_size
                else:
                    start = int(a) if a else 0
                    end = int(b) + 1 if b else st.st_size   # "bytes=100-" 表示取到末尾
                    end = min(end, st.st_size)
                start = max(0, start)
            except (ValueError, TypeError):
                start, end = 0, st.st_size
            if start >= st.st_size:
                # 越界：回 416 并告诉客户端合法范围
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{st.st_size}")
                self._sec_headers()
                self.end_headers()
                return
            length = end - start
            self.send_response(206)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Range", f"bytes {start}-{end-1}/{st.st_size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self._sec_headers()
            self.end_headers()
            if self.command == "HEAD":
                return  # HEAD 不能有响应体
            _stream_file_local(self, full, start, length)
            return
        # 无 Range：完整返回（或命中 304）
        if self._not_modified(etag):
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Vary", "Accept-Encoding")
            self.send_header("Cache-Control", "no-cache")
            self._sec_headers()
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(st.st_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self._sec_headers()
        self.end_headers()
        if self.command == "HEAD":
            return  # HEAD 不能有响应体，仅返回头部
        _stream_file_local(self, full, 0, st.st_size)


    def _send_error(self, code: int, title: str, msg: str):
        # 统一错误响应：用 send_response_only 先写状态行，再补安全头，最后 end_headers。
        # 这样能稳定带上 CSP/nosniff/X-Frame（send_error 内部会自动 end_headers，
        # 在其之后追加 send_header 会丢失，故不用它）。错误体不含用户输入，无 XSS 风险。
        body = (
            f"<!doctype html><html><head><meta charset='utf-8'>"
            f"<title>{code}</title></head><body style='font-family:sans-serif;padding:40px'>"
            f"<h1>{code} {title}</h1><p>{msg}</p></body></html>"
        ).encode("utf-8")
        self.send_response_only(code, title)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._sec_headers()
        self.end_headers()
        self.wfile.write(body)

    # ----------------------------------------------------------------------
    # 内置浏览器 · 站点代理
    # 背景：limestart.cn / 必应 / 百度结果页等绝大多数站点都用
    #   X-Frame-Options 或 CSP frame-ancestors 禁止被 <iframe> 嵌入，
    # 所以「主页能开、点进去一片空白」。前端无解，只能由服务端代理取回后
    # 改写链接再喂给 iframe（详见 browse_proxy.py 顶部说明）。
    # ----------------------------------------------------------------------


    def _reject_chunked(self) -> bool:
        """拒绝 Transfer-Encoding: chunked 的请求体，返回 True 表示已拒绝。

        开了 HTTP/1.1 长连接后这是必须的：本服务按 Content-Length 读请求体，
        遇到分块传输会当作「没有请求体」，把 chunk 数据留在连接里，导致同一个
        连接上的下一个请求被错位解析（响应张冠李戴）。浏览器 fetch/XHR 一律带
        Content-Length，只有手工构造的客户端才会走到这里。
        """
        if "chunked" not in (self.headers.get("Transfer-Encoding") or "").lower():
            return False
        self.close_connection = True
        body = json.dumps({"ok": False, "error": "不支持分块传输的请求体。"},
                          ensure_ascii=False).encode("utf-8")
        self.send_response(411)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self._sec_headers()
        self.end_headers()
        self.wfile.write(body)
        return True


    def _read_raw_body(self, limit: int = 12 * 1024 * 1024) -> bytes:
        """原样读取请求体（子应用上传/表单都靠它透传，不解析、不假设 JSON）。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            n = 0
        if n <= 0:
            return b""
        if n > limit:
            # 超出上限时不读取，交由下游拒绝：这里抛错会被 proxy 的异常分支转成 502。
            # 必须顺手关连接——body 还留在 socket 里，长连接复用会把它的尾部当成
            # 下一个请求的起始行来解析，导致响应错位。
            self.close_connection = True
            raise ValueError(f"请求体过大（{n} 字节 > {limit}）")
        return self.rfile.read(n)


    def _read_body(self) -> dict:
        # 读取 POST JSON 请求体；异常 / 超限 / 非对象（数组、字符串、数字）一律返回空 dict
        # （由调用方用 body.get() 校验字段），避免 json.loads('[]') 返回 list 后 body.get 抛 AttributeError。
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            return {}
        if n <= 0:
            return {}
        if n > 1_000_000:
            # 超限不读：同上，body 留在 socket 里，长连接必须断开，否则下一个请求错位
            self.close_connection = True
            return {}
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            # P1 修复：请求体不是合法 JSON 时记录，否则调用方只拿到空 dict，
            # 排障时完全无从判断是前端没传还是传坏了。
            diag.note("hub/handlers/base.py::_read_body", exc)
            return {}
        if not isinstance(payload, dict):
            diag.note("hub/handlers/base.py::_read_body",
                      ValueError(f"body 非对象：{type(payload).__name__}"))
            return {}
        return payload


    def do_OPTIONS(self):
        """代理页是不透明源，它的跨源 AJAX 会先发 preflight；只对 /browse/* 放行。"""
        path = urlparse(self.path).path
        if path == "/browse" or path.startswith("/browse/"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers",
                             "Content-Type, X-Hub-Ref, X-Requested-With, Accept")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----------------------------------------------------------------------
    # 子应用托管（/apps/*）：静态型直接读文件，进程型反代到回环端口
    # ----------------------------------------------------------------------


    def log_message(self, fmt, *args):
        # P1 修复：恢复访问日志，但只写诊断文件（.data/hub.log）不刷控制台——
        # 既让线上部署可观测（请求方法/路径/状态码/大小/来源），又不干扰本地开发。
        try:
            diag.access(fmt % args if args else fmt)
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# 入口：解析参数、启动服务、自动开浏览器
# --------------------------------------------------------------------------
