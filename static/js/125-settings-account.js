// 125-settings-account.js — 设置中心 · 账号页（当前账号 / 记住密码 / 空闲锁屏 / 退出登录）
// 由 120-theme-settings.js 的 openSettings 拆出；本文件只放声明，加载时不产生副作用。

function bindSettingsAccount(win) {
  const acctEmail = win.querySelector('#acctEmail');
  const acctRole = win.querySelector('#acctRole');
  const acctPwd = win.querySelector('#acctPwd');
  const acctReveal = win.querySelector('#acctReveal');
  const acctClear = win.querySelector('#acctClear');
  const setRemember = win.querySelector('#setRemember');

  // 当前账号身份
  if (acctEmail) acctEmail.textContent = (ME && ME.email) ? ME.email : '（未登录）';
  if (acctRole) acctRole.textContent = (ME && ME.role === 'admin') ? '管理员' : '普通用户';
  if (setRemember) setRemember.checked = rememberEnabled();

  // 本设备保存的密码：默认打点，点「显示」才出明文
  const revealed = () => !!(acctReveal && acctReveal.dataset.on);
  const renderSavedPwd = () => {
    if (!acctPwd) return;
    const s = loadSavedAccount() || {};
    acctPwd.textContent = (s.password && !revealed()) ? '••••••••' : (s.password || '（无）');
  };
  if (acctReveal) acctReveal.onclick = () => {
    acctReveal.dataset.on = acctReveal.dataset.on ? '' : '1';
    acctReveal.textContent = acctReveal.dataset.on ? '隐藏' : '显示';
    const s = loadSavedAccount() || {};
    if (acctPwd) acctPwd.textContent = (s.password && acctReveal.dataset.on) ? s.password : (s.password ? '••••••••' : '（无）');
  };
  if (acctClear) acctClear.onclick = async () => {
    const ok = await hubConfirm('清除本设备保存的密码？邮箱仍可自动填充。', { title: '清除保存的密码', okText: '清除' });
    if (!ok) return;
    clearSavedPassword();
    if (acctReveal) { acctReveal.dataset.on = ''; acctReveal.textContent = '显示'; }
    renderSavedPwd();
    toast('已清除本设备保存的密码');
  };
  if (setRemember) setRemember.onchange = (e) => {
    setRememberEnabled(e.target.checked);
    if (e.target.checked) {
      if (ME && ME.email) { const s = loadSavedAccount() || {}; saveAccountCreds(ME.email, s.password || '', true); }
      toast('已开启：下次自动填充账号');
    } else {
      clearSavedPassword();
      toast('已关闭：不再保存密码');
    }
  };
  renderSavedPwd();

  // 空闲自动锁屏（需先开启「启动锁屏」）
  settingsBindSeg(win, '#setIdleLock', 'idleLock');

  // 退出登录
  const logoutBtn = win.querySelector('#setLogout');
  if (logoutBtn) logoutBtn.onclick = async () => {
    // 文案必须说实话：早期这里写「账号密码会保留，下次可自动填充」，而自动登录上线后
    // 保留密码 = 退出后立刻被登回来。现在退出会清掉密码，提示要跟着改。
    const ok = await hubConfirm('退出当前账号？本机保存的密码会被清除，下次登录需重新输入。',
      { title: '退出登录', okText: '退出', danger: true });
    if (!ok) return;
    logoutBtn.disabled = true;
    ME = null;
    await performLogout();   // 唯一的退出实现：作废服务端会话 + 清本地凭证 + 重载
  };
}
