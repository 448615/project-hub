"""handlers.project_post — POST · 项目与文件写操作（终端命令 / 保存文件 / 新建项目 / 项目动作）

全部在「已登录 + 管理员 + 同源」之后到达；由 handlers/api_post.py 拆分而来。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from urllib.parse import parse_qs

from ..config import load_config
from .. import audit
from ..search_index import invalidate as invalidate_search
from ..projects import invalidate_projects
from ..util import _atomic_write_json, _with_lock


def exec_enabled(cloud: bool) -> bool:
    """终端是否可用。

    P0 修复（命令执行面过大）：云端部署默认**禁用**终端——owner 邮箱一旦失陷，
    开着终端就等于把服务器 RCE 入口交出去。必须显式设置 ``HUB_ENABLE_TERMINAL=1``
    才在云端开启。本地模式（仅 127.0.0.1 可达）默认开启。
    """
    env = os.environ.get("HUB_ENABLE_TERMINAL", "")
    if env in ("1", "true", "True", "yes", "on"):
        return True
    if env in ("0", "false", "False", "no", "off"):
        return False
    # 未显式设置：本地 True，云端 False
    return not cloud


def exec_allowlist() -> list | None:
    """命令白名单前缀列表；None 表示不限制（终端已开启时）。

    设置 ``HUB_EXEC_ALLOWLIST=git,ls,cat,python`` 后，只有以这些前缀开头的命令才会
    被放行，进一步收敛 RCE 面。空值/未设置返回 None（不限制）。
    """
    raw = os.environ.get("HUB_EXEC_ALLOWLIST", "")
    if not raw.strip():
        return None
    return [p.strip() for p in raw.split(",") if p.strip()]


class ProjectPostMixin:

    def _post_exec(self):
        # 内置终端：执行一条 shell 命令，返回输出（本地自用，cwd=项目根）
        body = self._read_body()
        cmd = (body.get("cmd") or "").strip()
        if not cmd:
            self._send_json({"ok": False, "error": "空命令。"})
            return
        # P0 闸门 1：部署模式开关（云端默认关）
        if not exec_enabled(self.cloud):
            self._send_json({"ok": False,
                             "error": "终端已在当前部署模式禁用（本地模式可用；"
                                      "云端需设置 HUB_ENABLE_TERMINAL=1 开启）。"},
                            status=403)
            audit.log_exec(ip=self._client_ip(),
                           user=(getattr(self, "user", None) or {}).get("email", "?"),
                           role=getattr(self, "role", "?"),
                           cmd=cmd, code=None, out_len=0, allowed=False,
                           note="terminal-disabled")
            return
        # P0 闸门 2：可选命令白名单（前缀匹配）
        allow = exec_allowlist()
        if allow is not None and not any(
                cmd == p or cmd.startswith(p + " ") or cmd.startswith(p + "\t")
                for p in allow):
            self._send_json({"ok": False,
                             "error": "该命令不在允许列表内（HUB_EXEC_ALLOWLIST）。"},
                            status=403)
            audit.log_exec(ip=self._client_ip(),
                           user=(getattr(self, "user", None) or {}).get("email", "?"),
                           role=getattr(self, "role", "?"),
                           cmd=cmd, code=None, out_len=0, allowed=False,
                           note="not-in-allowlist")
            return
        ip = self._client_ip()
        user_email = (getattr(self, "user", None) or {}).get("email", "?")
        role = getattr(self, "role", "?")
        try:
            r = subprocess.run(cmd, shell=True, cwd=self.root,
                               capture_output=True, text=True, timeout=15,
                               encoding="utf-8", errors="replace")
            out = (r.stdout or "") + (r.stderr or "")
            self._send_json({"ok": True, "code": r.returncode, "out": out})
            audit.log_exec(ip=ip, user=user_email, role=role, cmd=cmd,
                           code=r.returncode, out_len=len(out), allowed=True)
        except subprocess.TimeoutExpired:
            self._send_json({"ok": True, "code": -1, "out": "命令超时（15s）。"})
            audit.log_exec(ip=ip, user=user_email, role=role, cmd=cmd,
                           code=-1, out_len=0, allowed=True, note="timeout")
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(e)})
            audit.log_exec(ip=ip, user=user_email, role=role, cmd=cmd,
                           code=None, out_len=0, allowed=True, note=f"error:{e}")

    def _post_file_write(self):
        # 代码/文档编辑器：保存文本文件回项目目录
        body = self._read_body()
        name = body.get("project") or ""
        rel = body.get("path") or ""
        content = body.get("content") or ""
        if not self._is_valid_project(name):
            self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
            return
        full = self._resolve_in_project(name, rel)
        if full is None or not os.path.isfile(full):
            self._send_json({"ok": False, "error": "文件不存在。"}, status=404)
            return
        try:
            with open(full, "w", encoding="utf-8", newline="\n") as f:
                f.write(content)
            self._send_json({"ok": True})
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(e)})

    def _post_project_create(self):
        # 新建项目向导：选模板生成目录
        body = self._read_body()
        name = (body.get("name") or "").strip()
        tpl = body.get("template") or "blank"
        if not name or not re.match(r"^[A-Za-z0-9_\-一-龥]+$", name):
            self._send_json({"ok": False, "error": "项目名只能含中英文、数字、-、_。"})
            return
        target = os.path.join(self.root, name)
        if os.path.exists(target):
            self._send_json({"ok": False, "error": "同名项目已存在。"})
            return
        try:
            os.makedirs(target)
            display = (body.get("display") or name).strip()
            desc = (body.get("description") or f"{display} 项目").strip()
            readme = f"# {display}\n\n{desc}\n\n新建项目（{tpl} 模板）。\n"
            with open(os.path.join(target, "README.md"), "w", encoding="utf-8", newline="\n") as f:
                f.write(readme)
            if tpl == "python":
                with open(os.path.join(target, "main.py"), "w", encoding="utf-8", newline="\n") as f:
                    f.write('print("Hello from ' + name + '")\n')
            elif tpl == "node":
                with open(os.path.join(target, "index.js"), "w", encoding="utf-8", newline="\n") as f:
                    f.write('console.log("Hello from ' + name + '");\n')
            elif tpl == "web":
                with open(os.path.join(target, "index.html"), "w", encoding="utf-8", newline="\n") as f:
                    f.write(f"<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n  <meta charset=\"UTF-8\">\n  <title>{display}</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <h1>{display}</h1>\n  <p>{desc}</p>\n  <script src=\"app.js\"></script>\n</body>\n</html>\n")
                with open(os.path.join(target, "style.css"), "w", encoding="utf-8", newline="\n") as f:
                    f.write("body { font-family: system-ui, sans-serif; margin: 40px; color: #333; }\n")
                with open(os.path.join(target, "app.js"), "w", encoding="utf-8", newline="\n") as f:
                    f.write("console.log('" + display + " loaded');\n")
            # 写入 config.json：显示名 / 图标 / 描述 / docs
            cfg_path = os.path.join(self.root, "config.json")
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception:  # noqa: BLE001
                cfg = {"global": {}, "projects": {}}
            cfg.setdefault("projects", {})[name] = {
                "display_name": display,
                "icon": "🛠️",
                "description": desc,
                "docs": f"{name}/README.md",
            }
            # 原子写 + 文件锁：与回收站 manifest 共用同一套并发保护，
            # 避免两个 hub / 并发请求同时写 config.json 互相覆盖（#2）
            lockfile = cfg_path + ".lock"
            _with_lock(lockfile, lambda: _atomic_write_json(cfg_path, cfg))
            self.config = load_config(self.root)   # 刷新配置快照，让显示名立刻生效
            invalidate_search()                    # 新项目目录要能马上被搜索到
            invalidate_projects()                  # 项目列表缓存立即失效，仪表盘马上出现新卡片
            self._send_json({"ok": True})
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(e)})

    def _post_project_action(self, parsed, name, action):
        # 项目名合法性已在 _is_valid_project 内严格校验（路径穿越防护）
        if not self._is_valid_project(name):
            self._send_error(404, "Not Found", "项目不存在或不允许操作。")
            return
        cfg = self.config.get("projects", {}).get(name, {})
        if action == "start":
            # 把当前操作者身份传给子进程：数据处理脚本据此判断能否输出敏感报表
            result = self._start_project(name, cfg, operator=self.user, role=self.role)
        elif action == "stop":
            result = self._stop_project(name)
        elif action == "open":
            # 支持 open?path=<项目内相对路径>：文件管理器里"用系统程序打开"任意项目文件/目录。
            # 无 path 时维持原行为——打开项目根目录。路径必须先过 _resolve_in_project
            # （项目名合法 + realpath 不逃逸），杜绝借 open 接口越权打开系统文件。
            q = parse_qs(parsed.query)
            rel = (q.get("path") or [""])[0]
            if rel:
                full = self._resolve_in_project(name, rel)
                if full is None or not os.path.exists(full):
                    result = {"ok": False, "error": "路径不存在或不允许访问。"}
                else:
                    result = self._open_path(name + "/" + rel.replace("\\", "/"))
            else:
                result = self._open_path(name)
        else:  # docs
            if not cfg.get("docs"):
                result = {"ok": False, "error": "该项目未配置 docs"}
            else:
                result = self._open_path(cfg["docs"])
        self._send_json(result)
