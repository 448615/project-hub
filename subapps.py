#!/usr/bin/env python3
"""子应用托管：把「星枢 CMS」与「桓梦工作台」作为独立子项目嵌进项目枢纽。

两类承载方式：

1. **静态型**（桓梦工作台）：纯前端构建产物，由枢纽直接按文件读出，
   不需要任何额外进程。挂载点 `/apps/workbench/`。

2. **进程型**（星枢）：Node.js 服务，枢纽在其首次被访问时懒启动，
   软后再把 `/apps/starshu/*` 反向代理到 `127.0.0.1:<port>/*`。
   挂载点 `/apps/starshu/`。

为什么走「同源 + 反向代理」而不是 iframe 直连 `127.0.0.1:3000`：
  - 直连是跨源，云端的枢纽是 https，跨源 iframe 指向 http 会被当成混合内容拦掉；
  - 同源后应用与枢纽共享 origin，Cookie/localStorage 语义一致，CSP 也不用额外放开。
代价是应用前端必须用**相对路径**引用自己的资源（星枢已改，见其 README）。

安全边界：
  - 静态型只允许读子项目目录内的文件（realpath 前缀校验，防目录穿越）；
  - 进程型只反向代理到写死的回环端口，不接受任何用户提供的上游地址（无 SSRF 面）；
  - 代理响应不透传上游的 X-Frame-Options（否则自己嵌自己会被拦），也不套用枢纽的 CSP。
"""
from __future__ import annotations

import mimetypes
import os
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import unquote
from hub import diag

# 显式登记音频/视频/字体类型：部分精简镜像没有 /etc/mime.types，
# guess_type 会退化成 application/octet-stream；前端据此建 blob 时类型不对，
# <audio> 会拒绝播放（表现为「点了没反应」）。
for _ext, _type in (
    (".mp3", "audio/mpeg"), (".m4a", "audio/mp4"), (".aac", "audio/aac"),
    (".wav", "audio/wav"), (".ogg", "audio/ogg"), (".flac", "audio/flac"),
    (".mp4", "video/mp4"), (".webm", "video/webm"),
    (".woff", "font/woff"), (".woff2", "font/woff2"), (".ttf", "font/ttf"),
):
    mimetypes.add_type(_type, _ext)

# 挂载点 → 应用定义。prefix 必须以 "/" 结尾，表示「目录型」挂载。
APPS = [
    {
        "prefix": "/apps/starshu/",
        "kind": "node",
        "name": "星枢",
        "dir": "starshu",
        "entry": "server.js",
        "port": 3000,
        "log": os.path.join("starshu", "data", "hub-app.log"),
    },
    {
        "prefix": "/apps/workbench/",
        "kind": "static",
        "name": "桓梦工作台",
        "dir": os.path.join("workbench", "www"),
        "index": "index.html",
    },
]

# 进程型应用句柄：prefix → Popen
PROCS: dict[str, subprocess.Popen] = {}
LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# 启动状态机
# ---------------------------------------------------------------------------
# 为什么需要它：原实现把「装依赖 + spawn + 等端口」全部放在**请求线程**里，
# 首次访问且 node_modules 缺失时会同步跑 `npm install`（超时 300s）——
# 浏览器就在那儿白屏转圈，最坏等 5 分钟才拿到一个错误页。
# 现在改成：请求线程只负责「踢一脚」并短暂等待，真正的耗时工作交给后台线程，
# 请求立刻得到「正在启动」页面，页面自己定时重试。状态对外可查（/api/health）。
#
# phase: idle → installing → booting → ready / failed
STATE: dict[str, dict] = {}
_STATE_LOCK = threading.Lock()
_BOOT_LOCK = threading.Lock()
_BOOT_THREADS: dict[str, threading.Thread] = {}

#: 请求线程最多同步等这么久；绝大多数「依赖已就绪」的情况 3s 内就能进应用
BOOT_WAIT = 3.0
#: 后台线程等 Node 监听端口的兜底上限
BOOT_READY_TIMEOUT = 20.0
#: 失败后冷却时间：避免每个请求都重新触发一次 npm install
BOOT_RETRY_COOLDOWN = 30.0

#: ensure_running 的第二返回值：调用方据此渲染「正在启动」而非「启动失败」
NOTE_STARTING = "starting"


