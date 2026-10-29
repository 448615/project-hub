"""util — 通用工具：进程树结束、命令行解析、原子写 JSON、文件锁、文本读取、路径描述

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import atexit
import json
import os
import shlex
import signal
import subprocess

from .config import RUNNING, SUBAPPS
from . import diag

def _kill_tree(proc):
    # 结束子进程及其所有孙进程。npm run dev 这类命令会派生子进程，
    # 只 terminate 直接子进程的话，dev server 仍会继续占端口
    #（表现为"点了停止，端口仍显示运行中"，重启还会端口冲突）。
    if proc.poll() is not None:
        return
    try:
        if os.name == "nt":
            # Windows：taskkill /T 连子孙进程一起结束，/F 强制
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=10, check=False,
            )
        else:
            # POSIX：Popen 时已设 start_new_session=True，子进程是进程组组长，
            # 给整个进程组发 SIGTERM，一次性带走所有子孙进程
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:  # noqa: BLE001
        # 兜底：整棵树杀不掉，至少结束直接子进程
        try:
            proc.terminate()
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::_kill_tree", exc)


def _strip_quotes(s: str) -> str:
    # 剥掉包裹在参数外的引号（shlex 非 posix 模式不会自己剥）
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ('"', "'"):
        return s[1:-1]
    return s


def _split_run(run: str) -> list:
    # 把 config.json 的 run 字符串拆成 argv 列表。
    # Windows 必须 posix=False：那里反斜杠是路径分隔符而非转义符，
    # posix 模式会把 'python C:\dir\app.py' 的反斜杠吃掉变成乱码路径（S4）。
    # 但 posix=False 有个连带行为：不剥掉包裹引号，需手动剥，
    # 否则 '"C:\my dir\app.py"' 连引号一起传给程序，反而找不到文件。
    if os.name == "nt":
        return [_strip_quotes(a) for a in shlex.split(run, posix=False)]
    return shlex.split(run)


def _cleanup_children():
    # 本枢纽退出时，把由它拉起的子进程一并结束，避免留下孤儿进程占用端口
    for name, proc in list(RUNNING.items()):
        _kill_tree(proc)
    # 子应用（星枢 Node 服务）同理：只结束由本枢纽拉起的实例
    if SUBAPPS is not None:
        try:
            SUBAPPS.stop_all()
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::_cleanup_children", exc)


atexit.register(_cleanup_children)


def _safe_print(*args):
    # 有些 Windows 控制台（GBK / CP936 代码页）无法显示 emoji，
    # 直接 print 会抛 UnicodeEncodeError，进而让后面的 serve_forever 不执行、
    # 服务起不来。这里兜底：显示不了就跳过，绝不影响服务启动。
    try:
        print(*args)
    except UnicodeEncodeError:
        pass


def _atomic_write_json(path: str, data) -> None:
    # 先写临时文件再 os.replace 原子替换：要么整个旧文件、要么整个新文件，
    # 不会出现「写了一半被另一个进程读到」的损坏 JSON（覆盖式整文件写回的硬伤）。
    d = os.path.dirname(path) or "."
    os.makedirs(d, exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _with_lock(lockfile: str, fn):
    # 跨进程文件锁（进程级互斥），用操作系统 advisory lock 实现：
    #   Windows -> msvcrt.locking；POSIX -> fcntl.flock。
    # 锁失败（极少数环境不支持）不致命，仅退化为无锁（仍受原子写保护）。
    # 用途：多个 hub 实例 / 并发请求同时改写 manifest 或 config.json 时串行化，
    # 避免互相覆盖导致清单丢条目或写成损坏 JSON。
    d = os.path.dirname(lockfile) or "."
    os.makedirs(d, exist_ok=True)
    lf = open(lockfile, "a+")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lf.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::_with_lock", exc)
        return fn()
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lf.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::_with_lock", exc)
        try:
            lf.close()
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::_with_lock", exc)


# --------------------------------------------------------------------------
# 配置加载：读 config.json，读不到就返回空字典（自动扫描照样能用）
# --------------------------------------------------------------------------


def _read_file(path: str, limit: int = 4000) -> str:
    # 只读文件前 limit 个字符，足够提取描述，又不会把大文件全读进内存
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read(limit)
    except Exception:  # noqa: BLE001
        return ""


def auto_description(project_dir: str) -> str:
    # 优先取 README 的第一行有效内容（去掉标题行）
    readme = os.path.join(project_dir, "README.md")
    if os.path.isfile(readme):
        for line in _read_file(readme).splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line[:160]

    # 其次取 package.json 里的 description 字段
    pkg = os.path.join(project_dir, "package.json")
    if os.path.isfile(pkg):
        try:
            d = json.loads(_read_file(pkg))
            if d.get("description"):
                return str(d["description"])[:160]
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/util.py::auto_description", exc)

    # 再次取 pyproject.toml 里的 description = "xxx"
    toml = os.path.join(project_dir, "pyproject.toml")
    if os.path.isfile(toml):
        for line in _read_file(toml).splitlines():
            line = line.strip()
            if line.startswith("description"):
                v = line.split("=", 1)[-1].strip().strip('"').strip("'")
                if v:
                    return v[:160]
    return ""


def _is_loopback(addr: str) -> bool:
    """请求是否来自本机回环（仅用于「本地首次初始化」这一处判断）。"""
    a = (addr or "").strip()
    return a in ("::1", "localhost") or a.startswith("127.")
