// 010-window-layout.js — 窗口布局持久化、任务栏缩略图、角色图标
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 窗口布局持久化：记住每个窗口的 left/top/width/height，下次打开复位 =====
const LAYOUT_KEY = 'ph.winlayout';
function saveLayout(key, win) {
  if (!key || !win) return;
  const m = loadJSON(LAYOUT_KEY, {});
  m[key] = {
    left: parseInt(win.style.left) || 0,
    top: parseInt(win.style.top) || 0,
    width: parseInt(win.style.width) || 0,
    height: parseInt(win.style.height) || 0,
  };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(m)); } catch (e) {}
}
function applyLayout(win, key) {
  const l = loadJSON(LAYOUT_KEY, {})[key];
  if (!l) return;
  // 用 typeof 判断而非真值判断：窗口被拖到 left:0 时 0 是有效坐标，
  // if (l.left) 会把 0 当 falsy 跳过，导致靠左/靠上的窗口还原不了位置（N2）
  if (typeof l.left === 'number')   win.style.left = l.left + 'px';
  if (typeof l.top === 'number')    win.style.top = l.top + 'px';
  // 宽度/高度防御：历史坏数据（0 / 负数 / 过小）会压扁窗口，只应用合理尺寸
  if (typeof l.width === 'number' && l.width >= 200)  win.style.width = l.width + 'px';
  if (typeof l.height === 'number' && l.height >= 140) win.style.height = l.height + 'px';
}
function saveLayoutOfWin(win) {
  // 拖拽/拉伸结束时按元素反查其 openWins 的 key，再保存布局
  const entry = Object.entries(openWins).find(([, w]) => w.el === win);
  if (entry) saveLayout(entry[0], win);
}
// 窗口居中：按视口居中，底部给任务栏（54px + 10px 留边）留位；
// 窗口比视口大时回退到左上安全区，避免负坐标把窗口甩出屏幕。
function centerWin(win, w, h) {
  const left = Math.max(8, Math.round((window.innerWidth - w) / 2));
  const top = Math.max(8, Math.round((window.innerHeight - 64 - h) / 2));
  win.style.left = left + 'px';
  win.style.top = top + 'px';
}
// 统一的窗口注册入口：先还原布局，再登记到 openWins。
// openWins 是整个窗口系统的中枢——任务栏按钮、最小化/还原、单例去重、
// 布局反查全都依赖它。这行赋值曾因回归丢失导致所有窗口打开即崩，切勿删除。
function registerWindow(key, win, taskBtn) {
  applyLayout(win, key);
  openWins[key] = { el: win, taskBtn, minimized: false };
  // 任务栏 hover → 窗口缩略图仿真（系统窗口无 taskBtn 时跳过）
  if (taskBtn) {
    taskBtn.addEventListener('mouseenter', () => showTaskPreview(taskBtn, win));
    taskBtn.addEventListener('mouseleave', () => hideTaskPreview(taskBtn));
  }
}

// ===== 任务栏 hover 窗口缩略图（仿真）：克隆窗口缩小显示在按钮上方 =====
function showTaskPreview(taskBtn, win) {
  if (!taskBtn || !win || !taskBtn.isConnected || !win.isConnected || win._closing) return;
  hideTaskPreview(taskBtn);
  const nmEl = taskBtn.querySelector('.nm');
  const pv = document.createElement('div');
  pv.className = 'task-preview';
  pv.innerHTML = `<div class="tp-name"><span>${nmEl ? nmEl.textContent : '窗口'}</span></div><div class="tp-shot"></div>`;
  const shot = pv.querySelector('.tp-shot');
  const clone = win.cloneNode(true);
  clone.style.cssText += ';display:flex;position:absolute;left:0;top:0;animation:none;box-shadow:none;z-index:auto';
  clone.querySelectorAll('iframe').forEach(f => f.remove());   // 防 iframe 重载
  const w = win.offsetWidth || 560, h = win.offsetHeight || 360;
  const s = Math.min(228 / w, 146 / h);
  clone.style.transform = 'scale(' + s + ')';
  clone.style.transformOrigin = 'top left';
  shot.appendChild(clone);
  const r = taskBtn.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left + r.width / 2 - 114, window.innerWidth - 236));
  pv.style.left = left + 'px';
  pv.style.top = Math.max(4, r.top - 152 - 10) + 'px';
  document.body.appendChild(pv);
  taskBtn._preview = pv;
}
function hideTaskPreview(taskBtn) {
  if (!taskBtn) {
    document.querySelectorAll('.task-preview').forEach(p => p.remove());
    return;
  }
  if (taskBtn._preview) { taskBtn._preview.remove(); taskBtn._preview = null; }
}

