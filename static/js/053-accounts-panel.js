// 053-accounts-panel.js — 账号数据面板（管理员）
// 由 050-account.js 按函数边界切分；只做文件拆分，代码零改动。

// ---- 数据处理脚本 · 账号数据面板（一键运行后弹出；仅管理员）----
// 数据源：demo-scripts/hub_accounts.db（本地）与云库 hub_accounts（云端副本）。
// 服务端 /api/admin/accounts 强制校验 admin，前端隐藏只是体验层。
let _acctSource = 'local';
let _acctReveal = false;
let _acctData = null;

function openAccountsPanel() {
  if (!(ME && ME.role === 'admin')) { toast('仅管理员可打开账号数据'); return; }
  if (document.getElementById('acctPanel')) return;
  const veil = document.createElement('div');
  veil.id = 'acctPanel';
  veil.className = 'data-panel-veil';
  veil.innerHTML =
    '<div class="data-panel acct-panel">' +
      '<div class="data-panel-head">' +
        '<b>📊 账号数据</b>' +
        '<span class="acct-sec">🔒 加密存储</span>' +
        '<span class="data-panel-cloud" id="acctStatus">正在读取…</span>' +
        '<button class="data-panel-close" id="acctClose" title="关闭">✕</button>' +
      '</div>' +
      '<div class="acct-toolbar">' +
        '<div class="acct-tabs">' +
          '<button class="acct-tab active" data-src="local">本地库</button>' +
          '<button class="acct-tab" data-src="cloud">云端副本</button>' +
        '</div>' +
        '<button class="data-btn ghost" id="acctReveal">👁 显示密码</button>' +
        '<button class="data-btn ghost" id="acctSync">☁ 同步到云端</button>' +
        '<button class="data-btn ghost" id="acctRefresh">⟳ 刷新</button>' +
      '</div>' +
      '<div class="acct-table-wrap" id="acctBody"><div class="data-empty">加载中…</div></div>' +
      '<div class="acct-foot" id="acctFoot"></div>' +
    '</div>';
  document.body.appendChild(veil);
  veil.addEventListener('click', (e) => { if (e.target === veil) veil.remove(); });
  document.getElementById('acctClose').addEventListener('click', () => veil.remove());

  veil.querySelectorAll('.acct-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _acctSource = tab.dataset.src;
      veil.querySelectorAll('.acct-tab').forEach(t => t.classList.toggle('active', t === tab));
      loadAccounts();
    });
  });
  document.getElementById('acctReveal').addEventListener('click', (e) => {
    _acctReveal = !_acctReveal;
    e.currentTarget.textContent = _acctReveal ? '🙈 隐藏密码' : '👁 显示密码';
    renderAccounts();
  });
  document.getElementById('acctRefresh').addEventListener('click', loadAccounts);
  document.getElementById('acctSync').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      const res = await apiFetch('/api/admin/accounts/sync', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      toast('已同步 ' + (j.synced || 0) + ' 个账号到云端');
      await loadAccounts();
    } catch (err) {
      toast('同步失败：' + ((err && err.message) || err));
    } finally {
      btn.disabled = false;
      btn.textContent = '☁ 同步到云端';
    }
  });
  loadAccounts();
}

async function loadAccounts() {
  const bodyEl = document.getElementById('acctBody');
  const statusEl = document.getElementById('acctStatus');
  if (!bodyEl) return;
  if (statusEl) statusEl.textContent = '正在读取…';
  try {
    const res = await apiFetch('/api/admin/accounts?source=' + encodeURIComponent(_acctSource));
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    _acctData = j;
    if (statusEl) statusEl.textContent = (j.source === 'cloud' ? '云端' : '本地') + ' · ' + (j.total || 0) + ' 个账号';
    renderAccounts();
  } catch (e) {
    _acctData = null;
    if (statusEl) statusEl.textContent = '读取失败';
    bodyEl.innerHTML = '<div class="data-empty">读取失败：' + esc((e && e.message) || e) + '</div>';
  }
}

function renderAccounts() {
  const bodyEl = document.getElementById('acctBody');
  const footEl = document.getElementById('acctFoot');
  if (!bodyEl || !_acctData) return;
  const rows = _acctData.accounts || [];
  if (!rows.length) {
    bodyEl.innerHTML = '<div class="data-empty">暂无账号数据。</div>';
  } else {
    const head = '<div class="acct-row acct-head">' +
      '<span class="c-id">ID</span><span class="c-mail">邮箱</span>' +
      '<span class="c-user">用户名</span><span class="c-role">角色</span>' +
      '<span class="c-pwd">密码</span><span class="c-act">操作</span></div>';
    bodyEl.innerHTML = head + rows.map(a => {
      let pwd;
      if (!_acctReveal) pwd = '<span class="acct-mask">••••••</span>';
      else if (a.password) pwd = '<code>' + esc(a.password) + '</code>';
      else pwd = '<span class="acct-note">不可查看</span>';
      const isMe = ME && ME.email && a.email === ME.email;
      const ops = '<button class="acct-op" data-op="pwd" data-id="' + a.id + '">改密</button>' +
        '<button class="acct-op" data-op="role" data-id="' + a.id + '" data-role="' + esc(a.role) + '">' +
          (a.role === 'admin' ? '降级' : '升管理员') + '</button>' +
        (isMe ? '' : '<button class="acct-op danger" data-op="del" data-id="' + a.id + '">删除</button>');
      return '<div class="acct-row' + (isMe ? ' acct-me' : '') + '">' +
        '<span class="c-id">' + a.id + '</span>' +
        '<span class="c-mail">' + esc(a.email) + (isMe ? ' <i class="acct-self">我</i>' : '') + '</span>' +
        '<span class="c-user">' + esc(a.username || '') + '</span>' +
        '<span class="c-role"><b class="role-' + esc(a.role) + '">' + esc(a.role) + '</b></span>' +
        '<span class="c-pwd">' + pwd + '</span>' +
        '<span class="c-act">' + ops + '</span>' +
      '</div>';
    }).join('');
    bodyEl.querySelectorAll('.acct-op').forEach(btn => {
      btn.addEventListener('click', () => onAccountOp(btn));
    });
  }
  if (footEl) {
    const src = _acctData.source === 'cloud' ? '云端 hub_accounts' : (_acctData.db_path || 'demo-scripts/hub_accounts.db');
    footEl.textContent = '数据源：' + src + ' · 生成时间 ' + (_acctData.generated_at || '-');
  }
}

async function onAccountOp(btn) {
  const id = btn.dataset.id;
  const op = btn.dataset.op;
  const payload = { id: Number(id) };
  if (op === 'pwd') {
    const next = await hubPrompt('至少 6 位。', {
      title: '设置新密码', value: '', placeholder: '新密码（至少 6 位）', okText: '保存',
    });
    if (!next) return;
    if (next.length < 6) { toast('密码至少 6 位'); return; }
    payload.password = next;
  } else if (op === 'role') {
    payload.role = btn.dataset.role === 'admin' ? 'user' : 'admin';
  } else if (op === 'del') {
    const ok = await hubConfirm('确定删除该账号？不可恢复。', { title: '删除账号', okText: '删除', danger: true });
    if (!ok) return;
    payload.delete = true;
  } else {
    return;
  }
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/accounts/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    if (j.report) { _acctData = j.report; renderAccounts(); }
    toast('已更新');
  } catch (e) {
    toast('操作失败：' + ((e && e.message) || e));
    btn.disabled = false;
  }
}
