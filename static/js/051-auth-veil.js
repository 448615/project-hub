// 051-auth-veil.js — 登录/注册遮罩
// 由 050-account.js 按函数边界切分；只做文件拆分，代码零改动。

// ---- 登录 / 注册 双模式遮罩 ----
const loginVeil = document.getElementById('loginVeil');
const loginMsg = document.getElementById('loginMsg');
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const loginForm = document.getElementById('loginForm');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const btnLogin = document.getElementById('btnLogin');
const forgotPwd = document.getElementById('forgotPwd');
const registerForm = document.getElementById('registerForm');
const regEmail = document.getElementById('regEmail');
const regPassword = document.getElementById('regPassword');
const regPassword2 = document.getElementById('regPassword2');
const regCode = document.getElementById('regCode');
const btnSendCode = document.getElementById('btnSendCode');
const btnRegister = document.getElementById('btnRegister');
const regCaptcha = document.getElementById('regCaptcha');
const captchaBox = document.getElementById('captchaBox');
const switchToRegister = document.getElementById('switchToRegister');
const switchToLogin = document.getElementById('switchToLogin');
let _loginWired = false;
let _authMode = 'login';   // 'login' | 'register'

const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- 提示区统一入口 ----
// kind: 'error' | 'warn' | 'info' | 'ok' | ''（空 = 清除，只留最小高度占位）
// 为什么收敛成一个函数：原来是散落的 textContent 赋值，样式只有一种红，
// 于是「正在登录…」「邮箱格式错」「请求被网关拦截」视觉上完全一样——
// 用户分不清哪句是他要改的、哪句只是进度。分级后颜色即语义。
function setAuthMsg(text, kind) {
  const el = document.getElementById('loginMsg');
  if (!el) return;
  el.className = 'login-msg' + (kind ? ' is-' + kind : '');
  el.textContent = text || '';
}

