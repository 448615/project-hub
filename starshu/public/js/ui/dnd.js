// 拖拽排序（同组卡片：托起微抬 / 经过让位 / 松手完成 / 无效回弹）
// 仅在容器内的 .qa 卡片之间排序；松手落在容器外视为无效落点 → 不改数据、回弹原位并报错。
// 全局指针监听由 installDnd() 安装（在浏览器入口 init 时调用），保证模块顶层无 DOM 依赖。
import { toast } from './dom.js';

const _drag = { active: null };
let justDragged = false;

// 为某个容器开启拖拽排序；opts.onCommit(order) 在有效完成排序后回调（order 为 data-href 顺序数组）
export function makeSortable(container, opts) {
  opts = opts || {};
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const card = e.target.closest('.qa');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    _drag.active = {
      card, container, opts,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      startRect: rect, origNext: card.nextElementSibling,
      downX: e.clientX, downY: e.clientY, didDrag: false, placeholder: null,
    };
  });
}

function startSort(d) {
  d.didDrag = true;
  const card = d.card, rect = d.startRect;
  card.style.width = rect.width + 'px';
  card.style.height = rect.height + 'px';
  card.classList.add('dragging');
  const ph = document.createElement('div');
  ph.className = 'qa-placeholder';
  ph.style.width = rect.width + 'px';
  ph.style.height = rect.height + 'px';
  d.placeholder = ph;
  card.parentNode.insertBefore(ph, card);
  document.body.appendChild(card); // 移出容器避免 overflow 裁剪，使用视口坐标跟随
  d.container.classList.add('sorting');
}

function computeSortTarget(d, x, y) {
  const sibs = [...d.container.querySelectorAll('.qa')];
  if (!sibs.length) { d.container.appendChild(d.placeholder); return; }
  let nearest = null, nd = Infinity;
  for (const s of sibs) {
    const r = s.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < nd) { nd = dist; nearest = s; }
  }
  const r = nearest.getBoundingClientRect();
  const before = (y < r.top + r.height / 2) || (y >= r.top + r.height / 2 && x < r.left + r.width / 2);
  flipSort(d, () => {
    if (before) d.container.insertBefore(d.placeholder, nearest);
    else d.container.insertBefore(d.placeholder, nearest.nextSibling);
  });
}

// FLIP 动画：记录首末位置，让其它卡片平滑让位
function flipSort(d, mutate) {
  const els = [...d.container.querySelectorAll('.qa')];
  const first = new Map();
  els.forEach((el) => first.set(el, el.getBoundingClientRect()));
  mutate();
  els.forEach((el) => {
    const f = first.get(el); if (!f) return;
    const last = el.getBoundingClientRect();
    const dx = f.left - last.left, dy = f.top - last.top;
    if (!dx && !dy) return;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => { el.style.transition = 'transform .2s var(--ease)'; el.style.transform = ''; });
  });
}

function commitSort(d) {
  const card = d.card;
  const lastRect = card.getBoundingClientRect();
  d.container.insertBefore(card, d.placeholder);
  d.placeholder.remove();
  d.container.classList.remove('sorting');
  card.classList.remove('dragging');
  ['position', 'left', 'top', 'width', 'height', 'transform', 'zIndex', 'pointerEvents', 'margin'].forEach((p) => (card.style[p] = ''));
  const newRect = card.getBoundingClientRect();
  const dx = lastRect.left - newRect.left, dy = lastRect.top - newRect.top;
  if (dx || dy) {
    card.style.transition = 'none';
    card.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => { card.style.transition = 'transform .22s var(--ease)'; card.style.transform = ''; });
  }
  setTimeout(() => { card.style.transition = ''; }, 260);
  const order = [...d.container.querySelectorAll('.qa')].map((el) => el.getAttribute('data-href'));
  if (d.opts.onCommit) d.opts.onCommit(order);
  toast('已更新快捷入口顺序');
}

// 回弹归位（无效落点）
function springSort(d) {
  const card = d.card, orig = d.startRect;
  card.style.transition = 'left .3s var(--ease), top .3s var(--ease), transform .3s var(--ease), box-shadow .3s var(--ease)';
  card.style.left = orig.left + 'px';
  card.style.top = orig.top + 'px';
  card.style.transform = 'none';
  if (d.placeholder) d.placeholder.style.opacity = '0';
  setTimeout(() => {
    if (d.placeholder) d.placeholder.remove();
    d.container.classList.remove('sorting');
    d.container.insertBefore(card, d.origNext);
    card.classList.remove('dragging');
    card.style.cssText = '';
    card.style.transition = 'none';
    requestAnimationFrame(() => { card.style.transition = ''; });
  }, 320);
  toast('未放入有效区域，卡片已归位');
}

function isInside(el, x, y) {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// 安装全局拖拽监听（浏览器运行时调用一次）
export function installDnd() {
  document.addEventListener('pointermove', (e) => {
    const d = _drag.active; if (!d) return;
    if (!d.didDrag) {
      if (Math.hypot(e.clientX - d.downX, e.clientY - d.downY) < 6) return;
      startSort(d);
    }
    d.card.style.left = (e.clientX - d.offsetX) + 'px';
    d.card.style.top = (e.clientY - d.offsetY) + 'px';
    computeSortTarget(d, e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', (e) => {
    const d = _drag.active; if (!d) return;
    if (!d.didDrag) { _drag.active = null; return; } // 未拖动 → 视为点击，保留 <a> 跳转
    justDragged = true; // 阻止拖动后的误跳转
    if (isInside(d.container, e.clientX, e.clientY)) commitSort(d); else springSort(d);
    _drag.active = null;
  });
  document.addEventListener('pointercancel', () => {
    const d = _drag.active; if (!d || !d.didDrag) { _drag.active = null; return; }
    springSort(d); _drag.active = null;
  });
  document.addEventListener('click', (e) => {
    if (justDragged) { e.preventDefault(); e.stopPropagation(); justDragged = false; }
  }, true);
}
