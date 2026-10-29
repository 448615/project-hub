// 130-lock-sticky.js — 锁屏与便签
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 锁屏 / 开机画面：加载先见锁屏，点击进入桌面 =====
// ↑ 原 21 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 桌面便签：多色便利贴，独立小窗，自动保存 =====
const STICKY_KEY = 'hub-stickies';
let stickySeq = 0;
let stickyRecords = {};
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
function saveStickies() { localStorage.setItem(STICKY_KEY, JSON.stringify(stickyRecords)); }
const STICKY_COLORS = ['yellow', 'pink', 'green', 'blue'];
let stickyColorIdx = 0;
// 便签拖动/缩放：全文档只挂一对监听，靠 _dragSticky / _resizeSticky 标记当前操作对象，
// 避免旧实现里每个 createSticky 都向 document 挂 mousemove/mouseup 且关闭时不移除 → 监听器泄漏。
let _dragSticky = null, _dragSx = 0, _dragSy = 0, _dragOx = 0, _dragOy = 0;
let _resizeSticky = null, _resizeW = 0, _resizeH = 0;
function _stickyDragMove(e) {
  if (_resizeSticky) {   // 右下角手柄：改尺寸（有下限，防拖没了）
    _resizeSticky.style.width  = Math.max(240, _resizeW + e.clientX - _dragSx) + 'px';
    _resizeSticky.style.height = Math.max(170, _resizeH + e.clientY - _dragSy) + 'px';
    return;
  }
  if (!_dragSticky) return;
  _dragSticky.style.left = (_dragOx + e.clientX - _dragSx) + 'px';
  _dragSticky.style.top = (_dragOy + e.clientY - _dragSy) + 'px';
}
function _stickyDragUp() {
  if (_resizeSticky) {
    const el = _resizeSticky; _resizeSticky = null;
    if (el._rec) {
      el._rec.width = el.offsetWidth;
      el._rec.height = el.offsetHeight;
      saveStickies();
    }
    return;
  }
  if (!_dragSticky) return;
  const el = _dragSticky; _dragSticky = null;
  if (el._rec) {
    el._rec.left = parseInt(el.style.left) || _dragOx;
    el._rec.top = parseInt(el.style.top) || _dragOy;
    saveStickies();
  }
}
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
function createSticky(data) {
  const id = data ? data.id : ('s' + (++stickySeq));
  // 这张便签已经贴在桌面上了：抬到最前就行，别重复创建（在「便签与记事本」里连点两下会走到这里）
  const exist = document.querySelector('.sticky[data-sid="' + id + '"]');
  if (exist) { exist.style.zIndex = ++zCounter; return exist; }
  const rec = data || (function () {
    const c = centerPos(300, 260);
    return {
      id, color: STICKY_COLORS[stickyColorIdx++ % STICKY_COLORS.length],
      text: '', left: c.left, top: c.top,
      width: 300, height: 260,
    };
  })();
  rec.open = true;                            // 贴在桌面上 = 打开状态（启动时只恢复 open 的记录）
  if (!isFinite(rec.ts)) rec.ts = Date.now(); // 改动时间：决定启动时优先恢复哪一条
  stickyRecords[id] = rec;
  saveStickies();
  const el = document.createElement('div');
  el.className = 'sticky c-' + rec.color;
  el.dataset.sid = id;
  el.style.left = rec.left + 'px'; el.style.top = rec.top + 'px';
  el.style.width = (rec.width || 300) + 'px'; el.style.height = (rec.height || 260) + 'px';
  el.innerHTML = `
    <div class="st-bar">
      <span class="st-dots">${STICKY_COLORS.map(c =>
        `<i data-c="${c}" title="换色" style="background:${c === 'yellow' ? '#ffe98a' : c === 'pink' ? '#ffb9cf' : c === 'green' ? '#b7ecc0' : '#b7d8ff'}"></i>`).join('')}</span>
      <button class="st-save" title="保存到项目桌面">💾</button>
      <button class="st-mode" title="切换待办/便签">☑</button>
      <button class="st-x" title="收起便签（内容保留，可在「便签与记事本」里找回）">✕</button>
    </div>
    <textarea placeholder="随手记点什么…">${esc(rec.text)}</textarea>
    <div class="st-todo" style="display:none">
      <div class="st-list"></div>
      <div class="st-add"><input class="st-add-in" placeholder="添加事项，回车确认"><button class="st-add-btn">＋</button></div>
    </div>
    <div class="st-foot"><span class="st-len">0 字</span><span class="st-time">${rec.time || ''}</span></div>
    <div class="st-resize" title="拖动调整大小"></div>`;
  document.body.appendChild(el);
  const ta = el.querySelector('textarea');
  const todoBox = el.querySelector('.st-todo');
  const listEl = el.querySelector('.st-list');
  const addIn = el.querySelector('.st-add-in');
  const lenEl = el.querySelector('.st-len');
  const timeEl = el.querySelector('.st-time');
  const upd = () => {
    rec.text = ta.value;
    rec.time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    rec.ts = Date.now();          // 记录改动时间：启动时优先恢复最近动过的那一张
    rec.open = true;
    lenEl.textContent = ta.value.length + ' 字';
    timeEl.textContent = rec.time;
    saveStickies();
  };
  ta.addEventListener('input', () => {
    lenEl.textContent = ta.value.length + ' 字';
    clearTimeout(upd._t);
    upd._t = setTimeout(upd, 400);   // 自动保存（400ms 防抖）
  });
  // ---- 待办模式：把 textarea 内容按 Markdown 待办语法解析渲染 ----
  function syncTextToTa() { ta.value = rec.text; lenEl.textContent = ta.value.length + ' 字'; }
  function renderTodo() {
    const lines = rec.text.split('\n');
    listEl.innerHTML = '';
    let hasAny = false;
    lines.forEach((raw, i) => {
      if (!raw.trim()) return;
      hasAny = true;
      const m = raw.match(/^\s*- \[([xX ])\]\s*(.*)$/);
      const checked = m ? m[1].toLowerCase() === 'x' : false;
      const txt = m ? m[2] : raw.replace(/^\s*- /, '');
      const row = document.createElement('div');
      row.className = 'st-todo-item' + (checked ? ' done' : '');
      row.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><span class="st-todo-txt">${esc(txt)}</span><button class="st-todo-del" title="删除">✕</button>`;
      row.querySelector('input').onchange = () => {
        const L = rec.text.split('\n');
        const old = L[i];
        L[i] = row.querySelector('input').checked
          ? old.replace(/^(\s*- \[)[xX ](\])/, '$1x$2')
          : old.replace(/^(\s*- \[)[xX ](\])/, '$1 $2');
        if (!m) L[i] = (row.querySelector('input').checked ? '- [x] ' : '- [ ] ') + txt;
        rec.text = L.join('\n');
        syncTextToTa();
        saveStickies();
        renderTodo();
      };
      row.querySelector('.st-todo-del').onclick = () => {
        const L = rec.text.split('\n');
        L.splice(i, 1);
        rec.text = L.join('\n');
        syncTextToTa();
        saveStickies();
        renderTodo();
      };
      listEl.appendChild(row);
    });
    if (!hasAny) listEl.innerHTML = '<div class="st-todo-empty">还没有事项，下面添加～</div>';
  }
  function addTodo() {
    const v = addIn.value.trim();
    if (!v) return;
    rec.text = (rec.text ? rec.text.replace(/\n+$/, '') + '\n' : '') + '- [ ] ' + v;
    addIn.value = '';
    syncTextToTa();
    saveStickies();
    renderTodo();
  }
  el.querySelector('.st-add-btn').onclick = addTodo;
  addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTodo(); } });
  // 模式切换：便签 ⇄ 待办
  el.querySelector('.st-mode').onclick = (e) => {
    e.stopPropagation();
    const todoMode = todoBox.style.display !== 'none';
    todoBox.style.display = todoMode ? 'none' : '';
    ta.style.display = todoMode ? '' : 'none';
    el.querySelector('.st-mode').textContent = todoMode ? '☑' : '📝';
    if (!todoMode) { rec.text = ta.value; renderTodo(); }
  };
  // 手动保存：立即落盘并反馈
  el.querySelector('.st-save').onclick = (e) => {
    e.stopPropagation();
    upd();
    toast('便签已保存到项目桌面');
  };
  // 换色
  el.querySelectorAll('.st-dots i').forEach(dot => {
    dot.onclick = (e) => {
      e.stopPropagation();
      const c = dot.dataset.c;
      rec.color = c;
      el.className = 'sticky c-' + c;
      saveStickies();
    };
  });
  // 关闭 = 收起：内容照旧落盘，但这张便签不再自动回到桌面（否则关一次、下次打开又全冒出来），
  // 需要时从「便签与记事本」里点开。
  el.querySelector('.st-x').onclick = () => {
    upd();                 // 先落盘最新文字
    rec.open = false;      // 标记为已收起
    saveStickies();
    el.remove();
    toast('便签已收起，可在「便签与记事本」里找回');
  };
  // 右下角缩放手柄（复用单例拖拽监听）
  el.querySelector('.st-resize').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    _resizeSticky = el; el._rec = rec;
    _dragSx = e.clientX; _dragSy = e.clientY;
    _resizeW = el.offsetWidth; _resizeH = el.offsetHeight;
    el.style.zIndex = ++zCounter;
  });
  // 拖动（按住标题条，自由移动不吸附网格）—— 复用模块级单例监听，关闭便签不再泄漏监听器
  const bar = el.querySelector('.st-bar');
  bar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _dragSticky = el; el._rec = rec;
    _dragSx = e.clientX; _dragSy = e.clientY;
    _dragOx = parseInt(el.style.left) || 0; _dragOy = parseInt(el.style.top) || 0;
    el.style.zIndex = ++zCounter;
  });
  // 文字区点击置顶
  ta.addEventListener('mousedown', () => { el.style.zIndex = ++zCounter; });
  return el;
}
// ↑ 原 7 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
