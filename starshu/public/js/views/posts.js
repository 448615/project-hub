// 内容列表：筛选/排序/分页/批量操作 + 审核工作流条 + 编辑页自动存草稿。
import { ICONS } from '../core/constants.js';
import { api } from '../core/api.js';
import { esc, toast, statusBadge, emptyState, debounce, confirmDialog, promptDialog } from '../ui/dom.js';
import { modal, closeModal } from '../ui/modal.js';
import { can } from '../core/permissions.js';
import { fmtUtc } from '../core/format.js';
import { draftKey, saveDraft, loadDraft, clearDraft, draftSig, hhmm } from '../core/draft.js';
import { viewState } from '../core/runtime.js';
import { setView } from './shell.js';
import { openPostDrawer } from './post-editor.js';

// 列表状态：筛选条件 + 分页 + 已勾选项（本视图私有）

export async function postTransition(id, action, reason) {
  const body = { action };
  if (reason != null) body.reason = reason;
  return api('/posts/' + id + '/transition', { method: 'POST', body: JSON.stringify(body) });
}

// 在指定容器内渲染工作流操作区（根据当前状态 + 当前用户权限）
// onDone 在状态变更成功后回调（用于刷新列表/抽屉）
export function renderWorkflowBar(container, row, { onDone } = {}) {
  if (!container) return;
  const status = row.status;
  const canEdit = can('post:edit') || can('post:manage');
  const canPublish = can('post:publish') || can('post:manage');
  const canManage = can('post:manage');
  const btns = [];
  if ((status === 'draft' || status === 'rejected') && canEdit) {
    btns.push(`<button class="btn sm primary" data-wf="submit">${ICONS.check}提交审核</button>`);
  }
  if (status === 'pending' && canPublish) {
    btns.push(`<button class="btn sm primary" data-wf="approve">${ICONS.check}通过并发布</button>`);
    btns.push(`<button class="btn sm danger" data-wf="reject">${ICONS.x}驳回</button>`);
  }
  if (status === 'published' && canManage) {
    btns.push(`<button class="btn sm" data-wf="offline">${ICONS.off}下线</button>`);
  }
  if (status === 'offline' && canManage) {
    btns.push(`<button class="btn sm" data-wf="restore">${ICONS.check}恢复为草稿</button>`);
  }
  if (!btns.length) { container.innerHTML = ''; return; }
  container.innerHTML = `<div class="wf-label">工作流操作</div><div class="wf-actions">${btns.join('')}</div>`;
  container.querySelectorAll('[data-wf]').forEach((b) => (b.onclick = async () => {
    const act = b.dataset.wf;
    try {
      if (act === 'reject') {
        const reason = (await promptDialog('请填写驳回理由', { placeholder: '例如：信息不实，请核实后重新提交', okText: '确认驳回' }))?.trim();
        if (!reason) return;
        await postTransition(row.id, 'reject', reason);
        toast('已驳回，作者将收到通知', 'success');
      } else {
        const map = { submit: '已提交审核', approve: '已通过并发布', offline: '已下线', restore: '已恢复为草稿' };
        await postTransition(row.id, act);
        toast(map[act] || '操作成功', 'success');
      }
      if (onDone) onDone();
    } catch (e) { toast(e.message, 'error'); }
  }));
}

// ---------- 路由 ----------

