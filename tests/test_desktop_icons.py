#!/usr/bin/env python3
"""桌面图标：排列不重叠 + 三种图标同构 + 回收站符号不画进头像区。

这一组断言针对的是一次真实的 UI 回归，三个现象其实是三处独立缺陷：
  1. 「排列图标」横排后，回收站（或别的图标）压在另一个图标上 —— 排列只枚举了
     DATA.projects，漏掉桌面上的内置图标（浏览器/设置），于是把格子分给了
     它们已经占住的位；
  2. 回收站卡片比项目图标窄（92 vs 116），同一列起点下图心偏左 ~12px，看着像歪了；
  3. 回收站 PNG 的桶盖是一条通长横线，右端钻进右上角头像底下被吃掉，剩下半截，
     视觉重心偏左 —— 递归到「这个标画歪了」。

对应的锁法：
  · arrangeGrid 的行为级测试（抽真实源码在 node 里跑）—— 任意两格矩形不得相交，
    覆盖 3 种密度 × 2 种方向 × 多档数量与视口；
  · 源码断言 arrangeIcons 以 DOM 为准，而不是 DATA.projects；
  · 源码断言三种卡片共用 --ic-w/--ic-h，且不再各写各的宽度；
  · 画图脚本断言回收站里所有跨到头像 x 区间的线，y 必须在头像下沿之下。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "static", "js")
CSS = os.path.join(ROOT, "static", "css")
LAYOUT_JS = os.path.join(JS, "010-window-layout.js")
MENU_JS = os.path.join(JS, "090-menus-hotkeys.js")
ICON_BUILDER = os.path.join(ROOT, "static", "icons", "_build_icons_extra.py")

# 头像落点：img.paste(face, (84, 8))，face 为 36×36
AVATAR_X0, AVATAR_Y0, AVATAR_SIZE = 84, 8, 36


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def extract_fn(src: str, name: str) -> str:
    """按大括号配平抽出一个 function 的源码。"""
    idx = src.find("async function " + name + "(")
    if idx < 0:
        idx = src.index("function " + name + "(")
    start = src.index("{", idx)
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


def extract_py_fn(src: str, name: str) -> str:
    """抽出 Python 里一个 def 的函数体（按缩进收尾）。"""
    lines = src.splitlines()
    start = None
    for i, line in enumerate(lines):
        if line.startswith("def %s(" % name):
            start = i
            break
    if start is None:
        raise AssertionError("找不到函数 %s" % name)
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and not line.startswith((" ", "\t")):
            break
        end += 1
    return "\n".join(lines[start:end])


def extract_block(src: str, selector: str) -> str:
    """抽出 CSS 里某个选择器的声明块。"""
    idx = src.index(selector + " {")
    start = src.index("{", idx)
    depth = 0
    for j in range(start, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
    raise AssertionError("没能配平 CSS 块 %s" % selector)


def density_sizes() -> dict:
    """从 applyDensity() 里读出三种密度对应的卡片尺寸，避免测试自己抄一份数字。"""
    src = _read(LAYOUT_JS)
    w = re.search(r"ICON_W = d === 'sm' \? (\d+) : d === 'lg' \? (\d+) : (\d+);", src)
    h = re.search(r"ICON_H = d === 'sm' \? (\d+) : d === 'lg' \? (\d+) : (\d+);", src)
    if not w or not h:
        raise AssertionError("applyDensity 里的尺寸表变了，测试需要同步")
    sm, lg, md = (int(x) for x in w.groups())
    hsm, hlg, hmd = (int(x) for x in h.groups())
    return {"sm": (sm, hsm), "md": (md, hmd), "lg": (lg, hlg)}


ARRANGE_HARNESS = r"""
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const gridSrc = (() => {
  const key = 'function arrangeGrid(';
  const idx = src.indexOf(key);
  if (idx < 0) throw new Error('arrangeGrid not found');
  let depth = 0, start = src.indexOf('{', idx);
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('unbalanced');
})();

