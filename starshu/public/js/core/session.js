// 会话状态：token 与当前用户的单一数据源。
// 以单例对象形式导出，main、api 等模块共享同一引用，避免状态分散。

const TOKEN_KEY = 'starshu_token';
// 弱口令标记：登录响应里 weakPassword=true 表示仍在用源码内置默认口令。
// 存在本地是为了「刷新页面后提示不丢」，改密成功后会被清掉。
const WEAK_KEY = 'starshu_weak_pwd';

// 兼容 Node（测试/构建期）无 localStorage 的环境
function readToken() {
  try { return (typeof localStorage !== 'undefined') ? (localStorage.getItem(TOKEN_KEY) || null) : null; }
  catch { return null; }
}
function readWeak() {
  try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(WEAK_KEY) === '1' : false; }
  catch { return false; }
}

export const state = {
  token: readToken(),
  user: null,
  weakPassword: readWeak(),
};

export function setWeakPassword(on) {
  state.weakPassword = !!on;
  try {
    if (typeof localStorage !== 'undefined') {
      if (on) localStorage.setItem(WEAK_KEY, '1'); else localStorage.removeItem(WEAK_KEY);
    }
  } catch { /* 忽略隐私模式下的写入失败 */ }
}

export function persistToken() {
  try {
    if (typeof localStorage !== 'undefined') {
      if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
      else localStorage.removeItem(TOKEN_KEY);
    }
  } catch { /* 忽略隐私模式下的写入失败 */ }
}

export function clearSession() {
  state.token = null;
  state.user = null;
  setWeakPassword(false);
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
