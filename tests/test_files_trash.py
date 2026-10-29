#!/usr/bin/env python3
"""文件管理器写操作与服务器回收站回归测试。

这条链路的风险不在「能不能用」，而在**误删**：回收站是用户最后的后悔药，
所以重点断言

  1. 删除必须真的进 .hub-trash 且写清还原路径（不是直接 rm）；
  2. 清空只能清「当前项目」的条目，另一个项目的条目与磁盘文件必须原样保留；
  3. 拿着 A 项目的条目 id 在 B 项目页面操作，必须 404（否则等于跨项目删除）；
  4. 还原时原位置已被占用 → 加「-还原N」，绝不覆盖现有文件；
  5. 复制/移动的重名处理（-副本N）、禁止移进自身子目录、目标越界一律拒绝。

全部在临时目录里跑，不碰真实项目。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

from hub.files import _load_trash_manifest, _trash_root   # noqa: E402
from fakehub import FakeHub                              # noqa: E402


class FilesTrashTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.a = os.path.join(self.tmp, "projA")
        self.b = os.path.join(self.tmp, "projB")
        os.makedirs(os.path.join(self.a, "sub"))
        os.makedirs(self.b)
        self._write(os.path.join(self.a, "note.txt"), "hello")
        self._write(os.path.join(self.a, "sub", "deep.txt"), "deep")
        self._write(os.path.join(self.b, "other.txt"), "other")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 辅助 ----
    @staticmethod
    def _write(path, text):
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def hub(self, **kw):
        return FakeHub(root=self.tmp, config={}, **kw)

    def fs(self, **body):
        h = self.hub(body=body)
        h._handle_fs(urlparse("/api/fs"))
        return h

    def trash_list(self, project):
        h = self.hub()
        h._send_json  # 触发属性存在性检查（方法来自 mixin）
        manifest = _load_trash_manifest(self.tmp)
        return [x for x in manifest if (x.get("project") or "") == project]

    # ---- 删除进回收站 ----
    def test_delete_moves_to_trash_and_records_origin(self):
        h = self.fs(project="projA", action="delete", src="note.txt")
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertTrue(h.json["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.a, "note.txt")), "源文件应已移走")

        trash = _trash_root(self.tmp)
        self.assertTrue(os.path.isfile(os.path.join(trash, "note.txt")), "文件应落在回收站里")

        items = self.trash_list("projA")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["orig"], "note.txt", "必须记住还原路径")
        self.assertEqual(items[0]["project"], "projA")

    def test_delete_missing_src_404(self):
        h = self.fs(project="projA", action="delete", src="nope.txt")
        self.assertEqual(h.status, 404)

    def test_delete_escape_rejected(self):
        h = self.fs(project="projA", action="delete", src="../projB/other.txt")
        self.assertEqual(h.status, 404)
        self.assertTrue(os.path.exists(os.path.join(self.b, "other.txt")))

    def test_unknown_action_rejected(self):
        h = self.fs(project="projA", action="rm-rf", src="note.txt")
        self.assertEqual(h.status, 400)

    # ---- 还原 ----
    def test_restore_puts_file_back(self):
        self.fs(project="projA", action="delete", src="sub/deep.txt")
        tid = self.trash_list("projA")[0]["id"]

        h = self.hub(body={"project": "projA", "id": tid})
        h._handle_trash_restore(urlparse("/api/trash/restore"))
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertTrue(os.path.isfile(os.path.join(self.a, "sub", "deep.txt")))
        self.assertEqual(self.trash_list("projA"), [], "还原后清单条目应被移除")

    def test_restore_does_not_overwrite_existing(self):
        self.fs(project="projA", action="delete", src="note.txt")
        tid = self.trash_list("projA")[0]["id"]
        self._write(os.path.join(self.a, "note.txt"), "new content")

        h = self.hub(body={"project": "projA", "id": tid})
        h._handle_trash_restore(urlparse("/api/trash/restore"))
        self.assertEqual(h.status, 200, h.body_bytes)
        with open(os.path.join(self.a, "note.txt"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "new content", "原位置文件不能被覆盖")
        self.assertTrue(os.path.isfile(os.path.join(self.a, "note-还原1.txt")),
                        "重名时应加 -还原N 后缀")

    def test_restore_cross_project_forbidden(self):
        """拿 A 项目的条目 id 去 B 项目还原 → 必须 404（否则可跨项目取走别人的文件）。"""
        self.fs(project="projA", action="delete", src="note.txt")
        tid = self.trash_list("projA")[0]["id"]

        h = self.hub(body={"project": "projB", "id": tid})
        h._handle_trash_restore(urlparse("/api/trash/restore"))
        self.assertEqual(h.status, 404)
        self.assertFalse(os.path.exists(os.path.join(self.b, "note.txt")))

    def test_restore_unknown_id_404(self):
        h = self.hub(body={"project": "projA", "id": "t-does-not-exist"})
        h._handle_trash_restore(urlparse("/api/trash/restore"))
        self.assertEqual(h.status, 404)

    # ---- 永久删除 ----
    def test_remove_deletes_from_disk(self):
        self.fs(project="projA", action="delete", src="note.txt")
        tid = self.trash_list("projA")[0]["id"]
        h = self.hub(body={"project": "projA", "id": tid})
        h._handle_trash_remove(urlparse("/api/trash/remove"))
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertFalse(os.path.exists(os.path.join(_trash_root(self.tmp), "note.txt")))
        self.assertEqual(self.trash_list("projA"), [])

    def test_remove_cross_project_forbidden(self):
        self.fs(project="projA", action="delete", src="note.txt")
        tid = self.trash_list("projA")[0]["id"]
        h = self.hub(body={"project": "projB", "id": tid})
        h._handle_trash_remove(urlparse("/api/trash/remove"))
        self.assertEqual(h.status, 404)
        self.assertTrue(os.path.exists(os.path.join(_trash_root(self.tmp), "note.txt")),
                        "跨项目永久删除必须被拒绝")

    # ---- 清空 ----
    def test_empty_only_touches_current_project(self):
        """在 A 项目点「清空」不能把 B 项目的回收站一起删掉（历史 bug）。"""
        self.fs(project="projA", action="delete", src="note.txt")
        self.fs(project="projB", action="delete", src="other.txt")
        self.assertEqual(len(self.trash_list("projA")), 1)
        self.assertEqual(len(self.trash_list("projB")), 1)

        h = self.hub(body={"project": "projA"})
        h._handle_trash_empty(urlparse("/api/trash/empty"))
        self.assertEqual(h.status, 200, h.body_bytes)

        trash = _trash_root(self.tmp)
        self.assertFalse(os.path.exists(os.path.join(trash, "note.txt")), "A 的条目应被永久删除")
        self.assertTrue(os.path.exists(os.path.join(trash, "other.txt")), "B 的文件必须保留")
        self.assertEqual(self.trash_list("projA"), [])
        self.assertEqual(len(self.trash_list("projB")), 1, "B 的清单条目必须保留")

    def test_empty_ignores_unsafe_manifest_name(self):
        """清单里被人为塞入带路径分隔符的名字时，只清清单、绝不动回收站根目录。"""
        trash = _trash_root(self.tmp)
        os.makedirs(trash, exist_ok=True)
        self._write(os.path.join(trash, "keep.txt"), "keep")
        self._write(os.path.join(trash, "manifest.json"), "[]")
        manifest = [{"id": "t1", "name": "../", "orig": "x", "project": "projA",
                     "deletedAt": "2026-10-27 22:00"}]
        with open(os.path.join(trash, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False)

        h = self.hub(body={"project": "projA"})
        h._handle_trash_empty(urlparse("/api/trash/empty"))
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertTrue(os.path.isdir(trash), "回收站目录本身不能被删")
        self.assertTrue(os.path.exists(os.path.join(trash, "keep.txt")))

    # ---- 复制 / 移动 ----
    def test_copy_creates_duplicate_with_suffix(self):
        h = self.fs(project="projA", action="copy", src="note.txt", dst="note.txt")
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertTrue(os.path.exists(os.path.join(self.a, "note.txt")))
        self.assertTrue(os.path.exists(os.path.join(self.a, "note-副本1.txt")))

    def test_move_removes_source(self):
        h = self.fs(project="projA", action="move", src="note.txt", dst="sub/note.txt")
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertFalse(os.path.exists(os.path.join(self.a, "note.txt")))
        self.assertTrue(os.path.exists(os.path.join(self.a, "sub", "note.txt")))

    def test_move_into_itself_rejected(self):
        h = self.fs(project="projA", action="move", src="sub", dst="sub/inner")
        self.assertEqual(h.status, 400)

    def test_move_to_same_path_rejected(self):
        h = self.fs(project="projA", action="move", src="note.txt", dst="note.txt")
        self.assertEqual(h.status, 400)

    def test_copy_dst_escape_rejected(self):
        h = self.fs(project="projA", action="copy", src="note.txt", dst="../projB/stolen.txt")
        self.assertEqual(h.status, 403)
        self.assertFalse(os.path.exists(os.path.join(self.b, "stolen.txt")))

    def test_copy_creates_missing_parent_dir(self):
        h = self.fs(project="projA", action="copy", src="note.txt", dst="new/dir/note.txt")
        self.assertEqual(h.status, 200, h.body_bytes)
        self.assertTrue(os.path.exists(os.path.join(self.a, "new", "dir", "note.txt")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