// ---- 按钮忙碌态 ----
// 用 CSS 转圈而不是改文字：改文字会让按钮宽度在「登录」↔「正在登录…」之间跳动。
function setBusy(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-loading', !!on);
  btn.disabled = !!on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

// ---- 输入框级报错高亮 ----
// 三个输入框的表单里，只在下面飘一行红字等于没指认；红框要落在具体那个框上。
function markInvalid(el, bad) {
  if (!el) return;
  el.classList.toggle('is-invalid', !!bad);
  if (bad) el.setAttribute('aria-invalid', 'true');
  else el.removeAttribute('aria-invalid');
}
function clearInvalid() {
  [loginEmail, loginPassword, regEmail, regPassword, regPassword2, regCaptcha, regCode]
    .forEach((el) => markInvalid(el, false));
}

// ---- 图形验证码 ----
// 令牌一次性：后端无论答案对错都会把它作废，所以「换图」是失败后的必经动作，
// 不是可选优化。_captchaToken 为空表示当前没有可用图（还没取 / 已用过）。
let _captchaToken = '';
let _captchaBusy = false;

async function refreshCaptcha() {
  if (!captchaBox) return;
  if (_captchaBusy) return;                 // 连点图片时只发一个请求
  _captchaBusy = true;
  _captchaToken = '';                       // 先作废旧令牌：取图失败时不能拿旧图提交
  captchaBox.disabled = true;
  captchaBox.innerHTML = '<span class="cap-loading">加载中…</span>';
  try {
    const r = await fetch(hubApiUrl('/api/captcha'), { credentials: 'same-origin' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    const svg = (j && j.svg) || '';
    // 只接受「以 <svg 开头、不含脚本/事件属性」的内容。这里的内容来自自家后端，
    // 但把它塞进 innerHTML 之前做一次形状校验的成本几乎为零，能挡住
    // 「后端被换成返回别的东西」这类离谱情况演变成 XSS。
    if (!j || !j.ok || !j.token || svg.indexOf('<svg') !== 0
        || svg.indexOf('<script') >= 0 || /\son[a-z]+\s*=/i.test(svg)) {
      throw new Error('返回格式异常');
    }
    _captchaToken = j.token;
    captchaBox.innerHTML = svg;
  } catch (e) {
    _captchaToken = '';
    captchaBox.innerHTML = '<span class="cap-loading">点击重试</span>';
  } finally {
    _captchaBusy = false;
    captchaBox.disabled = false;
  }
}

// ---- 邮箱验证码 ----
// _emailVid 是服务端发信时返回的凭据，注册时必须原样带回。服务端靠它认「这张码
// 是发给哪个邮箱的」——云端的校验接口只认 id、不认邮箱，所以换邮箱必须重新发码。
// 把 id 和邮箱都交给客户端去拼，等于允许「拿自己的 id 配别人的邮箱」。
let _emailVid = '';
let _codeSentEmail = '';    // 这张码是发给谁的；用来发现「改了邮箱还在用旧码」
let _sendTimer = 0;
let _sendBusy = false;

function stopSendTimer() {
  if (_sendTimer) { clearInterval(_sendTimer); _sendTimer = 0; }
  if (btnSendCode) {
    btnSendCode.disabled = false;
    btnSendCode.textContent = '发送验证码';
  }
}

// 倒计时只挂在「发送」上，不锁住「注册」：码已经收到了，就该让用户立刻提交，
// 哪怕 60 秒还没走完。
function startCooldown(sec) {
  if (!btnSendCode) return;
  let left = Math.max(1, Math.min(600, sec | 0));
  btnSendCode.disabled = true;
  btnSendCode.textContent = left + ' 秒后重发';
  if (_sendTimer) clearInterval(_sendTimer);
  _sendTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { stopSendTimer(); return; }
    btnSendCode.textContent = left + ' 秒后重发';
  }, 1000);
}

async function sendRegisterCode() {
  if (_sendBusy) return;
  const email = ((regEmail && regEmail.value) || '').trim();
  const cap = ((regCaptcha && regCaptcha.value) || '').trim();
  clearInvalid();
  if (!_EMAIL_RE.test(email)) {
    markInvalid(regEmail, true);
    if (regEmail) regEmail.focus();
    setAuthMsg('请输入正确的邮箱地址', 'error');
    return;
  }
  if (!cap) {
    markInvalid(regCaptcha, true);
    if (regCaptcha) regCaptcha.focus();
    setAuthMsg('请先输入图片中的验证码', 'error');
    return;
  }
  if (!_captchaToken) {
    setAuthMsg('图片验证码已失效，正在重新获取…', 'warn');
    refreshCaptcha();
    return;
  }
  _sendBusy = true;
  btnSendCode.disabled = true;
  btnSendCode.textContent = '发送中…';
  setAuthMsg('正在发送验证码…', 'info');
  let r, body;
  try {
    r = await fetch(hubApiUrl('/api/auth/register-code'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: email, captchaId: _captchaToken, captcha: cap }),
    });
    const ctype = (r.headers.get('content-type') || '').toLowerCase();
    if (ctype.indexOf('json') < 0) {
      _sendBusy = false;
      stopSendTimer();
      setAuthMsg('请求被平台网关拦截（HTTP ' + r.status + '）：请用带 sharecode 的分享链接打开本应用后重试。', 'warn');
      return;
    }
    body = await r.json().catch(() => ({}));
  } catch (err) {
    _sendBusy = false;
    stopSendTimer();
    setAuthMsg('网络错误：' + ((err && err.message) || err), 'error');
    return;
  }
  _sendBusy = false;
  if (!r.ok) {
    // 图形验证码在服务端已作废（无论对错），必须换图，否则用户对着死图反复输
    if (body && body.captcha) {
      refreshCaptcha();
      if (regCaptcha) regCaptcha.value = '';
      markInvalid(regCaptcha, true);
    }
    if (r.status === 429) {
      const ra = parseInt(r.headers.get('retry-after') || '', 10);
      if (ra > 0) startCooldown(ra); else stopSendTimer();
      setAuthMsg(ra > 0 ? ('发送过于频繁，请在 ' + ra + ' 秒后再试')
                        : ((body && body.error) || '发送过于频繁，请稍后再试'), 'warn');
      return;
    }
    stopSendTimer();
    setAuthMsg((body && body.error) || '验证码发送失败，请稍后重试', 'error');
    return;
  }
  _emailVid = (body && body.verificationId) || '';
  _codeSentEmail = email;
  startCooldown((body && body.cooldown) || 60);
  // 发送时那张图形码已被服务端消费掉了：换一张，用户下次重发时才有可用的图。
  refreshCaptcha();
  if (regCaptcha) regCaptcha.value = '';
  setAuthMsg('验证码已发送至 ' + email + '，请查收（含垃圾箱）', 'ok');
  if (regCode) { regCode.value = ''; regCode.focus(); }
}

