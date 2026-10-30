"""handlers.auth_post — POST · 账号体系（登录 / 注册 / 发码 / 登出）

免登录闸门：这四个接口在鉴权之前分流，自带校验与限流。
账号与密码哈希全部落在本机/云库，会话 Cookie 由本端用 SECRET_KEY 签名，
后续请求本地验签即可放行，不回源。

唯一的云端依赖是**注册时的邮箱验证码**（hub/cloudauth.py）：密码、账号、会话
都不经过云端，云端只负责「把一串码发到那个邮箱」和「这串码对不对」。没配云服务
时自动退回图形验证码，本地仍可注册。
由 handlers/api_post.py 的 _do_post_impl 拆分而来。
"""
from __future__ import annotations

import re

from ..store import DS, _get_user_by_email
from ..security import (
    _check_password,
    _clear_session_cookie,
    _is_https_request,
    _login_gate,
    _login_note,
    _mint_session_cookie,
    rate_hit,
)
from ..accounts import (
    _cloud_create_account,
    _cloud_find_account,
    _create_user,
    _register_role,
    _reset_password,
    _role_for_email,
)
from ..captcha import verify_token
from .. import cloudauth
from .. import diag


# 服务端独立的邮箱格式校验。前端那份不可信（curl 直接发 POST 就绕过了），
# 而邮箱是账号主键：格式漏进脏数据后，后台按邮箱改密、查角色都会对不上人。
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

# 验证码失败原因 → 用户能看懂的话。分开写而不是统一一句「验证码错误」：
# 「过期」和「输错」对用户是两种完全不同的动作（等一会再试 vs 重看一遍图）。
_CAPTCHA_ERRORS = {
    "bad": "验证码不正确，请重新输入。",
    "expired": "验证码已过期，请点击图片换一张。",
    "used": "验证码已使用过，请点击图片换一张。",
    "malformed": "验证码无效，请点击图片换一张。",
}


def _login_keys(ip: str, email: str) -> tuple:
    """登录限流用到的三个桶键，按「从最细到最粗」排列。

    单独抽成函数是为了能被测试直接锁定：这三个键的组成方式就是限流强度本身，
    少一个键（历史上曾缺 email:）等于某个维度完全没有计数，而在代码里几乎看不出来。

      pair  = IP + 邮箱 —— 同一出口盯同一个账号
      email = 仅邮箱     —— 换出口盯同一个账号（不怕伪造 X-Forwarded-For）
      ip    = 仅 IP      —— 同一出口横扫多个账号
    """
    return ("pair:" + ip + "|" + email, "email:" + email, "ip:" + ip)


