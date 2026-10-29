"""hub/cloudauth.py — 云端邮箱验证码（平台 Auth 的 Email OTP 数据面）

为什么由服务端发信与校验，而不是前端装 SDK：
  1) 发信是最贵的动作（一封邮件有真实成本、也会打扰收件人）。只有服务端能按
     「IP + 邮箱」两个维度精确限流；放前端等于把闸门交给客户端，脚本随便刷。
  2) 前端装 SDK 必须把 CSP 的 script-src 从 'self' 放宽到 CDN，为一个功能拆掉
     一条防线不划算。
  3) 校验在服务端完成，账号库就不必相信客户端自述的「我已验证过」。

边界：本模块只做两件事 —— 发码、校验码。**不建云端用户、不取会话、不碰平台
      账号体系**，因为全程只调用 verification 两个接口；signup/signin 一概不碰，
      所以平台侧不会因为我们这里的注册而多出用户。

一个必须记住的协议细节：`/verification/verify` 的请求体里**没有邮箱**，只有
`verification_id` + `verification_code`。也就是说云端只认 id，不认「这个 id 属于
谁」。若把 id 和邮箱都交给客户端，用户只要拿自己的 id 配上别人的邮箱就能给别人的
地址开号。因此本模块在发码时把 id→邮箱 记在服务端内存里，注册时用**自己记的**
邮箱，而不是客户端传来的那个。
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request

from . import diag

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 服务端保守有效期：云端可能更短，取两者较小者，宁可让用户早一点重发，
# 也不要让一个「服务端认为还有效、云端已作废」的码通过第一道检查。
CODE_TTL = 600.0
SEND_COOLDOWN = 60.0
_MAX_PENDING = 2000

_CFG: dict | None = None
_CFG_LOCK = threading.Lock()

_PENDING: dict[str, dict] = {}
_PEND_LOCK = threading.Lock()


# --------------------------------------------------------------------------
# 配置
# --------------------------------------------------------------------------
def _cfg() -> dict | None:
    """读取 cloud.public.json（endpoint + publishableKey，均为可公开值）。

    与 accounts.py 的读取顺序一致：先 public 再完整版，两个文件都缺就视为未配置。
    """
    global _CFG
    if _CFG is not None:
        return _CFG or None
    with _CFG_LOCK:
        if _CFG is not None:
            return _CFG or None
        for fn in ("cloud.public.json", "cloud.json"):
            path = os.path.join(_ROOT, fn)
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
            except Exception as e:  # noqa: BLE001
                diag.note("hub/cloudauth.py::_cfg", e)
                continue
            base = str(raw.get("endpoint") or "").strip().rstrip("/")
            key = str(raw.get("publishableKey") or "").strip()
            if base and key:
                _CFG = {"base": base, "key": key}
                return _CFG
        _CFG = {}
        return None


def configured() -> bool:
    return _cfg() is not None


def reset_for_test() -> None:
    """测试用：清空配置缓存与待用验证码。"""
    global _CFG
    with _CFG_LOCK:
        _CFG = None
    with _PEND_LOCK:
        _PENDING.clear()


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
def _post(path: str, body: dict, timeout: float = 10.0) -> tuple[int, dict | str]:
    """POST 到应用自身的云认证数据面。返回 (status, 解析后的 body 或原始文本)。

    必须显式带 Origin：平台按「应用发布域」做精确匹配。这里填的正是本应用的发布域
    （endpoint 本身），不是伪装成别人的站点。
    """
    cfg = _cfg()
    if not cfg:
        return 0, "未配置云服务"
    url = cfg["base"] + path
    req = urllib.request.Request(url, method="POST")
    req.add_header("x-wb-webapp-access-key", cfg["key"])
    req.add_header("Origin", cfg["base"])
    req.add_header("Referer", cfg["base"] + "/")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode("utf-8")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
        except Exception:  # noqa: BLE001
            raw = b""
        status = e.code
    except Exception as e:  # noqa: BLE001
        # 网络层失败：只记类型，不记 URL 细节（URL 含应用域，不必进日志）
        diag.note("hub/cloudauth.py::_post", e)
        return 0, type(e).__name__
    try:
        return status, json.loads(raw.decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return status, raw[:200].decode("utf-8", "replace")


def _err_desc(obj) -> str:
    """从错误体里取一句人读描述。只用于排障日志，不回给用户。"""
    if isinstance(obj, dict):
        for k in ("error_description", "error", "message", "code"):
            v = obj.get(k)
            if isinstance(v, str) and v:
                return v[:120]
    return ""


# --------------------------------------------------------------------------
# 待用验证码登记（id → 邮箱）
# --------------------------------------------------------------------------
MAX_TRIES = 5          # 同一张码允许试错的次数


def _remember(vid: str, email: str) -> None:
    now = time.time()
    with _PEND_LOCK:
        # 顺手清掉过期的，避免这个字典随着时间无限长大
        if len(_PENDING) > _MAX_PENDING // 2:
            for k in [k for k, v in _PENDING.items() if now - v["at"] > CODE_TTL]:
                _PENDING.pop(k, None)
        _PENDING[vid] = {"email": email, "at": now, "tries": 0}


def _peek(vid: str) -> tuple[str, int]:
    """查看该 id 对应邮箱与已试次数，**不作废**。

    不作废是刻意的：用户手滑打错一位，不该罚他重新收一封邮件。云端在同一张码上
    允许重试到过期，我们这边保持一致，只额外限制总次数（见 MAX_TRIES）挡住穷举。
    过期或不存在返回 ("", 0)。
    """
    with _PEND_LOCK:
        rec = _PENDING.get(vid)
        if not rec:
            return "", 0
        if time.time() - rec["at"] > CODE_TTL:
            _PENDING.pop(vid, None)
            return "", 0
        return rec["email"], int(rec.get("tries", 0))


def _bump(vid: str) -> int:
    """记一次失败尝试，返回累计次数；达到上限则作废该 id。"""
    with _PEND_LOCK:
        rec = _PENDING.get(vid)
        if not rec:
            return MAX_TRIES
        rec["tries"] = int(rec.get("tries", 0)) + 1
        n = rec["tries"]
        if n >= MAX_TRIES:
            _PENDING.pop(vid, None)
        return n


def _drop(vid: str) -> None:
    with _PEND_LOCK:
        _PENDING.pop(vid, None)


# --------------------------------------------------------------------------
# 对外：发码 / 验码
# --------------------------------------------------------------------------
def request_code(email: str) -> tuple[bool, str, str, int]:
    """发送验证码。

    返回 (ok, verification_id, 错误文案, http_status)。
    失败时第 2 项为空串；成功时第 3 项为空串。
    """
    email = str(email or "").strip().lower()
    status, body = _post("/.cloud/auth/v1/verification",
                         {"email": email, "usage": "email"})
    if status == 200 and isinstance(body, dict):
        vid = body.get("verification_id")
        if not isinstance(vid, str) or not vid:
            # 拿不到 id 就等于这张码无法校验，宁可让用户重发也不要假装成功
            diag.note("hub/cloudauth.py::request_code",
                      RuntimeError("云端未返回 verification_id"))
            return False, "", "验证码服务返回异常，请稍后重试。", 502
        _remember(vid, email)
        return True, vid, "", 200
    if status == 0:
        return False, "", "邮箱验证服务暂时不可用，请稍后再试。", 503
    if status == 429:
        return False, "", "验证码发送过于频繁，请稍后再试。", 429
    if status == 400:
        # 云端认为邮箱格式非法（它有一套自己的正则）。前端也校验了一遍，
        # 走到这里说明两边的判定不一致，此时按云端的说法让用户改地址。
        return False, "", "邮箱地址无法接收验证码，请检查后重试。", 400
    diag.note("hub/cloudauth.py::request_code",
              RuntimeError(f"send status={status} desc={_err_desc(body)}"))
    return False, "", "验证码发送失败，请稍后重试。", 502


def confirm_code(verification_id: str, code: str, claimed_email: str) -> tuple[bool, str, int]:
    """校验验证码。

    返回 (ok, 错误文案, http_status)。

    `claimed_email` 只用来和**服务端自己记下的邮箱**比对，绝不作为校验依据提交给云端
    —— 云端那一步不认邮箱，比对必须在本进程完成。
    """
    vid = str(verification_id or "").strip()
    code = str(code or "").strip()
    if not vid or not code:
        return False, "请先获取邮箱验证码。", 400
    expect, tries = _peek(vid)
    if not expect:
        return False, "验证码已过期，请重新获取。", 400
    if tries >= MAX_TRIES:
        return False, "尝试次数过多，请重新获取验证码。", 429
    if str(claimed_email or "").strip().lower() != expect:
        # 一码一邮箱：换了地址就必须重新发码。这里不把 expect 回显出去，
        # 否则等于把「这个 id 属于哪个邮箱」告诉了一个不该知道的调用方。
        return False, "验证码与当前邮箱不匹配，请重新获取。", 400
    status, body = _post("/.cloud/auth/v1/verification/verify",
                         {"verification_id": vid, "verification_code": code})
    if status == 200 and isinstance(body, dict) and body.get("verification_token"):
        _drop(vid)          # 成功才作废，避免一条码被重复使用
        return True, "", 200
    if status == 0:
        # 网络失败：此时**不能**放行，也不消耗试错次数（这是我们的问题，不是用户输错）
        return False, "邮箱验证服务暂时不可用，请稍后再试。", 503
    if status in (400, 401, 403):
        _bump(vid)
        return False, "验证码不正确或已过期，请重新获取。", 400
    diag.note("hub/cloudauth.py::confirm_code",
              RuntimeError(f"verify status={status} desc={_err_desc(body)}"))
    return False, "邮箱验证失败，请稍后重试。", 502
