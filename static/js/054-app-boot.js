// 054-app-boot.js — 启动闸门与桌面加载
// 由 050-account.js 按函数边界切分；只做文件拆分，代码零改动。

// ---- 启动闸门：探测本地会话 Cookie → 已登录进桌面，否则弹登录遮罩 ----
// 静默重登：会话 Cookie 过期（7 天）或服务端密钥轮换后，用「记住我」保存的凭证
// 直接换一张新会话，用户不会再看到登录框。这正是「下次打开应用直接进桌面」的实现方式——
// 只靠 Cookie 做不到：它一定会过期，而过期那天用户就得重新输一次密码。
async function silentRelogin() {
  const saved = loadSavedAccount();
  if (!saved || !saved.remember || !saved.email || !saved.password) return false;
  try {
    const r = await fetch(hubApiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: saved.email, password: saved.password }),
    });
    if (!r.ok) {
      // 401 = 密码已改（或账号没了）：留着他每次启动都会白试一次，还平白消耗限流计数。
      // 429 = 被限流：这次先放弃，但**不清理**——凭证本身没错，只是现在不能试。
      if (r.status === 401) clearSavedPassword();
      return false;
    }
    const j = await r.json().catch(() => ({}));
    return !!(j && j.ok);
  } catch (e) {
    return false;   // 网络问题：保留凭证，下次启动再试
  }
}

async function authBoot() {
  // 刚点过「退出登录」：这一次启动不许自动登录。
  // 不做这个判断的话，退出→重载→silentRelogin 用保存的密码换新会话，
  // 用户看到的现象就是「退出登录点了完全没反应」。
  let justLoggedOut = false;
  try {
    justLoggedOut = sessionStorage.getItem(LOGGED_OUT_KEY) === '1';
    if (justLoggedOut) sessionStorage.removeItem(LOGGED_OUT_KEY);   // 一次性，用完即弃
  } catch (e) { /* sessionStorage 不可用：当作没退出过，行为退回旧逻辑 */ }
  try {
    const res = await fetch(hubApiUrl('/api/auth/me'), { credentials: 'same-origin' });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) { await enterApp(); return; }   // 有效会话 → 直接进桌面
    }
    // 只在「不是主动退出」时才尝试自动重登；服务端会话还在时上面已经进桌面了
    if (!justLoggedOut && await silentRelogin()) { await enterApp(); return; }
    showLogin();                                     // 无有效会话且无法自动重登 → 登录/注册
  } catch (e) {
    showLogin('无法连接后端服务，请确认 hub.py 已启动。');
  }
}

// 页面加载时拉取项目列表
async function load() {
  try {
    const res = await apiFetch('/api/projects');
    if (!res.ok) {
      // 401 已由 apiFetch 处理（弹登录）；这里展示服务端给出的具体错误（如 503）
      const j = await res.json().catch(() => ({}));
      iconsEl.innerHTML = '<div class="empty">' + esc(j.error || ('加载失败（HTTP ' + res.status + '）')) + '</div>';
      return;
    }
    DATA = await res.json();
  } catch (e) {
    if (e && e.code === 401) return;   // 已弹登录遮罩，不重复报错
    iconsEl.innerHTML = '<div class="empty">无法连接后端服务，请确认 hub.py 已启动。</div>';
    return;
  }
  renderDesktop();
  restoreAll();   // 数据就绪后再恢复文件夹/记事本：文件夹找空位时能看到已渲染的图标，避免抢占
  renderTrash();
  startClock();
  initVolume();   // 初始化状态栏音量控件
  // 按设置里的间隔静默轮询“运行中/离线”状态（设置→系统→状态自动刷新，0=关闭）
  restartAutoRefresh();
  toast('⏻ 关机在开始菜单 · 🗑 回收站在桌面左下角 · 单击图标即打开应用 · Ctrl+K 搜索');
}
