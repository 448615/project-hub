#!/usr/bin/env python3
"""静态资产完整性测试：页面引用的本地资源必须存在，SRI 与实际字节必须一致。

为什么值得单独守一个测试：`<script src>` 写错路径或文件被删掉，页面**不会报错退出**，
只会少一个功能（控制台一条 404），排查成本极高。SRI 则是另一层：integrity 哈希写死在
HTML 里，一旦与实际字节不一致，浏览器会直接拒绝执行那个脚本 —— 同样是「某个功能莫名
失效」。这里把「忘了」变成一条会失败的测试，并在失败信息里直接给出正确的哈希值。

历史背景：v56 之前页面还加载 cloud-config.js 与 static/vendor/workbuddy-cloud-sdk.js
（云端数据面板用），那套东西下线后页面已不含任何第三方脚本，所以 SRI 相关断言现在
通常是空跑（没有 integrity 可校验）。断言没有删，一旦以后再引入第三方脚本，供应链
兜底立刻生效。
"""
import base64
import hashlib
import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

INDEX = os.path.join(ROOT, "static", "index.html")
VENDOR_DIR = os.path.join(ROOT, "static", "vendor")

#: 服务端按 bundle.order 现场拼接的虚拟路径，磁盘上不存在，不能做存在性检查
VIRTUAL_PATHS = {"/static/js/bundle.js"}

#: <script src="..." integrity="sha384-..."> 或顺序反过来的写法
_TAG_RE = re.compile(r"<(script|link)\b([^>]*)>", re.I)
_ATTR_RE = re.compile(r'([\w-]+)\s*=\s*"([^"]*)"')


def _sri_for(path: str) -> str:
    with open(path, "rb") as f:
        return "sha384-" + base64.b64encode(hashlib.sha384(f.read()).digest()).decode("ascii")


def _subresource_tags():
    """返回 [(tag, src, integrity)]，只挑本地的 <script src> / <link href>。"""
    with open(INDEX, "r", encoding="utf-8") as f:
        html = f.read()
    out = []
    for m in _TAG_RE.finditer(html):
        tag, raw = m.group(1).lower(), m.group(2)
        attrs = {k.lower(): v for k, v in _ATTR_RE.findall(raw)}
        src = attrs.get("src") or attrs.get("href") or ""
        if src:
            out.append((tag, src, attrs.get("integrity", "")))
    return out


class StaticAssetTests(unittest.TestCase):

    def test_local_assets_exist(self):
        """页面引用的每个本地资源都得真的在磁盘上（bundle.js 是服务端现拼的虚拟路径）。"""
        checked = 0
        for _tag, src, _integrity in _subresource_tags():
            if not src.startswith("/static/") or src in VIRTUAL_PATHS:
                continue
            path = os.path.join(ROOT, src.lstrip("/").replace("/", os.sep))
            self.assertTrue(os.path.isfile(path), f"index.html 引用了不存在的文件：{src}")
            checked += 1
        self.assertGreater(checked, 0, "index.html 里没有任何本地静态资源？八成是路径写错了")

    def test_integrity_matches_bytes(self):
        checked = 0
        for tag, src, integrity in _subresource_tags():
            if not integrity:
                continue
            if not src.startswith("/static/"):
                continue
            path = os.path.join(ROOT, src.lstrip("/").replace("/", os.sep))
            self.assertTrue(os.path.isfile(path), f"index.html 引用了不存在的文件：{src}")
            actual = _sri_for(path)
            self.assertEqual(
                integrity, actual,
                f"{src} 的 integrity 已过期，浏览器会拒绝加载它。\n"
                f"  现在写的：{integrity}\n  应该是：  {actual}",
            )
            checked += 1
        if checked == 0:
            # 页面已无第三方脚本（云端 SDK 随 cloud-data.js 一起下线），SRI 无对象可校验。
            self.skipTest("index.html 没有带 integrity 的本地资源，无需校验")

    def test_every_vendor_file_has_integrity(self):
        """static/vendor/ 是「第三方代码」的集中地，必须逐个被 SRI 钉住。"""
        if not os.path.isdir(VENDOR_DIR):
            self.skipTest("没有 vendor 目录（当前无第三方脚本）")
        tags = _subresource_tags()
        used = {src for _t, src, integ in tags if integ}
        for name in sorted(os.listdir(VENDOR_DIR)):
            full = os.path.join(VENDOR_DIR, name)
            if not os.path.isfile(full):
                continue
            src = "/static/vendor/" + name
            self.assertIn(src, used,
                          f"{src} 没有被 index.html 以 integrity 方式引用（缺少供应链校验）")

    def test_no_crossorigin_on_same_origin_sri(self):
        """同源资源加 crossorigin 会走 CORS，而本站静态资源不发 ACAO → 脚本直接加载失败。"""
        with open(INDEX, "r", encoding="utf-8") as f:
            html = f.read()
        for m in _TAG_RE.finditer(html):
            raw = m.group(2)
            if "integrity=" not in raw:
                continue
            attrs = {k.lower(): v for k, v in _ATTR_RE.findall(raw)}
            self.assertNotIn("crossorigin", attrs,
                             "同源 SRI 资源不要加 crossorigin，否则需要服务端发 CORS 头")


if __name__ == "__main__":
    unittest.main(verbosity=2)