class AuthPostMixin:

    def _post_login(self):
        body = self._read_body()
        email = str(body.get("email") or "").strip().lower()
        pwd = str(body.get("password") or "")
        if not email or not pwd:
            self._send_json({"ok": False, "error": "请输入邮箱和密码。"}, status=400)
            return
        # 限流：防在线撞库（pbkdf2 让单次校验变慢，但并发尝试仍需拦）
        # 三个桶取最大剩余封禁时间，相比原来的两个桶只增不减：
        #   pair  = IP + 邮箱 —— 同一出口盯同一个账号
        #   email = 仅邮箱     —— 换出口盯同一个账号（与星枢同维度）
        #   ip    = 仅 IP      —— 同一出口横扫多个账号
        # 原来只有 pair 与 ip：攻击者每换一个出口 IP，pair 桶就是新的空桶，ip 桶也
        # 各自只攒 1 次，于是"盯住一个账号反复猜"这件事在账号维度上完全没被计数。
        # 这正是星枢 S-04 已修的同类缺陷在枢纽侧的残留。
        _ip = self._client_ip()
        _keys = _login_keys(_ip, email)
        _wait = max(_login_gate(k) for k in _keys)
        if _wait > 0:
            # Retry-After 与星枢对齐：客户端/网关据此退避，而不是盲目重试
            self._send_json({"ok": False,
                             "error": f"尝试过于频繁，请 {int(_wait) + 1} 秒后再试。"},
                            status=429,
                            headers={"Retry-After": str(max(1, int(_wait)))})
            return
        try:
            row = _get_user_by_email(email)
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": f"账号库读取失败：{e}"}, status=503)
            return
        # 本地无此账号 / 密码不符 → 回查云端副本（serverless 冷启动会把本地库清空）
        ok_local = bool(row) and _check_password(pwd, row[3], email)
        if not ok_local:
            cloud_row = _cloud_find_account(email)
            if cloud_row and _check_password(pwd, cloud_row.get("pwd_hash") or "", email):
                email = str(cloud_row.get("email") or email).lower()
                sub = str(cloud_row.get("id") or email)
                # 本地缓存一份，后续请求不再依赖云端
                try:
                    if DS is not None and not DS.get_by_email(email):
                        # 本地缓存副本沿用云端记录里的角色，否则管理员会被缓存成普通用户
                        DS.create(cloud_row.get("username") or email.split("@")[0], email, pwd,
                                  role=str(cloud_row.get("role") or "user"))
                except Exception as exc:  # noqa: BLE001
                    diag.note("hub/handlers/auth_post.py::_post_login", exc)
                for _k in _keys:
                    _login_note(_k, True)
                cookie = _mint_session_cookie(email, sub, _is_https_request(self))
                print(f"[auth] 登录成功（云端账号）：{email}")
                self._send_json_with_cookie({"ok": True, "email": email,
                                             "role": _role_for_email(email), "cloud": True}, cookie)
                return
            for _k in _keys:
                _login_note(_k, False)
            self._send_json({"ok": False, "error": "邮箱或密码错误。"}, status=401)
            return
        email = row[2]
        for _k in _keys:
            _login_note(_k, True)
        cookie = _mint_session_cookie(email, str(row[0]), _is_https_request(self))
        print(f"[auth] 登录成功：{email}")
        self._send_json_with_cookie({"ok": True, "email": email,
                                     "role": _role_for_email(email), "cloud": self.cloud}, cookie)

    def _post_register_code(self):
        """发一封真的验证码邮件到用户邮箱。

        与注册分开两个接口，是因为两者的闸门不同：
          · 发信是最贵的动作（真实邮件成本 + 会打扰收件人），必须先过图形验证码；
          · 注册只是提交结果，凭的是邮件里那串码。
        合成一个接口的话，就得在「还没证明是人」之前先发信。"""
        body = self._read_body()
        email = str(body.get("email") or "").strip().lower()
        # 字段别名同 _post_register：两个名字都收，避免前端改名后静默失效。
        cap_token = str(body.get("captchaId") or body.get("captchaToken") or "")
        cap_code = str(body.get("captcha") or body.get("captchaCode") or "")

        if not cloudauth.configured():
            self._send_json({"ok": False,
                             "error": "当前环境没有配置邮件服务，无法发送验证码。"},
                            status=503)
            return

        # 1) 三道限流桶。发信接口如果只按 IP 限，换 IP 就能继续给别人发邮件；
        #    所以必须再加一条按邮箱的桶，让「同一个地址」无论从哪来都发不出去太多封。
        #    IP 桶给到 12 次而不是卡在 5：认错两三张图是常事，不该因此锁人 10 分钟。
        _ip = self._client_ip()
        _wait = max(rate_hit("regcode:ip:" + _ip, 12, 600.0),
                    rate_hit("regcode:all", 60, 600.0),
                    rate_hit("regcode:em:" + email, 3, 600.0))
        if _wait > 0:
            self._send_json({"ok": False,
                             "error": f"验证码发送过于频繁，请 {int(_wait) + 1} 秒后再试。"},
                            status=429,
                            headers={"Retry-After": str(max(1, int(_wait)))})
            return

        if not email or not _EMAIL_RE.match(email):
            self._send_json({"ok": False, "error": "请输入有效的邮箱地址。"}, status=400)
            return

        # 2) 图形验证码在发信之前：它是「这是人点的」的唯一凭据。
        _cap_ok, _cap_why = verify_token(cap_token, cap_code)
        if not _cap_ok:
            self._send_json({"ok": False, "captcha": True,
                             "error": _CAPTCHA_ERRORS.get(_cap_why, "验证码不正确，请重新输入。")},
                            status=400)
            return

        # 3) 已注册就不再发信：省一封邮件，也堵住「拿这个接口给已注册用户刷邮件」。
        #    枚举风险由第 2 步的图形验证码兜着——每探一次都得先认一张图。
        try:
            _exists = _get_user_by_email(email) is not None
        except Exception:  # noqa: BLE001
            _exists = False
        if not _exists:
            try:
                _exists = _cloud_find_account(email) is not None
            except Exception:  # noqa: BLE001
                _exists = False
        if _exists:
            self._send_json({"ok": False, "error": "该邮箱已注册，请直接登录。"}, status=409)
            return

        ok, vid, why, st = cloudauth.request_code(email)
        if not ok:
            self._send_json({"ok": False, "error": why}, status=st)
            return
        self._send_json({"ok": True, "verificationId": vid,
                         "cooldown": int(cloudauth.SEND_COOLDOWN)})

    def _post_register(self):
        body = self._read_body()
        username = str(body.get("username") or "").strip()
        email = str(body.get("email") or "").strip().lower()
        pwd = str(body.get("password") or "")
        # 前端字段名是 captchaId + captcha；两个别名都收，避免前端改名后静默失效——
        # 静默失效在这里的含义是「验证码形同虚设」，不会有任何报错提示。
        cap_token = str(body.get("captchaId") or body.get("captchaToken") or "")
        cap_code = str(body.get("captcha") or body.get("captchaCode") or "")

        # 1) 频率闸门。注册是免登录接口，不设闸门就等于开了一台免费账号制造机：
        #    验证码只保证「这一下是人点的」，挡不住同一个人挂着脚本点一万次。
        #    双桶：reg:ip 挡单点猛刷；reg:all 挡换 IP 慢刷——IP 取自 XFF 首跳，可伪造，
        #    所以必须有一条不依赖 IP 的兜底（单机单用户系统，40 次/10 分钟远超真人需求）。
        _ip = self._client_ip()
        _wait = max(rate_hit("reg:ip:" + _ip, 10, 600.0),
                    rate_hit("reg:all", 40, 600.0))
        if _wait > 0:
            self._send_json({"ok": False,
                             "error": f"注册请求过于频繁，请 {int(_wait) + 1} 秒后再试。"},
                            status=429,
                            headers={"Retry-After": str(max(1, int(_wait)))})
            return

        # 2) 格式校验放在验证码之前：格式错不该消耗掉用户刚认对的那张图。
        #    后端必须独立校验邮箱格式——前端校验不可信，而邮箱是账号主键，
        #    放个 "随便写" 进来，将来「联系管理员重设密码」时连账号都对不上。
        if not email or not _EMAIL_RE.match(email):
            self._send_json({"ok": False, "error": "请输入有效的邮箱地址。"}, status=400)
            return
        if len(pwd) < 6:
            self._send_json({"ok": False, "error": "密码至少 6 位。"}, status=400)
            return

        # 3) 凭据校验。分两条路：
        #    配了云服务 → 邮箱验证码（证明「这个邮箱是你的」，比图形码强一个量级：
        #    图形码只证明「这是人」）；没配 → 退回图形验证码，保证离线/自托管仍可注册。
        if cloudauth.configured():
            _vid = str(body.get("verificationId") or body.get("verification_id") or "")
            _code = str(body.get("code") or body.get("emailCode") or "").strip()
            _ok, _why, _st = cloudauth.confirm_code(_vid, _code, email)
            if not _ok:
                self._send_json({"ok": False, "emailCode": True, "error": _why}, status=_st)
                return
        else:
            # 图形验证码。无论答案对错，令牌都在 verify_token 内部作废，
            # 所以失败响应带 captcha:true，前端据此换图——不换的话用户会盯着一张死图反复输。
            _cap_ok, _cap_why = verify_token(cap_token, cap_code)
            if not _cap_ok:
                self._send_json({"ok": False, "captcha": True,
                                 "error": _CAPTCHA_ERRORS.get(_cap_why, "验证码不正确，请重新输入。")},
                                status=400)
                return
        try:
            created = _create_user(username or email.split("@")[0], email, pwd,
                                   role=_register_role(self))
        except Exception:  # noqa: BLE001
            created = False
        if not created:
            # 本地盘只读（云端 serverless）→ 直接写云库；已注册则 409
            ok_cloud, err = _cloud_create_account(username or email.split("@")[0], email, pwd)
            if not ok_cloud:
                self._send_json({"ok": False, "error": err or "该邮箱已注册，请直接登录。"}, status=409)
                return
        try:
            row = _get_user_by_email(email)
        except Exception:  # noqa: BLE001
            row = None
        sub = str(row[0]) if row else email
        cookie = _mint_session_cookie(email, sub, _is_https_request(self))
        print(f"[auth] 注册成功：{email}")
        self._send_json_with_cookie({"ok": True, "email": email,
                                     "role": _role_for_email(email), "cloud": self.cloud}, cookie)

    def _post_reset_code(self):
        """给「找回密码」发一封验证码邮件。

        为什么不和注册发码共用一个接口：闸门方向相反。注册要求「这个邮箱还没注册」，
        找回要求「这个邮箱必须已注册」。塞进一个函数就得问两次账号库，拒绝时也说不清
        是哪条规则拦的，前端只能给一句含糊的失败提示。
        """
        body = self._read_body()
        email = str(body.get("email") or "").strip().lower()
        cap_token = str(body.get("captchaId") or body.get("captchaToken") or "")
        cap_code = str(body.get("captcha") or body.get("captchaCode") or "")

        if not cloudauth.configured():
            self._send_json({"ok": False,
                             "error": "当前环境未配置邮件服务，无法自助找回，请联系管理员重设密码。"},
                            status=503)
            return

        # 三桶限流，与注册发码同构：IP 挡单点猛刷，email 挡换 IP 死盯一个地址，
        # all 兜住「IP 可伪造」这件事（单机单用户，60 封/10 分钟远高于真人需求）。
        _ip = self._client_ip()
        _wait = max(rate_hit("rescode:ip:" + _ip, 12, 600.0),
                    rate_hit("rescode:all", 60, 600.0),
                    rate_hit("rescode:em:" + email, 3, 600.0))
        if _wait > 0:
            self._send_json({"ok": False,
                             "error": f"验证码发送过于频繁，请 {int(_wait) + 1} 秒后再试。"},
                            status=429,
                            headers={"Retry-After": str(max(1, int(_wait)))})
            return

        if not email or not _EMAIL_RE.match(email):
            self._send_json({"ok": False, "error": "请输入有效的邮箱地址。"}, status=400)
            return

        # 发信前先过图形码：发信是最贵、也是唯一会打扰到别人的动作
        _cap_ok, _cap_why = verify_token(cap_token, cap_code)
        if not _cap_ok:
            self._send_json({"ok": False, "captcha": True,
                             "error": _CAPTCHA_ERRORS.get(_cap_why, "验证码不正确，请重新输入。")},
                            status=400)
            return

        # 账号必须存在，否则发出去的信没有意义。
        # 这里直接说「尚未注册」不算新增泄露：注册发码接口本来就会回
        # 「该邮箱已注册」，能探的早就探到了；反过来说，含糊其辞只会让用户
        # 以为是系统坏了，反复重发邮件。
        try:
            _exists = _get_user_by_email(email) is not None
        except Exception:  # noqa: BLE001
            _exists = False
        if not _exists:
            try:
                _exists = _cloud_find_account(email) is not None
            except Exception:  # noqa: BLE001
                _exists = False
        if not _exists:
            self._send_json({"ok": False, "error": "该邮箱尚未注册，请先注册。"}, status=404)
            return

        ok, vid, why, st = cloudauth.request_code(email)
        if not ok:
            self._send_json({"ok": False, "error": why}, status=st)
            return
        self._send_json({"ok": True, "verificationId": vid,
                         "cooldown": int(cloudauth.SEND_COOLDOWN)})

    def _post_reset(self):
        """凭邮箱验证码重设密码，成功后直接登录。

        这里**必须**是邮箱验证码，不能像注册那样在没配云服务时退回图形验证码：
        图形码只证明「这是人」，证明不了「这个邮箱是你的」。若允许图形码改密，
        任何知道你邮箱的人都能把密码改掉 —— 那不叫找回，叫接管。
        所以云端不可用时的正确行为是明确拒绝，而不是降级放行。
        """
        body = self._read_body()
        email = str(body.get("email") or "").strip().lower()
        pwd = str(body.get("password") or "")
        _vid = str(body.get("verificationId") or body.get("verification_id") or "")
        _code = str(body.get("code") or body.get("emailCode") or "").strip()

        # 免登录的写操作：双桶限流，与注册同量级
        _ip = self._client_ip()
        _wait = max(rate_hit("reset:ip:" + _ip, 10, 600.0),
                    rate_hit("reset:all", 40, 600.0))
        if _wait > 0:
            self._send_json({"ok": False,
                             "error": f"找回请求过于频繁，请 {int(_wait) + 1} 秒后再试。"},
                            status=429,
                            headers={"Retry-After": str(max(1, int(_wait)))})
            return

        # 格式与长度先校验：格式错不该白消耗一次验证码的试错次数
        if not email or not _EMAIL_RE.match(email):
            self._send_json({"ok": False, "error": "请输入有效的邮箱地址。"}, status=400)
            return
        if len(pwd) < 6:
            self._send_json({"ok": False, "error": "密码至少 6 位。"}, status=400)
            return

        if not cloudauth.configured():
            self._send_json({"ok": False,
                             "error": "当前环境未配置邮件服务，无法自助找回，请联系管理员重设密码。"},
                            status=503)
            return

        _ok, _why, _st = cloudauth.confirm_code(_vid, _code, email)
        if not _ok:
            self._send_json({"ok": False, "emailCode": True, "error": _why}, status=_st)
            return

        ok, err = _reset_password(email, pwd)
        if not ok:
            self._send_json({"ok": False, "error": err or "密码重设失败，请稍后重试。"}, status=400)
            return

        # 把登录失败计数清掉：用户刚才可能已经猜错过几次密码，既然已证明邮箱归属，
        # 就不该让他重设完立刻被旧的封禁挡住。
        for _k in _login_keys(_ip, email):
            _login_note(_k, True)

        try:
            row = _get_user_by_email(email)
        except Exception:  # noqa: BLE001
            row = None
        sub = str(row[0]) if row else email
        cookie = _mint_session_cookie(email, sub, _is_https_request(self))
        print(f"[auth] 密码已重设：{email}")
        self._send_json_with_cookie({"ok": True, "email": email,
                                     "role": _role_for_email(email), "cloud": self.cloud}, cookie)

    def _post_logout(self):
        self._send_json_with_cookie({"ok": True}, _clear_session_cookie(_is_https_request(self)))
