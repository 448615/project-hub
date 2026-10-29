// 抽屉（Drawer）：从右侧滑入，保留底层页面可见（半透明遮罩）。用于查看详情 / 编辑表单。
import { ICONS } from '../core/constants.js';
import { esc } from './dom.js';

export function openDrawer(opts) {
  const o = opts || {};
  const width = o.width || 460;
  const mask = document.createElement('div');
  mask.className = 'drawer-mask';
  mask.innerHTML = `<div class="drawer" style="width:${width}px;max-width:92vw">
    <div class="drawer-head">
      <div class="d-title">${esc(o.title || '')}</div>
      <button class="drawer-close" title="关闭">${ICONS.x}</button>
    </div>
    <div class="drawer-body">${o.body || ''}</div>
    ${o.footer ? `<div class="drawer-foot">${o.footer}</div>` : ''}
  </div>`;
  document.body.appendChild(mask);
  const drawer = mask.querySelector('.drawer');
  const bodyEl = mask.querySelector('.drawer-body');
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    mask.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => mask.remove(), 360);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  requestAnimationFrame(() => mask.classList.add('open'));
  document.addEventListener('keydown', onKey);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  mask.querySelector('.drawer-close').addEventListener('click', close);
  return { root: drawer, body: bodyEl, close };
}
