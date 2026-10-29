// 角色与权限矩阵视图。
import { ICONS, PERMISSION_GROUPS } from '../core/constants.js';
import { api } from '../core/api.js';
import { esc, toast, setLoading, confirmDialog } from '../ui/dom.js';
import { modal, closeModal } from '../ui/modal.js';
import { can } from '../core/permissions.js';
import { markRequiredInvalid } from '../ui/form.js';
import { setView } from './shell.js';
import { renderError } from './error.js';
import { viewState } from '../core/runtime.js';

export async function renderRoles() {
  if (!can('role:view')) return renderError(403, '权限不足', '你没有访问角色权限管理的权限。');
  const canManage = can('role:manage');
  setView(`<div class="toolbar">
    <h2 style="margin:0">角色与权限</h2>
    <div class="grow"></div>
    ${canManage ? '<button class="btn primary" id="add-role">+ 新建角色</button>' : ''}
  </div>
  <div class="section-hint">角色决定用户能看到哪些菜单、能执行哪些操作。超级管理员始终拥有全部权限且不可降权。</div>
  <div class="roles-grid" id="roles"></div>`);

  function permCheckboxes(role) {
    const perms = role.permissions || (role.is_super ? PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)) : []);
    const disabled = !canManage || role.is_super ? 'disabled' : '';
    return PERMISSION_GROUPS.map((g) => `
      <div class="rc-group">
        <div class="rc-group-h">${g.label}</div>
        ${g.items.map((i) => `
          <label class="rc-perm"><input type="checkbox" data-perm="${i.key}" ${perms.includes(i.key) ? 'checked' : ''} ${disabled}>${i.label}</label>
        `).join('')}
      </div>`).join('');
  }

  const grid = document.getElementById('roles');
  async function load() {
    const epoch = viewState.epoch;
    const d = await api('/roles');
    if (epoch !== viewState.epoch) return;
    grid.innerHTML = d.rows.map((r) => `
      <div class="role-card" data-id="${r.id}">
        <div class="rc-head">
          <div class="rc-name">${esc(r.name)}
            ${r.is_system ? '<span class="badge b-published">系统</span>' : ''}
            ${r.is_super ? '<span class="badge b-admin">超管</span>' : ''}
          </div>
          <div class="rc-meta">${esc(r.key)} · ${r.memberCount} 名成员</div>
          <div class="rc-desc">${esc(r.description || '')}</div>
        </div>
        <div class="rc-perms">${permCheckboxes(r)}</div>
        ${canManage && !r.is_super
          ? `<div class="rc-actions">
              <button class="btn sm primary" data-save="${r.id}">保存</button>
              ${!r.is_system && r.memberCount === 0 ? `<button class="btn sm danger" data-del="${r.id}">删除</button>` : '<span class="muted" style="align-self:center">' + (r.is_system ? '系统内置角色' : '有成员，无法删除') + '</span>'}
            </div>`
          : (r.is_super ? '<div class="rc-actions muted">超级管理员权限不可更改</div>' : '')}
      </div>`).join('');
    grid.querySelectorAll('[data-save]').forEach((b) => (b.onclick = async () => {
      const card = b.closest('.role-card');
      const sel = [...card.querySelectorAll('input[data-perm]:checked')].map((c) => c.dataset.perm);
      try { await api('/roles/' + b.dataset.save, { method: 'PATCH', body: JSON.stringify({ permissions: sel }) }); toast('已保存权限', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }));
    grid.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确认删除该角色？删除后不可恢复。'))) return;
      try { await api('/roles/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); load(); }
      catch (e) { toast(e.message, 'error'); }
    }));
  }

  if (canManage) {
    document.getElementById('add-role').onclick = () => {
      const groupsHtml = PERMISSION_GROUPS.map((g) => `
        <div class="rc-group">
          <div class="rc-group-h">${g.label}</div>
          ${g.items.map((i) => `<label class="rc-perm"><input type="checkbox" data-perm="${i.key}">${i.label}</label>`).join('')}
        </div>`).join('');
      const m = modal(`<h3>新建角色</h3>
        <div class="field"><label>角色标识 <span class="req">*</span></label><input class="input" id="r-key" placeholder="如 operator（字母/数字/下划线）"></div>
        <div class="field"><label>角色名称 <span class="req">*</span></label><input class="input" id="r-name" placeholder="如 运营"></div>
        <div class="field"><label>描述</label><input class="input" id="r-desc" placeholder="该角色的职责说明"></div>
        <div class="field"><label>权限</label><div class="rc-perms" id="r-perms">${groupsHtml}</div></div>
        <div class="err" id="r-err"></div>
        <div class="actions"><button class="btn" id="r-cancel">取消</button><button class="btn primary" id="r-ok">创建</button></div>`);
      m.querySelector('#r-ok').onclick = async () => {
        const btn = m.querySelector('#r-ok'); const err = m.querySelector('#r-err'); err.textContent = '';
        if (markRequiredInvalid(m, ['r-key', 'r-name'])) { err.textContent = '标识与名称为必填项'; return; }
        const key = m.querySelector('#r-key').value.trim();
        const perms = [...m.querySelectorAll('#r-perms input[data-perm]:checked')].map((c) => c.dataset.perm);
        setLoading(btn, true);
        try {
          await api('/roles', { method: 'POST', body: JSON.stringify({ key, name: m.querySelector('#r-name').value.trim(), description: m.querySelector('#r-desc').value.trim(), permissions: perms }) });
          toast('已创建角色', 'success'); closeModal(m); load();
        } catch (e) { m.querySelector('#r-err').textContent = e.message; setLoading(btn, false); }
      };
      m.querySelector('#r-cancel').onclick = () => closeModal(m);
    };
  }
  load();
}

// ---------- 数据统计 ----------
