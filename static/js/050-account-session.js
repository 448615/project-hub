// 050-account-session.js — 会话状态与统一 API 请求
// 由 050-account.js 按函数边界切分；只做文件拆分，代码零改动。

// ===== 账号体系：本地账号库 + 本地签名会话（不依赖任何云端）=====
// 1) 账号与密码哈希存本机 users.db，由服务端 hub.py 管理；
// 2) 登录/注册成功后，服务端用 SECRET_KEY 签发 HttpOnly 会话 Cookie（hub_sess）；
// 3) 每个 API 请求浏览器自动携带该 Cookie，服务端本地验签即放行，永不回源。
let ME = null;            // 当前登录用户：{email, role, cloud}

// —— 本地记住账号：仅存于当前浏览器，用于下次自动填充（绝不上传、不替代云端鉴权）——
const SAVED_ACCT_KEY = 'ph.savedAccount';       // {email, password, remember}
const REMEMBER_KEY = 'ph.rememberEnabled';      // '1' | '0'
const LOGGED_OUT_KEY = 'ph.loggedOut';          // '1' = 本次启动来自「主动退出」，跳过自动登录

// ---- 退出登录：全站唯一的退出实现，所有出口都必须走这里 ----
// 之所以要「唯一」：服务端退出只作废 Cookie，而 silentRelogin 每次启动都会用本机保存的
// 密码换一张新会话。只清 Cookie 不清密码 → 重载后被立刻登回来，用户看到的就是
// 「点了退出没反应」。所以退出必须一并清掉本机凭证，两件事必须原子地发生在同一处。
async function performLogout() {
  try {
    await fetch(hubApiUrl('/api/auth/logout'), { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* 网络失败也照常回登录页：本地凭证已清，服务端会话到期自然失效 */ }
  clearSavedPassword();
  // 兜底：localStorage 不可写（隐私模式/配额满）时 clearSavedPassword 会静默失败，
  // 自动登录仍可能把人登回去。这个一次性标记让下一次启动无条件跳过自动登录。
  try { sessionStorage.setItem(LOGGED_OUT_KEY, '1'); } catch (e) { /* 忽略 */ }
  location.reload();
}
function loadSavedAccount() {
  try { return JSON.parse(localStorage.getItem(SAVED_ACCT_KEY) || 'null'); } catch (e) { return null; }
}
function saveAccountCreds(email, password, remember) {
  try {
    const cur = loadSavedAccount() || {};
    localStorage.setItem(SAVED_ACCT_KEY, JSON.stringify({
      email: email || cur.email || '',
      password: remember ? (password || '') : '',
      remember: !!remember,
    }));
  } catch (e) { /* 忽略 */ }
}
function clearSavedPassword() {
  try { const c = loadSavedAccount() || {}; localStorage.setItem(SAVED_ACCT_KEY, JSON.stringify({ email: c.email || '', password: '', remember: false })); } catch (e) {}
}
function rememberEnabled() {
  try { const v = localStorage.getItem(REMEMBER_KEY); return v === null ? true : v !== '0'; } catch (e) { return true; }
}
function setRememberEnabled(on) {
  try { localStorage.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch (e) {}
}

// 平台网关放行参数：云端 /api/* 若既没 Cookie 也没 sharecode，会被网关直接
// 拦成 403 的「链接不完整」HTML 页——前端拿到 HTML 却当成 JSON 解析，
// 表现就是「登录失败：邮箱或密码错误」这类误报。
// 网关下发的 __wb_rsc Cookie 在 iframe（第三方上下文）里可能被浏览器拦掉，
// 所以这里给每个 API 请求都显式补上 sharecode，作为第二重保险。
function hubApiUrl(path) {
  let s = '';
  try { s = brShareCode(); } catch (e) { s = ''; }
  if (!s) return path;
  const sep = String(path).indexOf('?') >= 0 ? '&' : '?';
  return path + sep + 'sharecode=' + encodeURIComponent(s);
}

// 统一 API 请求：本地签名会话 Cookie（hub_sess）随同源请求自动带出，
// 服务端本地验签即可放行——无需附加任何令牌头、无浏览器中转、无令牌续期。
async function apiFetch(path, opts = {}) {
  const o = Object.assign({}, opts);
  o.headers = Object.assign({}, opts.headers);
  o.credentials = 'same-origin';
  const res = await fetch(hubApiUrl(path), o);
  if (res.status === 401) {
    showLogin('登录已过期，请重新登录');
    const err = new Error('unauthorized');
    err.code = 401;
    throw err;
  }
  return res;
}
