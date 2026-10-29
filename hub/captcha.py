"""hub.captcha — 零依赖图形验证码：SVG 渲染 + HMAC 签名令牌 + 一次性消费

为什么自己写而不是引第三方库：
  1) 本项目坚持零第三方依赖（云端装不了包），Pillow / captcha 类库都不可用；
  2) 生成位图还需要字体文件，而 SVG 用「自绘点阵字形转路径」可以完全不依赖字体。

安全设计（三点缺一不可，每一条都对应一种真实的失效方式）：

  1) **SVG 里不能出现明文**。这是 SVG 验证码最容易踩的坑：用 <text> 渲染时，
     字符原封不动躺在响应源码里，`re.search(r'>([0-9A-Z]{4})<', html)` 一行就取到答案，
     验证码等于不存在。所以字形必须烘焙成 <path> 的坐标数据，且不保留任何
     transform 属性——坐标直接算成最终值，不给出「按组还原」的便利。

  2) **令牌必须自证**。答案不存服务端内存：云端 serverless 冷启动会清空内存，
     存内存等于「用户填对了却校验失败」。改为把答案签进令牌，服务端只需重新算
     HMAC 即可判真伪，无状态、跨进程、跨重启都成立。

  3) **一次性**。校验不通过也要作废令牌：4 位 29 字符集约 71 万种，若同一张图
     可以反复提交，脚本对着它穷举就能保证命中。作废后必须换图。
     （进程内 nonce 表在冷启动后会丢，这是已知残留；TTL 只有 5 分钟，且注册接口
     另有频率闸门，实际可利用窗口很小。）

字符集刻意去掉 0/O、1/I/L、S/5 这类易混字符：验证码的失败成本主要在「人看错了」，
而不是「机器猜对了」——后者由一次性 + 频率限制负责。M 也被去掉，原因不同：
5×7 点阵里 M 与 N 只差中间两行的四个像素，加上旋转错切后**实测**会被互相读错
（真机截图里 N 被读成 M）。歧义来自「有两个候选」，去掉一个，剩下的那个就没有
第二种解释——这比调整字形更可靠。代价是熵少了 1/28，可忽略。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import random
import secrets
import threading
import time

from .security import SECRET_KEY

# --------------------------------------------------------------------------
# 参数
# --------------------------------------------------------------------------
CHARSET = "23456789ABCDEFGHJKNQRTUVWXYZ"     # 28 个：去掉 0O1ILS 五项易混，再去掉 M
CODE_LEN = 4
TOKEN_TTL = 300.0                              # 令牌有效期（秒）：够填完表单，不够穷举
SVG_W, SVG_H = 132, 44

# 每个字形的 5×7 点阵。写点阵而不是折线：5×7 的字形人眼 100% 认得出，
# 手写折线字体则很容易画出「像又不像」的怪字，把可读性赌在笔画设计上不值得。
_GLYPHS = {
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01110"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "J": ("00111", "00010", "00010", "00010", "00010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "11011", "10001"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
}

# 墨色：都是深色，配固定的浅色底。不跟随主题取色——验证码必须有自己的底色，
# 否则深色主题下深墨字落在深色卡片上直接看不见。
_INKS = ("#233a5e", "#2b2a52", "#1f3d47", "#3a2b45", "#243b32")
_BG = "#f4f7fb"


# --------------------------------------------------------------------------
# 令牌：把答案签名后交给客户端，服务端不留状态
# --------------------------------------------------------------------------
def _sign_key() -> bytes:
    """从主密钥派生「令牌签名」专用密钥。

    直接复用 SECRET_KEY 也安全，但派生后再用可以保证：将来若把会话签名换成
    别的算法（或轮换主密钥的用法），验证码令牌的格式不会跟着被动改变。
    """
    return hmac.new(SECRET_KEY, b"hub-captcha-sign-v1", hashlib.sha256).digest()


def _answer_key() -> bytes:
    """从主密钥派生「答案摘要」专用密钥。

    与签名密钥分开：签名保护的是「令牌没被改过」，摘要保护的是「答案没被读出来」，
    两者混用一把密钥会让其中一个被破解时另一个跟着失效。
    """
    return hmac.new(SECRET_KEY, b"hub-captcha-answer-v1", hashlib.sha256).digest()


def _answer_digest(nonce: str, code: str) -> str:
    """答案的不可逆摘要。

    【必须这样做的原因】早期版本把答案直接写进 payload（`{"c":"AB2C"}`），
    而 payload 只是 base64 —— 它**不是加密**，任何客户端 unbase64 就能读出答案，
    验证码等于不存在。摘要只暴露一个 HMAC 值，无法反推答案。
    """
    msg = ("cap:" + nonce + ":" + str(code).strip().upper()).encode("utf-8")
    return hmac.new(_answer_key(), msg, hashlib.sha256).hexdigest()[:32]


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_token(code: str, ttl: float = TOKEN_TTL, now: float | None = None) -> str:
    """把验证码答案签成令牌：base64(payload) + "." + base64(hmac)。

    payload 里**只有摘要**，没有答案本身：{d: 摘要, e: 过期, n: nonce, v: 版本}
    """
    now = time.time() if now is None else now
    nonce = secrets.token_hex(8)
    payload = {"d": _answer_digest(nonce, code), "e": int(now + ttl), "n": nonce, "v": 1}
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_sign_key(), body.encode("ascii"), hashlib.sha256).digest()[:16]
    return body + "." + _b64e(sig)


# 已消费的 nonce → 令牌过期时刻。校验失败也写入，保证「一张图只能试一次」。
_USED: dict[str, float] = {}
_USED_LOCK = threading.Lock()
_USED_MAX = 4096


def _consume_nonce(nonce: str, exp: float) -> bool:
    """标记 nonce 已用；若此前已用过返回 False。顺带清掉过期记录。"""
    now = time.time()
    with _USED_LOCK:
        if len(_USED) > _USED_MAX:
            for k in [k for k, v in _USED.items() if v < now][:1024]:
                _USED.pop(k, None)
            if len(_USED) > _USED_MAX:      # 全都没过期（极端情况）：整体清空，宁可放宽也不OOM
                _USED.clear()
        if nonce in _USED:
            return False
        _USED[nonce] = exp
        return True


def reset_used_for_test() -> None:
    """仅供测试：清空 nonce 表。"""
    with _USED_LOCK:
        _USED.clear()


def verify_token(token: str, answer: str, now: float | None = None) -> tuple[bool, str]:
    """校验令牌 + 用户答案。

    返回 (是否通过, 原因)。原因用于给前端不同文案：
      ok / malformed（令牌缺失或格式坏）/ expired（超时）/ used（已用过）/ bad（答案错）
    任何非 ok 的结果都已让该令牌失效，前端必须换图。
    """
    if not token or not isinstance(token, str) or "." not in token:
        return False, "malformed"
    body, _, sig_b64 = token.partition(".")
    try:
        sig = _b64d(sig_b64)
        payload = json.loads(_b64d(body).decode("utf-8"))
        digest = str(payload["d"])
        exp = float(payload["e"])
        nonce = str(payload["n"])
    except Exception:  # noqa: BLE001 —— 任何解析失败都当成伪造令牌
        return False, "malformed"
    want = hmac.new(_sign_key(), body.encode("ascii", "ignore"), hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(want, sig):
        return False, "malformed"

    now = time.time() if now is None else now
    if exp < now:
        return False, "expired"
    # 先消费再比答案：顺序反了会出现「答案对但令牌已被并发用掉」仍返回 ok 的假象
    if not _consume_nonce(nonce, exp):
        return False, "used"
    if not hmac.compare_digest(_answer_digest(nonce, answer), digest):
        return False, "bad"
    return True, "ok"


# --------------------------------------------------------------------------
# 渲染
# --------------------------------------------------------------------------
def _emit_char(rows, ox: float, oy: float, unit: float, rot: float, skew: float) -> str:
    """把一个字形按「旋转 + 错切」变换后输出为多边形路径片段。

    刻意不使用 <g transform>：分组会把「哪几段属于同一个字符」直接告诉解析者，
    逐组求逆就能还原字形。这里把变换烘进坐标，所有字符混在一起输出，
    想还原就必须自己做矩形聚类 + 模板匹配——那已经是写 OCR 的工作量了。
    """
    w = 5 * unit
    h = 7 * unit
    cx = ox + w / 2.0
    cy = oy + h / 2.0
    cos_r, sin_r = math.cos(rot), math.sin(rot)

    def tx(lx: float, ly: float) -> tuple[float, float]:
        lx2 = lx + skew * ly
        return (cx + lx2 * cos_r - ly * sin_r, cy + lx2 * sin_r + ly * cos_r)

    parts: list[str] = []
    for y, row in enumerate(rows):
        x = 0
        while x < 5:
            if row[x] != "1":
                x += 1
                continue
            x2 = x
            while x2 < 5 and row[x2] == "1":
                x2 += 1
            # 同一行里连续的点合并成一个矩形，减少节点数（路径更短、更像手写块）
            x0 = x * unit - w / 2.0
            x1 = x2 * unit - w / 2.0
            y0 = y * unit - h / 2.0
            y1 = (y + 1) * unit - h / 2.0
            pts = [tx(x0, y0), tx(x1, y0), tx(x1, y1), tx(x0, y1)]
            d = "M" + "L".join(f"{px:.1f} {py:.1f}" for px, py in pts) + "Z"
            parts.append(d)
            x = x2
    return "".join(parts)


def render_svg(code: str, rnd: random.Random | None = None,
               width: int = SVG_W, height: int = SVG_H) -> str:
    """把 4 位验证码渲染成 SVG 字符串。rnd 可注入，便于测试锁定随机性。"""
    rnd = rnd or random.Random()
    chars = [c for c in code.upper() if c in _GLYPHS]
    if not chars:
        chars = ["A"]

    unit = 4.6
    glyph_w = 5 * unit
    gap = 6.5
    total = len(chars) * glyph_w + (len(chars) - 1) * gap
    start_x = (width - total) / 2.0

    # 按墨色把字形分到 2~3 组：同一条 path 只能一种 fill，分组顺带打散字符边界
    groups: dict[str, list[str]] = {}
    for i, ch in enumerate(chars):
        ox = start_x + i * (glyph_w + gap)
        oy = (height - 7 * unit) / 2.0 + rnd.uniform(-2.2, 2.2)
        rot = math.radians(rnd.uniform(-14.0, 14.0))
        skew = rnd.uniform(-0.18, 0.18)
        ink = rnd.choice(_INKS)
        groups.setdefault(ink, []).append(_emit_char(_GLYPHS[ch], ox, oy, unit, rot, skew))

    # 干扰线：贝塞尔，压在字形下方（先画），避免把字切碎到不可读
    noise: list[str] = []
    for _ in range(3):
        x0 = rnd.uniform(-4, width * 0.35)
        y0 = rnd.uniform(2, height - 2)
        x1 = rnd.uniform(width * 0.65, width + 4)
        y1 = rnd.uniform(2, height - 2)
        cx1 = rnd.uniform(0, width)
        cy1 = rnd.uniform(0, height)
        noise.append(f'<path d="M{x0:.1f} {y0:.1f}Q{cx1:.1f} {cy1:.1f} {x1:.1f} {y1:.1f}" '
                     f'fill="none" stroke="#9db3d4" stroke-width="1.1" opacity="0.55"/>')
    for _ in range(26):
        noise.append(f'<circle cx="{rnd.uniform(0, width):.1f}" cy="{rnd.uniform(0, height):.1f}" '
                     f'r="{rnd.uniform(0.6, 1.5):.1f}" fill="#8fa6c8" opacity="0.45"/>')

    ink_paths = "".join(
        # 描边跟着填充同色、宽度很小：旋转后相邻方块之间会出现发丝缝，
        # 一条 0.55 的描边刚好把缝糊住，字看着是「一整块」而不是「撒了一把碎点」。
        f'<path d="{"".join(segs)}" fill="{ink}" stroke="{ink}" stroke-width="0.55"/>'
        for ink, segs in groups.items()
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}" role="img" aria-label="图形验证码">'
        f'<rect width="{width}" height="{height}" rx="8" fill="{_BG}"/>'
        + "".join(noise)
        + ink_paths
        + "</svg>"
    )


def new_challenge(rnd: random.Random | None = None) -> dict:
    """生成一张新验证码：返回 {token, svg}。答案只存在于令牌里，不返回明文。"""
    code = "".join(secrets.choice(CHARSET) for _ in range(CODE_LEN))
    return {"token": issue_token(code), "svg": render_svg(code, rnd)}