def _set_state(app: dict, phase: str, note: str = "") -> None:
    with _STATE_LOCK:
        STATE[app["prefix"]] = {"phase": phase, "note": note, "since": time.time()}
    # 状态变了就让健康检查缓存失效，否则 /api/health 会滞后几秒才反映「已就绪」。
    # 延迟导入：subapps 是在 hub.config 导入期加载的，那时 hub 包还没初始化完。
    try:
        from hub import health as _health
        _health.invalidate()
    except Exception:  # noqa: BLE001  拿不到就让它自然过期，不影响启动
        pass


def _get_state(app: dict) -> dict:
    with _STATE_LOCK:
        st = STATE.get(app["prefix"])
        return dict(st) if st else {"phase": "idle", "note": "", "since": 0.0}


def app_status(app: dict) -> dict:
    """子应用运行态快照（只读，供 /api/health 与启动页使用）。"""
    st = _get_state(app)
    if app.get("kind") != "node":
        # 静态型没有进程概念：报 static 比 idle 准确，监控不会误判成「没起来」
        return {"phase": "static", "note": "", "port": 0, "listening": False,
                "since": st.get("since", 0.0)}
    port = int(app.get("_port") or app.get("port") or 0)
    listening = bool(port and port_open(port))
    phase = "ready" if listening else st.get("phase", "idle")
    return {"phase": phase, "note": st.get("note", ""), "port": port,
            "listening": listening, "since": st.get("since", 0.0)}


# 枢纽自己监听的端口（hub.py 启动后写入）。云端沙箱注入的 $PORT 常见就是 3000，
# 与星枢默认端口完全撞车——此时 port_open(3000) 命中的是枢纽本身，
# 反代会把「枢纽首页」当成子应用返回，用户看到的是「星枢打开后是桌面」。
HUB_PORT = 0

# 代理时不应透传的逐跳头（RFC 7230 §6.1）+ 我们不能安全转发的头
_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
}
# X-Frame-Options / CSP 必须丢弃：上游若声明 DENY，枢纽自己反而嵌不进去
_DROP_HEADERS = {"x-frame-options", "content-security-policy", "content-security-policy-report-only"}


def _subapp_sec_headers(handler) -> None:
    """子应用响应的统一安全头（含 nosniff），补上枢纽 CSP 覆盖不到的那一段。

    为什么在这里补、而不是直接套枢纽的 CSP：
      · 静态型（工作台）页面里仍有大量内联 onclick/onchange（96 处），
        套 script-src 'self' 会把交互全打死；所以只上 frame-ancestors，不动脚本策略。
      · 进程型（星枢）前端已零内联，其自身的严格 CSP 会在 proxy 处按
        _DROP_HEADERS 丢弃（否则枢纽自己嵌不进去），于是这两头谁都没发——
        正好由这里统一兜底。
      · X-Frame-Options 用 SAMEORIGIN 而非 DENY：枢纽是用同源 iframe 嵌子应用的
        （见 static/js/150-subapp-terminal.js:62），DENY 会把自家嵌套拦掉。
      · Referrer-Policy 用 no-referrer：子应用 URL 里可能带 sharecode/查询参数，
        不该随外链请求泄漏出去。
    """
    hdr = handler.send_header   # 别名：也避免下面批量替换时误伤本行
    hdr("X-Content-Type-Options", "nosniff")
    hdr("X-Frame-Options", "SAMEORIGIN")
    hdr("Content-Security-Policy", "frame-ancestors 'self'")
    hdr("Referrer-Policy", "no-referrer")


def match(raw_path: str):
    """按最长前缀匹配返回 (app, 应用内相对路径)；不匹配返回 (None, "")。"""
    for app in sorted(APPS, key=lambda a: -len(a["prefix"])):
        if raw_path.startswith(app["prefix"]):
            return app, raw_path[len(app["prefix"]):]
    return None, ""


def is_app_path(raw_path: str) -> bool:
    return raw_path == "/apps" or raw_path.startswith("/apps/")


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.3) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _pick_free_port(start: int, span: int = 50) -> int:
    """从 start 起找一个没人监听的端口（给「默认端口被枢纽占用」的进程型应用用）。"""
    for p in range(start, start + span):
        if not port_open(p):
            return p
    return start


