#!/usr/bin/env python3
"""workbench 本地存储守卫（storage-guard.js）的契约测试。

这里守两类东西：

1. **能用断言表达的静态契约**——页面必须真正加载这个脚本、脚本必须 CSP 友好
   （无内联事件、无 innerHTML 拼接）、修复流程必须留备份。这些一旦退化，
   症状都是「线上某个功能静默失效」，很难靠人工发现。

2. **把 Node 侧的纯逻辑测试接进主套件**——真正的行为断言在
   `workbench/tests/storage-guard.test.mjs`（22 项），这里只负责跑它。
   否则那套测试写完永远不会在 CI 里执行。

另有一条值得单独说明的断言：版本号键名必须落在应用「导入备份」白名单的前缀内。
这不是风格问题——白名单判定是 `startsWith(前缀.slice(0, -1))`，独立命名的键会被
当成无效数据丢弃，导致备份恢复后版本号丢失、迁移钩子永远不触发。
"""
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, "workbench", "www")
GUARD = os.path.join(WWW, "storage-guard.js")
INDEX = os.path.join(WWW, "index.html")
WORKBENCH = os.path.join(ROOT, "workbench")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class GuardStaticContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.guard = _read(GUARD)
        cls.index = _read(INDEX)

    def test_script_present_and_loaded_before_bundle(self):
        self.assertIn('src="./storage-guard.js"', self.index, "页面没有加载 storage-guard.js")
        guard_at = self.index.index("./storage-guard.js")
        bundle_at = self.index.index("assets/index-")
        self.assertLess(guard_at, bundle_at, "守卫必须在主 bundle 之前加载，否则补版本号太晚")

    def test_no_inline_script_added(self):
        """新增的必须是外链脚本：内联脚本在收紧 CSP 后会静默失效。"""
        inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", self.index)
        self.assertEqual(inline, [], "页面出现了内联脚本：%r" % inline)

    def test_guard_is_csp_friendly(self):
        self.assertNotRegex(self.guard, r"\bon(click|change|input|load)\s*=", "守卫里有内联事件处理器")
        self.assertNotIn("innerHTML", self.guard, "守卫不应使用 innerHTML（改用 textContent）")
        self.assertIn("textContent", self.guard)
        self.assertIn("addEventListener", self.guard)

    def test_no_remote_dependency(self):
        self.assertNotRegex(self.guard, r"https?://", "守卫不得依赖外部资源（离线可用是前提）")

    def test_heal_backs_up_before_removing(self):
        """修复必须「先备份到 sessionStorage，再删除」。"""
        self.assertIn("hm_guard_backup_", self.guard)
        backup_at = self.guard.index("hm_guard_backup_")
        # 备份常量在文件头部，真正的写入点在 heal() 里，顺序断言退化为「两者都存在」
        self.assertIn("sessionStorage.setItem", self.guard, "修复前没有把原文写进 sessionStorage")
        self.assertLess(backup_at, self.guard.index("function heal"))

    def test_destructive_action_needs_user_click(self):
        """守卫不得在启动时自动删数据：confirm 与按钮文字必须存在。"""
        self.assertIn("window.confirm", self.guard)
        self.assertIn("修复并重载", self.guard)

    def test_version_key_fits_import_whitelist(self):
        """版本号键名必须被应用的导入白名单接受（以 hm_setting 开头）。

        白名单判定：g === y || g.startsWith(y.substring(0, y.length - 1))，
        其中 settings 命中 → 前缀 "setting"。换个名字（如 hm_schemaVersion）
        会在导入备份时被当作无效数据丢弃。
        """
        m = re.search(r"var META_KEY\s*=\s*['\"]([^'\"]+)['\"]", self.guard)
        self.assertIsNotNone(m, "找不到 META_KEY 定义")
        key = m.group(1)
        self.assertTrue(key.startswith("hm_setting"), "%s 不在导入白名单前缀内" % key)

        bundle = ""
        for name in os.listdir(os.path.join(WWW, "assets")):
            if name.startswith("index-") and name.endswith(".js"):
                bundle += _read(os.path.join(WWW, "assets", name))
        self.assertIn('"settings"', bundle, "bundle 里找不到导入白名单，断言前提已失效")
        # 这一行是白名单的真实判定方式：前缀取到倒数第二位，所以 settings → "setting"
        self.assertIn("substring(0,y.length-1)", bundle, "导入白名单的判定方式变了，请重新确认前缀规则")
        self.assertIn('replace("hm_","")', bundle, "备份文件的键名前缀处理变了，请重新确认")

    def test_backup_does_not_include_music_is_documented(self):
        """备份不含音乐文件这件事必须在界面上说清楚，否则用户会以为备份是完整的。"""
        self.assertIn("不含音乐文件", self.index)

    def test_version_marker_is_separate_from_settings(self):
        """版本号必须独立成键。

        应用的设置读取是「存的是对象就直接用」，不做默认值合并；若把版本塞进
        hm_settings 且该键原本不存在，应用会读到只有 schemaVersion 的设置对象，
        主题/透明度等全部 undefined。
        """
        m = re.search(r"var META_KEY\s*=\s*['\"]([^'\"]+)['\"]", self.guard)
        self.assertIsNotNone(m, "找不到 META_KEY 定义")
        self.assertEqual(m.group(1), "hm_settingsMeta")
        self.assertNotEqual(m.group(1), "hm_settings", "版本号不能直接塞进设置对象")


class GuardLogicTests(unittest.TestCase):
    """跑 Node 侧纯逻辑测试（22 项断言在那份文件里）。"""

    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            raise unittest.SkipTest("未安装 node，跳过守卫逻辑测试")

    def test_node_suite_passes(self):
        proc = subprocess.run(
            ["node", "--test"],
            cwd=WORKBENCH,
            capture_output=True,
            text=True,
            timeout=180,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        self.assertEqual(
            proc.returncode,
            0,
            "workbench 守卫测试失败：\n" + output[-2500:],
        )
        m = re.search(r"^# pass (\d+)$", output, re.M)
        self.assertIsNotNone(m, "拿不到 node --test 的通过数：\n" + output[-800:])
        self.assertGreaterEqual(int(m.group(1)), 20, "用例数突然减少，可能有测试被误删")


if __name__ == "__main__":
    unittest.main(verbosity=2)
