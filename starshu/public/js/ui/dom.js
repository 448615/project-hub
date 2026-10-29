// DOM 工具：转义、消息提示、状态徽章、空状态、防抖
import { ICONS, STATUS_LABEL, BADGE_CLASS } from '../core/constants.js';
import { modal, closeModal } from './modal.js';

// 危险操作确认弹窗（替代原生 confirm，风格统一；返回 Promise<boolean>）
export function confirmDialog(message, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const m = modal(`
      <h3>${esc(o.title || '确认操作')}</h3>
      <p class="cf-msg">${esc(message)}</p>
      <div class="actions">
        <button class="btn" id="cf-no">取消</button>
        <button class="btn danger-solid" id="cf-yes">${esc(o.okText || '确认删除')}</button>
      </div>`);
    const done = (v) => { closeModal(m); resolve(v); };
    m.querySelector('#cf-no').onclick = () => done(false);
    m.querySelector('#cf-yes').onclick = () => done(true);
    m.addEventListener('click', (e) => { if (e.target === m) done(false); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); done(false); }
    });
  });
}

// 文本输入弹窗（用于驳回理由等场景），返回 Promise<string|null>（取消/关闭返回 null）
export function promptDialog(message, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const m = modal(`
      <h3>${esc(o.title || '请输入')}</h3>
      <p class="cf-msg">${esc(message)}</p>
      <textarea class="input" id="pd-input" style="min-height:84px" placeholder="${esc(o.placeholder || '')}"></textarea>
      <div class="err" id="pd-err"></div>
      <div class="actions">
        <button class="btn" id="pd-no">取消</button>
        <button class="btn primary" id="pd-yes">${esc(o.okText || '确定')}</button>
      </div>`);
    const input = m.querySelector('#pd-input');
    const err = m.querySelector('#pd-err');
    setTimeout(() => input && input.focus(), 30);
    const done = (v) => { closeModal(m); resolve(v); };
    m.querySelector('#pd-no').onclick = () => done(null);
    m.querySelector('#pd-yes').onclick = () => {
      const v = input.value.trim();
      if (o.required !== false && !v) { err.textContent = '内容不能为空'; return; }
      done(v);
    };
    m.addEventListener('click', (e) => { if (e.target === m) done(null); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); done(null); }
    });
  });
}

// HTML 转义，防止 XSS
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 轻量 toast 提示（懒加载 DOM 节点，避免模块顶层依赖 document）
let toastTimer = null;
export function toast(msg, type) {
  const $toast = document.getElementById('toast');
  if (!$toast) return;
  $toast.textContent = msg;
  $toast.classList.remove('success', 'error');
  if (type) $toast.classList.add(type);
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2600);
}

// 按钮 loading 态：显示旋转环并禁用，避免异步请求期间重复提交
export function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle('loading', !!on);
  btn.disabled = !!on;
}

// 统一空状态组件（全局复用）
export function emptyState(opts) {
  const o = opts || {};
  const icon = ICONS[o.icon] || ICONS.inbox;
  return `<div class="empty-state">
    <div class="es-ic">${icon}</div>
    <div class="es-title">${esc(o.title || '暂无数据')}</div>
    ${o.desc ? `<div class="es-desc">${esc(o.desc)}</div>` : ''}
    ${o.action ? `<div class="es-action">${o.action}</div>` : ''}
  </div>`;
}

// 状态徽章
export function statusBadge(s) {
  const t = STATUS_LABEL[s] || s;
  const c = BADGE_CLASS[s] || 'b-draft';
  return `<span class="badge ${c}">${t}</span>`;
}

// 防抖
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