// ---- 认证草稿：记住「当前模式 + 已填邮箱」----
// 只存邮箱不存密码（密码不进 sessionStorage）。用途：意外刷新 / Service Worker 更新后
// 仍停在原来的「注册」页并回填邮箱，而不是被弹回「登录」。
const AUTH_DRAFT_KEY = 'hub_auth_draft';
function saveAuthDraft() {
  try {
    const el = (_authMode === 'login') ? loginEmail : regEmail;
    const email = (el && el.value) || '';
    sessionStorage.setItem(AUTH_DRAFT_KEY, JSON.stringify({ mode: _authMode, email: email }));
  } catch (e) { /* 隐私模式忽略 */ }
}
function loadAuthDraft() {
  try {
    const s = sessionStorage.getItem(AUTH_DRAFT_KEY);
    if (!s) return null;
    const o = JSON.parse(s);
    if (!o || typeof o !== 'object') return null;
    if (o.mode !== 'login' && o.mode !== 'register') return null;
    return o;
  } catch (e) { return null; }
}
function clearAuthDraft() { try { sessionStorage.removeItem(AUTH_DRAFT_KEY); } catch (e) {} }

// 登录/注册遮罩是否可见（未登录）。用 getElementById 而非闭包变量：
// restartAutoRefresh 在脚本前段就会被 applySettings() 调用，那时 const loginVeil 还在 TDZ。
function authVeilVisible() {
  const v = document.getElementById('loginVeil');
  return !!(v && !v.hidden);
}

// 重置表单状态：跨会话 / 切换模式时调用，避免敏感字段残留（修复 #2、#6）
function resetForms(full) {
  setBusy(btnLogin, false);          // 顺带清掉 loading 转圈，避免请求被中断后按钮一直转
  setBusy(btnRegister, false);
  clearInvalid();
  regPassword.value = '';
  regPassword2.value = '';
  if (regCaptcha) regCaptcha.value = '';
  if (regCode) regCode.value = '';
  // 邮件验证码的待用凭据一并作废：表单都空了还要留着旧 id，会让「改了邮箱再提交」
  // 走到服务端才被拒，白跑一趟网络。
  _emailVid = '';
  _codeSentEmail = '';
  stopSendTimer();
  if (full) {
    // 重新打开遮罩：彻底清空（含邮箱/密码），避免上次账号残留
    if (loginForm) loginForm.reset();
    if (registerForm) registerForm.reset();
    loginEmail.value = '';
    loginPassword.value = '';
    regEmail.value = '';
  }
}

