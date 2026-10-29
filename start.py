# -*- coding: utf-8 -*-
"""
启动主系统脚本  start.py
====================================
作用：一键启动 project-hub 桌面系统（原 hub.py，现拆分为 hub/ 包）。
适合人群：不想记命令、想双击就能跑的小伙伴。

它会帮你做这几件事：
  1. 自动切到脚本所在目录（这样无论你从哪运行都能找到 hub.py）；
  2. 检查 hub.py 在不在；
  3. 让你选一个端口（直接回车就是用 8000）；
  4. 启动 hub.py，并自动打开浏览器。

两种用法：
  用法一（最省事）：python start.py          -> 会问你端口，回车用 8000
  用法二（直接指定）：python start.py 9000     -> 不提问，直接用 9000 端口
"""

import os          # 用来处理文件和目录路径
import sys         # 用来拿到当前 python 解释器路径、读取命令行参数
import subprocess  # 用来在脚本里再启动另一个 python 程序（hub.py）
import platform    # 用来判断当前是什么操作系统（Windows / 其他）
import threading   # 用来延迟打开浏览器，不阻塞服务启动
import time        # 配合延迟
import webbrowser  # 启动后自动打开默认浏览器
from hub import diag


def main():
    # 第 1 步：拿到这个脚本自己的位置，并切过去
    # __file__        -> 当前这个文件的路径，比如 "D:/xxx/start.py"
    # os.path.abspath -> 把它变成完整的绝对路径，避免相对路径出错
    # os.path.dirname -> 只取出"目录部分"，去掉文件名
    script_dir = os.path.dirname(os.path.abspath(__file__))
    # 切到那个目录。后面找 hub.py 时，就一定会在这个目录里找，不会找错地方
    os.chdir(script_dir)

    # 第 2 步：如果是 Windows，把控制台切换成 UTF-8 编码
    # 原因：老版 Windows 命令行默认用 GBK，直接打印中文会"乱码"
    # 用 sys.stdout/stderr.reconfigure 替代 os.system("chcp 65001")：
    # 避免再起一个 shell 子进程（os.system 既慢又有注入观感），且对管道/重定向同样生效。
    if platform.system() == "Windows":
        for _s in (sys.stdout, sys.stderr):
            try:
                _s.reconfigure(encoding="utf-8")
            except (AttributeError, ValueError, OSError):
                pass

    # 第 3 步：打印一个好看的欢迎横幅
    print("=" * 52)
    print("        Project Hub 桌面系统 · 启动器")
    print("=" * 52)

    # 第 4 步：检查 hub.py 是否存在
    # os.path.exists 返回 True（在）或 False（不在）
    # 主程序已从单文件 hub.py 拆分为 hub/ 包，入口改为 main.py
    if not (os.path.exists("main.py") and os.path.isdir("hub")):
        print("没找到 main.py 或 hub/ 目录，请确认 start.py 与它们放在同一个文件夹下。")
        return

    # 第 5 步：决定用哪个端口
    # sys.argv 是一个列表，里面放着运行命令时的所有词
    #   例如你输入  python start.py 9000
    #   那么 sys.argv = ["start.py", "9000"]
    #   第 0 个是脚本名，第 1 个往后才是我们关心的"参数"
    if len(sys.argv) >= 2:
        # 命令行给了端口，比如 python start.py 9000，就直接用第 1 个参数
        port = sys.argv[1]
        # 简单校验：端口必须是个数字，否则 hub.py 的 argparse 会直接报错退出，
        # 而这里又收不到报错，用户只会看到"没反应"。校验不通过就回退默认端口。
        if not port.isdigit() or not (1 <= int(port) <= 65535):
            print(f"端口「{port}」不是 1-65535 之间的有效数字，已改用默认端口 8000。")
            port = "8000"
    else:
        # 没给参数，就问用户。input() 会显示括号里的提示并等待输入
        # .strip() 是把用户输入首尾的空格去掉，防止手滑多打了空格
        try:
            port = input("请输入端口号（直接回车用默认 8000）：").strip()
        except EOFError:
            # 万一没有可输入的环境（比如被管道调用、或某些双击场景）
            # 就退回默认端口，不让程序因为"没人回答"而崩溃
            port = ""
        if port == "":          # 用户什么都没输，就当成 8000
            port = "8000"

    # 第 6 步：拼出要执行的"启动命令"
    # sys.executable 就是"当前正在跑的 python 程序自己"的完整路径
    # 用它的好处：哪怕你电脑里装了好几个 python，也一定用"现在这个对的"
    # 最终命令相当于：python main.py --port 9000
    # 统一兜底校验：无论端口来自命令行还是手动输入，最终再确认是 1-65535 的合法端口
    if not str(port).isdigit() or not (1 <= int(port) <= 65535):
        print(f"端口「{port}」不是 1-65535 之间的有效数字，已改用默认端口 8000。")
        port = "8000"
    cmd = [sys.executable, "main.py", "--port", str(port)]

    # 第 7 步：启动主系统！
    print(f"正在启动主系统，端口：{port}")
    print("启动后浏览器会自动打开；想停止时，关闭本窗口或按 Ctrl+C 即可。")

    # 延迟 1.5 秒后自动打开默认浏览器（等服务先起来）；daemon 线程不阻塞主流程
    def _open_browser():
        time.sleep(1.5)
        try:
            webbrowser.open(f"http://127.0.0.1:{port}/")
        except Exception as exc:  # noqa: BLE001
            diag.note("start.py::_open_browser", exc)

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        # subprocess.run 会"卡住"在这里，一直等到 hub.py 结束才往下走
        subprocess.run(cmd)
    except KeyboardInterrupt:
        # 用户按了 Ctrl+C（强制中断），给个温柔的告别提示
        print("\n已停止主系统，再见~")


# 这一段是 Python 的"主入口"固定写法：
# 只有当"直接双击 / 直接运行这个文件"时，才会执行 main()
# 如果别的程序把它当普通模块 import，这一段不会执行，避免误启动
if __name__ == "__main__":
    main()
