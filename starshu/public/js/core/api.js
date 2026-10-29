// API 客户端：统一封装请求、token 透传、看板数据缓存、ECharts 懒加载
import { state, clearSession } from './session.js';

// 统一请求封装
// 平台反代会篡改 Authorization 头，故用自定义头 X-Auth-Token 透传原始 token
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (state.token) headers['X-Auth-Token'] = state.token;
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch('api' + path, { method: opts.method || 'GET', headers, body: opts.body });

  // 登录/注册是公开入口：其 401 只表示「凭据错误」，不是会话失效。
  // 必须放行到下方 !res.ok 分支，把后端 error（如「账号或密码错误」）抛给登录页展示；
  // 若在此处统一清 session，会把「密码错」误报成「会话已失效」。
  // 其余接口（含 /auth/me、/auth/logout）的 401 才是真正的会话失效。
  const isAuthEntry = /^\/auth\/(login|register)\b/.test(path);
  if (res.status === 401 && !isAuthEntry) {
    clearSession();
    if (location.hash !== '#/login') location.hash = '#/login';
    throw new Error('会话已失效，请重新登录');
  }

  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
  return data;
}

// 看板数据缓存：同一时间窗内合并重复请求（首屏与消息中心共用，避免重复拉取）
let _dashCache = { ts: 0, range: null, data: null };
async function getDashboard(range) {
  const now = Date.now();
  if (_dashCache.range === range && _dashCache.data && now - _dashCache.ts < 8000) return _dashCache.data;
  const d = await api('/dashboard?range=' + range);
  _dashCache = { ts: now, range, data: d };
  return d;
}

// 按需懒加载 ECharts（仅看板用到，避免其它页面阻塞 ~1MB 脚本）；失败则调用方按 SVG 降级处理
let _echartsLoading = null;
function ensureECharts() {
  if (window.echarts) return Promise.resolve(true);
  if (_echartsLoading) return _echartsLoading;
  _echartsLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'vendor-echarts.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return _echartsLoading;
}

export { api, getDashboard, ensureECharts };