const postsState = { q: '', status: '', category_id: '', sort: 'created_at', order: 'desc', page: 1, pageSize: 10, selected: new Set() };
let postCatsCache = [], postTagsCache = [];
export async function renderPosts() {
  setView(`<div class="toolbar">
    <input class="input" id="f-q" placeholder="搜索标题/摘要" style="max-width:220px">
    <select class="select" id="f-status">
      <option value="">全部状态</option><option value="draft">草稿</option>
      <option value="pending">待审核</option><option value="scheduled">计划中</option><option value="published">已发布</option><option value="rejected">已驳回</option><option value="offline">已下线</option>
    </select>
    <select class="select" id="f-cat"><option value="">全部分类</option></select>
    <select class="select" id="f-sort">
      <option value="created_at">创建时间</option><option value="updated_at">更新时间</option>
      <option value="views">浏览量</option><option value="title">标题</option>
    </select>
    <select class="select" id="f-order"><option value="desc">降序</option><option value="asc">升序</option></select>
    <div class="grow"></div>
    <button class="btn" id="btn-export">${ICONS.download}导出 CSV</button>
    ${can('post:create') ? '<a class="btn primary" href="#/posts/new">+ 新建内容</a>' : ''}
  </div>
  <div id="batchbar"></div>
  <div class="card tbl-card"><table class="tbl" id="posts-tbl">
    <thead><tr>
      <th style="width:30px"><input type="checkbox" id="sel-all" class="check"></th>
      <th>标题</th><th>分类</th><th>状态</th><th>作者</th><th>浏览</th><th>更新时间</th><th>操作</th>
    </tr></thead><tbody id="posts-body"></tbody></table></div>
  <div class="pager" id="pager"></div>`);

  const epoch0 = viewState.epoch; // 渲染世代：await 后若已切换页面则中止，避免写入过期 DOM
  const cats = await api('/categories');
  if (viewState.epoch !== epoch0) return;
  cats.rows.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; document.getElementById('f-cat').appendChild(o); });
  postCatsCache = cats.rows;
  const tags = await api('/tags');
  if (viewState.epoch !== epoch0) return;
  postTagsCache = tags.rows;

  const fq = document.getElementById('f-q'), fs = document.getElementById('f-status'), fc = document.getElementById('f-cat'), fso = document.getElementById('f-sort'), fo = document.getElementById('f-order');
  fq.value = postsState.q; fs.value = postsState.status; fc.value = postsState.category_id; fso.value = postsState.sort; fo.value = postsState.order;
  const reload = () => loadPosts();
  fq.oninput = debounce(() => { postsState.q = fq.value; postsState.page = 1; reload(); }, 350);
  fs.onchange = () => { postsState.status = fs.value; postsState.page = 1; reload(); };
  fc.onchange = () => { postsState.category_id = fc.value; postsState.page = 1; reload(); };
  fso.onchange = () => { postsState.sort = fso.value; reload(); };
  fo.onchange = () => { postsState.order = fo.value; reload(); };
  document.getElementById('btn-export').onclick = () => {
    const q = new URLSearchParams({ q: postsState.q, status: postsState.status, category_id: postsState.category_id }).toString();
    window.open('api/posts/export?' + q, '_blank');
  };
  document.getElementById('sel-all').onchange = (e) => {
    document.querySelectorAll('.row-sel').forEach((cb) => { cb.checked = e.target.checked; toggleSel(cb); });
  };
  loadPosts();
}
export function toggleSel(cb) {
  const id = +cb.dataset.id;
  if (cb.checked) postsState.selected.add(id); else postsState.selected.delete(id);
  const tr = cb.closest('tr');
  if (tr) tr.classList.toggle('selected', cb.checked);
  renderBatchBar();
}
export function renderBatchBar() {
  const bar = document.getElementById('batchbar');
  if (!bar) return;
  if (postsState.selected.size === 0 || !can('post:manage')) { bar.innerHTML = ''; return; }
  const catOpts = postCatsCache.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  bar.innerHTML = `<span class="bb-count">已选 <b>${postsState.selected.size}</b> 项</span>
    <div class="bb-actions">
      <button class="btn sm" id="b-pub">${ICONS.check}设为已发布</button>
      <button class="btn sm" id="b-pend">提交审核</button>
      <button class="btn sm" id="b-off">设为下线</button>
      <span class="bb-sep"></span>
      <select class="select sm" id="b-cat"><option value="">移动分类…</option>${catOpts}</select>
      <button class="btn sm" id="b-cat-go">移动</button>
      <button class="btn sm" id="b-tag">${ICONS.tag}批量打标签</button>
      <span class="bb-sep"></span>
      <button class="btn sm danger" id="b-del">${ICONS.trash}批量删除</button>
      <button class="btn sm ghost" id="b-clear">取消</button>
    </div>`;
  bar.querySelector('#b-pub').onclick = () => batch('status', 'published');
  bar.querySelector('#b-pend').onclick = () => batch('status', 'pending');
  bar.querySelector('#b-off').onclick = () => batch('status', 'offline');
  bar.querySelector('#b-cat-go').onclick = () => {
    const v = bar.querySelector('#b-cat').value;
    if (!v) { toast('请先选择目标分类', 'error'); return; }
    batch('category', +v);
  };
  bar.querySelector('#b-tag').onclick = openBatchTagModal;
  bar.querySelector('#b-del').onclick = async () => { if (await confirmDialog('确认删除选中的 ' + postsState.selected.size + ' 项？删除后不可恢复。', { okText: '确认删除' })) batch('delete'); };
  bar.querySelector('#b-clear').onclick = () => { postsState.selected.clear(); document.querySelectorAll('.row-sel').forEach((c) => (c.checked = false)); document.querySelectorAll('.tbl tr.selected').forEach((tr) => tr.classList.remove('selected')); renderBatchBar(); };
}
export function openBatchTagModal() {
  const tags = postTagsCache || [];
  const sel = new Set();
  const m = modal(`<h3>批量打标签</h3>
    <p class="cf-msg">为选中的 ${postsState.selected.size} 项追加标签（不覆盖已有标签）</p>
    <div class="chips" id="bt-chips">${tags.length ? tags.map((t) => `<span class="chip" data-id="${t.id}">${esc(t.name)}</span>`).join('') : '<span class="muted">暂无标签，请先到“标签管理”创建</span>'}</div>
    <div class="actions"><button class="btn" id="bt-cancel">取消</button><button class="btn primary" id="bt-ok">确定</button></div>`);
  m.querySelectorAll('#bt-chips .chip').forEach((c) => (c.onclick = () => { c.classList.toggle('on'); const idv = +c.dataset.id; if (sel.has(idv)) sel.delete(idv); else sel.add(idv); }));
  m.querySelector('#bt-cancel').onclick = () => closeModal(m);
  m.querySelector('#bt-ok').onclick = () => {
    if (sel.size === 0) { toast('请至少选择一个标签', 'error'); return; }
    closeModal(m);
    batch('tags', [...sel]);
  };
}
export async function batch(action, extra) {
  const payload = { ids: [...postsState.selected], action };
  if (action === 'status') payload.status = extra;
  else if (action === 'category') payload.category_id = extra;
  else if (action === 'tags') payload.tag_ids = extra;
  try {
    const r = await api('/posts/batch', { method: 'PATCH', body: JSON.stringify(payload) });
    toast(`已处理 ${r.count != null ? r.count : postsState.selected.size} 项`, 'success');
    postsState.selected.clear(); loadPosts();
  } catch (e) { toast(e.message, 'error'); }
}
export async function loadPosts() {
  const epoch = viewState.epoch;
  const p = new URLSearchParams({
    q: postsState.q, status: postsState.status, category_id: postsState.category_id,
    sort: postsState.sort, order: postsState.order, page: postsState.page, pageSize: postsState.pageSize,
  }).toString();
  try {
    const d = await api('/posts?' + p);
    if (epoch !== viewState.epoch) return; // 已切换到其他页面，终止过期渲染
    const body = document.getElementById('posts-body');
    if (!d.rows.length) { body.innerHTML = `<tr><td colspan="8">${emptyState({ icon: 'doc', title: '暂无内容', desc: '点击右上角“新建内容”开始创作', action: '<a class="btn primary" href="#/posts/new">+ 新建内容</a>' })}</td></tr>`; document.getElementById('pager').innerHTML = ''; return; }
    body.innerHTML = d.rows.map((r) => `
      <tr class="${postsState.selected.has(r.id) ? 'selected' : ''}">
        <td><input type="checkbox" class="check row-sel" data-id="${r.id}" ${postsState.selected.has(r.id) ? 'checked' : ''}></td>
        <td><a class="t-link" href="#/posts/${r.id}">${esc(r.title)}</a>${r.cover_image ? `<span class="cover-ic" title="含封面">${ICONS.image}</span>` : ''}</td>
        <td>${esc(r.category_name || '-')}</td>
        <td>${statusBadge(r.status)}${r.status === 'scheduled' && r.scheduled_at ? `<div class="sched-hint">${ICONS.clock}${esc(fmtUtc(r.scheduled_at))}</div>` : ''}${r.status === 'rejected' && r.reject_reason ? `<button class="link-btn" data-reason="${r.id}">驳回原因</button>` : ''}</td>
        <td class="muted">${esc(r.author_name || '-')}</td>
        <td>${r.views || 0}</td>
        <td class="muted">${esc((r.updated_at || '').slice(0, 16))}</td>
        <td class="ops">
          <button class="btn sm" data-view="${r.id}">${ICONS.search}详情</button>
          <a class="btn sm" href="#/posts/${r.id}">${ICONS.edit}编辑</a>
          ${can('post:delete') ? `<button class="btn sm danger" data-del="${r.id}">${ICONS.trash}删除</button>` : ''}
        </td>
      </tr>`).join('');
    body.querySelectorAll('.row-sel').forEach((cb) => (cb.onchange = () => toggleSel(cb)));
    body.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => openPostDrawer(+b.dataset.view)));
    body.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('确认删除该内容？删除后不可恢复。'))) return;
      try { await api('/posts/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); loadPosts(); }
      catch (e) { toast(e.message, 'error'); }
    }));
    body.querySelectorAll('[data-reason]').forEach((b) => (b.onclick = async () => {
      try { const { row } = await api('/posts/' + b.dataset.reason); modal(`<h3>驳回理由</h3><p class="cf-msg" style="white-space:pre-wrap">${esc(row.reject_reason || '（无）')}</p><div class="actions"><button class="btn primary" id="rr-ok">知道了</button></div>`).querySelector('#rr-ok').onclick = (e) => closeModal(e.target.closest('.modal-mask')); }
      catch (e) { toast(e.message, 'error'); }
    }));
    const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
    const pg = document.getElementById('pager');
    pg.innerHTML = `共 ${d.total} 条 · 第 ${d.page}/${totalPages} 页
      <button class="btn sm" id="pg-p" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn sm" id="pg-n" ${d.page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    pg.querySelector('#pg-p').onclick = () => { postsState.page--; loadPosts(); };
    pg.querySelector('#pg-n').onclick = () => { postsState.page++; loadPosts(); };
  } catch (e) { toast(e.message, 'error'); }
}

// 在内容编辑场景接入“自动保存草稿 + 草稿恢复”（纯前端，写入 localStorage）
// opts: { key, prefix, root, editor, collect, base, bannerParent, syncTags }
//  - collect:    () => ({title,type,summary,content,category_id,tag_ids,status,cover_image})
//  - base:      服务端当前值对象（用于判断本地草稿是否与服务端一致）
//  - syncTags:  (tagIds) => void，仅在完整编辑页用于同步 selTags 闭包
export function installAutosave(opts) {
  const { key, prefix, root, editor, collect, base, bannerParent } = opts;
  const savedEl = root.querySelector('#' + prefix + '-saved');
  let timer = null;
  function flush() {
    const values = collect();
    saveDraft(key, values);
    if (savedEl) savedEl.textContent = '已自动保存 ' + hhmm();
  }
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(flush, 1200); }
  // 文本/下拉字段变化即安排自动保存
  ['title', 'type', 'status', 'cat', 'summary'].forEach((f) => {
    const el = root.querySelector('#' + prefix + '-' + f);
    if (el) { el.addEventListener('input', schedule); el.addEventListener('change', schedule); }
  });
  // 标签点选
  const tagsEl = root.querySelector('#' + prefix + '-tags');
  if (tagsEl) tagsEl.addEventListener('click', schedule);
  // 暴露给富文本编辑器 onChange 调用
  opts.schedule = schedule;
  // 恢复草稿到表单
  function applyDraft(d) {
    const q = (id) => root.querySelector('#' + prefix + '-' + id);
    if (q('title')) q('title').value = d.title || '';
    if (q('type')) q('type').value = d.type || 'article';
    if (q('summary')) q('summary').value = d.summary || '';
    if (q('content')) q('content').value = d.content || '';
    if (editor) editor.setValue(d.content || '');
    if (q('status')) q('status').value = d.status || 'draft';
    if (q('cat')) q('cat').value = d.category_id || '';
    if (tagsEl && Array.isArray(d.tag_ids)) {
      tagsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', d.tag_ids.includes(+c.dataset.id)));
      if (prefix === 'e' && typeof opts.syncTags === 'function') opts.syncTags(d.tag_ids);
    }
    if (savedEl) savedEl.textContent = '已恢复草稿';
  }
  // 打开时若本地草稿与服务端不一致，提示恢复
  const draft = loadDraft(key);
  if (draft && draft.data && draftSig(draft.data) !== draftSig(base || {})) {
    const bar = document.createElement('div');
    bar.className = 'draft-bar';
    bar.innerHTML = `<span class="draft-ic">${ICONS.clock}</span>
      <span class="draft-msg">检测到未保存的草稿（保存于 <b>${hhmm(draft.ts)}</b>），是否恢复？</span>
      <span class="draft-acts">
        <button class="btn sm" id="${prefix}-draft-restore">恢复草稿</button>
        <button class="btn sm ghost" id="${prefix}-draft-discard">丢弃</button>
      </span>`;
    bannerParent.insertBefore(bar, bannerParent.firstChild);
    bar.querySelector('#' + prefix + '-draft-restore').onclick = () => { applyDraft(draft.data); bar.remove(); };
    bar.querySelector('#' + prefix + '-draft-discard').onclick = () => { clearDraft(key); bar.remove(); if (savedEl) savedEl.textContent = ''; };
  }
  return { schedule, flush, clear: () => clearDraft(key) };
}

// ---------- 编辑器 ----------
