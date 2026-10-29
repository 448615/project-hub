"""demo-api 启动入口（演示用）。

本示例用 Python 标准库起一个极简 HTTP 服务，监听 config.json 中配置的 8081 端口，
方便演示「一键启动」后端口检测变绿、以及「桌面内预览 / 外链跳转」打开页面。
真实项目中此处换成你的 FastAPI / Flask 等服务即可，其余无需改动。

说明：为让 Project Hub 的「预览」窗口能用 iframe 内嵌本服务，
本服务**不发送** X-Frame-Options / frame-ancestors 限制。
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8081


def _status_html() -> str:
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>demo-api · 运行中</title><style>
body{margin:0;min-height:100vh;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;
color:#1e2a3f;background:linear-gradient(135deg,#eafaf1,#eef4ff);display:flex;align-items:center;justify-content:center;padding:32px}
.card{width:100%;max-width:680px;padding:40px;border-radius:24px;background:rgba(255,255,255,.82);
backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.85);box-shadow:0 18px 50px rgba(34,197,94,.15)}
.tag{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;background:rgba(34,197,94,.12);color:#16a34a;margin-bottom:16px}
h1{margin:0 0 8px;font-size:30px}.lead{color:#5d6c85;line-height:1.7;font-size:15px}
.endpoint{margin-top:22px;padding:14px 16px;border-radius:14px;background:rgba(34,197,94,.08);font-size:14px;color:#14532d}
code{background:rgba(0,0,0,.06);padding:2px 6px;border-radius:6px}
</style></head><body><div class="card">
<span class="tag">FastAPI 风格 · 本地接口服务</span>
<h1>demo-api 运行中 ✅</h1>
<p class="lead">这个页面正被 Project Hub 的「预览」窗口以 iframe 内嵌显示。它模拟一个后端接口服务，可以提供 JSON 数据给前端消费。</p>
<div class="endpoint">示例接口：<code>GET /api/ping</code> → <code>{"status":"ok"}</code><br>
完整文档请点项目窗里的「接口文档」外链，或访问 <code>/docs</code>。</div>
</div></body></html>"""


def _docs_html() -> str:
    return """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>demo-api · 接口文档</title><style>
body{margin:0;font-family:-apple-system,"Segoe UI","PingFang SC",sans-serif;color:#1e2a3f;
background:linear-gradient(135deg,#eef4ff,#f7f0ff);padding:40px}
.wrap{max-width:720px;margin:0 auto;background:rgba(255,255,255,.82);backdrop-filter:blur(14px);
border:1px solid rgba(255,255,255,.85);border-radius:24px;padding:36px;box-shadow:0 18px 50px rgba(91,140,255,.15)}
h1{margin:0 0 18px;font-size:28px}.item{padding:14px 0;border-top:1px solid rgba(0,0,0,.06)}
code{background:rgba(91,140,255,.12);color:#3b6fd4;padding:2px 7px;border-radius:6px;font-size:14px}
p{color:#5d6c85;line-height:1.6}
</style></head><body><div class="wrap"><h1>demo-api 接口文档</h1>
<div class="item"><code>GET /api/ping</code><p>健康检查，返回 {"status":"ok"}。</p></div>
<div class="item"><code>GET /api/items</code><p>返回示例条目列表（演示用）。</p></div>
<div class="item"><code>GET /docs</code><p>本页面。</p></div>
<p style="margin-top:20px;color:#8a96ad;font-size:13px">本页为演示内容；真实项目请替换为 Swagger / Redoc 自动生成的文档。</p>
</div></body></html>"""


class _Handler(BaseHTTPRequestHandler):
    def _send_json(self, obj: dict, status: int = 200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, html: str, status: int = 200):
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        # 允许被 Hub 预览窗口嵌套
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # 让 / 与 /docs 返回漂亮的 HTML 页面（预览窗口 / 外链跳转都能直接看）
        if self.path in ("/", "/index.html"):
            self._send_html(_status_html())
        elif self.path == "/docs":
            self._send_html(_docs_html())
        else:
            # 其余路径保留 JSON 接口语义
            self._send_json({"echo": self.path, "status": "ok"})

    def log_message(self, *args):  # 静默访问日志，避免刷屏
        pass


if __name__ == "__main__":
    print(f"[demo-api] 演示服务已启动，监听 http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), _Handler).serve_forever()
