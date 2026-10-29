#!/usr/bin/env python3
"""P0 安全加固回归测试：命令执行闸门 + 审计日志 + 受限并发服务器

不碰真实账号库，全部跑在临时目录/临时环境变量上。
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from hub.handlers import project_post as pp  # noqa: E402
from hub import audit  # noqa: E402
from hub import server as srv  # noqa: E402


class ExecGateTest(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get("HUB_ENABLE_TERMINAL")
        self._saved_al = os.environ.get("HUB_EXEC_ALLOWLIST")

    def tearDown(self):
        for k, v in (("HUB_ENABLE_TERMINAL", self._saved),
                     ("HUB_EXEC_ALLOWLIST", self._saved_al)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_enabled_local_default(self):
        os.environ.pop("HUB_ENABLE_TERMINAL", None)
        self.assertTrue(pp.exec_enabled(cloud=False))

    def test_disabled_cloud_default(self):
        os.environ.pop("HUB_ENABLE_TERMINAL", None)
        self.assertFalse(pp.exec_enabled(cloud=True))

    def test_cloud_opt_in(self):
        os.environ["HUB_ENABLE_TERMINAL"] = "1"
        self.assertTrue(pp.exec_enabled(cloud=True))
        os.environ["HUB_ENABLE_TERMINAL"] = "true"
        self.assertTrue(pp.exec_enabled(cloud=True))

    def test_explicit_disable_local(self):
        os.environ["HUB_ENABLE_TERMINAL"] = "0"
        self.assertFalse(pp.exec_enabled(cloud=False))

    def test_allowlist_none_when_unset(self):
        os.environ.pop("HUB_EXEC_ALLOWLIST", None)
        self.assertIsNone(pp.exec_allowlist())

    def test_allowlist_parsing(self):
        os.environ["HUB_EXEC_ALLOWLIST"] = "git, ls ,cat"
        self.assertEqual(pp.exec_allowlist(), ["git", "ls", "cat"])


class AuditLogTest(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.mkdtemp()
        self._path = os.path.join(self._dir, "exec-audit.log")
        audit.set_log_path(self._path)

    def tearDown(self):
        audit.set_log_path(None)
        try:
            os.remove(self._path)
        except OSError:
            pass
        try:
            os.rmdir(self._dir)
        except OSError:
            pass

    def _count_lines(self):
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                return [json.loads(l) for l in f if l.strip()]
        except FileNotFoundError:
            return []

    def test_log_exec_writes_json_line(self):
        audit.log_exec(ip="1.2.3.4", user="a@b.com", role="admin",
                       cmd="ls -la", code=0, out_len=42, allowed=True)
        lines = self._count_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["cmd"], "ls -la")
        self.assertEqual(lines[0]["code"], 0)
        self.assertEqual(lines[0]["allowed"], True)
        self.assertEqual(lines[0]["ip"], "1.2.3.4")

    def test_log_exec_disabled_records_allowed_false(self):
        audit.log_exec(ip="9.9.9.9", user="x@y.com", role="admin",
                       cmd="rm -rf /", code=None, out_len=0,
                       allowed=False, note="terminal-disabled")
        lines = self._count_lines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["allowed"], False)
        self.assertEqual(lines[0]["note"], "terminal-disabled")

    def test_log_exec_is_thread_safe(self):
        def worker(i):
            audit.log_exec(ip=f"10.0.0.{i}", user="u", role="admin",
                           cmd=f"echo {i}", code=0, out_len=1, allowed=True)
        ts = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(self._count_lines()), 20)


class BoundedServerConfigTest(unittest.TestCase):
    def setUp(self):
        self._saved_w = os.environ.get("HUB_MAX_WORKERS")
        self._saved_t = os.environ.get("HUB_REQUEST_TIMEOUT")

    def tearDown(self):
        for k, v in (("HUB_MAX_WORKERS", self._saved_w),
                     ("HUB_REQUEST_TIMEOUT", self._saved_t)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _make(self):
        # 不需要真正 bind：传入一个假地址即可让构造完成（BoundedHTTPServer.__init__
        # 会先 super().__init__ → 但 ThreadingHTTPServer.__init__ 会 bind 到地址）
        # 为避免占用端口，这里只测环境变量解析逻辑，而不真正实例化服务。
        return None

    def test_max_workers_clamped(self):
        os.environ["HUB_MAX_WORKERS"] = "99999"
        self.assertEqual(srv._env_int("HUB_MAX_WORKERS", 64, 1, 1024), 1024)
        os.environ["HUB_MAX_WORKERS"] = "0"
        self.assertEqual(srv._env_int("HUB_MAX_WORKERS", 64, 1, 1024), 1)
        os.environ["HUB_MAX_WORKERS"] = "abc"
        self.assertEqual(srv._env_int("HUB_MAX_WORKERS", 64, 1, 1024), 64)

    def test_request_timeout_clamped(self):
        os.environ["HUB_REQUEST_TIMEOUT"] = "0.5"
        self.assertAlmostEqual(srv._env_float("HUB_REQUEST_TIMEOUT", 30.0, 1.0, 600.0), 1.0)
        os.environ["HUB_REQUEST_TIMEOUT"] = "5000"
        self.assertAlmostEqual(srv._env_float("HUB_REQUEST_TIMEOUT", 30.0, 1.0, 600.0), 600.0)
        os.environ["HUB_REQUEST_TIMEOUT"] = "not-a-number"
        self.assertAlmostEqual(srv._env_float("HUB_REQUEST_TIMEOUT", 30.0, 1.0, 600.0), 30.0)


if __name__ == "__main__":
    unittest.main()
