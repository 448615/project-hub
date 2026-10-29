// 媒体库视图：上传、预览、删除。
import { ICONS } from '../core/constants.js';
import { api } from '../core/api.js';
import { esc, toast, emptyState, confirmDialog } from '../ui/dom.js';
import { can } from '../core/permissions.js';
import { setView } from './shell.js';
import { renderError } from './error.js';
import { viewState } from '../core/runtime.js';

export async function renderMedia() {
  if (!can('media:view')) return renderError(403, '权限不足', '你没有访问媒体库的权限。');
  const canManage = can('media:manage');
  setView(`${canManage ? `<div class="dropzone" id="dropzone">
      <div class="dz-ic">${ICONS.upload}</div>
      <div class="dz-title">拖拽文件到此处上传</div>
      <div class="dz-sub">支持图片 / 文档（单文件 ≤ 5MB），或点击下方按钮选择</div>
      <button class="btn primary" id="up-btn">选择文件</button>
      <input type="file" id="up" style="display:none" multiple accept="image/*,.pdf,.doc,.docx">
    </div>` : ''}
    <div class="media-grid" id="grid"></div>`);
  if (canManage) {
    const dz = document.getElementById('dropzone');
    const up = document.getElementById('up');
    const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);
    dz.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dz.classList.add('drag-over'); });
    dz.addEventListener('dragleave', (e) => { if (e.target === dz || !dz.contains(e.relatedTarget)) dz.classList.remove('drag-over'); });
    dz.addEventListener('drop', async (e) => { if (!hasFiles(e)) return; e.preventDefault(); dz.classList.remove('drag-over'); await handleFiles(e.dataTransfer.files); });
    dz.querySelector('#up-btn').onclick = () => up.click();
    up.onchange = async () => { await handleFiles(up.files); up.value = ''; };
  }
  async function handleFiles(files) {
    files = files || [];
    if (!files.length) return;
    let ok = 0, fail = 0;
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file);
      try { await api('/media', { method: 'POST', body: fd }); ok++; }
      catch (err) { fail++; toast(err.message); }
    }
    if (ok) toast(`成功上传 ${ok} 个文件` + (fail ? `，${fail} 个失败` : ''));
    else if (fail) toast(`${fail} 个文件上传失败`);
    load();
  }
  async function load() {
    const epoch = viewState.epoch;
    const d = await api('/media');
    if (epoch !== viewState.epoch) return;
    const grid = document.getElementById('grid');
    if (!d.rows.length) { grid.innerHTML = emptyState({ icon: 'image', title: '暂无文件', desc: canManage ? '拖拽文件到上方区域，或点击“选择文件”添加素材' : '当前暂无媒体文件' }); return; }
    grid.innerHTML = d.rows.map((m) => `
      <div class="media-item">
        <div class="prev">${m.mime_type && m.mime_type.startsWith('image/') ? `<img src="api/media/${m.id}/file" loading="lazy">` : `<span class="file-ic">${ICONS.doc}</span>`}</div>
        <div class="meta"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.original_name)}</div>
        <div class="muted">${(m.size / 1024).toFixed(0)} KB</div>
        ${canManage ? `<button class="btn sm danger" data-del="${m.id}" style="margin-top:4px">${ICONS.trash}删除</button>` : ''}</div>
      </div>`).join('');
    grid.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('确认删除该文件？')) { await api('/media/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'success'); load(); } }));
  }
  load();
}

// ---------- 用户管理 ----------