def hub_admin_emails(root: str) -> list[str]:
    """枢纽 config.json 里的管理员邮箱（小写、去重、排序）。

    用途：拉起子应用时通过 HUB_ADMIN_EMAILS 传给星枢，供其比对「星枢超管是否也在
    枢纽名单里」。**只传递信息、不传递权限**——星枢的鉴权仍然完全由它自己的数据库
    决定，这个变量不参与任何准入判断，避免变成一条隐藏的跨进程信任链。
    """
    try:
        from hub import config as hub_config
        raw = hub_config.load_config(root).get("admins") or []
        # 写错成字符串时要整条拒绝：直接迭代字符串会得到逐字符的"邮箱"，比空更糟
        if not isinstance(raw, (list, tuple)):
            return []
        return sorted({str(e).strip().lower() for e in raw if str(e).strip()})
    except Exception as exc:  # noqa: BLE001
        diag.note("subapps.py::hub_admin_emails", exc)
        return []


def app_port(app: dict) -> int:
    """应用的实际监听端口：优先用运行时分配过的，其次配置端口。

    配置端口与枢纽自身端口相同（云端 $PORT=3000 撞星枢 3000）时，
    顺延到 3010 附近找一个空闲端口，并把结果缓存在 app 上，后续请求复用。
    """
    got = int(app.get("_port") or 0)
    if got:
        return got
    port = int(app.get("port") or 0)
    if not port:
        return 0
    if port == HUB_PORT:
        port = _pick_free_port(port + 10)
        app["_port"] = port
        print(f"[信息] 子应用「{app.get('name', app['prefix'])}」端口 {app.get('port')} "
              f"与枢纽冲突，改用 {port}")
    return port


def _log_tail(path: str, limit: int = 400) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return f.read().decode("utf-8", "replace").strip()
    except Exception:  # noqa: BLE001
        return ""


def node_available() -> bool:
    return bool(shutil.which("node"))


# 运行期必需依赖：与 starshu/scripts/start.js 的 requiredDeps 对齐。
# 只装 dependencies，不装 devDependencies（Playwright 等测试工具日常/线上都不需要）。
REQUIRED_NODE_DEPS = ("express", "better-sqlite3", "jsonwebtoken", "multer")


def _dep_log(app_dir: str, msg: str) -> None:
    """把依赖预检/安装过程写进 <app_dir>/data/hub-deps.log，方便事后查问题。

    为什么单独一个文件：hub-app.log 里混着 Node 进程自己的输出，
    把"装依赖"这类 Python 侧动作单独记一份，排查时一眼能分清是谁说的。
    写日志失败不能影响启动，所以整段用 try 包住、出错就忽略。
    """
    try:
        log_dir = os.path.join(app_dir, "data")
        os.makedirs(log_dir, exist_ok=True)
        path = os.path.join(log_dir, "hub-deps.log")
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as exc:  # noqa: BLE001  日志写不进也不能挡住启动
        diag.note("subapps.py::_dep_log", exc)


def _missing_node_deps(app_dir: str) -> list:
    mods = os.path.join(app_dir, "node_modules")
    return [d for d in REQUIRED_NODE_DEPS
            if not os.path.isdir(os.path.join(mods, d))]


