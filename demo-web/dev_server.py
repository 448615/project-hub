"""demo-web 预览服务（演示用，零依赖，仅标准库）。

监听 config.json 中配置的 5173 端口，提供一份 React 风格的静态落地页，
用于演示「一键启动 + 桌面内 iframe 预览」。

重点是：本服务**故意不发送** X-Frame-Options / Content-Security-Policy 的
frame-ancestors 限制，确保能被 Project Hub 的「预览」窗口用 iframe 框住。
真实项目里换成你的 `npm run dev` / Vite / Webpack dev server 即可，
只要那个 dev server 也允许被同源外框嵌套就没问题。
"""
from __future__ import annotations

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 5173
ROOT = os.path.dirname(os.path.abspath(__file__))

PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>demo-web · React + Vite</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; font-family: -apple-system, "Segoe UI", "PingFang SC", sans-serif;
    color: #1e2a3f; background: linear-gradient(135deg, #eef4ff 0%, #f7f0ff 100%);
    display: flex; align-items: center; justify-content: center; padding: 32px;
  }
  .app { width: 100%; max-width: 760px; }
  .nav { display: flex; align-items: center; gap: 12px; padding: 14px 18px;
         background: rgba(255,255,255,.7); backdrop-filter: blur(12px);
         border: 1px solid rgba(255,255,255,.8); border-radius: 16px;
         box-shadow: 0 8px 30px rgba(91,140,255,.15); }
  .logo { width: 34px; height: 34px; border-radius: 9px;
          background: linear-gradient(135deg,#5B8CFF,#67E8F9); display: grid; place-items: center;
          color: #fff; font-weight: 800; }
  .nav b { font-size: 16px; } .nav .sp { flex: 1; } .nav a { color: #5B8CFF; text-decoration: none; font-size: 14px; }
  .hero { margin-top: 28px; padding: 40px 36px; border-radius: 24px;
          background: rgba(255,255,255,.78); backdrop-filter: blur(14px);
          border: 1px solid rgba(255,255,255,.85); box-shadow: 0 18px 50px rgba(91,140,255,.18); }
  .tag { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px;
         background: rgba(91,140,255,.12); color: #3b6fd4; margin-bottom: 16px; }
  h1 { margin: 0 0 12px; font-size: 34px; letter-spacing: -.5px; }
  p.lead { margin: 0 0 26px; color: #5d6c85; line-height: 1.7; font-size: 15px; }
  .grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; }
  .card { padding: 18px; border-radius: 16px; background: rgba(255,255,255,.9);
          border: 1px solid rgba(91,140,255,.18); }
  .card .ico { font-size: 22px; } .card h3 { margin: 10px 0 6px; font-size: 15px; }
  .card p { margin: 0; color: #6b7894; font-size: 13px; line-height: 1.6; }
  .foot { margin-top: 24px; font-size: 12px; color: #8a96ad; text-align: center; }
  .badge { display:inline-flex; align-items:center; gap:6px; }
  .dot { width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.2); }
</style>
</head>
<body>
  <div class="app">
    <div class="nav">
      <span class="logo">R</span><b>demo-web</b>
      <span class="sp"></span>
      <span class="badge"><span class="dot"></span> 运行在 :5173</span>
      <a href="/">Home</a><a href="/about">About</a>
    </div>
    <div class="hero">
      <span class="tag">React + Vite · 本地开发服务</span>
      <h1>欢迎来到 demo-web 👋</h1>
      <p class="lead">这个页面由 <code>demo-web/dev_server.py</code> 提供，正被 Project Hub 的「预览」窗口以 iframe 内嵌显示。点击「启动并预览」后，这里会即时呈现你的前端应用。</p>
      <div class="grid">
        <div class="card"><div class="ico">⚡</div><h3>热更新</h3><p>真实项目里改代码即刷新，开发体验拉满。</p></div>
        <div class="card"><div class="ico">🧩</div><h3>组件化</h3><p>用同一套组件拼出仪表盘、表单与图表。</p></div>
        <div class="card"><div class="ico">📦</div><h3>一键构建</h3><p>build 后产出静态资源，可直接托管。</p></div>
      </div>
      <div class="foot">本页由零依赖 Python 服务渲染 · 仅为演示「桌面内预览」而存在</div>
    </div>
  </div>
</body>
</html>
"""


class _Handler(BaseHTTPRequestHandler):
    def _html(self, body: str, status: int = 200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        # 关键：不发送 X-Frame-Options / frame-ancestors，允许被 Hub 预览窗口嵌套
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        # 所有路径都返回同一落地页，方便演示预览窗口
        self._html(PAGE)

    def log_message(self, *args):  # 静默访问日志，避免刷屏
        pass


if __name__ == "__main__":
    print(f"[demo-web] 预览服务已启动，监听 http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), _Handler).serve_forever()
