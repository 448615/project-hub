#!/usr/bin/env python3
"""子应用懒启动回归测试。

原来「装依赖 + spawn + 等端口」全在请求线程里跑，首次访问最坏要 300 秒才回包。
改成后台线程推进后，这里守三条底线：

  1. 缺 node / 缺入口文件这类**确定性失败**必须立刻返回，不能被当成「正在启动」；
  2. 装依赖这种**耗时工作**绝不能阻塞请求线程（用例里让装依赖睡 5 秒，
     断言请求 1 秒内就拿到 NOTE_STARTING）；
  3. 失败要冷却，不能在用户每次刷新时重跑一轮 npm install。

不启动真实 Node 进程：subprocess.Popen / 端口探测 / 依赖检查全部替换成替身。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import subapps   # noqa: E402


class _FakeProc:
    """假子进程：立刻「已退出」，让后台线程尽快收敛，测试不留尾巴。"""

    def __init__(self, *a, **kw):
        self.returncode = 1
        self.pid = 4242

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode


class SubappBootTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.app_dir = os.path.join(self.tmp, "app")
        os.makedirs(os.path.join(self.app_dir, "data"), exist_ok=True)
        with open(os.path.join(self.app_dir, "server.js"), "w", encoding="utf-8") as f:
            f.write("// noop\n")

        self._orig = {
            "node_available": subapps.node_available,
            "port_open": subapps.port_open,
            "ensure_node_deps": subapps.ensure_node_deps,
            "Popen": subapps.subprocess.Popen,
            "STATE": dict(subapps.STATE),
        }
        subapps.STATE.clear()
        subapps.PROCS.clear()

    def tearDown(self):
        subapps.node_available = self._orig["node_available"]
        subapps.port_open = self._orig["port_open"]
        subapps.ensure_node_deps = self._orig["ensure_node_deps"]
        subapps.subprocess.Popen = self._orig["Popen"]
        subapps.STATE.clear()
        subapps.STATE.update(self._orig["STATE"])
        subapps.PROCS.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def app(self, **over):
        d = {
            # 每个用例一个独立 prefix：后台线程按 prefix 去重，复用同一个 prefix
            # 会让上一个用例遗留的启动线程挡住本用例（测试之间互相串状态）。
            "prefix": f"/apps/t{id(self):x}/",
            "kind": "node",
            "name": "测试应用",
            "dir": "app",
            "entry": "server.js",
            "port": 39871,
            "log": os.path.join("app", "data", "hub-app.log"),
        }
        d.update(over)
        return d

    # ---- 确定性失败：必须立刻返回，且不能是 "starting" ----
    def test_no_node_fails_fast(self):
        subapps.node_available = lambda: False
        t0 = time.time()
        ok, note = subapps.ensure_running(self.app(), self.tmp, wait=3)
        cost = time.time() - t0
        self.assertFalse(ok)
        self.assertNotEqual(note, subapps.NOTE_STARTING)
        self.assertIn("node", note)
        self.assertLess(cost, 1.0, "缺 node 属于确定性失败，不该等待")

    def test_missing_entry_fails_fast(self):
        subapps.node_available = lambda: True
        subapps.port_open = lambda *a, **k: False
        ok, note = subapps.ensure_running(self.app(entry="nope.js"), self.tmp, wait=3)
        self.assertFalse(ok)
        self.assertIn("缺少入口文件", note)

    # ---- 耗时工作不得阻塞请求 ----
    def test_dependency_install_does_not_block_request(self):
        def slow_deps(app_dir, timeout=300):
            # 故意耗时后返回失败：既证明请求不被阻塞，又不让线程在做完测试后
            # 继续去 spawn 一个真 Node 进程（tearDown 会还原子进程替换）
            time.sleep(5)
            return False, "测试用：装依赖失败"

        subapps.node_available = lambda: True
        subapps.port_open = lambda *a, **k: False
        subapps.ensure_node_deps = slow_deps
        subapps.subprocess.Popen = _FakeProc

        app = self.app()
        t0 = time.time()
        ok, note = subapps.ensure_running(app, self.tmp, wait=0.3)
        cost = time.time() - t0

        self.assertFalse(ok)
        self.assertEqual(note, subapps.NOTE_STARTING, "装依赖期间应告知「正在启动」")
        self.assertLess(cost, 1.5, f"请求线程被拖住了：{cost:.2f}s")
        self.assertIn(subapps.app_status(app)["phase"], ("installing", "booting", "failed"))

    # ---- 后台推进到 ready ----
    def test_becomes_ready(self):
        calls = {"n": 0}

        def port_open(port, host="127.0.0.1", timeout=0.3):
            calls["n"] += 1
            return calls["n"] >= 3      # 前两次「未监听」，之后「已监听」

        subapps.node_available = lambda: True
        subapps.port_open = port_open
        subapps.ensure_node_deps = lambda d, timeout=300: (True, "ready")
        subapps.subprocess.Popen = _FakeProc

        app = self.app()
        ok, note = subapps.ensure_running(app, self.tmp, wait=3)
        self.assertTrue(ok, note)
        self.assertEqual(note, "started")
        self.assertEqual(subapps.app_status(app)["phase"], "ready")
        self.assertTrue(subapps.app_status(app)["listening"])

    # ---- 启动子应用时必须声明「前面有一层可信反代」 ----
    def test_spawn_env_declares_trust_proxy(self):
        """子应用藏在枢纽反代后面，必须收到 TRUST_PROXY=1。

        不声明的话，子应用看到的客户端地址恒为 127.0.0.1，它自己的「按 IP 限流」
        会退化成全站共用一个桶：正常用户被误伤，真正的攻击者反而拦不住。
        这里用替身接住 Popen 的 kwargs，直接断言环境变量确实传下去了。
        """
        captured = {}

        class _CaptureProc(_FakeProc):
            def __init__(self, *a, **kw):
                captured.update(kw)
                super().__init__(*a, **kw)

        calls = {"n": 0}

        def port_open(port, host="127.0.0.1", timeout=0.3):
            calls["n"] += 1
            return calls["n"] >= 3   # 前两次「未监听」，之后「已监听」

        subapps.node_available = lambda: True
        subapps.port_open = port_open
        subapps.ensure_node_deps = lambda d, timeout=300: (True, "ready")
        subapps.subprocess.Popen = _CaptureProc

        # 清掉外部环境可能带的同名变量，确保断言的是「默认注入值」
        saved = {k: os.environ.pop(k, None) for k in ("TRUST_PROXY", "NODE_ENV")}
        try:
            ok, note = subapps.ensure_running(self.app(), self.tmp, wait=3)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

        self.assertTrue(ok, note)
        # spawn 发生在后台线程里，ensure_running 返回 "started" 时线程可能刚跑到一半，
        # 所以这里等一会儿直到 Popen 真的被调用（最多 2 秒），避免用例本身变成偶发
        for _ in range(200):
            if captured:
                break
            time.sleep(0.01)
        self.assertTrue(captured, "后台线程始终没调用 Popen，子应用根本没被拉起")
        env = captured.get("env") or {}
        self.assertEqual(env.get("TRUST_PROXY"), "1",
                         "必须注入 TRUST_PROXY=1，否则子应用的 IP 维度限流失效")
        self.assertEqual(env.get("HOST"), "127.0.0.1", "子应用端口不该对外暴露")
        self.assertEqual(env.get("NODE_ENV"), "production", "生产形态决定 health 不吐内部细节")
        self.assertIn("HUB_ADMIN_EMAILS", env,
                      "必须把枢纽的管理员名单传下去，否则星枢无法发现「枢纽普通用户却是星枢超管」的错配")

    # ---- 管理员名单：只传信息，且要规范化 ----
    def test_hub_admin_emails_normalized(self):
        """config.json 的 admins 传下去之前必须小写、去重、去空白、排序。

        这串值只用于星枢的告警比对，不参与任何准入判断——所以这里也只断言
        「传得干净」，不涉及权限。
        """
        with open(os.path.join(self.tmp, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"admins": ["Boss@X.com", "  boss@x.com ", "second@x.com", "", "   "]}, f)
        self.assertEqual(subapps.hub_admin_emails(self.tmp), ["boss@x.com", "second@x.com"])

    def test_hub_admin_emails_survives_bad_config(self):
        """配置缺失/损坏时返回空列表，不能把启动流程带崩。"""
        self.assertEqual(subapps.hub_admin_emails(self.tmp), [], "没有 config.json 时应返回空")
        with open(os.path.join(self.tmp, "config.json"), "w", encoding="utf-8") as f:
            f.write("{ 这不是 JSON ")
        self.assertEqual(subapps.hub_admin_emails(self.tmp), [], "config.json 损坏时应返回空")
        with open(os.path.join(self.tmp, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"admins": "not-a-list"}, f)
        self.assertEqual(subapps.hub_admin_emails(self.tmp), [], "admins 写成字符串时应返回空，而不是逐字符拆开")

    # ---- 失败冷却 ----
    def test_failure_cools_down(self):
        subapps.node_available = lambda: True
        subapps.port_open = lambda *a, **k: False
        calls = {"n": 0}

        def deps(app_dir, timeout=300):
            calls["n"] += 1
            return False, "npm 挂了"

        subapps.ensure_node_deps = deps
        subapps.subprocess.Popen = _FakeProc

        app = self.app()
        subapps._set_state(app, "failed", "npm 挂了")
        ok, note = subapps.ensure_running(app, self.tmp, wait=1)
        self.assertFalse(ok)
        self.assertEqual(note, "npm 挂了")
        self.assertEqual(calls["n"], 0, "冷却期内不应重跑依赖安装")

    def test_retry_after_cooldown(self):
        subapps.node_available = lambda: True
        subapps.port_open = lambda *a, **k: False
        subapps.ensure_node_deps = lambda d, timeout=300: (False, "npm 挂了")
        subapps.subprocess.Popen = _FakeProc

        app = self.app()
        subapps._set_state(app, "failed", "上次失败")
        subapps.STATE[app["prefix"]]["since"] = time.time() - subapps.BOOT_RETRY_COOLDOWN - 1

        ok, note = subapps.ensure_running(app, self.tmp, wait=0)
        self.assertFalse(ok)
        # 冷却已过 → 允许「正在启动」，让用户重试而不是永久卡在失败态
        self.assertEqual(note, subapps.NOTE_STARTING)

    # ---- 运行态与页面 ----
    def test_app_status_shape(self):
        app = self.app()
        st = subapps.app_status(app)
        for k in ("phase", "note", "port", "listening", "since"):
            self.assertIn(k, st)
        self.assertEqual(st["phase"], "idle")

    def test_static_app_has_no_port_probe(self):
        st = subapps.app_status({"prefix": "/apps/wb/", "kind": "static", "name": "工作台", "dir": "wb"})
        self.assertFalse(st["listening"])
        self.assertEqual(st["port"], 0)
        self.assertEqual(st["phase"], "static", "静态应用应报 static 而不是 idle")

    def test_app_page_refresh_meta(self):
        auto = subapps.app_page("正在启动", "稍候", refresh=2)
        self.assertIn(b'http-equiv="refresh" content="2"', auto)
        self.assertNotIn(b'meta http-equiv', subapps.app_page("失败", "原因"))

    def test_app_page_escapes_html(self):
        body = subapps.app_page("<script>x</script>", "<img onerror=1>").decode("utf-8")
        self.assertNotIn("<script>x</script>", body)
        self.assertIn("&lt;script&gt;", body)


class SubappPageTests(unittest.TestCase):
    """handlers/subapp.py 的 503 分支：正在启动 vs 真失败 vs API 请求。

    这三条分支直接决定用户看到什么，而它们只有在「子应用没就绪」时才走到，
    平时手工点不出来，所以用替身把状态强制注入。
    """

    def setUp(self):
        from urllib.parse import urlparse
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fakehub import FakeHub
        from hub.handlers.subapp import SubappMixin

        class H(SubappMixin, FakeHub):
            pass

        self.urlparse = urlparse
        self.H = H
        # _handle_subapp 要求已登录（未登录是 302 回桌面），先签一个有效会话
        from hub import security
        self.cookie = "hub_sess=" + security._mint_session("tester@example.com", "1")
        self._orig = {k: getattr(subapps, k) for k in ("ensure_running", "app_status")}

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(subapps, k, v)

    def _call(self, path, note):
        app = subapps.APPS[0]        # 星枢（node 型）
        subapps.ensure_running = lambda a, r, wait=None: (False, note)
        subapps.app_status = lambda a: {"phase": "booting", "note": "正在安装运行依赖…"}
        h = self.H(root=".", cookie=self.cookie)
        parsed = self.urlparse(path)
        h._handle_subapp(parsed, method="GET")
        return h

    def test_starting_page_auto_refreshes(self):
        h = self._call("/apps/starshu/", subapps.NOTE_STARTING)
        self.assertEqual(h.status, 503)
        self.assertEqual(h.header("Retry-After"), "2")
        self.assertIn(b'http-equiv="refresh"', h.body_bytes)
        self.assertIn("正在启动".encode("utf-8"), h.body_bytes)
        self.assertNotIn("没能启动".encode("utf-8"), h.body_bytes)

    def test_real_failure_page_has_no_refresh(self):
        h = self._call("/apps/starshu/", "缺少入口文件：starshu/server.js")
        self.assertEqual(h.status, 503)
        self.assertNotIn(b'http-equiv="refresh"', h.body_bytes,
                         "确定性失败不该自动重试，否则会无限刷新")
        self.assertIn("没能启动".encode("utf-8"), h.body_bytes)

    def test_api_request_gets_json_not_html(self):
        """子应用自己的 AJAX 拿到 HTML 会让前端 JSON.parse 失败，必须回 JSON。"""
        h = self._call("/apps/starshu/api/login", subapps.NOTE_STARTING)
        self.assertEqual(h.status, 503)
        self.assertFalse(h.json["ok"])
        self.assertTrue(h.json["starting"])
        self.assertIn("application/json", h.header("Content-Type"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
