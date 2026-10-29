// 标签管理视图。
import { ICONS } from '../core/constants.js';
import { api } from '../core/api.js';
import { esc, toast, setLoading, confirmDialog } from '../ui/dom.js';
import { modal, closeModal } from '../ui/modal.js';
import { can } from '../core/permissions.js';
import { markRequiredInvalid } from '../ui/form.js';
import { setView } from './shell.js';
import { renderError } from './error.js';
import { viewState } from '../core/runtime.js';

export async function renderTags() {
  if (!can('tag:view')) return renderError(403, '权限不足', '你没有访问标签管理的权限。');
  const canManage = can('tag:manage');
  setView(`<div class="toolbar"><div class="grow"></div>${canManage ? '<button class="btn primary" id="add">+ 新建标签</button>' : ''}</div>
    <div class="card tbl-card"><table class="tbl"><thead><tr><th>名称</th><th>slug</th><th>操作</th></tr></thead>
    <tbody id="tag-body"></tbody></table></div>`);
  const load = async () => {
    const epoch = viewState.epoch;
    const d = await api('/tags');
    if (epoch !== viewState.epoch) return;
    document.getElementById('tag-body').innerHTML = d.rows.map((c) => `
      <tr><td>${esc(c.name)}</td><td class="muted">${esc(c.slug)}</td>
      <td class="ops">${canManage ? `<button class="btn sm" data-edit="${c.id}">${ICONS.edit}编辑</button><button class="btn sm danger" data-del="${c.id}">${ICONS.trash}删除</button>` : '<span class="muted">只读</span>'}</td></tr>`).join('');
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openForm(d.rows.find((x) => x.id == b.dataset.edit))));
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('确认删除该标签？')) { await api('/tags/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); load(); } }));
  };
  function openForm(row) {
    const m = modal(`<h3>${row ? '编辑标签' : '新建标签'}</h3>
      <div class="field"><label>名称 <span class="req">*</span></label><input class="input" id="m-name" value="${row ? esc(row.name) : ''}"></div>
      <div class="field"><label>slug <span class="req">*</span></label><input class="input" id="m-slug" value="${row ? esc(row.slug) : ''}"></div>
      <div class="err" id="m-err"></div>
      <div class="actions"><button class="btn" id="m-cancel">取消</button><button class="btn primary" id="m-ok">保存</button></div>`);
    m.querySelector('#m-ok').onclick = async () => {
      const btn = m.querySelector('#m-ok');
      const err = m.querySelector('#m-err'); err.textContent = '';
      if (markRequiredInvalid(m, ['m-name', 'm-slug'])) { err.textContent = '名称与 slug 为必填项'; return; }
      const body = { name: m.querySelector('#m-name').value.trim(), slug: m.querySelector('#m-slug').value.trim() };
      setLoading(btn, true);
      try {
        if (row) await api('/tags/' + row.id, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/tags', { method: 'POST', body: JSON.stringify(body) });
        toast('已保存', 'success');
        const mm = m.querySelector('.modal'); if (mm) mm.classList.add('flash-ok');
        setTimeout(() => { closeModal(m); load(); }, 420);
      } catch (e) { m.querySelector('#m-err').textContent = e.message; setLoading(btn, false); }
    };
    m.querySelector('#m-cancel').onclick = () => closeModal(m);
  }
  document.getElementById('add').onclick = () => openForm(null);
  load();
}

// ---------- 媒体库 ----------