let dragBlockUntil = 0;   // 拖动结束后短暂阻止 click/dblclick（防误触）
let fmClipboard = null;   // 文件管理器剪贴板：{action:'copy'|'cut', proj, rel, name}
// 桌面网格：起点 (26,26)，步长恒为「卡片尺寸 + 10」——拖动吸附，保证图标整齐。
// 密度只改卡片尺寸，步长由它推出来：这样任何一个密度下格子都不会小于卡片，
// 也就不会出现「相邻图标压在一起」。CSS 侧读同一组变量（--ic-w/--ic-h），
// 避免 JS 算的格子与 CSS 画的卡片各说各话。
const GRID_X = 26, GRID_Y = 26;
const GRID_GAP = 10;
let ICON_W = 116, ICON_H = 112;             // 卡片尺寸，随密度变化
let GRID_STEP_X = ICON_W + GRID_GAP, GRID_STEP_Y = ICON_H + GRID_GAP;
function applyDensity() {
  const d = SETTINGS.density || 'md';
  ICON_W = d === 'sm' ? 96 : d === 'lg' ? 136 : 116;
  ICON_H = d === 'sm' ? 92 : d === 'lg' ? 132 : 112;
  GRID_STEP_X = ICON_W + GRID_GAP;
  GRID_STEP_Y = ICON_H + GRID_GAP;
  const root = document.documentElement.style;
  root.setProperty('--ic-w', ICON_W + 'px');
  root.setProperty('--ic-h', ICON_H + 'px');
  root.setProperty('--ic-img', (d === 'sm' ? 40 : d === 'lg' ? 50 : 46) + 'px');
  root.setProperty('--ic-fs', (d === 'sm' ? 12 : d === 'lg' ? 13 : 12.5) + 'px');
}
function snapPos(x, y) {
  let gx = GRID_X + Math.round((x - GRID_X) / GRID_STEP_X) * GRID_STEP_X;
  let gy = GRID_Y + Math.round((y - GRID_Y) / GRID_STEP_Y) * GRID_STEP_Y;
  gx = Math.max(GRID_X, Math.min(gx, window.innerWidth - ICON_W - GRID_X));
  gy = Math.max(GRID_Y, Math.min(gy, window.innerHeight - 56 - ICON_H - GRID_Y));
  return { x: gx, y: gy };
}
// 从目标格起找最近的空格（避免图标重叠）
function nextFree(x, y, takenSet) {
  const sx = Math.round((x - GRID_X) / GRID_STEP_X);
  const sy = Math.round((y - GRID_Y) / GRID_STEP_Y);
  const maxCol = Math.floor((window.innerWidth - GRID_X - ICON_W) / GRID_STEP_X);
  const maxRow = Math.floor((window.innerHeight - 56 - GRID_Y - ICON_H) / GRID_STEP_Y);
  for (let row = sy; row <= maxRow; row++) {
    for (let col = (row === sy ? sx : 0); col <= maxCol; col++) {
      const px = GRID_X + col * GRID_STEP_X, py = GRID_Y + row * GRID_STEP_Y;
      if (!takenSet.has(px + ',' + py)) return { x: px, y: py };
    }
  }
  return { x: GRID_X + sx * GRID_STEP_X, y: GRID_Y + sy * GRID_STEP_Y };
}
function findFreeGrid(x, y, excludeEl) {
  const taken = new Set();
  document.querySelectorAll('.desk-icon, .folder-item, .trash-item').forEach(el => {
    if (excludeEl && el === excludeEl) return;
    taken.add((parseInt(el.style.left) || 0) + ',' + (parseInt(el.style.top) || 0));
  });
  return nextFree(x, y, taken);
}
function collectTakenAll() {
  const t = new Set();
  document.querySelectorAll('.desk-icon, .folder-item, .trash-item').forEach(el => {
    t.add((parseInt(el.style.left) || 0) + ',' + (parseInt(el.style.top) || 0));
  });
  return t;
}
// 桌面元素指针拖拽：按住移动调位置（实时网格吸附）；松手点在文件夹上 = 拖入该文件夹（图标回弹原位）
function makeDesktopDraggable(el, onPos, opts) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    ox = parseInt(el.style.left) || 0; oy = parseInt(el.style.top) || 0;
    dragging = true; moved = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    // 位移超过 12px 才算真拖动：真人单击的轻微手抖不会误触（否则会吞掉单击打开）
    if (!moved && Math.abs(dx) + Math.abs(dy) > 12) {
      moved = true; el.style.zIndex = 60; el.classList.add('dragging');
    }
    if (moved) {
      const s = snapPos(ox + dx, oy + dy);   // 实时网格吸附，拖动也保持整齐
      el.style.left = s.x + 'px'; el.style.top = s.y + 'px';
    }
  });
  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (!moved) return;
    el.classList.remove('dragging');
    el.style.zIndex = '';
    dragBlockUntil = Date.now() + 500;   // 拖完 0.5 秒内忽略单击/双击
    const nx = parseInt(el.style.left) || ox, ny = parseInt(el.style.top) || oy;
    // 回收站不参与“拖入文件夹”，直接落位
    if (opts && opts.noDrop) {
      const free = findFreeGrid(nx, ny, el);
      el.style.left = free.x + 'px'; el.style.top = free.y + 'px';
      if (onPos) onPos(free.x, free.y);
      return;
    }
    // 拖入文件夹：松手点落在某个 folder-item 上（排除自身）
    const selfId = el.classList.contains('folder-item') ? el.dataset.id : null;
    let target = null;
    document.querySelectorAll('.folder-item').forEach(f => {
      if (f.dataset.id === selfId) return;
      const r = f.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) target = f;
    });
    if (target) {
      el.style.left = ox + 'px'; el.style.top = oy + 'px';   // 回弹原位，不落位
      const d = selfId ? { type: 'folder', key: selfId } : { type: 'icon', key: el.dataset.name };
      addFolderMember(target.dataset.id, d);
      return;
    }
    // 拖入回收站：松手点落在回收站图标上 → 删除 / 移入回收站
    if (!el.classList.contains('trash-item')) {
      let trashT = null;
      document.querySelectorAll('.trash-item').forEach(t => {
        const r = t.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) trashT = t;
      });
      if (trashT) {
        if (el.classList.contains('folder-item')) {
          deleteFolder(el.dataset.id);             // 桌面文件夹 → 移入回收站（含提示）
        } else {
          el.style.left = ox + 'px'; el.style.top = oy + 'px';   // 项目不可删，回弹原位
          toast('项目图标不能拖入回收站删除（项目在 config.json 中管理）');
        }
        return;
      }
    }
    const free = findFreeGrid(nx, ny, el);   // 吸附网格 + 避免重叠
    el.style.left = free.x + 'px'; el.style.top = free.y + 'px';
    if (onPos) onPos(free.x, free.y);
  });
}

