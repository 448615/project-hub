"""accounts — 账号存储：本地 SQLite + 云端加密表同步、用户增删改查、角色判定、账号报表

由原 hub.py 拆分而来；修改时请注意保持与同层模块的单向依赖。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .config import ADMINS, DB_PATH, HERE
from .util import _is_loopback
from .store import DS, _get_user_by_email
from . import diag

_DB_READY = False


def _init_user_db():
    """建表 + 迁移旧库（best-effort）：云端只读/受限磁盘下不抛异常，保证服务仍能启动。"""
    global _DB_READY
    if DS is None:
        _DB_READY = False
        return
    _DB_READY = bool(DS.init_db())
    if _DB_READY:
        try:
            # 旧版 users.db（枢纽根目录）自动搬到数据处理脚本项目内
            moved = DS.migrate_legacy()
            if moved:
                print(f"[信息] 已从旧 users.db 迁移 {moved} 个账号到 {DB_PATH}")
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/accounts.py::_init_user_db", exc)
    if not _DB_READY:
        print("[warn] 账号库不可写（云端只读？）；登录读取可用，注册将不可用。")


def _create_user(username: str, email: str, pwd: str, role: str = "user") -> bool:
    """创建账号。角色由调用方显式给出（默认普通用户），不再「首个注册即管理员」。"""
    if DS is None:
        return False
    ok, _err = DS.create(username, email, pwd, role=role)
    if ok:
        _cloud_async("upsert", email, username)
    return ok


def _register_role(handler) -> str:
    """注册时给新账号的角色。

    默认一律 user。唯一的例外是「本地全新环境首次初始化」：服务跑在本机回环、
    config.json / HUB_ADMINS 里没有任何管理员、且账号库还是空的 —— 这时才让第一个
    账号成为管理员，保证开箱可用。云端（handler.cloud）与任何远程来源永远只给 user，
    避免公网抢注首个管理员。
    """
    try:
        if ADMINS or getattr(handler, "cloud", False):
            return "user"
        addr = handler.client_address[0] if handler.client_address else ""
        if not _is_loopback(addr):
            return "user"
        if DS is None or DS.count() > 0:
            return "user"
        return "admin"
    except Exception:  # noqa: BLE001
        return "user"


_init_user_db()

# --------------------------------------------------------------------------
# 云端账号副本（WorkBuddy 云数据库 hub_accounts）
# --------------------------------------------------------------------------
# serverless 沙箱磁盘不保证持久：本地 hub_accounts.db 会随冷启动回收。
# 因此账号同时写一份到云库（PostgREST），登录时本地查不到再回查云端。
# 全部为 best-effort：云端不可达不影响本地登录。


def _role_for_email(email: str) -> str:
    """邮箱命中 admins 名单 → admin；命中本地库 admin 角色 → admin；其余 user。"""
    e = (email or "").strip().lower()
    if e and e in ADMINS:
        return "admin"
    row = _get_user_by_email(e)
    if row and (row[4] or "user") == "admin":
        return "admin"
    return "user"


# --------------------------------------------------------------------------
# 登录限流：挡住在线爆破（pbkdf2 已让单次校验变慢，但并发撞库仍需拦截）
# 维度「IP+邮箱」与「IP」双计，6 次失败锁 5 分钟，窗口 10 分钟。
# 只存在内存里：单机自用足够；重启清空不会造成持久拒绝服务。


def _accounts_report(src: str = "local", reveal: bool = True) -> dict:
    """账号报表（数据处理脚本产出）。src=local 读本项目库，cloud 读云端副本。"""
    if DS is None:
        return {"ok": False, "error": "账号数据模块未加载。", "accounts": []}

    if src == "cloud":
        rows = _cloud_list_accounts()
        if rows is None:
            return {"ok": False, "error": "云端不可用（未配置或网络不通）。",
                    "source": "cloud", "accounts": []}
        items = []
        for r in rows:
            enc = r.get("pwd_enc") or ""
            mail = r.get("email") or ""
            items.append({
                "id": r.get("id"), "username": r.get("username") or "",
                "email": mail, "role": r.get("role") or "user",
                "created_at": r.get("created_at") or 0,
                "updated_at": r.get("updated_at") or 0,
                # 不再持有可逆明文副本，报表永不回显密码
                "has_plain": False,
                "password": "",
                "source": "cloud",
            })
        return {"ok": True, "source": "cloud", "db_path": "cloud:" + _CLOUD_TABLE,
                "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "total": len(items), "accounts": items}

    rep = DS.build_report(reveal=reveal)
    for a in rep.get("accounts", []):
        a["source"] = "local"
    rep["ok"] = True
    rep["source"] = "local"
    rep["cloud_available"] = bool(_cloud_cfg())
    return rep


def _accounts_update(uid: int, fields: dict) -> tuple[bool, str]:
    """改密码 / 改角色 / 删账号（本地 + 云端尽力同步）。"""
    if DS is None:
        return False, "账号数据模块未加载。"
    row = DS.get_by_id(uid)
    if not row:
        return False, "账号不存在。"
    email = row["email"]

    if "password" in fields:
        pwd = str(fields.get("password") or "")
        if len(pwd) < 6:
            return False, "密码至少 6 位。"
        if not DS.set_password(int(uid), pwd):
            return False, "密码更新失败（账号库不可写）。"
        _cloud_async("upsert", email)

    if "role" in fields:
        role = "admin" if str(fields.get("role")) == "admin" else "user"
        if not DS.set_role(int(uid), role):
            return False, "角色更新失败（账号库不可写）。"
        _cloud_async("upsert", email)

    if fields.get("delete"):
        if not DS.delete(int(uid)):
            return False, "删除失败。"
        if _cloud_cfg():
            _cloud_async("delete", email)

    return True, ""


# --------------------------------------------------------------------------
# 服务端签名会话 Cookie（本地验签，永不回源）：
# 登录成功后由本端用「仅服务端持有的会话子密钥」签发 HttpOnly 会话 Cookie，
# 后续请求服务端本地验签即可放行。密钥首次运行自动生成并持久化到 .data/secret.key，
# 重启不失效；外人无密钥无法伪造会话（含管理员会话）。
#
# 会话子密钥由主密钥经 HKDF 单独派生（label=session），与「账号加密」「云端副本
# 加密」等用途的密钥互不派生关系——任一用途密钥泄露不外溢到会话伪造。


_CLOUD_CFG_CACHE = {}


def _cloud_cfg():
    """读取 cloud.public.json（endpoint + publishableKey，均为可公开值）。"""
    if _CLOUD_CFG_CACHE:
        return _CLOUD_CFG_CACHE
    for fn in ("cloud.public.json", "cloud.json"):
        p = os.path.join(HERE, fn)
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                if cfg.get("endpoint") and cfg.get("publishableKey"):
                    _CLOUD_CFG_CACHE.update({
                        "endpoint": str(cfg["endpoint"]).rstrip("/"),
                        "key": str(cfg["publishableKey"]),
                    })
                    return _CLOUD_CFG_CACHE
        except Exception as exc:  # noqa: BLE001
            diag.note("hub/accounts.py::_cloud_cfg", exc)
            continue
    return {}


def _cloud_rest(method: str, table: str, query: str = "", body=None, timeout: float = 8.0):
    """调用云数据库 REST。返回 (ok, data_or_error)。无代理、HTTPS。"""
    cfg = _cloud_cfg()
    if not cfg:
        return False, "未配置云端"
    url = f"{cfg['endpoint']}/.cloud/database/rest/{table}{query}"
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-wb-webapp-access-key", cfg["key"])
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    if method in ("POST", "PATCH"):
        req.add_header("Prefer", "resolution=merge-duplicates,return=representation")
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
        return True, (json.loads(raw) if raw.strip() else [])
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


# 云端表：hub_accounts_enc（整条记录加密，库里没有明文邮箱/密码/哈希）
# 为什么整条加密而不是只加密密码：云库的 RLS 对 anon 开放（单租户自用的定位），
# 拿到公开 publishableKey 就能读表。若存明文邮箱/哈希，一次拖库等于拿到全部账号
# 名单 + 可离线爆破的哈希。现在落库的只有「HMAC 索引 + 密文 + 完整性签名」，
# 没有 secret.key 时读到的是一堆无意义字节。


_CLOUD_TABLE = "hub_accounts_enc"


def _cloud_index(email: str) -> str:
    """邮箱 → 确定性不可逆索引（HMAC），用于按邮箱查行而不必存明文邮箱。"""
    k = DS.subkey("cloud:index") if DS is not None else b""
    if not k:
        return ""
    mac = hmac.new(k, str(email or "").strip().lower().encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")


def _cloud_sig(idx: str, blob: str, updated_at) -> str:
    k = DS.subkey("cloud:sig") if DS is not None else b""
    if not k:
        return ""
    msg = f"{idx}|{blob}|{updated_at}".encode("utf-8")
    return base64.urlsafe_b64encode(hmac.new(k, msg, hashlib.sha256).digest()).rstrip(b"=").decode("ascii")


def _cloud_seal(record: dict) -> dict | None:
    """记录 → {email_idx, blob, sig, updated_at}；密钥不可用返回 None。"""
    if DS is None:
        return None
    email = str(record.get("email") or "").strip().lower()
    idx = _cloud_index(email)
    if not idx:
        return None
    body = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    blob = DS.aead_encrypt(body, aad=("cloud:" + idx).encode("utf-8"), label="cloud")
    if not blob:
        return None
    updated = float(record.get("updated_at") or time.time())
    row = {"email_idx": idx, "blob": blob, "sig": _cloud_sig(idx, blob, updated),
           "updated_at": updated}
    return row


def _cloud_open(row: dict) -> dict | None:
    """云端行 → 记录。签名不符 / 解密失败一律丢弃（防篡改与伪造行）。"""
    if DS is None or not isinstance(row, dict):
        return None
    idx, blob, sig = row.get("email_idx") or "", row.get("blob") or "", row.get("sig") or ""
    if not idx or not blob:
        return None
    if sig and not hmac.compare_digest(sig, _cloud_sig(idx, blob, row.get("updated_at"))):
        print(f"[warn] 云端账号行签名不符，已忽略：{idx[:12]}…")
        return None
    raw = DS.aead_decrypt(blob, aad=("cloud:" + idx).encode("utf-8"), label="cloud")
    if not raw:
        return None
    try:
        rec = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(rec, dict):
        return None
    rec.setdefault("id", row.get("id"))
    return rec


def _cloud_upsert_account(email: str, username: str = "") -> bool:
    """把本地账号以密文形式同步到云库（按 email_idx 冲突合并）。失败静默。"""
    if DS is None or not _cloud_cfg():
        return False
    row = DS.get_by_email(email)
    if not row:
        return False
    rec = {
        "id": row["id"],
        "username": row["username"] or username or str(email).split("@")[0],
        "email": row["email"],
        # 云端副本存的是「明文哈希段」：blob 本身已整体加密，且这样冷启动后即使
        # 本机哈希子密钥变了，云回查登录依然可校验（不依赖第二个密钥）。
        "pwd_hash": DS.raw_hash(email) or "",
        "pwd_enc": row["pwd_enc"] or "",
        "role": row["role"] or "user",
        "created_at": row["created_at"] or time.time(),
        "updated_at": time.time(),
    }
    sealed = _cloud_seal(rec)
    if not sealed:
        return False
    ok, _res = _cloud_rest("POST", _CLOUD_TABLE, "?on_conflict=email_idx", sealed)
    return ok


# --------------------------------------------------------------------------
# 云端同步异步化：注册 / 改密码 / 改角色 / 删账号不再等云端
# --------------------------------------------------------------------------
# 原实现直接在请求线程里调云端（超时 8s）。云端慢或不通时，用户点"注册"会卡在
# 转圈上，最坏 8 秒才返回——而这一步的结果对用户毫无意义（本地已经写入成功）。
# 改成单线程后台队列：请求立即返回，同步动作按顺序在后台重试一次。
# 队列满（连续堆积）时直接丢弃：本地才是权威数据源，云副本丢了可 _cloud_sync_all() 补。

_CLOUD_Q: "queue.Queue" = queue.Queue(maxsize=256)
_CLOUD_WORKER = {"t": None}
_CLOUD_WORKER_LOCK = threading.Lock()


def _cloud_worker_loop():
    while True:
        kind, email, username = _CLOUD_Q.get()
        try:
            if kind == "delete":
                idx = _cloud_index(email)
                if idx:
                    _cloud_rest("DELETE", _CLOUD_TABLE, f"?email_idx=eq.{urllib.parse.quote(idx)}")
            else:
                _cloud_upsert_account(email, username)
        except Exception:  # noqa: BLE001
            pass          # 后台同步失败不影响任何用户可见行为
        finally:
            _CLOUD_Q.task_done()


def _cloud_async(kind: str, email: str, username: str = "") -> None:
    """把一次云端同步排进后台队列（立刻返回，不等网络）。"""
    if not _cloud_cfg():
        return
    with _CLOUD_WORKER_LOCK:
        t = _CLOUD_WORKER.get("t")
        if t is None or not t.is_alive():
            t = threading.Thread(target=_cloud_worker_loop, name="hub-cloud-sync", daemon=True)
            t.start()
            _CLOUD_WORKER["t"] = t
    try:
        _CLOUD_Q.put_nowait((kind, str(email or ""), username or ""))
    except queue.Full:
        pass


def _cloud_find_account(email: str):
    """云端按邮箱查账号（用 HMAC 索引查询，不暴露邮箱）。返回记录 dict 或 None。"""
    if not _cloud_cfg():
        return None
    idx = _cloud_index(email)
    if not idx:
        return None
    q = f"?select=id,email_idx,blob,sig,updated_at&email_idx=eq.{urllib.parse.quote(idx)}&limit=1"
    ok, data = _cloud_rest("GET", _CLOUD_TABLE, q)
    if ok and isinstance(data, list) and data:
        return _cloud_open(data[0])
    return None


def _cloud_list_accounts():
    """云端账号清单（逐条解密）；不可用返回 None（区别于空列表）。"""
    if not _cloud_cfg():
        return None
    ok, data = _cloud_rest("GET", _CLOUD_TABLE, "?select=id,email_idx,blob,sig,updated_at&order=id.asc&limit=500")
    if not ok or not isinstance(data, list):
        return None
    out = []
    for row in data:
        rec = _cloud_open(row)
        if rec:
            out.append(rec)
    return out


def _cloud_sync_all() -> int:
    """把本地全部账号推成云端密文副本（幂等）。返回成功条数。"""
    if DS is None:
        return 0
    n = 0
    for row in DS.list_accounts(reveal=False):
        if _cloud_upsert_account(row["email"], row["username"]):
            n += 1
    return n


def _cloud_create_account(username: str, email: str, pwd: str):
    """云端直接建号（本地盘只读时兜底）。返回 (ok, 错误说明)。"""
    if DS is None or not _cloud_cfg():
        return False, "云端未配置"
    if _cloud_find_account(email):
        return False, "该邮箱已注册。"
    # 角色一律普通用户：原来这里用 `not (_cloud_list_accounts() or [])` 判「首个即管理员」，
    # 而云端列表抓取失败会返回 None，`None or []` → 空 → 判成管理员（fail-open）。
    # 管理员身份只认 config.json 的 admins 白名单 / 本地库的 role 字段。
    role = "user"
    now = time.time()
    rec = {
        "id": None,
        "username": username or str(email).split("@")[0],
        "email": str(email).strip().lower(),
        "pwd_hash": DS.hash_pwd(pwd),
        # 不再存可逆明文副本（与本地库一致）：拿到 secret.key 就能解出全部密码，风险过大
        "pwd_enc": "",
        "role": role, "created_at": now, "updated_at": now,
    }
    sealed = _cloud_seal(rec)
    if not sealed:
        return False, "云端密钥不可用，无法加密写入。"
    ok, res = _cloud_rest("POST", _CLOUD_TABLE, "", sealed)
    if not ok:
        return False, str(res)
    return True, ""


# 服务端签名会话 Cookie 名（登录成功后由本端用 SECRET_KEY 签名）。


# --------------------------------------------------------------------------
# 子项目说明自动提取：从 README / package.json / pyproject.toml 取一句话
# --------------------------------------------------------------------------
