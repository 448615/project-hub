"""security — 安全基础设施：密钥加载、口令哈希、会话签名与 Cookie、登录限速、CSP

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import secrets

from .config import KEY_PATH, _KEY_DIR, _SESSION_TTL
from .store import DS
from . import diag

def _load_secret_key() -> bytes:
    """加载会话签名密钥。

    来源优先级：
      1) 环境变量 HUB_SECRET_KEY / SECRET_KEY（云端首选）：无状态沙箱冷启动时
         .data/secret.key 可能丢失，导致重启后所有会话失效、云端密文副本 AEAD 解密失败。
         把密钥放在环境变量/挂载密钥里，重启与扩容后保持稳定，彻底规避该风险。
      2) 本地文件 .data/secret.key：首次运行自动生成并持久化（重启不失效）。
    """
    # 1) 云端优先读环境变量；支持十六进制或 base64（64 字节）
    env_key = os.environ.get("HUB_SECRET_KEY") or os.environ.get("SECRET_KEY")
    if env_key:
        try:
            import re as _re
            if _re.fullmatch(r"[0-9a-fA-F]{64}", env_key):
                return bytes.fromhex(env_key)
            raw = base64.b64decode(env_key, validate=True)
            if len(raw) >= 32:
                return raw[:64] if len(raw) >= 64 else raw.ljust(64, b"\x00")
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/security.py::_load_secret_key(env)", exc)
    # 2) 本地：首次运行自动生成并持久化，重启不失效
    try:
        os.makedirs(_KEY_DIR, exist_ok=True)
        if os.path.isfile(KEY_PATH):
            with open(KEY_PATH, "rb") as f:
                return f.read(64)
    except Exception as exc:  # noqa: BLE001
        diag.note("hub/security.py::_load_secret_key", exc)
    key = secrets.token_bytes(64)
    try:
        with open(KEY_PATH, "wb") as f:
            f.write(key)
        os.chmod(KEY_PATH, 0o600)
    except Exception as e:  # noqa: BLE001
        # P1 修复：密钥写不进磁盘 → 重启后会话全部失效、且每次启动换密钥。仅 print 在云端不可见。
        print(f"[warn] 写入密钥文件失败（仅本进程有效）：{e}")
        diag.note("hub/security.py::_load_secret_key", e)
    return key


SECRET_KEY = _load_secret_key()


def _hash_password(pwd: str) -> str:
    """pbkdf2_hmac + 每用户随机盐。委托 data_store。"""
    return DS.hash_pwd(pwd)


def _check_password(pwd: str, stored: str, email: str = "") -> bool:
    """校验密码。stored 可能是加密后的哈希，需带邮箱（aad 绑定）才能解开。"""
    return DS.check_pwd(pwd, stored, email)


def _session_key() -> bytes:
    k = DS.subkey("session") if DS is not None else b""
    if k:
        return k
    # 极端降级（data_store 加载失败）：退回主密钥直接签署，保证仍能登录
    return SECRET_KEY


# ---- 内置浏览器的代理密钥 -------------------------------------------------
# 为什么需要它：代理页必须被降级成「不透明源」（iframe 不给 allow-same-origin），
# 否则目标站点的 JS 与枢纽同源，可以直接 fetch('/api/exec') 以登录用户身份执行
# 任意命令。降级之后浏览器不再自动带 Cookie，于是改成「URL 里带一个短期密钥」
# 给 /browse/* 用。密钥只对 /browse 有效，拿去打 /api/* 一律 401。


_BROWSE_KEY_TTL = 1800.0          # 30 分钟一档，跨档校验前后各一档


def _browse_key() -> str:
    slot = int(time.time() // _BROWSE_KEY_TTL)
    sig = hmac.new(_session_key(), f"browse|hub|{slot}".encode("utf-8"),
                   hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")[:22]


def _browse_key_ok(key: str) -> bool:
    k = (key or "").strip()
    if not k or len(k) > 64:
        return False
    slot = int(time.time() // _BROWSE_KEY_TTL)
    for s in (slot, slot - 1):    # 允许跨档（刚过整点不至于立刻失效）
        sig = hmac.new(_session_key(), f"browse|hub|{s}".encode("utf-8"),
                       hashlib.sha256).digest()
        cand = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")[:22]
        if hmac.compare_digest(cand, k):
            return True
    return False


def _mint_session(email: str, sub: str) -> str:
    now = int(time.time())
    payload = {"v": 2, "email": str(email or "").strip().lower(), "sub": str(sub or ""),
               "iat": now, "exp": now + int(_SESSION_TTL)}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    body = body.rstrip(b"=").decode("ascii")
    sig = hmac.new(_session_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return body + "." + sig


def _verify_session(tok: str):
    """验签 + 校验有效期。任何字段不合法一律视为无效会话（失败关闭）。"""
    if not tok or "." not in tok:
        return None
    try:
        body, sig = tok.rsplit(".", 1)
        calc = hmac.new(_session_key(), body.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(calc, sig):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if not isinstance(payload, dict):
            return None
        exp = payload.get("exp")
        iat = payload.get("iat") or 0
        if not isinstance(exp, (int, float)) or exp <= time.time():
            return None
        # iat 不许来自未来太多（时钟漂移容差 5 分钟），也绝不接受超长有效期
        if iat > time.time() + 300 or exp - iat > _SESSION_TTL + 60:
            return None
        if not str(payload.get("email") or ""):
            return None
        return payload
    except Exception:  # noqa: BLE001
        return None


def _is_https_request(self) -> bool:
    """判断当前请求是否经 HTTPS 到达（云端反代用 X-Forwarded-Proto 告知）。"""
    try:
        if (self.headers.get("X-Forwarded-Proto", "") or "").split(",")[0].strip().lower() == "https":
            return True
        return bool(getattr(self.server, "is_https", False))
    except Exception:  # noqa: BLE001
        return False


def _mint_session_cookie(email: str, sub: str, secure: bool = False) -> str:
    tok = _mint_session(email, sub)
    parts = [f"{_SESSION_COOKIE_NAME}={tok}", "Path=/", f"Max-Age={int(_SESSION_TTL)}",
             "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def _clear_session_cookie(secure: bool = False) -> str:
    parts = [f"{_SESSION_COOKIE_NAME}=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


_SESSION_COOKIE_NAME = "hub_sess"


_LOGIN_LOCK = threading.Lock()


_LOGIN_FAILS: dict[str, list] = {}


# --------------------------------------------------------------------------
# 登录限流策略：唯一真源是项目根的 auth-policy.json（与星枢共用同一份）
# --------------------------------------------------------------------------
# 为什么不再把数字写死在代码里：枢纽与星枢此前各有各的阈值（6 次/10 分钟 vs
# 10 次/5 分钟），同一个系统里两套规则，攻击者挑宽松的那个入口试即可。把数字
# 收进一份带说明的配置，两端读同一份，改一处同时生效。
# 读取失败必须回退而不是崩：限流退化总好过整站登录不可用。回退值与 JSON 内的
# 值必须一致，否则「文件丢了」会静默变成另一套策略——有跨语言一致性测试守着。
_POLICY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "auth-policy.json"
)
_DEFAULT_POLICY = {
    "loginAccount": {"windowSec": 600, "maxFails": 6, "blockSec": 300},
    "loginIpCoarse": {"windowSec": 300, "maxFails": 200, "blockSec": 0},
    "register": {"windowSec": 3600, "maxFails": 5, "blockSec": 0},
}


def _clean_section(raw, fallback: dict) -> dict:
    """校验一节策略；任一字段非法就整节回退，避免出现「窗口半新半旧」的组合。"""
    if not isinstance(raw, dict):
        return dict(fallback)
    try:
        window = raw["windowSec"]
        maxf = raw["maxFails"]
        block = raw.get("blockSec", 0)
    except KeyError:
        return dict(fallback)
    for v in (window, maxf, block):
        if not isinstance(v, int) or isinstance(v, bool):
            return dict(fallback)
    if window <= 0 or maxf < 1 or block < 0:
        return dict(fallback)
    return {"windowSec": window, "maxFails": maxf, "blockSec": block}


def load_auth_policy(path: str | None = None) -> dict:
    """读取 auth-policy.json；缺文件/坏 JSON/字段非法一律按节回退到默认值。"""
    target = path or _POLICY_PATH
    loaded: dict = {}
    try:
        with open(target, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict):
            raise ValueError("auth-policy.json 顶层必须是对象")
    except FileNotFoundError:
        loaded = {}
        print(f"[warn] 未找到 auth-policy.json（{target}），登录限流使用内置默认值")
    except Exception as exc:  # noqa: BLE001
        loaded = {}
        print(f"[warn] auth-policy.json 解析失败，登录限流使用内置默认值：{exc}")
        diag.note("hub/security.py::load_auth_policy", exc)
    return {k: _clean_section(loaded.get(k), v) for k, v in _DEFAULT_POLICY.items()}


AUTH_POLICY = load_auth_policy()

_LOGIN_MAX_FAILS = int(AUTH_POLICY["loginAccount"]["maxFails"])


_LOGIN_WINDOW = float(AUTH_POLICY["loginAccount"]["windowSec"])


_LOGIN_BLOCK = float(AUTH_POLICY["loginAccount"]["blockSec"])


def _login_gate(key: str) -> float:
    """返回剩余封禁秒数；0 表示可继续尝试。"""
    now = time.time()
    with _LOGIN_LOCK:
        rec = _LOGIN_FAILS.get(key)
        if not rec:
            return 0.0
        cnt, first, until = rec
        if until and until > now:
            return until - now
        if now - first > _LOGIN_WINDOW:
            _LOGIN_FAILS.pop(key, None)
        return 0.0


def _login_note(key: str, ok: bool) -> None:
    now = time.time()
    with _LOGIN_LOCK:
        if ok:
            _LOGIN_FAILS.pop(key, None)
            return
        rec = _LOGIN_FAILS.get(key)
        if not rec or now - rec[1] > _LOGIN_WINDOW:
            _LOGIN_FAILS[key] = [1, now, 0.0]
        else:
            rec[0] += 1
            if rec[0] >= _LOGIN_MAX_FAILS:
                rec[0] = 0
                rec[1] = now
                rec[2] = now + _LOGIN_BLOCK
        # 内存上限：表格被恶意刷爆时整体清理最老的一批
        if len(_LOGIN_FAILS) > 4096:
            for k in list(_LOGIN_FAILS)[:1024]:
                _LOGIN_FAILS.pop(k, None)


# --------------------------------------------------------------------------
# 通用频率闸门：统计「所有尝试」，不区分成功失败
# --------------------------------------------------------------------------
# 与上面的 _login_gate/_login_note 是两套语义，不能混用：
#   登录那套是「失败计数 + 达到阈值就封禁」，恢复靠一次成功登录清零；
#   这里统计的是总尝试次数，用于注册、取验证码这类没有「成功」可言的入口——
#   把注册也套上 6 次就封 5 分钟，等于用户填错三次验证码就被锁一小时，不可接受。
_RATE_LOCK = threading.Lock()
_RATE_HITS: dict[str, list] = {}


def rate_hit(key: str, limit: int, window: float) -> float:
    """记一次尝试；超过 limit 时返回还需等待的秒数，放行则返回 0。"""
    now = time.time()
    with _RATE_LOCK:
        rec = _RATE_HITS.get(key)
        if not rec or now - rec[1] > window:
            _RATE_HITS[key] = [1, now]
            if len(_RATE_HITS) > 4096:
                for k in list(_RATE_HITS)[:1024]:
                    _RATE_HITS.pop(k, None)
            return 0.0
        rec[0] += 1
        if rec[0] > limit:
            return max(1.0, rec[1] + window - now)
        return 0.0


def reset_rate_for_test() -> None:
    """仅供测试：清空频率表（否则用例之间会互相计数）。"""
    with _RATE_LOCK:
        _RATE_HITS.clear()


def _build_csp() -> str:
    """内容安全策略：
    - 脚本仅同源（页面不含任何第三方脚本；原自托管云 SDK 已于 v56 随面板下线删除）。
    - connect-src 放行云数据平面域名（云端同源时 'self' 已覆盖；本地开发时跨源需显式放行，
      账号云端同步仍由服务端发起，浏览器侧不直连）。
    """
    return (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self'; object-src 'none'; "
        "connect-src 'self' https://phub.app.workbuddy.host https://*.workbuddy.host; "
        "frame-src 'self' http://127.0.0.1:* http://localhost:* https: http:; "
        "base-uri 'self'; frame-ancestors 'none'"
    )


CSP_HEADER = _build_csp()

# 云端公开配置（可安全暴露：publishableKey 仅标识应用，服务端按 Origin 校验，无权限）