def ensure_node_deps(app_dir: str, timeout: int = 300) -> tuple:
    """确保子应用的 Node 运行依赖就绪，缺了就按需安装。

    与 starshu/scripts/start.js 的策略一致：
      - 只装 dependencies（--omit=dev），跳过 Playwright 等测试工具；
      - better-sqlite3 走 npmmirror 二进制镜像，避免拉不到 GitHub Release；
      - 首次失败自动换 npmmirror 源重试一次。
    安装发生在首次访问的请求线程里（可能几十秒），装好后再 spawn，
    避免 server.js 直接以 Cannot find module 退出。
    全过程写 hub-deps.log，事后能查到"什么时候、缺了什么、装没装成、耗时多少"。
    """
    missing = _missing_node_deps(app_dir)
    if not missing:
        return True, "ready"

    _dep_log(app_dir, f"检测到缺少依赖：{', '.join(missing)}，准备自动安装")

    npm_exe = "npm.cmd" if os.name == "nt" else "npm"
    if not shutil.which(npm_exe):
        _dep_log(app_dir, f"未找到 {npm_exe}，无法自动安装")
        return False, f"缺少依赖（{', '.join(missing)}），且未找到 npm，无法自动安装"

    cmd = [npm_exe, "install", "--omit=dev", "--no-audit", "--no-fund"]
    env = dict(os.environ)
    env.setdefault(
        "npm_config_better_sqlite3_binary_host_mirror",
        "https://registry.npmmirror.com/-/binary/better-sqlite3",
    )

    def _run(extra: list, tag: str) -> tuple:
        started = time.time()
        try:
            r = subprocess.run(
                cmd + extra, cwd=app_dir, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                timeout=timeout, shell=(os.name == "nt"),
            )
            cost = time.time() - started
            ok = r.returncode == 0
            tail = (r.stdout or b"").decode("utf-8", "replace")[-600:]
            _dep_log(app_dir, f"{tag} 结束：rc={r.returncode}，用时 {cost:.1f}s")
            if not ok:
                _dep_log(app_dir, f"{tag} 输出尾部：{tail.strip()}")
            return ok, tail
        except subprocess.TimeoutExpired:
            _dep_log(app_dir, f"{tag} 超时（{timeout}s）")
            return False, f"安装超时（{timeout}s）"
        except Exception as e:  # noqa: BLE001
            _dep_log(app_dir, f"{tag} 异常：{e}")
            return False, str(e)

    _dep_log(app_dir, "开始安装（--omit=dev）：" + " ".join(cmd))
    ok, out = _run([], "首次安装")
    if not ok:
        _dep_log(app_dir, "首次失败，改用 npmmirror 源重试")
        ok, out = _run(["--registry=https://registry.npmmirror.com"], "镜像重试")
    if not ok:
        _dep_log(app_dir, f"自动安装最终失败：{out.strip()}")
        return False, f"自动安装依赖失败：{out.strip()}"

    # npm 返回 0 不代表真装上了，显式复核一次
    still = _missing_node_deps(app_dir)
    if still:
        _dep_log(app_dir, f"安装后复核仍缺少：{', '.join(still)}")
        return False, f"安装后仍缺少：{', '.join(still)}"
    _dep_log(app_dir, "依赖安装完成，复核通过")
    return True, "installed"


def _safe_write(handler, data: bytes) -> bool:
    """写响应体，容忍客户端提前断开。返回 True 表示写成功。

    浏览器/curl 在拿到响应头后就可能关掉连接（切页、取消下载、`-o /dev/null` 提前退出），
    此时 wfile.write 抛 ConnectionAbortedError/BrokenPipeError。这属于正常的网络事件，
    不该冒泡成「500 Internal Error」再在 stderr 刷一屏 traceback（日志全被噪声淹没）。
    返回布尔值是为了让流式发送知道自己是否该停止并关闭连接。
    """
    try:
        handler.wfile.write(data)
        return True
    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
        return False
    except OSError:
        return False


def _kick_boot(app: dict, root: str, app_dir: str, entry: str) -> None:
    """确保有一个后台线程在推进启动（幂等：已在跑就不重复起）。"""
    with _BOOT_LOCK:
        th = _BOOT_THREADS.get(app["prefix"])
        if th is not None and th.is_alive():
            return
        t = threading.Thread(
            target=_boot_worker, args=(app, root, app_dir, entry),
            name="hub-boot-" + app["prefix"].strip("/").replace("/", "-"),
            daemon=True,
        )
        _BOOT_THREADS[app["prefix"]] = t
        t.start()


