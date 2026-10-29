// 052-role-data.js — 身份落地：取身份 → 应用角色 → 进入桌面
// 由 050-account.js 按函数边界切分；只做文件拆分，代码零改动。

// ---- 登录成功：取身份 → 应用角色 → 进入桌面 ----
async function enterApp() {
  try {
    const res = await apiFetch('/api/auth/me');
    const j = await res.json().catch(() => ({}));
    ME = j.ok ? j : { email: '', role: 'user' };
  } catch (e) {
    ME = { email: '', role: 'user' };
  }
  applyRole();
  load();   // 原有的桌面初始化（项目列表 / 图标 / 恢复数据 / 时钟…）
}

// 角色落地：body 类名驱动 CSS 隐藏 [data-admin-only]；任务栏渲染用户芯片
function applyRole() {
  const isAdmin = !!(ME && ME.role === 'admin');
  document.body.classList.toggle('role-admin', isAdmin);
  document.body.classList.toggle('role-user', !isAdmin);
  const chip = document.getElementById('userChip');
  const em = document.getElementById('userEmail');
  const role = document.getElementById('userRole');
  if (chip && ME) {
    chip.hidden = false;
    em.textContent = ME.email || '未知账号';
    em.title = ME.email || '';
    role.textContent = isAdmin ? '管理员' : '普通用户';
    role.className = 'user-role ' + (isAdmin ? 'admin' : 'user');
  }
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout && !btnLogout._wired) {
    btnLogout._wired = true;
    btnLogout.addEventListener('click', async () => {
      // 退出会连带清掉本机保存的密码（不清的话自动登录会立刻把人登回来），
      // 所以这里必须先确认一次，不能点一下就静默抹掉。
      const ok = await hubConfirm('退出当前账号？本机保存的密码会被清除，下次登录需重新输入。',
        { title: '退出登录', okText: '退出', danger: true });
      if (!ok) return;
      ME = null;
      await performLogout();   // 唯一的退出实现，内部会清凭证并重载
    });
  }
}
