#!/usr/bin/env python3
"""访客模式（未登录只读）回归测试。

访客模式是本项目里**唯一一条免登录的数据接口**，所以这里的断言重点不是
「功能能跑」，而是「只开了这一条、且只吐该吐的字段」：

  1. public_cards 白名单：run/docs/port/preview_url/started 一律不出现；
  2. 未知字段（含未来新增的敏感字段）默认丢弃 —— 白名单的失败方向是「少显示」，
     而不是「多泄露」；
  3. 脏输入（None / 非 dict 项 / tags 不是数组）不会炸；
  4. HTTP 层：未登录 GET /api/public/projects → 200 且响应体里不含内部字段；
  5. 回归：未登录 GET /api/projects 仍是 401 —— 证明没有把鉴权闸门整体挪开，
     只是单独开了一条通道。
"""
import json
import os
import sys
import tempfile
import unittest
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for path in (ROOT, os.path.dirname(os.path.abspath(__file__))):
    if path not in sys.path:
        sys.path.insert(0, path)

from hub.handlers.routes_get import GetMixin   # noqa: E402
from hub.projects import PUBLIC_FIELDS, public_cards   # noqa: E402
from fakehub import FakeHub                    # noqa: E402


class _GuestHub(FakeHub, GetMixin):
    """带 GET 路由的测试替身；只用于打 /api/* 的闸门与公开接口。"""


def _full_project(**extra):
    """构造一个「字段齐全」的项目（含全部内部字段），用来验证裁剪。"""
    p = {
        "name": "demo",
        "display_name": "演示项目",
        "description": "一句话描述",
        "icon": "📦",
        "tags": ["demo", "test"],
        # —— 以下均为不该给访客的内部字段 ——
        "port": 8081,
        "running": True,
        "started": True,
        "run": "python demo/main.py",
        "links": [{"label": "文档", "url": "http://127.0.0.1:8081/docs"}],
        "docs": "demo/README.md",
        "app": "/apps/demo/",
        "preview_url": "http://127.0.0.1:8081",
        "panel": "accounts",
    }
    p.update(extra)
    return p


class PublicCardsTest(unittest.TestCase):
    """纯函数：字段白名单与脏输入。"""

    def test_只保留白名单字段(self):
        card = public_cards([_full_project()])[0]
        self.assertEqual(set(card), set(PUBLIC_FIELDS))

    def test_内部字段一个都不出现(self):
        card = public_cards([_full_project()])[0]
        for key in ("run", "docs", "port", "preview_url", "started",
                    "running", "links", "app", "panel"):
            self.assertNotIn(key, card, "内部字段 %s 泄露给访客" % key)

    def test_未来新增的敏感字段默认不可见(self):
        # 模拟「以后 scan_projects 多返回了一个字段」：白名单应默认挡住
        card = public_cards([_full_project(secret_key="abc123", db_path="/etc/x")])[0]
        self.assertNotIn("secret_key", card)
        self.assertNotIn("db_path", card)

    def test_保留字段的值原样透出(self):
        p = _full_project()
        card = public_cards([p])[0]
        for key in PUBLIC_FIELDS:
            if key == "tags":
                continue
            self.assertEqual(card[key], p[key])

    def test_tags_重新包一层(self):
        p = _full_project()
        card = public_cards([p])[0]
        self.assertEqual(card["tags"], ["demo", "test"])
        card["tags"].append("改我")          # 不应波及原对象
        self.assertEqual(p["tags"], ["demo", "test"])

    def test_tags_非法类型归一为空数组(self):
        card = public_cards([_full_project(tags="不是数组")])[0]
        self.assertEqual(card["tags"], [])

    def test_缺字段不报错(self):
        card = public_cards([{"name": "only-name"}])[0]
        self.assertEqual(card["name"], "only-name")
        self.assertNotIn("description", card)
        self.assertEqual(card["tags"], [])

    def test_脏输入返回空列表(self):
        self.assertEqual(public_cards([]), [])
        self.assertEqual(public_cards(None), [])
        # 非 dict 项被跳过；空 dict 仍会补一个 tags:[]（见 public_cards 的归一逻辑）
        self.assertEqual(public_cards(["字符串", 42, None, {}]), [{"tags": []}])


