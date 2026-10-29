"""退出登录的回归测试（行为级）。

为什么不用「断言源码顺序」那种写法：这条 Bug 的本质是**运行时两个功能互相抵消**
（退出清 Cookie / 自动登录换 Cookie），只看源码很难判断谁赢。所以这里把
`performLogout` 与 `authBoot` 的真实源码抽出来，在 node 里配一套假 DOM/存储/fetch 跑四种场景。

四个场景各有各的用处，缺一个都会漏：
  A 退出必须清本地凭证（否则自动登录会把会话换回来）
  B 退出后的下一次启动不许自动登录（这条就是用户报的「点了没反应」）
  C 正常启动仍然要自动登录（防止修 B 修过头，把「下次打开直接进」也一起废了）
  D 会话还有效时不该白打一次登录接口（会白吃限流计数）
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "static", "js")
SESSION_JS = os.path.join(JS, "050-account-session.js")
BOOT_JS = os.path.join(JS, "054-app-boot.js")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def extract_fn(src: str, name: str) -> str:
    """按大括号配平抽出一个 function 的源码（含前面的 async 关键字）。"""
    idx = src.find("async function " + name + "(")
    if idx < 0:
        idx = src.index("function " + name + "(")
    start = src.index("{", idx)      # 这几个函数都没有默认参数，第一个 { 就是函数体
    depth = 0
    for j in range(start, len(src)):
        ch = src[j]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[idx:j + 1]
    raise AssertionError("没能配平 function %s" % name)


def extract_const(src: str, name: str) -> str:
    for line in src.splitlines():
        line = line.strip()
        if line.startswith("const %s" % name):
            return line.split("=", 1)[1].strip().rstrip(";")
    raise AssertionError("找不到常量 %s" % name)


HARNESS_HEAD = r"""
// ---- 最小运行环境：只提供被测函数真正用到的东西 ----
let ENTERED = 0, SHOWED = 0, RELOADED = 0;
const CALLS = [];

const _mk = () => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    _dump: () => Object.fromEntries(m),
    _seed: (k, v) => { m.set(k, String(v)); },
  };
};
globalThis.localStorage = _mk();
globalThis.sessionStorage = _mk();
globalThis.location = { reload() { RELOADED += 1; } };
globalThis.hubApiUrl = p => p;
globalThis.enterApp = async () => { ENTERED += 1; };
globalThis.showLogin = async () => { SHOWED += 1; };

let ME_RES = { status: 401, body: {} };
let LOGIN_RES = { status: 200, body: { ok: true } };

function _res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body || {} };
}

globalThis.fetch = async (url, opt) => {
  CALLS.push({ url, method: (opt && opt.method) || 'GET' });
  if (url.indexOf('/api/auth/me') === 0) return _res(ME_RES.status, ME_RES.body);
  if (url.indexOf('/api/auth/login') === 0) return _res(LOGIN_RES.status, LOGIN_RES.body);
  if (url.indexOf('/api/auth/logout') === 0) return _res(200, { ok: true });
  return _res(404, {});
};
"""

HARNESS_CALL = r"""
async function run(scenario) {
  const out = {
    entered: ENTERED, showed: SHOWED, reloaded: RELOADED,
    calls: CALLS.map(c => c.url + ' ' + c.method),
    local: localStorage._dump(),
    session: sessionStorage._dump(),
  };
  return out;
}

const _sc = process.argv[2];
const _seedAcct = { email: 'a@example.com', password: 'p@ssw0rd', remember: true };
localStorage._seed('ph.savedAccount', JSON.stringify(_seedAcct));