def _boot_worker(app: dict, root: str, app_dir: str, entry: str) -> None:
    """后台启动流程：装依赖 → spawn → 等端口。全程只更新状态，不阻塞任何请求。"""
    prefix = app["prefix"]
    try:
        port = app_port(app)
        if port_open(port):
            _set_state(app, "ready", "已在运行")
            return

        _set_state(app, "installing", "正在检查运行依赖…")
        ok, dep_msg = ensure_node_deps(app_dir)
        if not ok:
            _set_state(app, "failed", dep_msg)
            return

        _set_state(app, "booting", "依赖已就绪，正在启动服务…" if dep_msg != "installed"
                   else "依赖安装完成，正在启动服务…")

        with LOCK:
            # 双检：并发请求只允许一个线程真正 spawn
            proc = PROCS.get(prefix)
            if proc is None or proc.poll() is not None:
                log_path = os.path.join(os.path.abspath(root), app["log"])
                os.makedirs(os.path.dirname(log_path), exist_ok=True)
                env = dict(os.environ)
                env.update({
                    "PORT": str(port),
                    "HOST": "127.0.0.1",          # 只给本机反代用，不对外暴露端口
                    "NODE_ENV": env.get("NODE_ENV", "production"),
                    # 子应用永远藏在枢纽反代之后，所以告诉它「前面有 1 层可信反代」，
                    # 它才会按 X-Forwarded-For 还原真实来源 IP。不声明的话，
                    # 子应用看到的客户端一律是 127.0.0.1，按 IP 限流等于全站共用一个桶。
                    # 枢纽代理是原样透传上游请求头的，所以这里取「最右侧一个」即为
                    # 平台（或直连客户端）看到的来源，客户端自造的 XFF 首跳骗不到它。
                    "TRUST_PROXY": env.get("TRUST_PROXY", "1"),
                    # 管理员名单（X-01 短期项）：把枢纽 config.json 的 admins 传下去，
                    # 星枢据此比对「星枢超管是否也在枢纽名单里」并告警。只传信息不传权限。
                    "HUB_ADMIN_EMAILS": env.get("HUB_ADMIN_EMAILS") or ",".join(hub_admin_emails(root)),
                })
                # 句柄只借给子进程：Popen 之后必须关掉父进程这一份，
                # 否则枢纽每启动一次子应用就泄漏一个文件描述符（Windows 上还锁着文件）
                logf = open(log_path, "ab", buffering=0)
                try:
                    PROCS[prefix] = subprocess.Popen(
                        [shutil.which("node") or "node", entry],
                        cwd=app_dir,
                        env=env,
                        stdout=logf,
                        stderr=subprocess.STDOUT,
                        stdin=subprocess.DEVNULL,
                    )
                finally:
                    logf.close()

        deadline = time.time() + BOOT_READY_TIMEOUT
        while time.time() < deadline:
            if port_open(port):
                _set_state(app, "ready", "已启动")
                return
            proc = PROCS.get(prefix)
            if proc is not None and proc.poll() is not None:
                tail = _log_tail(os.path.join(os.path.abspath(root), app["log"]))
                _set_state(app, "failed",
                           f"进程已退出（code={proc.returncode}）。{('日志：' + tail) if tail else ''}")
                return
            time.sleep(0.2)
        _set_state(app, "failed", f"启动超时（{int(BOOT_READY_TIMEOUT)}s 内未监听 {port} 端口）。")
    except Exception as e:  # noqa: BLE001  启动线程不能把异常抛给 nobody
        _set_state(app, "failed", f"启动异常：{type(e).__name__}: {e}")


def ensure_running(app: dict, root: str, wait: float | None = None) -> tuple[bool, str]:
    """确保进程型应用在监听。返回 (ok, 说明)。

    说明为 ``"reuse"`` / ``"started"`` 表示已可用；``NOTE_STARTING`` 表示后台正在
    推进启动（调用方应回「正在启动」页并让前端重试）；其余文本是**真正的失败原因**。

    同步等待上限由 ``wait`` 控制（默认 BOOT_WAIT=3s）：依赖已就绪时通常几秒内就绪，
    首次安装依赖则立刻返回 starting，不再把请求线程钉在 npm install 上。
    """
    port = app_port(app)
    if port_open(port):
        _set_state(app, "ready", "已在运行")
        return True, "reuse"
    if not node_available():
        _set_state(app, "failed", "未找到 node 可执行文件，无法启动 Node 子应用。")
        return False, "未找到 node 可执行文件，无法启动 Node 子应用。"

    app_dir = os.path.join(os.path.abspath(root), app["dir"])
    entry = os.path.join(app_dir, app["entry"])
    if not os.path.isfile(entry):
        msg = f"缺少入口文件：{app['dir']}/{app['entry']}"
        _set_state(app, "failed", msg)
        return False, msg

    # 失败冷却：刚失败过就先别重试，避免每个请求都触发一轮依赖安装
    st = _get_state(app)
    if st["phase"] == "failed" and (time.time() - st["since"]) < BOOT_RETRY_COOLDOWN:
        return False, st["note"] or "启动失败。"

    _kick_boot(app, root, app_dir, entry)

    deadline = time.time() + (BOOT_WAIT if wait is None else max(0.0, wait))
    while time.time() < deadline:
        if port_open(port):
            _set_state(app, "ready", "已启动")
            return True, "started"
        st = _get_state(app)
        if st["phase"] == "failed":
            return False, st["note"] or "启动失败。"
        time.sleep(0.15)
    return False, NOTE_STARTING


