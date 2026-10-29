// 文章编辑页 + 侧滑详情抽屉（草稿自动保存、审核流转、富文本编辑）。
import { ICONS } from '../core/constants.js';
import { api } from '../core/api.js';
import { esc, toast, setLoading } from '../ui/dom.js';
import { openDrawer } from '../ui/drawer.js';
import { createEditor } from '../ui/editor.js';
import { toUtcSql, toLocalInput } from '../core/format.js';
import { draftKey } from '../core/draft.js';
import { installAutosave, renderWorkflowBar } from './posts.js';
import { markRequiredInvalid } from '../ui/form.js';
import { can } from '../core/permissions.js';
import { setView } from './shell.js';
import { router } from '../core/router.js';

export async function renderEditor(id) {
  let row = null, cats = [], tags = [];
  try {
    [cats, tags] = [(await api('/categories')).rows, (await api('/tags')).rows];
    if (id) row = (await api('/posts/' + id)).row;
  } catch (e) { toast(e.message, 'error'); }
  const canPublish = can('post:publish');
  const selTags = new Set(row ? row.tag_ids : []);
  setView(`<div class="toolbar"><a class="btn" href="#/posts">← 返回列表</a><div class="grow"></div>
    <span class="autosave-hint" id="e-saved"></span>
    <button class="btn primary" id="save">保存</button></div>
    <div class="panel">
      <div class="field"><label>标题 <span class="req">*</span></label><input class="input" id="e-title" value="${row ? esc(row.title) : ''}"></div>
      <div class="row">
        <div class="field" style="flex:1"><label>类型</label>
          <select class="select" id="e-type"><option value="article">文章</option><option value="notice">公告</option></select></div>
        <div class="field" style="flex:1"><label>分类 <span class="req">*</span></label>
          <select class="select" id="e-cat">${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><label>状态</label>
          <select class="select" id="e-status">
            <option value="draft">草稿</option><option value="pending">待审核</option>
            <option value="scheduled">定时发布</option>
            <option value="published" ${canPublish ? '' : 'disabled'}>已发布${canPublish ? '' : '（无权限）'}</option>
            <option value="offline">已下线</option>
          </select></div>
      </div>
      <div class="field" id="e-sched-field" style="display:none"><label>计划发布时间</label>
        <input type="datetime-local" class="input" id="e-schedule" style="max-width:280px">
        <span class="muted">选择未来时间，到点后内容将自动发布（需有发布权限）。</span>
      </div>
      <div class="field"><label>标签</label><div class="chips" id="e-tags">${tags.map((t) => `<span class="chip ${selTags.has(t.id) ? 'on' : ''}" data-id="${t.id}">${esc(t.name)}</span>`).join('')}</div></div>
      <div class="field"><label>摘要</label><textarea class="input" id="e-summary" style="min-height:60px">${row ? esc(row.summary) : ''}</textarea></div>
      <div class="field"><label>正文 <span class="req">*</span></label><input type="hidden" id="e-content"><div id="e-editor-mount"></div></div>
      <div class="field"><label>封面图</label>
        <input type="file" id="e-file" accept="image/*">
        <div id="e-cover" style="margin-top:8px">${row && row.cover_image ? `<img src="${esc(row.cover_image)}" class="thumb" style="height:60px">` : '<span class="muted">未设置</span>'}</div>
      </div>
      <div class="err" id="e-err"></div>
    </div>`);
  if (row) { document.getElementById('e-type').value = row.type; document.getElementById('e-cat').value = row.category_id || ''; document.getElementById('e-status').value = row.status; }
  const eStatus = document.getElementById('e-status');
  const eSchedField = document.getElementById('e-sched-field');
  const eSched = document.getElementById('e-schedule');
  const syncSched = () => { const on = eStatus.value === 'scheduled'; eSchedField.style.display = on ? '' : 'none'; };
  eStatus.addEventListener('change', syncSched);
  if (row && row.status === 'scheduled') eSched.value = toLocalInput(row.scheduled_at);
  syncSched();
  let coverImage = row ? row.cover_image : null;
  document.getElementById('e-tags').querySelectorAll('.chip').forEach((c) => (c.onclick = () => {
    c.classList.toggle('on'); const idv = +c.dataset.id;
    if (selTags.has(idv)) selTags.delete(idv); else selTags.add(idv);
  }));
  document.getElementById('e-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try { const d = await api('/media', { method: 'POST', body: fd }); coverImage = d.row.url;
      document.getElementById('e-cover').innerHTML = `<img src="${esc(coverImage)}" class="thumb" style="height:60px">`; toast('封面上传成功', 'success'); }
    catch (e2) { toast(e2.message, 'error'); }
  };
  let draftSchedule = null;
  const editor = createEditor({
    mount: document.getElementById('e-editor-mount'),
    value: row ? row.content : '',
    minHeight: 300, placeholder: '在此撰写正文，使用上方工具栏设置标题、列表、引用、链接与图片…',
    onChange: (html) => { document.getElementById('e-content').value = html; if (draftSchedule) draftSchedule(); },
  });
  document.getElementById('e-content').value = row ? row.content : '';
  const eKey = draftKey(row ? row.id : null);
  const collectE = () => ({
    title: document.getElementById('e-title').value,
    type: document.getElementById('e-type').value,
    summary: document.getElementById('e-summary').value,
    content: document.getElementById('e-content').value,
    category_id: document.getElementById('e-cat').value,
    tag_ids: [...selTags],
    status: document.getElementById('e-status').value,
    cover_image: coverImage,
  });
  const eBase = row ? { title: row.title, type: row.type, summary: row.summary, content: row.content, category_id: row.category_id, tag_ids: row.tag_ids, status: row.status, cover_image: row.cover_image } : { title: '', type: 'article', summary: '', content: '', category_id: '', tag_ids: [], status: 'draft', cover_image: null };
  const as = installAutosave({ key: eKey, prefix: 'e', root: document, editor, collect: collectE, base: eBase, bannerParent: document.querySelector('.panel'), syncTags: (ids) => { selTags.clear(); ids.forEach((x) => selTags.add(x)); } });
  draftSchedule = as.schedule;
  document.getElementById('save').onclick = async () => {
    const btn = document.getElementById('save');
    const title = document.getElementById('e-title').value.trim();
    document.getElementById('e-content').value = editor.getValue();
    const content = document.getElementById('e-content').value.trim();
    const category_id = document.getElementById('e-cat').value;
    const err = document.getElementById('e-err'); err.textContent = '';
    if (markRequiredInvalid(document, ['e-title', 'e-content', 'e-cat'])) { err.textContent = '标题、正文与分类为必填项'; return; }
    setLoading(btn, true);
    const statusVal = document.getElementById('e-status').value;
    const payload = {
      title, type: document.getElementById('e-type').value, summary: document.getElementById('e-summary').value,
      content, category_id, tag_ids: [...selTags], status: statusVal, cover_image: coverImage,
      scheduled_at: statusVal === 'scheduled' ? toUtcSql(document.getElementById('e-schedule').value) : null,
    };
    try {
      if (row) { await api('/posts/' + row.id, { method: 'PUT', body: JSON.stringify(payload) }); toast('已更新', 'success'); }
      else { await api('/posts', { method: 'POST', body: JSON.stringify(payload) }); toast('已创建', 'success'); }
      as.clear();
      location.hash = '#/posts';
    } catch (e2) { err.textContent = e2.message; }
    finally { setLoading(btn, false); }
  };
}