function showLogin(msg) {
  if (!loginVeil) return;
  // 访客视图打开时不弹遮罩。触发路径很真实：任何一次后台请求 401（如自动刷新、
  // 或用户点了一下需要登录的入口）都会走到这里，遮罩 z-index 比访客视图高，
  // 直接盖上去，表现就是「卡片看得好好的突然被登录框糊住」。
  const _gv = document.getElementById('guestView');
  if (_gv && !_gv.hidden) return;
  // 【关键】遮罩已经显示时只做「不打扰」处理，绝不重置表单、不切换模式、不抢焦点。
  // 曾经的问题：未登录时后台自动刷新每 20s 打一次 /api/projects → 401 → 这里被调用 →
  // resetForms(true) 清空输入 + setAuthMode('login')，表现就是「密码还没输完、没点注册，
  // 界面自己跳回登录页」。
  if (!loginVeil.hidden) return;
  resetForms(true);                  // 重新打开：彻底清空表单（含邮箱/密码）
  loginVeil.hidden = false;
  // 恢复上次的模式与邮箱（草稿）：意外刷新后仍停在注册页，邮箱不用重填
  const _draft = loadAuthDraft();
  const _saved = loadSavedAccount();
  if (_draft && _draft.mode === 'register') {
    setAuthMode('register');
    if (_draft.email) regEmail.value = _draft.email;
  } else if (_saved && _saved.email) {
    setAuthMode('login');
    loginEmail.value = _saved.email || '';
    if (_saved.remember && _saved.password) loginPassword.value = _saved.password || '';
  } else if (_draft && _draft.mode === 'login') {
    setAuthMode('login');
    if (_draft.email) loginEmail.value = _draft.email;
  } else {
    setAuthMode('register');
  }
  if (msg) setAuthMsg(msg, 'warn');   // 再写提示，避免被 setAuthMode 抹掉（修复 #4）
  wireLogin();
  saveAuthDraft();
}
function hideLogin() {
  clearAuthDraft();                  // 已登录：草稿不再需要，避免下次误恢复
  // 正常路径下访客视图早已收起，这里只是防御：万一以后有人从访客视图直接登录，
  // 不至于登录成功后还被一张只读卡片盖着。
  const _gv = document.getElementById('guestView');
  if (_gv) _gv.hidden = true;
  if (loginVeil) loginVeil.hidden = true;
}

// 切换登录 / 注册模式：显隐对应表单与标签高亮
function setAuthMode(mode) {
  _authMode = mode;
  const isLogin = mode === 'login';
  loginForm.hidden = !isLogin;
  registerForm.hidden = isLogin;
  tabLogin.classList.toggle('active', isLogin);
  tabRegister.classList.toggle('active', !isLogin);
  clearInvalid();
  setAuthMsg('', '');
  if (isLogin) loginEmail.focus(); else regEmail.focus();
  // 切到注册模式时确保有一张可用图。已有 token 就不重取——来回切标签页
  // 不该把用户刚认对的那张图刷掉（它还没被提交过，仍然有效）。
  if (!isLogin && !_captchaToken) refreshCaptcha();
}

