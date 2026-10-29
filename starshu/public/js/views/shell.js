// 桌面外壳：侧边栏 + 顶栏 + 消息中心 + 视图容器，以及修改密码弹窗。
import { ICONS, NAV } from '../core/constants.js';
import { state, clearSession, setWeakPassword } from '../core/session.js';
import { api, getDashboard } from '../core/api.js';
import { esc, toast, setLoading } from '../ui/dom.js';
import { modal, closeModal } from '../ui/modal.js';
import { resizeCharts, disposeCharts } from '../ui/charts.js';
import { can } from '../core/permissions.js';
import { currentRoute } from '../core/route.js';
import { router } from '../core/router.js';
import { appRef, shellState, viewState } from '../core/runtime.js';

export function openChangePwd() {
  const m = modal(`<h3>修改密码</h3>
    <div class="field"><label>原密码 <span class="req">*</span></label><input class="input" type="password" id="pw-old" autocomplete="current-password"></div>
    <div class="field"><label>新密码 <span class="req">*</span></label><input class="input" type="password" id="pw-new" autocomplete="new-password" placeholder="至少 8 位"></div>
    <div class="field"><label>确认新密码 <span class="req">*</span></label><input class="input" type="password" id="pw-new2" autocomplete="new-password"></div>
    <div class="err" id="pw-err"></div>
    <div class="actions"><button class="btn" id="pw-cancel">取消</button><button class="btn primary" id="pw-ok">保存</button></div>`);
  const err = m.querySelector('#pw-err');
  m.querySelector('#pw-cancel').onclick = () => closeModal(m);
  m.querySelector('#pw-ok').onclick = async () => {
    const btn = m.querySelector('#pw-ok');
    const oldPassword = m.querySelector('#pw-old').value;
    const newPassword = m.querySelector('#pw-new').value;
    const again = m.querySelector('#pw-new2').value;
    err.textContent = '';
    if (!oldPassword) { err.textContent = '请输入原密码'; return; }
    if (newPassword.length < 8) { err.textContent = '新密码至少 8 位'; return; }
    if (newPassword !== again) { err.textContent = '两次输入的新密码不一致'; return; }
    setLoading(btn, true);
    try {
      await api('/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
      // 无状态 JWT：改密不会让当前 token 失效，只需清掉弱口令提醒并重绘外壳
      setWeakPassword(false);
      closeModal(m);
      toast('密码已修改', 'success');
      shellState.chromeReady = false;
      renderShell();
      router();
    } catch (e) { err.textContent = e.message; setLoading(btn, false); }
  };
  setTimeout(() => { const i = m.querySelector('#pw-old'); if (i) i.focus(); }, 30);
}

// ---------- 主框架 ----------
export function renderShell() {
  const navItems = NAV.filter((n) => !n.perm || can(n.perm)).map((n) =>
    `<a href="${n.h}" data-h="${n.h}"${n.external ? ' class="nav-ext"' : ''}><span class="ic">${ICONS[n.ic] || ''}</span>${n.t}${n.external ? '<span class="ext">↗</span>' : ''}</a>`).join('');
  const initial = (state.user.name || state.user.email || '?').trim().charAt(0).toUpperCase();
  const roleName = esc(state.user.roleName || state.user.role || '');
  appRef.el.className = 'layout';
  appRef.el.innerHTML = `
    <aside class="sidebar" id="sidebar">
      <div class="brand"><span class="logo">${ICONS.layers}</span><span>星枢<small>内容运营中枢</small></span></div>
      <nav class="nav" id="nav">${navItems}<span class="nav-indicator" id="nav-indicator"></span></nav>
    </aside>
    <div class="main">
      <div class="topbar">
        <div class="topbar-left">
          <button class="menu-btn" id="menu-btn">☰</button>
          <span class="title" id="pg-title">数据看板</span>
        </div>
        <div class="topbar-right">          <div class="msg-wrap">
            <button class="bell" id="bell" title="消息中心">${ICONS.bell}<span class="dot" id="msg-dot">0</span></button>
            <div class="msg-menu" id="msg-menu">
              <div class="msg-head"><span>消息中心</span><span class="muted" id="msg-mark">全部已读</span></div>
              <div id="msg-list"></div>
            </div>
          </div>
          <div class="user-chip">
            <span class="avatar" id="avatar" title="${esc(state.user.name || state.user.email)}">${esc(initial)}</span>
            <span class="name-text muted">${esc(state.user.name || state.user.email)}</span>
            <span class="role-badge">${roleName}</span>
          </div>
          <button class="btn sm" id="pwd-btn">修改密码</button>
          <button class="btn sm danger" id="logout">退出</button>
        </div>
      </div>
      ${state.weakPassword ? `<div class="pwd-warn">
        <span class="pw-ico">⚠</span>
        <span class="pw-txt">当前账号仍在使用系统内置的默认口令，公网部署前请立即修改。</span>
        <button class="btn sm primary" id="pwd-warn-btn">现在修改</button>
      </div>` : ''}
      <div class="content" id="view"></div>
    </div>`;
  document.getElementById('logout').onclick = () => {
    clearSession();
    shellState.chromeReady = false; shellState.navInitialized = false;
    location.hash = '#/login';
  };
  document.getElementById('menu-btn').onclick = () => document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('pwd-btn').onclick = openChangePwd;
  const pwdWarnBtn = document.getElementById('pwd-warn-btn');
  if (pwdWarnBtn) pwdWarnBtn.onclick = openChangePwd;
  document.querySelectorAll('.nav a').forEach((a) => (a.onclick = () => {
    document.getElementById('sidebar').classList.remove('open');
  }));
  // 消息中心：点击铃铛切换下拉，点击外部关闭
  const bell = document.getElementById('bell'), msgMenu = document.getElementById('msg-menu');
  bell.onclick = (e) => { e.stopPropagation(); msgMenu.classList.toggle('open'); };
  document.addEventListener('click', (e) => {
    if (!msgMenu.contains(e.target) && !bell.contains(e.target)) msgMenu.classList.remove('open');
  });
  document.getElementById('msg-mark').onclick = (e) => {
    e.stopPropagation();
    const dot = document.getElementById('msg-dot'); dot.classList.remove('show'); dot.textContent = '0';
    toast('已全部标记为已读');
  };
  loadMessages();
  window.addEventListener('resize', () => {
    moveIndicator(false);
    resizeCharts();
  });
}

// 顶部消息中心：从看板数据派生真实消息（待审核数量等）
export async function loadMessages() {
  try {
    const d = await getDashboard(30);
    paintMessages(d);
  } catch (e) { /* 忽略：消息中心非关键路径 */ }
}
export async function paintMessages(d) {
  const items = [];
  // 真实站内通知（驳回、定时发布等）
  let unreadNotif = 0;
  try {
    const n = await api('/notifications');
    unreadNotif = n.unread || 0;
    (n.rows || []).forEach((it) => {
      const href = it.refType === 'post' && it.refId ? '#/posts/' + it.refId : '#/posts';
      items.push({
        notifId: it.id, isRead: !!it.is_read,
        ic: it.type === 'review' ? 'alert' : 'bell', color: it.type === 'review' ? 'warn' : 'purple',
        title: it.title, desc: it.body || '', href,
      });
    });
  } catch (e) { /* 通知非关键路径 */ }

  const pending = (d.byStatus.find((x) => x.status === 'pending') || {}).c || 0;
  const total = d.total || 0;
  const canReview = can('post:publish') || can('post:manage');
  if (pending > 0 && canReview) items.push({ ic: 'alert', color: 'warn', title: pending + ' 篇内容待审核', desc: '请尽快处理提交的内容', href: '#/posts' });
  if (!items.length) {
    items.push({ ic: 'doc', color: 'brand', title: '共 ' + total + ' 篇内容', desc: '点击查看全部内容列表', href: '#/posts' });
    items.push({ ic: 'info', color: 'purple', title: '欢迎使用星枢', desc: '左侧菜单可切换各功能模块', href: '#/' });
  }

  const list = document.getElementById('msg-list');
  if (!list) return;
  if (!items.length) { list.innerHTML = `<div class="msg-empty">${ICONS.inbox}<div>暂无新消息</div></div>`; return; }
  list.innerHTML = items.map((m) => `
    <div class="msg-item${m.notifId && !m.isRead ? ' unread' : ''}" data-href="${m.href}"${m.notifId ? ` data-notif="${m.notifId}"` : ''}>
      <div class="mi-ic" style="background:var(--${m.color}-soft,var(--brand-soft));color:var(--${m.color},var(--brand))">${ICONS[m.ic]}</div>
      <div class="mi-body"><div class="mi-title">${esc(m.title)}</div>${m.desc ? `<div class="mi-desc">${esc(m.desc)}</div>` : ''}</div>
    </div>`).join('');
  list.querySelectorAll('.msg-item').forEach((it) => (it.onclick = async () => {
    const notifId = it.dataset.notif;
    if (notifId) { try { await api('/notifications/mark', { method: 'POST', body: JSON.stringify({ ids: [+notifId] }) }); } catch (e) {} }
    location.hash = it.dataset.href;
    const mm = document.getElementById('msg-menu'); if (mm) mm.classList.remove('open');
  }));
  const dot = document.getElementById('msg-dot');
  const totalUnread = unreadNotif + (pending > 0 && canReview ? pending : 0);
  if (dot && totalUnread > 0) { dot.textContent = totalUnread > 99 ? '99+' : totalUnread; dot.classList.add('show'); }
}

// 更新当前选中项：切换 active 高亮、更新标题、移动滑动高亮块
export function updateNav(animate) {
  const h = currentRoute().split('?')[0];
  let target = h === '#/dashboard' ? '#/' : h;
  if (target.startsWith('#/posts')) target = '#/posts'; // 新建/编辑内容归属“内容管理”
  const links = document.querySelectorAll('.nav a');
  links.forEach((a) => a.classList.toggle('active', a.dataset.h === target));
  const active = document.querySelector('.nav a.active');
  if (active) document.getElementById('pg-title').textContent = active.textContent.trim();
  moveIndicator(animate);
}

// 滑动高亮块：定位到选中 <a> 的精确位置与尺寸，背景块平滑滑动，文字固定在 <a> 上不动
export function moveIndicator(animate) {
  const nav = document.getElementById('nav');
  const ind = document.getElementById('nav-indicator');
  if (!nav || !ind) return;
  const active = nav.querySelector('.nav a.active');
  if (!active) { ind.style.opacity = '0'; return; }
  if (!animate) ind.classList.add('no-anim');
  ind.style.opacity = '1';
  ind.style.width = active.offsetWidth + 'px';
  ind.style.height = active.offsetHeight + 'px';
  ind.style.transform = 'translate(' + active.offsetLeft + 'px,' + (active.offsetTop - nav.scrollTop) + 'px)';
  if (!animate) requestAnimationFrame(() => ind.classList.remove('no-anim'));
}
// 视图世代号：setView 每次切换视图自增；异步 load() 在 await 后校验，
// 过期（用户已导航到其他页面）则中止渲染，避免向已卸载的 DOM 写入。
export function setView(html) {
  const v = document.getElementById('view');
  if (!v) return;
  v.innerHTML = html;
  v.classList.remove('view-anim'); void v.offsetWidth; v.classList.add('view-anim');
  disposeCharts();
  viewState.epoch++;
}

// ---------- 看板 ----------
