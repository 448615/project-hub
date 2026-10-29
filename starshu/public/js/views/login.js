// 登录 / 注册视图。
import { api } from '../core/api.js';
import { state, persistToken, setWeakPassword } from '../core/session.js';
import { toast, setLoading } from '../ui/dom.js';
import { appRef } from '../core/runtime.js';

export function renderLogin() {
  appRef.el.className = '';
  appRef.el.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <h2>星枢</h2>
      <div class="sub">内容运营中枢 · 登录你的账号</div>
      <div class="tabs">
        <div class="tab on" id="tab-login">登录</div>
        <div class="tab" id="tab-reg">注册</div>
      </div>
      <form id="auth-form">
        <div class="field" id="f-name" style="display:none">
          <label>昵称</label><input class="input" id="name" placeholder="显示名称" />
        </div>
        <div class="field">
          <label>邮箱 <span class="req">*</span></label>
          <input class="input" id="email" type="email" placeholder="you@example.com" required />
        </div>
        <div class="field">
          <label>密码 <span class="req">*</span></label>
          <input class="input" id="password" type="password" placeholder="至少 6 位" required />
        </div>
        <div class="err" id="auth-err"></div>
        <button class="btn primary" style="width:100%;justify-content:center" id="auth-submit" type="submit">登 录</button>
      </form>
      <div style="margin-top:14px;text-align:center" class="muted">首个注册账号将自动成为管理员</div>
    </div>
  </div>`;
  let mode = 'login';
  document.getElementById('tab-login').onclick = () => switchTab('login');
  document.getElementById('tab-reg').onclick = () => switchTab('reg');
  function switchTab(m) {
    mode = m;
    document.getElementById('tab-login').classList.toggle('on', m === 'login');
    document.getElementById('tab-reg').classList.toggle('on', m === 'reg');
    document.getElementById('f-name').style.display = m === 'reg' ? '' : 'none';
    document.getElementById('auth-submit').textContent = m === 'login' ? '登 录' : '注 册';
    document.getElementById('auth-err').textContent = '';
  }
  document.getElementById('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('auth-submit');
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const err = document.getElementById('auth-err');
    err.textContent = '';
    setLoading(btn, true);
    try {
      const data = mode === 'login'
        ? await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
        : await api('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, display_name: document.getElementById('name').value.trim() }) });
      state.token = data.token; persistToken(); state.user = data.user;
      // 后端在「密码 == 源码内置默认口令」时置位，进入后台后顶栏会常驻修改提醒
      setWeakPassword(!!(mode === 'login' && data.weakPassword));
      toast(mode === 'login' ? '登录成功' : '注册成功，已自动登录', 'success');
      location.hash = '#/';
    } catch (e2) { err.textContent = e2.message; }
    finally { setLoading(btn, false); }
  };
  switchTab('login');
}

// ---------- 修改密码 ----------
// 此前系统没有任何改密入口（PROJECT.md 只教用户用 node -e 直接改库），
// 配合「内置默认管理员」等于线上长期挂着已知口令。这里补上最小闭环。
