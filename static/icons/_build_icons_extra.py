# -*- coding: utf-8 -*-
"""补三张桌面图标：星枢 / 桓梦工作台 / 回收站。

与 _build_icons.py 同一套视觉语言（128×128、角色蓝→青渐变圆角卡、白色单色符号、
底部气泡、右上角干饭脸），这样三个后加的图标和原有的 api/web/scripts 摆在一起不会
显得是另一套 UI。原有脚本会整体重绘四张旧图，这里只生成新的三张，避免动到已上线的。
"""
import os
import math
from PIL import Image, ImageDraw

SRC = r"C:\Users\msy44\WorkBuddy\2026-10-23-21-39-31\project-hub\static\bg.jpg"
OUT = r"C:\Users\msy44\WorkBuddy\2026-10-23-21-39-31\project-hub\static\icons"
os.makedirs(OUT, exist_ok=True)

S = 128
BLUE_TOP = (79, 134, 247)     # 角色卫衣蓝
BLUE_BOT = (103, 232, 249)    # 鲸鱼青
WHITE = (255, 255, 255, 255)

# ---- 干饭脸小头像（与 _build_icons.py 相同的裁切参数与落点）----
im = Image.open(SRC).convert("RGBA").crop((2380, 110, 2710, 440))
w, h = im.size
s = min(w, h)
im = im.crop(((w - s) // 2, 0, (w + s) // 2, s))
mask = Image.new("L", im.size, 0)
ImageDraw.Draw(mask).ellipse((0, 0, im.size[0], im.size[1]), fill=255)
face = Image.new("RGBA", im.size, (0, 0, 0, 0))
face.paste(im, (0, 0), mask)
face = face.resize((36, 36), Image.LANCZOS)


def base():
    """角色蓝→青渐变圆角卡片底（与旧图标逐像素一致）"""
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dg = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        r = int(BLUE_TOP[0] + (BLUE_BOT[0] - BLUE_TOP[0]) * t)
        g = int(BLUE_TOP[1] + (BLUE_BOT[1] - BLUE_TOP[1]) * t)
        b = int(BLUE_TOP[2] + (BLUE_BOT[2] - BLUE_TOP[2]) * t)
        dg.line([(0, y), (S, y)], fill=(r, g, b, 255))
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=28, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), m)
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle((4, 4, S - 5, S - 5), radius=24,
                                         outline=(255, 255, 255, 90), width=2)
    return Image.alpha_composite(out, hl)


def bubbles(d, y0=110):
    for dx, r in [(30, 3), (52, 4), (72, 3), (92, 3)]:
        d.ellipse((dx - r, y0 - r, dx + r, y0 + r), fill=(255, 255, 255, 110))


def star_pts(cx, cy, R, r_in, rot_deg=-90):
    """四角星：8 个顶点外/内交替，尖角朝正上"""
    pts = []
    for i in range(8):
        a = math.radians(rot_deg + i * 45)
        rad = R if i % 2 == 0 else r_in
        pts.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    return pts


def starshu(d):
    """星枢：中央四角星 + 一圈倾斜轨道（星轨），旁边两颗小星"""
    # 轨道环：先画，被星遮住中段，露出两端成环
    d.ellipse((14, 46, 114, 86), outline=(255, 255, 255, 210), width=4)
    d.polygon(star_pts(64, 64, 33, 12), fill=WHITE)
    # 轨道上的两颗小星（左右外缘）
    d.ellipse((20, 62, 27, 69), fill=(255, 255, 255, 235))
    d.ellipse((101, 62, 107, 68), fill=(255, 255, 255, 235))
    # 点缀小星
    d.ellipse((30, 26, 36, 32), fill=(255, 255, 255, 200))
    d.ellipse((96, 96, 101, 101), fill=(255, 255, 255, 180))


def workbench(d):
    """桓梦工作台：顶部标题条 + 三栏看板卡片。
    刻意不做成单个应用窗口——那样和 Web 前端图标（就是一扇窗口）撞脸，
    并排放在桌面上分不出谁是谁。三栏错落高度更像一块工作台/看板。"""
    # 标题条只画到头像左侧（头像占 84~120），避免线条从脸后面穿出来
    d.line([(20, 36), (82, 36)], fill=WHITE, width=6)                  # 顶部标题条
    d.rounded_rectangle((20, 48, 46, 100), radius=6, outline=WHITE, width=4)
    d.rounded_rectangle((52, 48, 78, 86), radius=6, outline=(255, 255, 255, 235), width=4)
    d.rounded_rectangle((52, 92, 78, 104), radius=5, fill=(255, 255, 255, 200))
    d.rounded_rectangle((84, 48, 110, 72), radius=6, outline=(255, 255, 255, 215), width=4)


def trash(d):
    """回收站：提手 + 盖 + 梯形桶身 + 两条竖纹（线条风，与 web 图标的描边框一致）

    整组符号压在 y≈37 以下是有意的：右上角头像占 (84,8)-(120,44)，桶盖是一条通长横线，
    只要它穿过 y<44 且 x>84 的那块区域，右端就会被头像吃掉——残留的盖子短了一截，
    重心偏左，看着像画歪了。所以盖下移到 y=50（整条落在头像下沿之下），
    提手虽然还在头像的高度区间里，但只占 x 56~72，碰不到头像。
    """
    d.line([(56, 40), (72, 40)], fill=WHITE, width=5)            # 提手
    d.line([(30, 50), (98, 50)], fill=WHITE, width=6)            # 盖
    d.line([(37, 58), (91, 58), (84, 102), (44, 102), (37, 58)],
           fill=WHITE, width=5, joint="curve")                   # 桶身
    d.line([(54, 66), (57, 94)], fill=(255, 255, 255, 215), width=4)
    d.line([(74, 66), (71, 94)], fill=(255, 255, 255, 215), width=4)


def build(name, symbol_fn):
    img = base()
    d = ImageDraw.Draw(img)
    symbol_fn(d)
    bubbles(d)
    img.paste(face, (84, 8), face)
    img.save(os.path.join(OUT, name + ".png"))
    print("icon:", name, img.size)


build("starshu", starshu)
build("workbench", workbench)
build("trash", trash)
print("done")