def stop_all():
    """枢纽退出时结束由本模块拉起的 Node 子进程（只杀自己拉起的，不动别人的服务）。"""
    for prefix, proc in list(PROCS.items()):
        if proc.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                   capture_output=True, check=False)
                else:
                    proc.terminate()
            except Exception as exc:  # noqa: BLE001
                diag.note("subapps.py::stop_all", exc)
        PROCS.pop(prefix, None)
    with _STATE_LOCK:
        STATE.clear()


# ---------------------------------------------------------------------------
# 静态型：按文件读出（带目录穿越防护）
# ---------------------------------------------------------------------------
_CHUNK = 64 * 1024       # 流式发送分块大小
_GZIP_MIN = 1024         # 小于这个体积不值得压


def _assets():
    """延迟取 hub.static_assets（gzip 缓存 + 压缩判定）。

    subapps 是在 hub.config 导入期被加载的，那时 hub 包还没初始化完，
    模块级 `from hub.static_assets import ...` 会踩循环导入。请求期再取就完全安全。
    """
    import importlib
    return importlib.import_module("hub.static_assets")


def _req_header(handler, name: str, default: str = "") -> str:
    """读请求头。

    真实 handler 的 headers 是 email.message.Message（有 .get）；测试里的 FakeHandler
    把 headers 当成「响应头列表」用，没有 .get。统一在这里兜住，两种都能跑：
    测试替身可以挂一个 req_headers 字典来模拟客户端请求头。
    """
    rh = getattr(handler, "req_headers", None)
    if isinstance(rh, dict):
        return rh.get(name) or default
    h = getattr(handler, "headers", None)
    get = getattr(h, "get", None)
    if callable(get):
        try:
            return get(name) or default
        except Exception:  # noqa: BLE001
            return default
    return default


def _hdr_accepts_gzip(handler) -> bool:
    fn = getattr(handler, "_accepts_gzip", None)
    if callable(fn):
        try:
            return bool(fn())
        except Exception as exc:  # noqa: BLE001
            diag.note("subapps.py::_hdr_accepts_gzip", exc)
    return "gzip" in _req_header(handler, "Accept-Encoding").lower()


def _hdr_not_modified(handler, etag: str) -> bool:
    fn = getattr(handler, "_not_modified", None)
    if callable(fn):
        try:
            return bool(fn(etag))
        except Exception as exc:  # noqa: BLE001
            diag.note("subapps.py::_hdr_not_modified", exc)
    inm = _req_header(handler, "If-None-Match")
    return etag.strip('"') in inm.replace("W/", "").replace('"', "")


def _parse_range(header: str, size: int):
    """解析单区间 Range。

    返回 (start, end) 含端点；None 表示没带 Range 或语法不认识（按整份发送，符合
    RFC 的"忽略无法满足/无法解析的 Range"）；"invalid" 表示范围不可满足，要回 416。
    """
    h = (header or "").strip()
    if not h.lower().startswith("bytes="):
        return None
    spec = h[6:].split(",", 1)[0].strip()      # 多区间只取第一段（够用且实现简单）
    if "-" not in spec:
        return None
    a, b = spec.split("-", 1)
    a, b = a.strip(), b.strip()
    try:
        if a == "":
            n = int(b)                          # bytes=-500 → 最后 500 字节
            if n <= 0 or size == 0:
                return "invalid"
            return (max(0, size - n), size - 1)
        start = int(a)
        end = int(b) if b else size - 1
    except ValueError:
        return None
    if start >= size or start > end:
        return "invalid"
    return (start, min(end, size - 1))


def _stream_file(handler, path: str, offset: int, length: int) -> None:
    """分块发送文件片段，不把整个文件读进内存。

    音乐/视频动辄几 MB，原来 `f.read()` 整块塞进内存再写；并发几个人听歌，
    内存峰值就会出现明显尖峰。分块后常驻内存只剩 64KB。
    """
    remaining = length
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            while remaining > 0:
                chunk = f.read(min(_CHUNK, remaining))
                if not chunk:
                    break
                # 只有明确返回 False 才算写失败（None 视为成功：测试替身常不返回值）
                if _safe_write(handler, chunk) is False:
                    # 客户端中途断开（切页 / 拖动进度条取消上一次请求）：关掉这条连接，
                    # 否则残留的半个响应体会污染 keep-alive 上的下一个请求。
                    try:
                        handler.close_connection = True
                    except Exception as exc:  # noqa: BLE001
                        diag.note("subapps.py::_stream_file", exc)
                    return
                remaining -= len(chunk)
    except OSError:
        try:
            handler.close_connection = True
        except Exception as exc:  # noqa: BLE001
            diag.note("subapps.py::_stream_file", exc)