const cases = JSON.parse(process.argv[3]);
const out = [];
for (const c of cases) {
  const ctx = {
    ICON_W: c.card[0], ICON_H: c.card[1],
    GRID_STEP_X: (c.step ? c.step[0] : c.card[0] + 10),
    GRID_STEP_Y: (c.step ? c.step[1] : c.card[1] + 10),
    GRID_X: 26, GRID_Y: 26,
    window: { innerWidth: c.vp[0], innerHeight: c.vp[1] },
    Math: Math,
  };
  vm.createContext(ctx);
  vm.runInContext(gridSrc + '\nthis.__g = arrangeGrid;', ctx);
  const cells = ctx.__g(c.count, c.dir);
  const bad = [];
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const ox = Math.min(a.x + c.card[0], b.x + c.card[0]) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + c.card[1], b.y + c.card[1]) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) bad.push([i, j, ox, oy]);
    }
  }
  const keys = new Set(cells.map(p => p.x + ',' + p.y));
  out.push({ tag: c.tag, n: cells.length, overlaps: bad.length, dupCells: cells.length - keys.size });
}
console.log(JSON.stringify(out));
"""


class ArrangeGridTest(unittest.TestCase):
    """行为级：抽真实 arrangeGrid 在 node 里跑，格子之间不许相交。"""

    @classmethod
    def setUpClass(cls):
        cls.sizes = density_sizes()

    def _run(self, cases):
        with tempfile.TemporaryDirectory() as td:
            harness = os.path.join(td, "h.js")
            with open(harness, "w", encoding="utf-8") as f:
                f.write(ARRANGE_HARNESS)
            proc = subprocess.run(
                ["node", harness, MENU_JS, json.dumps(cases)],
                capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
        if proc.returncode != 0:
            self.fail("node 跑挂了：%s" % (proc.stderr or proc.stdout)[-600:])
        return json.loads(proc.stdout)

    def test_三种密度两种方向任意数量都不重叠(self):
        cases = []
        for d, card in self.sizes.items():
            for vp in ((1440, 900), (1024, 700), (800, 600)):
                for dirn in ("col", "row"):
                    for count in (1, 2, 5, 9, 12, 20, 33):
                        cases.append({"tag": f"{d}/{vp[0]}x{vp[1]}/{dirn}/{count}",
                                      "card": list(card), "vp": list(vp),
                                      "dir": dirn, "count": count})
        res = self._run(cases)
        bad = [r for r in res if r["overlaps"] or r["dupCells"]]
        self.assertEqual(bad, [], "出现重叠或同格：%s" % bad[:5])

    def test_装置本身能发现重叠(self):
        """阳性对照：故意把步长设成小于卡片，断言器必须报出重叠。

        没有这一条，上面那个「全部不重叠」的绿灯说明不了问题——可能是断言根本没在看。
        """
        card = list(self.sizes["md"])
        res = self._run([{"tag": "bad", "card": card,
                          "step": [card[0] - 10, card[1] - 10],
                          "vp": [1440, 900], "dir": "col", "count": 6}])
        self.assertGreater(res[0]["overlaps"], 0, "步长小于卡片却没报重叠，断言是瞎的")

    def test_步长等于卡片加十(self):
        """密度只改卡片尺寸，步长由卡片推出来——这条保证「格子永远不小于卡片」。"""
        for d, (w, h) in self.sizes.items():
            res = self._run([{"tag": d, "card": [w, h], "vp": [1440, 900],
                              "dir": "col", "count": 2}])
            self.assertEqual(res[0]["n"], 2)
        src = _read(LAYOUT_JS)
        self.assertIn("GRID_STEP_X = ICON_W + GRID_GAP;", src)
        self.assertIn("GRID_STEP_Y = ICON_H + GRID_GAP;", src)
        self.assertIn("const GRID_GAP = 10;", src)
        # 默认档的既有观感：126 = 116+10、122 = 112+10
        self.assertEqual(self.sizes["md"], (116, 112))
        self.assertEqual(self.sizes["sm"], (96, 92))
        self.assertEqual(self.sizes["lg"], (136, 132))


class ArrangeEnumerationTest(unittest.TestCase):
    """「排列」必须覆盖桌面上真实存在的所有图标。"""

    def test_以_DOM_为准而不是_DATA_projects(self):
        body = extract_fn(_read(MENU_JS), "arrangeIcons")
        self.assertIn("querySelectorAll('.desk-icon')", body,
                      "排列应以 DOM 为准；用 DATA.projects 会漏掉内置图标")
        self.assertNotIn("DATA.projects", body,
                         "不要再从 DATA.projects 枚举——浏览器/设置图标不在里面")

    def test_内置图标的位置要落到各自的键(self):
        src = _read(MENU_JS)
        self.assertIn("const FIXED_ICON_POS_KEY", src)
        m = re.search(r"const FIXED_ICON_POS_KEY = \{([^}]*)\};", src)
        self.assertIsNotNone(m)
        table = m.group(1)
        self.assertIn("__browser: 'hub-browser-pos'", table)
        self.assertIn("__settings: 'hub-settings-pos'", table)
        body = extract_fn(src, "arrangeIcons")
        self.assertIn("FIXED_ICON_POS_KEY", body,
                      "排列后要把内置图标的位置写回它们自己的键，否则刷新就弹回原位")

    def test_回收站也进同一套网格(self):
        body = extract_fn(_read(MENU_JS), "arrangeIcons")
        self.assertIn("trash-item", body)
        self.assertIn("TRASH_POS_KEY", body)


class IconCardGeometryTest(unittest.TestCase):
    """项目图标 / 文件夹 / 回收站必须是同一个盒子，否则同列图心不在一条竖线上。"""

    def setUp(self):
        self.desktop_css = _read(os.path.join(CSS, "10-desktop.css"))
        self.window_css = _read(os.path.join(CSS, "11-window.css"))

    def test_三种卡片共用尺寸变量(self):
        for sel in (".desk-icon", ".folder-item", ".trash-item"):
            css = self.desktop_css if sel == ".desk-icon" else self.window_css
            block = extract_block(css, sel)
            self.assertIn("width: var(--ic-w)", block, "%s 应使用 --ic-w" % sel)
            self.assertIn("height: var(--ic-h)", block, "%s 应使用 --ic-h" % sel)
            self.assertIn("padding: 10px 6px", block, "%s 内边距应与项目图标一致" % sel)
            self.assertIn("gap: 8px", block, "%s 图标与文字的间距应与项目图标一致" % sel)

    def test_不再有写死的卡片宽度(self):
        for sel, css in ((".desk-icon", self.desktop_css),
                         (".folder-item", self.window_css),
                         (".trash-item", self.window_css)):
            block = extract_block(css, sel)
            self.assertIsNone(re.search(r"width:\s*\d+px", block),
                              "%s 里还有写死的宽度，密度切换时会对不上格子" % sel)

    def test_尺寸变量有默认值且由_JS_写(self):
        self.assertIn("--ic-w: 116px", self.desktop_css)
        self.assertIn("--ic-h: 112px", self.desktop_css)
        js = _read(LAYOUT_JS)
        self.assertIn("setProperty('--ic-w'", js)
        self.assertIn("setProperty('--ic-h'", js)

    def test_图标图与文字也跟随密度(self):
        js = _read(LAYOUT_JS)
        self.assertIn("setProperty('--ic-img'", js)
        self.assertIn("setProperty('--ic-fs'", js)
        self.assertIn("width: var(--ic-img)", self.desktop_css)
        trash_block = extract_block(self.window_css, ".trash-item .fi-ic img")
        self.assertIn("width: var(--ic-img)", trash_block)


class TrashArtworkTest(unittest.TestCase):
    """回收站符号不许画进右上角头像的区域。"""

    @classmethod
    def setUpClass(cls):
        cls.body = extract_py_fn(_read(ICON_BUILDER), "trash")

    def test_跨到头像区的线都在头像下沿之下(self):
        avatar_bottom = AVATAR_Y0 + AVATAR_SIZE
        offenders = []
        for chunk in re.findall(r"\[\((?:-?\d+(?:\.\d+)?(?:,\s*)?)+\)", self.body):
            pts = re.findall(r"\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)", chunk)
            for px, py in pts:
                x, y = float(px), float(py)
                if x > AVATAR_X0 and y < avatar_bottom:
                    offenders.append((x, y))
        self.assertEqual(offenders, [],
                         "这些点落进了头像区（x>%d 且 y<%d），会被头像盖住：%s"
                         % (AVATAR_X0, avatar_bottom, offenders))

    def _white_hlines(self):
        """取出 fill=WHITE 的两点横线（提手、盖子），按跨度排序。

        连 width 一起取：PIL 的线是以 y 为中轴、上下各占 width/2 的，
        只看 y 会漏掉「线心在头像下沿、上半截却仍在头像里」这种情况。
        """
        out = []
        for m in re.finditer(
                r"d\.line\(\[\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\),\s*"
                r"\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\)\],\s*fill=WHITE,\s*width=(\d+)", self.body):
            x1, y1, x2, y2, w = (float(v) for v in m.groups())
            out.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "w": w, "top": y1 - w / 2.0, "span": abs(x2 - x1)})
        out.sort(key=lambda d: -d["span"])
        return out

    def test_桶盖是完整的一条且居中(self):
        lines = self._white_hlines()
        self.assertGreaterEqual(len(lines), 2, "应当有提手和盖子两条白色横线")
        lid = lines[0]                                    # 跨度最大的那条 = 盖子
        self.assertEqual(lid["y1"], lid["y2"], "盖子应当水平")
        self.assertGreater(lid["x2"], AVATAR_X0,
                           "盖子本来就该伸到头像那一侧，否则桶口太小")
        self.assertGreater(lid["top"], AVATAR_Y0 + AVATAR_SIZE,
                           "盖子上沿（y - 线宽/2）必须在头像下沿之下，否则右端会被头盔吃掉")
        self.assertEqual(lid["x1"] + lid["x2"], 128, "盖子应关于卡片中线 x=64 对称")

    def test_提手在盖子之上且避开头像(self):
        lines = self._white_hlines()
        lid, handle = lines[0], lines[1]
        self.assertLess(handle["y1"], lid["y1"], "提手应在盖子之上")
        self.assertLessEqual(max(handle["x1"], handle["x2"]), AVATAR_X0,
                             "提手整条都要在头像左侧，否则会被压掉一截")


if __name__ == "__main__":
    unittest.main(verbosity=2)
