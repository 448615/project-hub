# -*- coding: utf-8 -*-
"""生成四张角色主题桌面图标（128x128 PNG，蓝白角色风）"""
import os
from PIL import Image, ImageDraw

SRC = r"C:\Users\msy44\WorkBuddy\2026-10-23-21-39-31\project-hub\static\bg.jpg"
OUT = r"C:\Users\msy44\WorkBuddy\2026-10-23-21-39-31\project-hub\static\icons"
os.makedirs(OUT, exist_ok=True)

S = 128
BLUE_TOP = (79, 134, 247)     # 角色卫衣蓝
BLUE_BOT = (103, 232, 249)    # 鲸鱼青
WHITE = (255, 255, 255, 255)

# ---- 干饭脸小头像（从 bg.jpg 裁） ----
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
    """角色蓝→青渐变圆角卡片底"""
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dg = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        r = int(BLUE_TOP[0] + (BLUE_BOT[0] - BLUE_TOP[0]) * t)
        g = int(BLUE_TOP[1] + (BLUE_BOT[1] - BLUE_TOP[1]) * t)
        b = int(BLUE_TOP[2] + (BLUE_BOT[2] - BLUE_TOP[2]) * t)
        dg.line([(0, y), (S, y)], fill=(r, g, b, 255))
    # 圆角遮罩
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=28, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), m)
    # 顶部内高光（玻璃感）
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dhl = ImageDraw.Draw(hl)
    dhl.rounded_rectangle((4, 4, S - 5, S - 5), radius=24, outline=(255, 255, 255, 90), width=2)
    out = Image.alpha_composite(out, hl)
    return out

def bubbles(d, y0=110):
    for dx, r in [(30, 3), (52, 4), (72, 3), (92, 3)]:
        d.ellipse((dx - r, y0 - r, dx + r, y0 + r), fill=(255, 255, 255, 110))

def arrow(d):
    d.polygon([(12, 16), (98, 62), (66, 64), (76, 100), (52, 100), (40, 64), (12, 60)], fill=WHITE)
    d.polygon([(20, 26), (84, 58), (64, 59), (70, 88), (58, 88), (50, 60), (20, 58)], fill=(255, 255, 255, 255))

def gear(d, cx=64, cy=66, R=26, r_in=13, teeth=8):
    import math
    for i in range(teeth):
        a = i * (360 / teeth) - 90
        rad = math.radians(a)
        tx, ty = cx + R * math.cos(rad), cy + R * math.sin(rad)
        d.rounded_rectangle((tx - 5, ty - 9, tx + 5, ty + 9), radius=3, fill=WHITE)
    d.ellipse((cx - R, cy - R, cx + R, cy + R), fill=WHITE)
    d.ellipse((cx - r_in, cy - r_in, cx + r_in, cy + r_in), fill=(79, 134, 247, 255))

def code(d):
    w7 = 7
    d.line([(36, 38), (18, 64), (36, 90)], fill=WHITE, width=w7, joint="curve")
    d.line([(52, 36), (78, 92)], fill=WHITE, width=w7)
    d.line([(92, 38), (110, 64), (92, 90)], fill=WHITE, width=w7, joint="curve")
    d.line([(30, 106), (98, 106)], fill=(255, 255, 255, 170), width=4)

def web(d):
    d.rounded_rectangle((22, 26, 106, 100), radius=10, outline=WHITE, width=6)
    d.ellipse((31, 39, 39, 47), fill=WHITE)
    d.ellipse((45, 39, 53, 47), fill=(255, 255, 255, 200))
    d.ellipse((59, 39, 67, 47), fill=(255, 255, 255, 140))
    d.line([(28, 58), (100, 58)], fill=(255, 255, 255, 160), width=4)
    d.rounded_rectangle((40, 70, 88, 86), radius=6, fill=(255, 255, 255, 220))

def build(name, symbol_fn):
    img = base()
    d = ImageDraw.Draw(img)
    symbol_fn(d)
    bubbles(d)
    img.paste(face, (84, 8), face)
    img.save(os.path.join(OUT, name + ".png"))
    print("icon:", name)

build("cursors", arrow)
build("api", gear)
build("scripts", code)
build("web", web)
print("done")