// 抽屉式详情 + 快速编辑（从侧边滑入，保留列表/看板可见）
export async function openPostDrawer(id) {
  const dlg = openDrawer({ title: '内容详情 · 快速编辑', width: 480, body: '<div class="muted" style="padding:8px 0">加载中…</div>' });
  try {
    const [row, cats, tags] = [(await api('/posts/' + id)).row, (await api('/categories')).rows, (await api('/tags')).rows];
    const canPublish = can('post:publish');
    const selTags = new Set(row.tag_ids || []);
    dlg.body.innerHTML = `
      <div class="d-field"><span class="d-label">内容 ID</span><span>#${row.id}</span></div>
      <div class="d-field"><span class="d-label">作者</span><span>${esc(row.author_name || '-')}</span></div>
      <div class="d-field"><span class="d-label">浏览量</span><span>${row.views || 0}</span></div>
      <div class="d-field"><span class="d-label">创建时间</span><span>${esc((row.created_at || '').slice(0, 16))}</span></div>
      <div class="field" style="margin-top:14px"><label>标题</label><input class="input" id="d-title" value="${esc(row.title)}"></div>
      <div class="row">
        <div class="field" style="flex:1"><label>状态</label>
          <select class="select" id="d-status">
            <option value="draft">草稿</option><option value="pending">待审核</option>
            <option value="scheduled">定时发布</option>
            <option value="published" ${canPublish ? '' : 'disabled'}>已发布${canPublish ? '' : '（无权限）'}</option>
            <option value="offline">已下线</option>
          </select></div>
        <div class="field" style="flex:1"><label>分类</label>
          <select class="select" id="d-cat">${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field" id="d-sched-field" style="display:none"><label>计划发布时间</label>
        <input type="datetime-local" class="input" id="d-schedule" style="max-width:280px">
        <span class="muted">选择未来时间，到点后内容将自动发布（需有发布权限）。</span>
      </div>
      ${row.status === 'rejected' && row.reject_reason ? `<div class="reject-box"><span class="rb-ic">${ICONS.alert}</span><div><div class="rb-title">该内容已被驳回</div><div class="rb-reason">${esc(row.reject_reason)}</div></div></div>` : ''}
      <div id="d-wf"></div>
      <div class="field"><label>标签</label><div class="chips" id="d-tags">${tags.map((t) => `<span class="chip ${selTags.has(t.id) ? 'on' : ''}" data-id="${t.id}">${esc(t.name)}</span>`).join('')}</div></div>
      <div class="field"><label>摘要</label><textarea class="input" id="d-summary" style="min-height:60px">${esc(row.summary || '')}</textarea></div>
      <div class="field"><label>正文</label><input type="hidden" id="d-content"><div id="d-editor-mount"></div></div>
      ${row.cover_image ? `<div class="field"><label>封面</label><img src="${esc(row.cover_image)}" style="height:96px;border-radius:8px;border:1px solid var(--line)"></div>` : ''}
      <div class="err" id="d-err"></div>
      <div class="drawer-actions">
        <a class="btn" href="#/posts/${row.id}">打开完整编辑</a>
        <span class="autosave-hint" id="d-saved"></span>
        <button class="btn primary" id="d-save">保存</button>
      </div>`;
    dlg.body.querySelector('#d-status').value = row.status;
    dlg.body.querySelector('#d-cat').value = row.category_id || '';
    const dStatus = dlg.body.querySelector('#d-status');
    const dSchedField = dlg.body.querySelector('#d-sched-field');
    const dSched = dlg.body.querySelector('#d-schedule');
    const syncDSched = () => { dSchedField.style.display = dStatus.value === 'scheduled' ? '' : 'none'; };
    dStatus.addEventListener('change', syncDSched);
    if (row.status === 'scheduled') dSched.value = toLocalInput(row.scheduled_at);
    syncDSched();
    dlg.body.querySelectorAll('#d-tags .chip').forEach((c) => (c.onclick = () => c.classList.toggle('on')));
    const refreshWf = () => {
      // 工作流操作依赖最新状态：变更后重新拉取并刷新
      api('/posts/' + id).then(({ row: r2 }) => { row = r2; renderWorkflowBar(dlg.body.querySelector('#d-wf'), row, { onDone: refreshWf }); }).catch(() => {});
    };
    renderWorkflowBar(dlg.body.querySelector('#d-wf'), row, { onDone: refreshWf });
    let draftSchedule = null;
    const dEditor = createEditor({
      mount: dlg.body.querySelector('#d-editor-mount'),
      value: row.content || '', minHeight: 200, placeholder: '在此撰写正文…',
      onChange: (html) => { dlg.body.querySelector('#d-content').value = html; if (draftSchedule) draftSchedule(); },
    });
    dlg.body.querySelector('#d-content').value = row.content || '';
    const dKey = draftKey(id);
    const collectD = () => ({
      title: dlg.body.querySelector('#d-title').value,
      type: row.type || 'article',
      summary: dlg.body.querySelector('#d-summary').value,
      content: dlg.body.querySelector('#d-content').value,
      category_id: dlg.body.querySelector('#d-cat').value,
      tag_ids: [...dlg.body.querySelectorAll('#d-tags .chip.on')].map((c) => +c.dataset.id),
      status: dlg.body.querySelector('#d-status').value,
      cover_image: row.cover_image,
    });
    const dBase = { title: row.title, type: row.type, summary: row.summary, content: row.content, category_id: row.category_id, tag_ids: row.tag_ids, status: row.status, cover_image: row.cover_image };
    const dAs = installAutosave({ key: dKey, prefix: 'd', root: dlg.body, editor: dEditor, collect: collectD, base: dBase, bannerParent: dlg.body });
    draftSchedule = dAs.schedule;
    dlg.body.querySelector('#d-save').onclick = async () => {
      const btn = dlg.body.querySelector('#d-save');
      const title = dlg.body.querySelector('#d-title').value.trim();
      dlg.body.querySelector('#d-content').value = dEditor.getValue();
      const content = dlg.body.querySelector('#d-content').value.trim();
      const err = dlg.body.querySelector('#d-err'); err.textContent = '';
      if (markRequiredInvalid(dlg.body, ['d-title', 'd-content'])) { err.textContent = '标题与正文为必填项'; return; }
      setLoading(btn, true);
      const tag_ids = [...dlg.body.querySelectorAll('#d-tags .chip.on')].map((c) => +c.dataset.id);
      const dStatusVal = dlg.body.querySelector('#d-status').value;
      const payload = {
        title, type: row.type || 'article', summary: dlg.body.querySelector('#d-summary').value,
        content, category_id: dlg.body.querySelector('#d-cat').value, tag_ids,
        status: dStatusVal, cover_image: row.cover_image,
        scheduled_at: dStatusVal === 'scheduled' ? toUtcSql(dlg.body.querySelector('#d-schedule').value) : null,
      };
      try {
        await api('/posts/' + id, { method: 'PUT', body: JSON.stringify(payload) });
        dAs.clear();
        toast('已更新', 'success');
        dlg.root.classList.add('flash-ok');
        setTimeout(() => { dlg.close(); router(); }, 420);
      }
      catch (e2) { err.textContent = e2.message; setLoading(btn, false); }
    };
  } catch (e) { dlg.body.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// 必填校验：把为空的字段标记 aria-invalid（触发红边高亮），聚焦首个错误项，返回是否有错误