def serve_static(handler, app: dict, sub: str, root: str) -> None:
    base = os.path.realpath(os.path.join(os.path.abspath(root), app["dir"]))
    # 空路径或目录路径 → 目录索引页（前端是 SPA，全部路由回落 index.html）
    # 必须先 unquote：中文/空格等文件名在浏览器里是百分号编码的，
    # 不解码会拿字面量 "%E5%8B%BE..." 去找文件，永远找不到（曾导致音乐等资源失效）。
    rel = unquote(sub.split("?", 1)[0].split("#", 1)[0])
    full = os.path.realpath(os.path.join(base, rel))
    # 解码后再做 realpath 前缀校验：%2e%2e 之类的穿越写法在这里被拦下
    if not (full == base or full.startswith(base + os.sep)):
        handler._send_error(404, "Not Found", "请求的文件不存在。")   # noqa: SLF001
        return
    if os.path.isdir(full):
        full = os.path.join(full, app["index"])
    if not os.path.isfile(full):
        # 带扩展名的静态资源（.mp3/.png/.json…）找不到就如实 404，
        # 不能回落 index.html：那会让前端 fetch 拿到 200 的 HTML，
        # 把 HTML 当音频/图片用，表现为「静默播放失败」，极难排查。
        ext = os.path.splitext(rel)[1].lower()
        if ext and ext not in (".html", ".htm"):
            handler._send_error(404, "Not Found", "请求的文件不存在。")   # noqa: SLF001
            return
        full = os.path.join(base, app["index"])       # SPA 路由回落
        if not os.path.isfile(full):
            handler._send_error(404, "Not Found", "子应用尚未构建。")  # noqa: SLF001
            return
    ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
        ctype += "; charset=utf-8"
    try:
        st = os.stat(full)
    except OSError:
        handler._send_error(500, "Internal Error", "读取子应用文件失败。")   # noqa: SLF001
        return

    size = st.st_size
    # 缓存策略（消除「人工改名破缓存」的脚枪）：
    # 统一 no-cache + ETag 协商。内容一变（mtime+size 进 ETag）浏览器立即失效并重拉，
    # 因此「原地修补文件」也能马上生效，不再需要手工改文件名来破除 24h 缓存。
    # 注：不采用 immutable 长缓存，是因为子应用 assets 目录下常混入用户上传文件
    # （如背景图 xxx-<hash>.png），它们可能被原地替换；immutable 会让这类更新永远不刷新，
    # 重新引入「改了不生效」的坑。ETag 协商在正确性上更稳妥。
    cache_ctl = "no-cache"
    # Range 请求不压缩：视频/音频拖动进度要靠字节偏移，压缩后偏移就对不上了
    rng_hdr = _req_header(handler, "Range")
    try:
        assets = _assets()
        compressible = assets.is_compressible(ctype)
    except Exception:  # noqa: BLE001
        compressible = False
    use_gzip = (size >= _GZIP_MIN and compressible and not rng_hdr.strip()
                and _hdr_accepts_gzip(handler))
    etag = '"%x-%x-%s"' % (st.st_mtime_ns, size, "gz" if use_gzip else "raw")

    if _hdr_not_modified(handler, etag):
        handler.send_response(304)
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache_ctl)
        handler.send_header("Vary", "Accept-Encoding")
        _subapp_sec_headers(handler)
        handler.end_headers()
        return

    rng = _parse_range(rng_hdr, size)
    if rng == "invalid":
        handler.send_response(416)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        _subapp_sec_headers(handler)
        handler.end_headers()
        return

    if rng:
        start, end = rng
        length = end - start + 1
        handler.send_response(206)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Content-Length", str(length))
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        handler.send_header("Accept-Ranges", "bytes")
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache_ctl)
        _subapp_sec_headers(handler)
        handler.end_headers()
        _stream_file(handler, full, start, length)
        return

    if use_gzip:
        try:
            with open(full, "rb") as f:
                data = f.read()
            body = assets.gzip_bytes(f"{st.st_mtime_ns:x}-{size:x}-gz-{len(data):x}", data)
        except OSError:
            handler._send_error(500, "Internal Error", "读取子应用文件失败。")   # noqa: SLF001
            return
        handler.send_response(200)
        handler.send_header("Content-Type", ctype)
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Content-Encoding", "gzip")
        handler.send_header("Vary", "Accept-Encoding")
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", cache_ctl)
        _subapp_sec_headers(handler)
        handler.end_headers()
        _safe_write(handler, body)
        return

    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(size))
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", cache_ctl)
    _subapp_sec_headers(handler)
    handler.end_headers()
    _stream_file(handler, full, 0, size)


