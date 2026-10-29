"""handlers.files_write — POST · 文件管理器写操作与服务器回收站

复制 / 剪切粘贴 / 删除进回收站，以及回收站的还原、单条永久删除、按项目清空。
由 handlers/api_post.py 拆分而来；方法之间通过 self 互相调用，不 import 彼此。
"""
from __future__ import annotations

import os
import shutil
import time

from ..files import _load_trash_manifest, _safe_trash_name, _save_trash_manifest, _trash_root, _unique_trash_name
from ..search_index import invalidate as invalidate_search
from .. import diag


class FilesWriteMixin:

    # ----------------------------------------------------------------------
    # 文件管理器增强：复制 / 剪切粘贴 / 删除进回收站 / 回收站还原与清空
    # ----------------------------------------------------------------------


    def _handle_fs(self, parsed):
        # POST /api/fs  body: {project, action: copy|move|delete, src, dst}
        #   copy/move：src（项目内相对路径）→ dst（项目内目标相对路径，含文件名）
        #   delete：src 移到项目根 .hub-trash（服务器回收站），记录还原路径
        # 所有路径必须通过 _resolve_in_project 校验（项目名合法 + realpath 不逃逸）。
        body = self._read_body()
        name = body.get("project") or ""
        action = body.get("action") or ""
        src = body.get("src") or ""
        dst = body.get("dst") or ""
        if action not in ("copy", "move", "delete"):
            self._send_json({"ok": False, "error": "不支持的操作。"}, status=400)
            return
        if not src:
            self._send_json({"ok": False, "error": "缺少 src。"}, status=400)
            return
        src_full = self._resolve_in_project(name, src)
        if src_full is None or not os.path.exists(src_full):
            self._send_json({"ok": False, "error": "源路径不存在或不允许访问。"}, status=404)
            return

        if action in ("copy", "move"):
            if not dst:
                self._send_json({"ok": False, "error": "缺少目标路径 dst。"}, status=400)
                return
            dst_full = self._resolve_in_project(name, dst)
            if dst_full is None:
                self._send_json({"ok": False, "error": "目标路径不允许访问。"}, status=403)
                return
            # 防止把目录移/复制到自身内部（目录拖进自己）；
            # 复制到同名目标合法（下方自动生成「-副本N」），仅“移动”到自身才拒绝
            if (action == "move" and dst_full == src_full) or (os.path.isdir(src_full) and dst_full.startswith(src_full + os.sep)):
                self._send_json({"ok": False, "error": "不能移动到自身内部。"}, status=400)
                return
            # 目标父目录可能不存在（用户指定的中间目录），先建好，否则 shutil 直接报错（#7）
            os.makedirs(os.path.dirname(dst_full) or dst_full, exist_ok=True)
            # 目标已存在时自动加「-副本」，不覆盖用户文件
            target = dst_full
            n = 1
            base, ext = os.path.splitext(dst_full)
            while os.path.exists(target):
                target = f"{base}-副本{n}{ext}"
                n += 1
            try:
                if os.path.isdir(src_full):
                    shutil.copytree(src_full, target) if action == "copy" else shutil.move(src_full, target)
                else:
                    shutil.copy2(src_full, target) if action == "copy" else shutil.move(src_full, target)
            except Exception as e:  # noqa: BLE001
                diag.note("hub/handlers/files_write.py::_handle_fs", e)
                self._send_json({"ok": False, "error": f"操作失败：{e}"}, status=500)
                return
            verb = "已复制" if action == "copy" else "已移动"
            invalidate_search()      # 文件树变了，搜索索引立即失效
            self._send_json({"ok": True, "msg": verb})
            return

        # delete：移入服务器回收站 .hub-trash
        try:
            os.makedirs(_trash_root(self.root), exist_ok=True)
            trash_name = _unique_trash_name(self.root, os.path.basename(src_full))
            trash_target = os.path.join(_trash_root(self.root), trash_name)
            shutil.move(src_full, trash_target)
            manifest = _load_trash_manifest(self.root)
            manifest.append({
                "id": f"t{int(time.time() * 1000)}",
                "name": os.path.basename(src_full),
                "orig": src,
                "project": name,
                "deletedAt": time.strftime("%Y-%m-%d %H:%M"),
            })
            _save_trash_manifest(self.root, manifest)
            invalidate_search()      # 文件树变了，搜索索引立即失效
            self._send_json({"ok": True, "msg": "已移入回收站"})
        except Exception as e:  # noqa: BLE001
            diag.note("hub/handlers/files_write.py::_handle_fs.delete", e)
            self._send_json({"ok": False, "error": f"删除失败：{e}"}, status=500)


    def _handle_trash_restore(self, parsed):
        # POST /api/trash/restore  body: {project, id}
        body = self._read_body()
        name = body.get("project") or ""
        tid = body.get("id") or ""
        if not self._is_valid_project(name):
            self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
            return
        manifest = _load_trash_manifest(self.root)
        # 条目必须属于本次请求的项目：否则拿着 A 项目页面里的 id 就能还原/删除 B 项目的东西
        item = next((x for x in manifest if x.get("id") == tid
                     and (x.get("project") or "") == name), None)
        if not item:
            self._send_json({"ok": False, "error": "回收站条目不存在。"}, status=404)
            return
        trash_file = os.path.join(_trash_root(self.root), _safe_trash_name(item.get("name")))
        if not trash_file or not os.path.exists(trash_file):
            # 磁盘文件已丢：清掉清单条目，按缺失处理
            _save_trash_manifest(self.root, [x for x in manifest if x.get("id") != tid])
            self._send_json({"ok": False, "error": "回收站中的文件已不存在。"}, status=404)
            return
        # 还原回原相对路径（原位置被占用则加 -N）
        proj_dir = os.path.realpath(os.path.join(os.path.abspath(self.root), name))
        orig = item.get("orig") or item.get("name", "")
        orig_full = os.path.realpath(os.path.join(proj_dir, orig))
        if not orig_full.startswith(proj_dir + os.sep):
            self._send_json({"ok": False, "error": "还原路径不合法。"}, status=403)
            return
        if os.path.exists(orig_full):
            base, ext = os.path.splitext(orig_full)
            n = 1
            while os.path.exists(orig_full):
                orig_full = f"{base}-还原{n}{ext}"
                n += 1
        os.makedirs(os.path.dirname(orig_full), exist_ok=True)
        try:
            shutil.move(trash_file, orig_full)
            _save_trash_manifest(self.root, [x for x in manifest if x.get("id") != tid])
            invalidate_search()      # 文件回到项目树里了，搜索索引立即失效
            self._send_json({"ok": True, "msg": "已还原"})
        except Exception as e:  # noqa: BLE001
            diag.note("hub/handlers/files_write.py::_handle_trash_restore", e)
            self._send_json({"ok": False, "error": f"还原失败：{e}"}, status=500)


    def _handle_trash_remove(self, parsed):
        # POST /api/trash/remove  body: {project, id} —— 从回收站永久删除单个条目
        body = self._read_body()
        name = body.get("project") or ""
        tid = body.get("id") or ""
        if not self._is_valid_project(name):
            self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
            return
        manifest = _load_trash_manifest(self.root)
        item = next((x for x in manifest if x.get("id") == tid
                     and (x.get("project") or "") == name), None)
        if not item:
            self._send_json({"ok": False, "error": "回收站条目不存在。"}, status=404)
            return
        trash_file = os.path.join(_trash_root(self.root), _safe_trash_name(item.get("name")))
        try:
            if not trash_file or not os.path.exists(trash_file):
                _save_trash_manifest(self.root, [x for x in manifest if x.get("id") != tid])
                self._send_json({"ok": False, "error": "回收站中的文件已不存在。"}, status=404)
                return
            if os.path.isdir(trash_file):
                shutil.rmtree(trash_file, ignore_errors=True)
            else:
                try:
                    os.remove(trash_file)
                except OSError:
                    pass
            _save_trash_manifest(self.root, [x for x in manifest if x.get("id") != tid])
            self._send_json({"ok": True, "msg": "已永久删除"})
        except Exception as e:  # noqa: BLE001
            diag.note("hub/handlers/files_write.py::_handle_trash_remove", e)
            self._send_json({"ok": False, "error": f"删除失败：{e}"}, status=500)


    def _handle_trash_empty(self, parsed):
        # POST /api/trash/empty  body: {project} —— 清空「当前项目」的回收站
        #
        # 重要：.hub-trash 是所有项目共用的一个目录，但界面只列出当前项目的条目。
        # 早期实现直接 listdir 全删 + manifest 清空，等于「在 A 项目点清空，把 B 项目的
        # 回收站也一起永久删了」（不可恢复）。这里改成只处理清单里 project == 当前项目
        # 的条目，其余条目原样保留。
        body = self._read_body()
        name = body.get("project") or ""
        if not self._is_valid_project(name):
            self._send_json({"ok": False, "error": "项目不存在。"}, status=404)
            return
        try:
            trash = _trash_root(self.root)
            manifest = _load_trash_manifest(self.root)
            mine = [x for x in manifest if (x.get("project") or "") == name]
            keep = [x for x in manifest if (x.get("project") or "") != name]
            removed = 0
            for item in mine:
                safe = _safe_trash_name(item.get("name"))
                if not safe:
                    continue          # 名字非法（含路径分隔符）就只清清单条目，不碰磁盘
                p = os.path.join(trash, safe)
                try:
                    if os.path.isdir(p) and not os.path.islink(p):
                        shutil.rmtree(p, ignore_errors=True)
                    elif os.path.lexists(p):
                        os.remove(p)
                    removed += 1
                except OSError:
                    pass
            if mine:
                _save_trash_manifest(self.root, keep)
            self._send_json({"ok": True, "msg": f"已清空（{removed} 项）"})
        except Exception as e:  # noqa: BLE001
            diag.note("hub/handlers/files_write.py::_handle_trash_empty", e)
            self._send_json({"ok": False, "error": f"清空失败：{e}"}, status=500)
