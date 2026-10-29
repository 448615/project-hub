"""handlers.project_ops — 写请求：项目启停、目录解析

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import os
import re
import subprocess
from urllib.parse import urlparse

from ..config import RUNNING, RUNNING_LOCK, SUBAPPS
from ..projects import invalidate_ports
from ..util import _kill_tree, _split_run
from .. import diag

class ProjectOpsMixin:


    def _handle_write_method(self, method: str):
        path = urlparse(self.path).path
        if self._reject_chunked():
            return
        if SUBAPPS is not None and SUBAPPS.is_app_path(path):
            try:
                self._handle_subapp(urlparse(self.path), method=method)
            except Exception as e:  # noqa: BLE001
                try:
                    self._send_json({"error": f"服务器错误：{e}"}, status=500)
                except Exception as exc:  # noqa: BLE001
                    diag.note("hub/handlers/project_ops.py::_handle_write_method", exc)
            return
        self._send_json({"ok": False, "error": f"不支持的方法 {method}。"}, status=405)


    def do_PUT(self):
        self._handle_write_method("PUT")


    def do_PATCH(self):
        self._handle_write_method("PATCH")


    def do_DELETE(self):
        self._handle_write_method("DELETE")

    # ----------------------------------------------------------------------
    # 子项目管理：一键启动 / 停止 / 打开目录 / 打开文档
    # ----------------------------------------------------------------------


    def _is_valid_project(self, name: str) -> bool:
        # 校验项目名是否确实是一个被扫描到的子目录，防止越权操作任意路径。
        # 必须限制为「纯文件名」形态（字母/数字/点/下划线/连字符），
        # 杜绝 ".."、斜杠等路径穿越式项目名。
        if not re.fullmatch(r"[\w.\-]+", name):
            return False
        full = os.path.join(os.path.abspath(self.root), name)
        if not os.path.isdir(full):
            return False
        excludes = set(self.config.get("exclude", []))
        return not (name in excludes or name.startswith("."))


    def _start_project(self, name: str, cfg: dict, operator=None, role: str = "") -> dict:
        run = (cfg or {}).get("run")
        if not run:
            return {"ok": False, "error": "该项目未配置 run 命令（请在 config.json 的 projects.<name>.run 中设置）"}
        # 子进程环境：注入操作者身份，供脚本内部做权限判断（如数据处理脚本报表）
        child_env = os.environ.copy()
        child_env["HUB_OPERATOR_EMAIL"] = str((operator or {}).get("email", ""))
        child_env["HUB_OPERATOR_ROLE"] = str(role or "")
        # 并发保护（S2）：整个「检查-启动-写入」持锁，杜绝并发 start 重复拉起进程
        with RUNNING_LOCK:
            if name in RUNNING and RUNNING[name].poll() is None:
                return {"ok": True, "already": True, "msg": "已在运行"}
            try:
                # Windows 上反斜杠是路径分隔符而不是转义符，必须 posix=False 解析，
                # 否则 'python C:\dir\app.py' 的反斜杠会被当转义符吃掉，路径变成乱码（S4）
                args = _split_run(run)
            except Exception as e:  # noqa: BLE001
                diag.note("hub/handlers/project_ops.py::_start_project", e)
                return {"ok": False, "error": f"run 命令解析失败：{e}"}
            # POSIX 上让子进程成为独立进程组组长，停止时才能连孙进程一起杀（S3）
            extra = {"start_new_session": True} if os.name != "nt" else {}
            try:
                # 优先 shell=False：参数已拆分、命令来自可信配置，最安全、无注入风险
                proc = subprocess.Popen(
                    args, cwd=os.path.abspath(self.root), env=child_env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                    **extra,
                )
            except (FileNotFoundError, OSError):
                # Windows 上 npm/yarn/pnpm 其实是 .cmd 批处理，shell=False 找不到可执行文件，
                # 此时回退 shell=True。命令仍是配置里的可信字符串、无用户输入，风险可控。
                try:
                    proc = subprocess.Popen(
                        run, cwd=os.path.abspath(self.root), shell=True, env=child_env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                    )
                except Exception as e:  # noqa: BLE001
                    diag.note("hub/handlers/project_ops.py::_start_project.spawn", e)
                    return {"ok": False, "error": f"启动失败：{e}"}
            RUNNING[name] = proc
            # 状态已变：丢掉端口探测缓存，「运行中」标记下一次刷新立即生效
            invalidate_ports()
            return {"ok": True, "msg": "已启动", "pid": proc.pid}


    def _stop_project(self, name: str) -> dict:
        # 同样持锁，避免与并发的 start/stop 交错把 RUNNING 弄乱（S2）
        with RUNNING_LOCK:
            proc = RUNNING.get(name)
            if not proc or proc.poll() is not None:
                RUNNING.pop(name, None)
                return {"ok": True, "msg": "未在运行"}
            _kill_tree(proc)          # 结束整棵进程树，含 npm 等派生的孙进程（S3）
            try:
                proc.wait(timeout=5)  # 最多等 5 秒体面退出
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()       # 超时还不退，强制结束
                except Exception as exc:     # noqa: BLE001
                    diag.note("hub/handlers/project_ops.py::_stop_project", exc)
            RUNNING.pop(name, None)
            invalidate_ports()
            return {"ok": True, "msg": "已停止"}


    def _resolve_in_project(self, name: str, rel: str):
        # 把「项目内的相对路径」解析成真实绝对路径；越权一律返回 None。
        # 文件管理器的列表 / 文本预览 / 图片预览 / 系统打开全部走这里做前置校验：
        #   1) 项目名合法（_is_valid_project，防 ".." / 斜杠穿越式项目名）；
        #   2) realpath 后必须仍位于该项目目录内（防 "../x"、绝对路径、符号链接外逃）。
        # 返回 None 表示拒绝；返回的路径保证在项目目录之内。
        if not self._is_valid_project(name):
            return None
        proj_dir = os.path.realpath(os.path.join(os.path.abspath(self.root), name))
        full = os.path.realpath(os.path.join(proj_dir, rel)) if rel else proj_dir
        if full != proj_dir and not full.startswith(proj_dir + os.sep):
            return None
        return full
