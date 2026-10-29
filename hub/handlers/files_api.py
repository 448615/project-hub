"""handlers.files_api — 文件接口：目录列表、文本预览、图片原文件、文档读取

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import os
import subprocess
import sys
from urllib.parse import parse_qs

from ..config import DOC_ALLOW_EXTS, DOC_MAX_BYTES, FILE_MAX_BYTES, FILE_TEXT_EXTS, FM_MAX_ENTRIES, RAW_IMAGE_EXTS, RAW_MAX_BYTES

class FilesMixin:


    def _handle_files(self, parsed):
        # GET /api/files?project=<name>&path=<rel> —— 目录列表（rel 为空即项目根目录）。
        # 过滤 config.exclude 与点开头的隐藏项（node_modules / .git 等不进文件管理器），
        # 目录在前、文件在后按名称排序，超过 FM_MAX_ENTRIES 截断并标记 truncated。
        q = parse_qs(parsed.query)
        name = (q.get("project") or [""])[0]
        rel = (q.get("path") or [""])[0]
        full = self._resolve_in_project(name, rel)
        if full is None or not os.path.isdir(full):
            self._send_json({"ok": False, "error": "目录不存在。"}, status=404)
            return
        excludes = set(self.config.get("exclude", []))
        entries = []
        try:
            for n in os.listdir(full):
                if n in excludes or n.startswith("."):
                    continue
                child = os.path.join(full, n)
                try:
                    is_dir = os.path.isdir(child)
                    entries.append({
                        "name": n,
                        "type": "dir" if is_dir else "file",
                        "size": None if is_dir else os.path.getsize(child),
                        "mtime": int(os.path.getmtime(child) * 1000),
                    })
                except OSError:
                    continue    # 单个条目 stat 失败不影响整体列表
        except OSError:
            self._send_json({"ok": False, "error": "目录读取失败。"}, status=500)
            return
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
        parent = os.path.dirname(rel) if rel else ""
        self._send_json({
            "ok": True,
            "project": name,
            "path": rel,
            "parent": parent,
            "entries": entries[:FM_MAX_ENTRIES],
            "truncated": len(entries) > FM_MAX_ENTRIES,
        })


    def _handle_file(self, parsed):
        # GET /api/file?project=<name>&path=<rel> —— 项目内任意文本文件的内容。
        # 与 _handle_docs 同款三重校验（项目名 → 路径不逃逸 → 扩展名白名单 → 大小上限），
        # 让文件管理器里双击 .py/.json/.css 等也能在桌面内预览。
        q = parse_qs(parsed.query)
        name = (q.get("project") or [""])[0]
        rel = (q.get("path") or [""])[0]
        if not rel:
            self._send_json({"ok": False, "error": "缺少 path 参数。"}, status=400)
            return
        full = self._resolve_in_project(name, rel)
        if full is None or not os.path.isfile(full):
            self._send_json({"ok": False, "error": "文件不存在。"}, status=404)
            return
        if os.path.splitext(full)[1].lower() not in FILE_TEXT_EXTS:
            self._send_json({"ok": False, "error": "该文件类型不支持预览。"}, status=403)
            return
        try:
            if os.path.getsize(full) > FILE_MAX_BYTES:
                self._send_json({"ok": False, "error": "文件过大（超过 512 KB），请用系统程序打开。"}, status=413)
                return
            with open(full, "r", encoding="utf-8") as f:
                content = f.read()
        except (OSError, UnicodeDecodeError):
            self._send_json({"ok": False, "error": "文件读取失败。"}, status=500)
            return
        self._send_json({"ok": True, "name": name, "file": rel, "content": content})


    def _handle_raw(self, parsed):
        # GET /api/raw?project=<name>&path=<rel> —— 图片字节流（文件管理器内嵌预览）。
        # 只放行图片扩展名 + 大小上限：刻意不做成通用文件下载器，缩小接口暴露面。
        q = parse_qs(parsed.query)
        name = (q.get("project") or [""])[0]
        rel = (q.get("path") or [""])[0]
        full = self._resolve_in_project(name, rel)
        if full is None or not os.path.isfile(full):
            self._send_json({"ok": False, "error": "文件不存在。"}, status=404)
            return
        ext = os.path.splitext(full)[1].lower()
        if ext not in RAW_IMAGE_EXTS:
            self._send_json({"ok": False, "error": "仅支持预览图片文件。"}, status=403)
            return
        mime = {
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        }.get(ext, "application/octet-stream")
        try:
            if os.path.getsize(full) > RAW_MAX_BYTES:
                self._send_json({"ok": False, "error": "图片过大（超过 5 MB）。"}, status=413)
                return
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            self._send_json({"ok": False, "error": "文件读取失败。"}, status=500)
            return
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self._sec_headers()
        self.end_headers()
        self.wfile.write(data)


    def _handle_docs(self, parsed):
        # GET /api/docs?project=<name> —— 供前端「文档查看器」在桌面内渲染 README。
        # 与 _open_path 同款三重校验，杜绝越权读取任意文件：
        #   1) 项目名必须是扫描到的合法子目录（防 ".." / 斜杠穿越式项目名）；
        #   2) docs 路径 realpath 后必须仍位于项目根目录内
        #      （防配置被改成 "../x.md"、绝对路径或经符号链接指到外面）；
        #   3) 扩展名白名单：只放行纯文本文档，二进制/图片不进预览器。
        q = parse_qs(parsed.query)
        name = (q.get("project") or [""])[0]
        if not self._is_valid_project(name):
            self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
            return
        cfg = (self.config.get("projects") or {}).get(name) or {}
        rel = cfg.get("docs")
        if not rel:
            self._send_json({"ok": False, "error": "该项目未配置 docs。"}, status=404)
            return
        root = os.path.abspath(self.root)
        full = os.path.realpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            self._send_json({"ok": False, "error": "文档不存在。"}, status=404)
            return
        if os.path.splitext(full)[1].lower() not in DOC_ALLOW_EXTS:
            self._send_json({"ok": False, "error": "仅支持预览 md / txt 文档。"}, status=403)
            return
        try:
            if os.path.getsize(full) > DOC_MAX_BYTES:
                self._send_json({"ok": False, "error": "文档过大（超过 512 KB），请用外部程序打开。"}, status=413)
                return
            with open(full, "r", encoding="utf-8") as f:
                content = f.read()
        except (OSError, UnicodeDecodeError):
            self._send_json({"ok": False, "error": "文档读取失败。"}, status=500)
            return
        self._send_json({"ok": True, "name": name, "file": rel, "content": content})


    def _open_path(self, rel: str) -> dict:
        # 用系统文件管理器打开目录/文件（仅本地枢纽使用，路径来自可信配置）
        path = os.path.abspath(os.path.join(os.path.abspath(self.root), rel)) if rel else ""
        if not path or not os.path.exists(path):
            return {"ok": False, "error": f"路径不存在：{rel}"}
        try:
            if sys.platform.startswith("win"):
                os.startfile(path)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", path])
            else:
                subprocess.Popen(["xdg-open", path])
            return {"ok": True, "msg": "已打开"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"打开失败：{e}"}