// esc 转义函数已抽到 static/common.js（本文件前通过 <script> 引入，全局可用）

// ===== 角色主题图标：按项目 name 映射到 static/icons 下的图片 =====
const ICON_MAP = {
  cursors: '/static/icons/cursors.png',
  'demo-api': '/static/icons/api.png',
  'demo-scripts': '/static/icons/scripts.png',
  'demo-web': '/static/icons/web.png',
  starshu: '/static/icons/starshu.png',
  workbench: '/static/icons/workbench.png',
};
function iconHtml(p) {
  const img = ICON_MAP[p.name];
  return img
    ? `<span class="ic"><img src="${img}" alt=""></span>`
    : `<span class="ic">${esc(p.icon)}</span>`;
}

// 提示条：底部弹一句消息，2.6 秒后自动消失；同时记入通知中心（17）
const notifListEl = document.getElementById('notifList');
const notifBtn = document.getElementById('notifBtn');
const notifDot = document.getElementById('notifDot');
const notifPanel = document.getElementById('notifPanel');
let notifications = [];   // {msg, time}
function refreshNotifPanel() {
  if (!notifications.length) {
    notifListEl.innerHTML = '<div class="np-empty">暂无通知</div>';
    return;
  }
  notifListEl.innerHTML = notifications.map(n =>
    `<div class="np-item"><span class="np-msg">${esc(n.msg)}</span><span class="np-time">${esc(n.time)}</span></div>`
  ).join('');
}
function toast(msg) {
  if (SETTINGS.notif) {   // 设置=关通知：不弹浮层，仍记入通知中心
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toastEl.hidden = true; }, Number(SETTINGS.toastMs) || 2600);
  }
  // 记入通知中心（最近 50 条）
  notifications.unshift({ msg: String(msg), time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
  if (notifications.length > 50) notifications.length = 50;
  notifDot.hidden = false;
  refreshNotifPanel();
}
// 通知中心：面板完全由通知按钮的点击切换显隐控制——点击出现，再点一次消失。
// 不挂任何 mousemove / mousedown 自动关闭逻辑，平时（鼠标移开、点别处、任务栏收起）都不会自动关。
// ↑ 原 12 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 系统音效：Web Audio 合成，零外部资源（不占体积、无网络依赖） =====
// 浏览器自动播放策略要求首次用户交互后才能创建 AudioContext，故在首次 click/keydown 时惰性初始化。
let _audioCtx = null, _sfxOn = true;
function initAudioCtx() {
  if (_audioCtx) return;
  try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { _audioCtx = null; }
}
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
function setSfxOn(v) { _sfxOn = !!v; }