function wireLogin() {
  if (_loginWired) return;
  _loginWired = true;

  // 模式切换入口（切换后立刻记草稿，刷新也能停在同一模式）
  tabLogin.addEventListener('click', () => { setAuthMode('login'); saveAuthDraft(); });
  tabRegister.addEventListener('click', () => { setAuthMode('register'); saveAuthDraft(); });
  switchToLogin.addEventListener('click', (e) => { e.preventDefault(); setAuthMode('login'); saveAuthDraft(); });
  switchToRegister.addEventListener('click', (e) => { e.preventDefault(); setAuthMode('register'); saveAuthDraft(); });

  // 输入即记草稿：任何意外刷新/Service Worker 更新后都能恢复到「注册 + 已填邮箱」
  [loginEmail, loginPassword, regEmail, regPassword, regPassword2].forEach((el) => {
    if (el) el.addEventListener('input', saveAuthDraft);
  });

  // —— 登录模式：邮箱 + 密码（本地账号库校验）——
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (loginEmail.value || '').trim();
    const password = loginPassword.value || '';
    clearInvalid();
    if (!_EMAIL_RE.test(email)) {
      markInvalid(loginEmail, true); loginEmail.focus();
      setAuthMsg('请输入正确的邮箱地址', 'error'); return;
    }
    if (!password) {
      markInvalid(loginPassword, true); loginPassword.focus();
      setAuthMsg('请输入密码', 'error'); return;
    }
    setBusy(btnLogin, true);
    setAuthMsg('正在登录…', 'info');
    let r, body;
    try {
      r = await fetch(hubApiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      // 网关拦截时返回的是 HTML 而不是 JSON：不能把它当成「密码错误」，
      // 否则用户会以为账号有问题，永远查不到真正原因。
      const ctype = (r.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('json') < 0) {
        setBusy(btnLogin, false);
        setAuthMsg('请求被平台网关拦截（HTTP ' + r.status + '）：请用带 sharecode 的分享链接打开本应用后重试。', 'warn');
        return;
      }
      body = await r.json().catch(() => ({}));
    } catch (err) {
      setBusy(btnLogin, false);
      setAuthMsg('网络错误：' + ((err && err.message) || err), 'error');
      return;
    }
    setBusy(btnLogin, false);
    if (!r.ok) {
      // 429 是「被限流」，不是「密码错」。两者必须分开说：
      // 混成一句「登录失败」会让用户继续重试，而每重试一次都可能把封禁续期。
      if (r.status === 429) {
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        setAuthMsg(ra > 0 ? ('尝试次数过多，请在 ' + ra + ' 秒后再试')
                          : ('尝试次数过多，请稍后再试'), 'warn');
        return;
      }
      markInvalid(loginPassword, true);
      setAuthMsg('登录失败：' + ((body && body.error) || '邮箱或密码错误'), 'error');
      return;
    }
    setAuthMsg('', '');
    if (rememberEnabled()) saveAccountCreds(email, password, true); else clearSavedPassword();
    hideLogin();
    enterApp();
  });

  // —— 忘记密码：本地账号库没有邮件通道，自助找回不成立 ——
  // 只陈述事实（找管理员重设）。原提示教用户「删掉 users.db 里的账号再重新注册」，
  // 那是破坏性操作，不该作为登录页的默认引导。
  if (forgotPwd) {
    forgotPwd.addEventListener('click', (e) => {
      e.preventDefault();
      setAuthMsg('本地账号不支持邮件自助重置，请联系管理员重设密码。', 'warn');
    });
  }

  // —— 注册：邮箱 + 邮件验证码 + 密码（首位注册用户自动成为管理员）——
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (regEmail.value || '').trim();
    const pwd = regPassword.value || '';
    const pwd2 = regPassword2.value || '';
    const code = ((regCode && regCode.value) || '').trim();
    clearInvalid();
    if (!_EMAIL_RE.test(email)) {
      markInvalid(regEmail, true); regEmail.focus();
      setAuthMsg('请输入正确的邮箱地址', 'error'); return;
    }
    if (pwd.length < 6) {
      markInvalid(regPassword, true); regPassword.focus();
      setAuthMsg('密码至少 6 位', 'error'); return;
    }
    if (pwd !== pwd2) {
      markInvalid(regPassword2, true); regPassword2.focus();
      setAuthMsg('两次输入的密码不一致', 'error'); return;
    }
    // 换过邮箱就必须重新发码：服务端记的是「这张码发给了谁」，不是当前输入框里的值。
    // 这里先挡一次，省得用户填完密码才被拒。
    if (!_emailVid || _codeSentEmail.toLowerCase() !== email.toLowerCase()) {
      markInvalid(regCode, true);
      if (regCode) regCode.focus();
      setAuthMsg(_emailVid ? '邮箱已修改，请重新获取验证码' : '请先点击「发送验证码」并查收邮件', 'warn');
      return;
    }
    // 不写死位数：码的长度由平台模板决定，前端只挡住「明显不是码」的输入，
    // 真正的判定交给云端。写死 6 位的话，模板换成 8 位就会把所有人挡在门外。
    if (!/^\d{4,8}$/.test(code)) {
      markInvalid(regCode, true);
      if (regCode) regCode.focus();
      setAuthMsg('请输入邮件里的验证码', 'error'); return;
    }
    setBusy(btnRegister, true);
    setAuthMsg('正在注册…', 'info');
    let r, body;
    try {
      r = await fetch(hubApiUrl('/api/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password: pwd,
                               verificationId: _emailVid, code: code }),
      });
      const ctype = (r.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('json') < 0) {
        setBusy(btnRegister, false);
        setAuthMsg('请求被平台网关拦截（HTTP ' + r.status + '）：请用带 sharecode 的分享链接打开本应用后重试。', 'warn');
        return;
      }
      body = await r.json().catch(() => ({}));
    } catch (err) {
      setBusy(btnRegister, false);
      setAuthMsg('网络错误：' + ((err && err.message) || err), 'error');
      return;
    }
    setBusy(btnRegister, false);
    if (!r.ok) {
      if (r.status === 429) {
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        setAuthMsg(ra > 0 ? ('注册过于频繁，请在 ' + ra + ' 秒后再试')
                          : ('注册过于频繁，请稍后再试'), 'warn');
        return;
      }
      setAuthMsg('注册失败：' + ((body && body.error) || '请稍后重试'), 'error');
      // 邮件码错误：不清空、只选中，让用户在原有六位里改一位，
      // 而不是从头再敲一遍。码本身没作废（服务端允许重试到过期）。
      if (body && body.emailCode) {
        markInvalid(regCode, true);
        if (regCode) { regCode.focus(); regCode.select(); }
        return;
      }
      if (body && body.captcha) {
        refreshCaptcha();
        if (regCaptcha) regCaptcha.value = '';
        markInvalid(regCaptcha, true);
      }
      return;
    }
    _captchaToken = '';
    _emailVid = '';
    _codeSentEmail = '';
    stopSendTimer();
    if (rememberEnabled()) saveAccountCreds(email, pwd, true); else clearSavedPassword();
    resetForms(false);
    setAuthMsg('', '');
    hideLogin();
    enterApp();
    if (body && body.role === 'admin') toast('已注册并成为管理员（首位用户自动获得管理员权限）');
  });

  // 回车快捷操作：阻止浏览器对含 submit 按钮的表单发起“隐式提交”（修复 #3、#9）
  loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loginPassword.focus(); } });
  loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btnLogin.click(); } });
  regEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (regCaptcha) regCaptcha.focus(); } });
  if (regCaptcha) regCaptcha.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // 还没发码时，回车等于「发送」；已经发过就直接跳到填码，别重复发信。
    if (_emailVid) { if (regCode) regCode.focus(); } else { sendRegisterCode(); }
  });
  if (regCode) regCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); regPassword.focus(); } });
  regPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); regPassword2.focus(); } });
  regPassword2.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btnRegister.click(); } });

  if (btnSendCode) btnSendCode.addEventListener('click', () => sendRegisterCode());

  // —— 换一张验证码：点图即可。按钮是 <button>，键盘同样可达 ——
  if (captchaBox) captchaBox.addEventListener('click', () => refreshCaptcha());

  // —— 密码可见性切换：事件委托，三个眼睛按钮共用一套逻辑 ——
  // 用委托而不是逐个绑定：按钮是随 HTML 一起渲染的，未来加第四个密码框不用再改这里。
  loginVeil.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.pwd-eye') : null;
    if (!btn) return;
    e.preventDefault();
    const id = btn.getAttribute('data-eye');
    const input = id ? document.getElementById(id) : null;
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
    btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    // 切完把焦点还给输入框并保持光标位置：某些浏览器改 type 后光标会跳到末尾
    try {
      const pos = input.value.length;
      input.focus({ preventScroll: true });
      input.setSelectionRange(pos, pos);
    } catch (_) { /* 部分浏览器对 number/email 禁止 setSelectionRange，忽略即可 */ }
  });

  // —— 右下角访客入口 ——
  // 只是「打开只读视图」，不改变登录态：随时可以点「登录/注册」回到本遮罩。
  const guestBtn = document.getElementById('guestEnter');
  if (guestBtn) {
    guestBtn.addEventListener('click', () => {
      if (typeof enterGuestMode === 'function') enterGuestMode();
      else setAuthMsg('访客模式尚未就绪，请刷新页面重试。', 'warn');
    });
  }
}