class PublicRouteTest(unittest.TestCase):
    """HTTP 层：免登录通道与既有闸门的边界。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-public-")
        os.makedirs(os.path.join(self.tmp, "demo"), exist_ok=True)
        self.config = {
            "global": {"title": "测试枢纽", "subtitle": "副标题"},
            "projects": {
                "demo": {
                    "display_name": "演示项目",
                    "description": "一句话描述",
                    "icon": "📦",
                    "tags": ["demo"],
                    "run": "python demo/main.py",     # 内部：启动命令
                    "docs": "demo/README.md",         # 内部：文档路径
                }
            },
        }
        with open(os.path.join(self.tmp, "config.json"), "w", encoding="utf-8") as f:
            json.dump(self.config, f, ensure_ascii=False)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)
        from hub.projects import _PROJECTS_CACHE
        _PROJECTS_CACHE.clear()      # 别让临时目录的扫描结果串到别的用例

    def _get(self, path):
        h = _GuestHub(root=self.tmp, config=self.config)
        h.path = path
        h._do_get_inner()
        return h

    def test_未登录可以取公开项目列表(self):
        h = self._get("/api/public/projects")
        self.assertEqual(h.status, 200)
        self.assertTrue(h.json["ok"])
        self.assertEqual(h.json["title"], "测试枢纽")
        self.assertEqual(len(h.json["projects"]), 1)

    def test_公开接口响应体不含内部字段(self):
        h = self._get("/api/public/projects")
        raw = h.body_bytes.decode("utf-8")
        # 直接查响应原文：字段一旦被序列化进去就一定出现在字节里，
        # 这比只断言 dict 的键更难被「忘记删某个键」绕过。
        self.assertNotIn("python demo/main.py", raw)
        self.assertNotIn("demo/README.md", raw)
        self.assertNotIn('"run"', raw)
        self.assertNotIn('"docs"', raw)

    def test_公开接口仍带项目卡片基本字段(self):
        card = self._get("/api/public/projects").json["projects"][0]
        self.assertEqual(card["name"], "demo")
        self.assertEqual(card["display_name"], "演示项目")
        self.assertEqual(card["icon"], "📦")

    def test_携带伪造会话cookie也不能提权(self):
        # 公开接口不读会话；带一个乱码 Cookie 也应照常 200（而不是 500）
        h = _GuestHub(root=self.tmp, config=self.config,
                      cookie="hub_sess=forged.token.value")
        h.path = "/api/public/projects"
        h._do_get_inner()
        self.assertEqual(h.status, 200)

    def test_原项目接口仍然要求登录(self):
        # 关键回归：不能因为开了公开通道，把 /api/projects 的闸门一起放开
        h = self._get("/api/projects")
        self.assertEqual(h.status, 401)
        self.assertIn("未登录", h.json["error"])


class RouteWiringTest(unittest.TestCase):
    """静态检查：公开分支必须排在鉴权闸门之前。

    这是最容易在后续重构中被「整理」坏的一处——如果哪天有人把闸门提到前面，
    访客模式会静默 401，功能退化但测试若不盯顺序就会漏掉。
    """

    def test_公开分支在闸门之前(self):
        with open(os.path.join(ROOT, "hub", "handlers", "routes_get.py"),
                  encoding="utf-8") as f:
            src = f.read()
        i_pub = src.index('"/api/public/projects"')
        i_gate = src.index('if path.startswith("/api/"):')
        self.assertLess(i_pub, i_gate, "公开接口分支被放到了鉴权闸门之后")


if __name__ == "__main__":
    unittest.main(verbosity=2)
