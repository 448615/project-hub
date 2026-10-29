// 统一错误页 + 浮层收敛（下拉菜单/抽屉等）。
import { esc } from '../ui/dom.js';
import { setView } from './shell.js';

export function renderError(code, title, desc) {
  setView(`<div class="err-page"><div class="code">${code}</div><h2>${esc(title)}</h2><p class="muted">${esc(desc)}</p>
    <p><a class="btn primary" href="#/">返回首页</a></p></div>`);
}

// ---------- 启动 ----------
// 路由切换时收起浮层（抽屉/弹窗/消息菜单），避免覆盖新页面
export function dismissOverlays() {
  document.querySelectorAll('.drawer-mask, .modal-mask').forEach((m) => m.remove());
  const mm = document.getElementById('msg-menu'); if (mm) mm.classList.remove('open');
}
