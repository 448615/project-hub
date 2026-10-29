# -*- coding: utf-8 -*-
"""PWA 应用图标 512x512：四格窗口 logo（与开始按钮同款），角色蓝→青渐变底"""
import os, math
from PIL import Image, ImageDraw

OUT = r"C:\Users\msy44\WorkBuddy\2026-10-23-21-39-31\project-hub\static\icons"
S = 512
BLUE = (91, 140, 255)
CYAN = (103, 232, 249)

grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    r = int(BLUE[0] + (CYAN[0] - BLUE[0]) * t)
    g = int(BLUE[1] + (CYAN[1] - BLUE[1]) * t)
    b = int(BLUE[2] + (CYAN[2] - BLUE[2]) * t)
    d.line([(0, y), (S, y)], fill=(r, g, b, 255))

m = Image.new("L", (S, S), 0)
ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), radius=112, fill=255)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
img.paste(grad, (0, 0), m)
d = ImageDraw.Draw(img)

# 四格方块（仿开始按钮），白色底衬 + 四色
gap = 34
cell = (S - gap * 3) // 2
ox = oy = gap + 20
for i, (cx, cy, col) in enumerate([
    (ox, oy, BLUE),
    (ox + cell + gap, oy, CYAN),
    (ox, oy + cell + gap, CYAN),
    (ox + cell + gap, oy + cell + gap, BLUE),
]):
    d.rounded_rectangle((cx, cy, cx + cell, cy + cell), radius=58, fill=(255, 255, 255, 240))
    d.rounded_rectangle((cx + 14, cy + 14, cx + cell - 14, cy + cell - 14), radius=46, fill=col + (255,))

img.save(os.path.join(OUT, "app-512.png"))
print("app-512.png saved")
