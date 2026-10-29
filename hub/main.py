"""main — 启动入口：参数解析、监听地址与端口、服务启动

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import argparse
import os
import sys
import webbrowser

from .config import ADMINS, DB_PATH, HERE, SUBAPPS, load_config
from .util import _safe_print
from .handlers import HubHandler
from . import diag
from .server import BoundedHTTPServer


def main():
    # 诊断日志：把「被有意吞掉」的异常记到 .data/hub.log（1MB×3 滚动）。
    # 刻意不往控制台打，启动输出保持干净；HUB_DIAG=0 可整体关闭。
    diag.setup()

    ap = argparse.ArgumentParser(description="Project Hub —— 项目启动中心")
    ap.add_argument("--root", default=HERE, help="项目根目录（默认 hub.py 所在目录）")
    ap.add_argument("--port", type=int, default=8000, help="监听端口（1-65535，默认 8000）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--cloud", action="store_true",
                    help="云端模式：绑定 0.0.0.0 并读取环境变量 PORT。"
                         "登录与权限规则同本地——邮箱登录，普通用户只读、管理员全功能")
    args = ap.parse_args()

    # 云端只读模式触发条件：显式 --cloud，或检测到云端沙箱注入的 PORT 环境变量。
    # （本地 `python hub.py` / `python start.py` 默认不设 PORT，仍走本地模式，行为不变；
    #   加 PORT 兜底是为了部署时即便启动命令/解释器与预期不同，也能可靠进入只读模式。）
    cloud_mode = args.cloud or bool(os.environ.get("PORT"))

    # ---- 决定监听地址与端口 ----
    if cloud_mode:
        # 云端沙箱：必须 bind 0.0.0.0，端口取自沙箱注入的 PORT 环境变量
        host = "0.0.0.0"
        try:
            port = int(os.environ.get("PORT") or args.port)
        except ValueError:
            port = args.port
    else:
        host = args.host
        port = args.port
        # 本地模式：禁止绑到 0.0.0.0（会把 /api/exec 等写接口暴露到局域网）
        if host in ("0.0.0.0", ""):
            ap.error("--host 0.0.0.0 不被允许（安全限制：会暴露 /api/exec 到局域网）。"
                     " 如需远程访问，请用 SSH 端口转发到本机 127.0.0.1。")

    # 端口范围校验（S6）：argparse 的 type=int 只保证是整数，不保证范围；
    # 不校验的话 --port 65530 会连试到 65550，bind 抛的是 OverflowError 而非 OSError，
    # 原来的 except OSError 接不住，启动直接崩溃。这里显式拦掉并给出可读错误。
    if not (1 <= port <= 65535):
        ap.error(f"--port 必须在 1-65535 之间，当前为 {port}")

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        # root 不存在时 os.listdir 会在请求阶段才炸，导致 /api/projects 永久无响应（S5）；
        # 启动阶段就校验，直接给出明确错误，不留到运行时。
        print(f"[错误] 项目根目录不存在或不是目录：{root}")
        print("       请用 --root 指定正确的目录。")
        sys.exit(2)
    config = load_config(root)
    HubHandler.root = root
    HubHandler.config = config
    HubHandler.cloud = cloud_mode

    # 前端合并包自检：清单与实际文件是否对得上（漏登记 / 路径拼错）。
    # 合并最容易踩的坑就是「新增了文件忘了登记」或「清单路径写错」，
    # 症状都是新代码静默不生效，启动时打一条提示远比事后排查便宜。
    try:
        from .static_assets import check_order
        _bad = check_order(os.path.join(HERE, "static"))
        if _bad:
            print("[提示] static/js/bundle.order 与实际文件不一致，相关脚本不会生效：")
            for _m in _bad:
                print("       - " + _m)
    except Exception as exc:  # noqa: BLE001
        diag.note("hub/main.py::main", exc)

    # 管理员名单：config.json 的 admins（邮箱数组）+ 环境变量 HUB_ADMINS（逗号分隔，
    # 部署时不必改文件）。刻意不做「首个注册用户自动当管理员」——公网上那等于
    # 谁先注册谁拿走服务器，管理员只能由这份名单显式指定。
    # 名单为空时，所有登录用户都是普通用户（只读），写接口全部 403。
    admins = set()
    for e in (config.get("admins") or []):
        e = str(e).strip().lower()
        if e:
            admins.add(e)
    for e in (os.environ.get("HUB_ADMINS") or "").split(","):
        e = e.strip().lower()
        if e:
            admins.add(e)
    HubHandler.admins = admins
    ADMINS.clear()
    ADMINS.update(admins)   # 账号层通过 config.ADMINS 读取，保持同一份
    if admins:
        print(f"[信息] 管理员账号：{', '.join(sorted(admins))}")
    else:
        print("[提示] 未配置管理员（config.json 的 admins 或环境变量 HUB_ADMINS），"
              "所有登录用户均为普通用户（只读）。")
    print(f"[信息] 本地账号库：{DB_PATH}（首个注册用户自动成为管理员）")

    # 尝试启动服务
    httpd = None
    actual_port = port
    if cloud_mode:
        # 云端：PORT 由沙箱分配，必须精确绑定（顺延会让外部映射失效），失败直接抛错
        httpd = BoundedHTTPServer((host, actual_port), HubHandler)
    else:
        # 本地：端口被占用是 Windows 上最常见的启动失败原因（WinError 10048），自动顺延
        for offset in range(20):  # 最多往后试 20 个端口，足够避开占用
            try:
                # 这一行会在内部立刻绑定端口；绑定失败会抛 OSError
                httpd = BoundedHTTPServer((host, actual_port), HubHandler)
                break  # 绑定成功，跳出循环
            except (OSError, OverflowError):
                # OSError: 端口被占用；OverflowError: 端口号超出 16 位范围（S6）
                if offset == 0:
                    print(f"[提示] 端口 {actual_port} 被占用，自动尝试下一个端口…")
                actual_port += 1
        if httpd is None:
            # 连续 20 个端口都满了，实在起不来，抛错让外层统一处理
            raise RuntimeError("连续 20 个端口都不可用，无法启动服务。")

    # 把枢纽真实端口告诉子应用托管层：云端 $PORT 往往就是 3000，
    # 与星枢默认端口撞车时 port_open() 会命中枢纽自己，表现为「星枢打开的是桌面」。
    if SUBAPPS is not None:
        SUBAPPS.HUB_PORT = actual_port

    # 用"真正用上的端口"拼访问地址，避免和你看到的不一致
    url = f"http://{host}:{actual_port}/"
    _safe_print("\n  🚀 Project Hub 已启动" + ("（云端模式）" if cloud_mode else ""))
    _safe_print(f"  📂 根目录：{root}")
    _safe_print(f"  🔗 打开：  {url}")
    _safe_print(f"  ⚙️ 并发上限：{httpd.max_workers} 线程 · 连接超时：{httpd.request_timeout:g}s")
    if cloud_mode:
        _safe_print("  ☁️ 云端模式：邮箱登录后按角色使用——普通用户只读，管理员全功能")
        _safe_print("  ⌨️ 内置终端：云端默认禁用，需 HUB_ENABLE_TERMINAL=1 开启（已强制审计）")
    _safe_print("  ⌨️  Ctrl+C 退出\n")

    # 云端模式没有本地浏览器可开，跳过自动打开
    if not args.no_browser and not cloud_mode:
        try:
            webbrowser.open(url)
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/main.py::main", exc)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("  已停止。")
        httpd.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception:  # 任何启动阶段的意外错误都兜住，避免窗口一闪而过
        import traceback
        tb = traceback.format_exc()
        # 把完整错误写进日志文件，方便你发给我看、或直接排查
        try:
            with open(os.path.join(HERE, "hub-error.log"), "w", encoding="utf-8") as f:
                f.write(tb)
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/main.py", exc)
        print("启动失败！错误信息已保存到 hub-error.log：\n")
        print(tb)
        # 仅在交互式终端等待回车；云端沙箱/管道等无 stdin 场景直接退出，避免挂起
        if sys.stdin.isatty():
            input("按回车键关闭窗口…")
