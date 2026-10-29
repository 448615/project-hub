// 用户管理视图。
import { ICONS } from '../core/constants.js';
import { api } from '../core/api.js';
import { state } from '../core/session.js';
import { esc, toast, setLoading, confirmDialog } from '../ui/dom.js';
import { modal, closeModal } from '../ui/modal.js';
import { can } from '../core/permissions.js';
import { setView } from './shell.js';
import { renderError } from './error.js';
import { viewState } from '../core/runtime.js';

export async function renderUsers() {
  if (!can('user:view')) return renderError(403, '权限不足', '你没有访问用户管理的权限。');
  const canManage = can('user:manage');
  setView(`<div class="card tbl-card"><table class="tbl"><thead><tr>
    <th>ID</th><th>邮箱</th><th>昵称</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>
    <tbody id="u-body"></tbody></table></div>`);
  const load = async () => {
    const epoch = viewState.epoch;
    const d = await api('/users');
    const roles = await api('/roles');
    if (epoch !== viewState.epoch) return;
    window.__roleOptions = roles.rows || [];
    const roleMap = {};
    roles.rows.forEach((r) => { roleMap[r.key] = r.name; });
    document.getElementById('u-body').innerHTML = d.rows.map((u) => `
      <tr><td>${u.id}</td><td>${esc(u.email)}</td><td>${esc(u.display_name || '-')}</td>
        <td><span class="badge ${u.role === 'admin' ? 'b-admin' : 'b-editor'}">${esc(roleMap[u.role] || u.role)}</span></td>
        <td><span class="badge ${u.status === 'active' ? 'b-active' : 'b-disabled'}">${u.status === 'active' ? '正常' : '禁用'}</span></td>
        <td class="muted">${esc((u.created_at || '').slice(0, 16))}</td>
        <td class="ops">${canManage ? `<button class="btn sm" data-edit="${u.id}">${ICONS.edit}设置</button>${u.id != state.user.id ? `<button class="btn sm danger" data-del="${u.id}">${ICONS.trash}删除</button>` : ''}` : '<span class="muted">只读</span>'}</td></tr>`).join('');
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openSet(d.rows.find((x) => x.id == b.dataset.edit))));
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('确认删除该用户？')) { await api('/users/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); load(); } }));
  };
  function openSet(u) {
    const roleOpts = (window.__roleOptions || []).map((r) => `<option value="${r.key}">${esc(r.name)}</option>`).join('');
    const m = modal(`<h3>用户设置 · ${esc(u.email)}</h3>
      <div class="field"><label>角色</label><select class="select" id="m-role">${roleOpts}</select></div>
      <div class="field"><label>状态</label><select class="select" id="m-status"><option value="active">正常</option><option value="disabled">禁用</option></select></div>
      <div class="err" id="m-err"></div>
      <div class="actions"><button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">保存</button></div>`);
    try { m.querySelector('#m-role').value = u.role; } catch (e) {}
    m.querySelector('#m-status').value = u.status;
    m.querySelector('#m-ok').onclick = async () => {
      const btn = m.querySelector('#m-ok');
      setLoading(btn, true);
      try {
        const r = await api('/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ role: m.querySelector('#m-role').value, status: m.querySelector('#m-status').value }) });
        toast('已更新', 'success');
        const mm = m.querySelector('.modal'); if (mm) mm.classList.add('flash-ok');
        if (r && r.changedSelf) { setTimeout(() => location.reload(), 420); return; }
        setTimeout(() => { closeModal(m); load(); }, 420);
      } catch (e) { m.querySelector('#m-err').textContent = e.message; setLoading(btn, false); }
    };
    m.querySelector('#m-cancel').onclick = () => closeModal(m);
  }
  load();
}

// ---------- 角色权限 ----------