# ---------------------------------------------------------------------------
# 进程型：反向代理到回环端口
# ---------------------------------------------------------------------------
def proxy(handler, app: dict, sub: str, method: str, body: bytes | None) -> None:
    up = f"http://127.0.0.1:{app_port(app)}"
    url = up + "/" + sub
    req = urllib.request.Request(url, method=method, data=body if method not in ("GET", "HEAD") else None)
    for k, v in handler.headers.items():
        lk = k.lower()
        # Host 必须改写成上游；Accept-Encoding 去掉，避免拿到 gzip 后再二次处理
        if lk in ("host", "accept-encoding", "content-length", "connection"):
            continue
        req.add_header(k, v)
    if body:
        req.add_header("Content-Length", str(len(body)))
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
            status = r.status
            headers = list(r.headers.items())
    except urllib.error.HTTPError as e:
        # 4xx/5xx 也是「应用的真实响应」，原样透传给前端（登录失败要靠它显示原因）
        try:
            data = e.read()
        except Exception:  # noqa: BLE001
            data = b""
        status = e.code
        headers = list(e.headers.items()) if e.headers else []
    except Exception as e:  # noqa: BLE001
        handler._send_error(502, "Bad Gateway",           # noqa: SLF001
                            f"子应用无响应：{e}。可在桌面内用「一键运行」重启，或查看 {app.get('log', '日志')}。")
        return

    handler.send_response(status)
    for k, v in headers:
        lk = k.lower()
        if lk in _HOP_HEADERS or lk in _DROP_HEADERS or lk == "content-length":
            continue
        # 上游若回绝对地址跳转，改写成枢纽的挂载路径，否则会把用户送进 127.0.0.1:3000
        if lk == "location" and v.startswith(up):
            v = app["prefix"] + v.split(up + "/", 1)[-1]
        handler.send_header(k, v)
    handler.send_header("Content-Length", str(len(data)))
    _subapp_sec_headers(handler)
    handler.end_headers()
    if method != "HEAD":
        _safe_write(handler, data)


def app_page(title: str, msg: str, detail: str = "", refresh: int = 0) -> bytes:
    """子应用不可用时的兜底页（深色，风格与枢纽一致）。

    refresh > 0 时页面会自动整页重载（秒）：用于「正在启动 / 正在安装依赖」这类
    临时状态——用户什么都不用做，就绪后自动进入应用，不会停在一张错误页上。
    """
    import html as _html
    meta = f'<meta http-equiv="refresh" content="{int(refresh)}">' if refresh > 0 else ""
    return f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">{meta}
<title>{_html.escape(title)}</title><style>
html,body{{height:100%;margin:0;background:#11131a;color:#e8ebf2;
 font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.box{{max-width:560px;margin:12vh auto;padding:28px 30px;background:#191c25;
 border:1px solid #262a37;border-radius:16px}}
h1{{font-size:17px;margin:0 0 12px}}p{{color:#9aa3b8;margin:0 0 10px}}
pre{{margin:12px 0 0;padding:12px;background:#0d0f15;border-radius:10px;color:#8d96ab;
 font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}}
.spin{{display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;
 border:2px solid #3a4055;border-top-color:#6ea8fe;border-radius:50%;
 animation:r .8s linear infinite}}
@keyframes r{{to{{transform:rotate(360deg)}}}}
</style></head><body><div class="box"><h1>{_html.escape(title)}</h1>
<p>{"<span class=spin></span>" if refresh > 0 else ""}{_html.escape(msg)}</p>{f'<pre>{_html.escape(detail)}</pre>' if detail else ''}
</div></body></html>""".encode("utf-8")