if (_sc === 'A') {
  await performLogout();
} else if (_sc === 'B') {
  sessionStorage._seed(LOGGED_OUT_KEY, '1');
  ME_RES = { status: 401, body: {} };
  await authBoot();
} else if (_sc === 'C') {
  ME_RES = { status: 401, body: {} };
  await authBoot();
} else if (_sc === 'D') {
  ME_RES = { status: 200, body: { ok: true, email: 'a@example.com', role: 'user' } };
  await authBoot();
}
console.log(JSON.stringify(await run(_sc)));
"""


def build_harness() -> str:
    sess, boot = _read(SESSION_JS), _read(BOOT_JS)
    parts = [HARNESS_HEAD]
    # 这三个常量是凭证读写的全部依赖，漏一个就会让 clearSavedPassword / loadSavedAccount
    # 在各自的 try 里静默失效——测试会变成「怎么改都绿」的假象。
    for key in ("SAVED_ACCT_KEY", "REMEMBER_KEY", "LOGGED_OUT_KEY"):
        parts.append("const %s = %s;" % (key, extract_const(sess, key)))
    for name in ("loadSavedAccount", "clearSavedPassword", "performLogout"):
        parts.append(extract_fn(sess, name))
    for name in ("silentRelogin", "authBoot"):
        parts.append(extract_fn(boot, name))
    parts.append(HARNESS_CALL)
    return "\n\n".join(parts)


class 退出登录测试(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which("node")
        if not cls.node:
            raise unittest.SkipTest("环境无 node，跳过 JS 行为测试")
        cls.dir = tempfile.mkdtemp(prefix="hub-logout-")
        cls.files = {}
        src = build_harness()
        for sc in "ABCD":
            p = os.path.join(cls.dir, "h_%s.mjs" % sc)
            with open(p, "w", encoding="utf-8") as f:
                f.write(src)
            cls.files[sc] = p

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def run_scenario(self, sc):
        r = subprocess.run([self.node, self.files[sc], sc], capture_output=True, text=True,
                           encoding="utf-8", timeout=60)
        self.assertEqual(r.returncode, 0, "node 失败:\n%s\n%s" % (r.stdout, r.stderr))
        return json.loads(r.stdout.strip().splitlines()[-1])

    # ---- A：退出必须清掉本地密码 ----
    def test_A_退出清掉本地密码(self):
        out = self.run_scenario("A")
        acct = json.loads(out["local"]["ph.savedAccount"])
        self.assertEqual(acct["password"], "", "退出后本机密码必须清空，否则自动登录会把人登回来")
        self.assertFalse(acct["remember"])
        self.assertEqual(acct["email"], "a@example.com", "邮箱应保留以便下次填充")
        self.assertIn("/api/auth/logout POST", out["calls"], "必须真的通知服务端作废会话")
        self.assertEqual(out["reloaded"], 1, "退出后要重载回登录页")

    def test_A_退出留下一次性跳过标记(self):
        out = self.run_scenario("A")
        self.assertEqual(out["session"].get("ph.loggedOut"), "1",
                         "localStorage 不可写时，这个标记是唯一的兜底")

    # ---- B：这条就是用户报的 Bug ----
    def test_B_退出后的启动不许自动登录(self):
        out = self.run_scenario("B")
        self.assertNotIn("/api/auth/login POST", out["calls"],
                         "主动退出后仍去登录接口换会话 → 用户看到的就是「退出没反应」")
        self.assertEqual(out["showed"], 1, "应停在登录页")
        self.assertEqual(out["entered"], 0, "不该进桌面")

    def test_B_跳过标记用过即弃(self):
        out = self.run_scenario("B")
        self.assertNotIn("ph.loggedOut", out["session"],
                         "标记必须一次性，否则之后每次启动都再也登不进来")

    # ---- C：对照组，防止修过头 ----
    def test_C_正常启动仍然自动登录(self):
        out = self.run_scenario("C")
        self.assertIn("/api/auth/login POST", out["calls"], "凭证还在时应静默换会话")
        self.assertEqual(out["entered"], 1, "「下次打开直接进桌面」不能被修坏")
        self.assertEqual(out["showed"], 0)

    # ---- D：会话有效时不该白打登录 ----
    def test_D_会话有效时不重复登录(self):
        out = self.run_scenario("D")
        self.assertNotIn("/api/auth/login POST", out["calls"], "会话有效还去登录会白吃限流计数")
        self.assertEqual(out["entered"], 1)


class 退出实现唯一性(unittest.TestCase):
    """所有退出出口必须走同一个函数：将来再加第三个入口时，这条会挡一下。"""

    def test_只有一处调退出接口(self):
        hits = []
        for base, _dirs, names in os.walk(os.path.join(ROOT, "static")):
            for n in names:
                if not n.endswith((".js", ".html")):
                    continue
                p = os.path.join(base, n)
                with open(p, encoding="utf-8", errors="ignore") as f:
                    if "/api/auth/logout" in f.read():
                        hits.append(os.path.relpath(p, ROOT).replace("\\", "/"))
        self.assertEqual(hits, ["static/js/050-account-session.js"],
                         "退出接口只应出现在 performLogout 里，其它地方请调用它：%s" % hits)

    def test_两个界面都调用统一实现(self):
        for rel in ("static/js/052-role-data.js", "static/js/125-settings-account.js"):
            src = _read(os.path.join(ROOT, rel))
            self.assertIn("performLogout()", src, "%s 的退出按钮没有走统一实现" % rel)
            self.assertNotIn("location.reload()", src,
                             "%s 里不该自己重载：清凭证与重载必须发生在 performLogout 内部" % rel)


if __name__ == "__main__":
    unittest.main(verbosity=2)
