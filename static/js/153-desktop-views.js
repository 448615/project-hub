// 153-desktop-views.js — 虚拟桌面与任务视图
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ---- 22 虚拟桌面（切换带过渡动画 + 提示） ----
let currentDesk = 0;
const DESK_COUNT = 3;
// 让单个窗口按方向做“滑入/滑出”动画：纯 transform（GPU 合成，不触发重排，丝滑）。
// mode='in'：从屏外滑入到原位；mode='out'：滑出到屏外后隐藏。dirSign>0 向右、<0 向左。
function deskAnimWin(win, mode, dirSign) {
  const off = dirSign > 0 ? '110vw' : '-110vw';   // 多留 10vw 余量，确保完全滑出视野
  win.style.willChange = 'transform, opacity';
  win.style.transition = 'transform .4s cubic-bezier(.22,.61,.36,1), opacity .32s ease';
  if (mode === 'in') {
    win.style.display = '';
    win.style.opacity = '0';
    win.style.transform = 'translateX(' + off + ')';
    void win.offsetWidth;                          // 强制回流：先让“停在屏外”这一帧生效，下一帧才过渡到 0
    win.style.opacity = '1';
    win.style.transform = 'translateX(0)';
    setTimeout(() => { if (Number(win.dataset.desk || 0) === currentDesk) win.style.willChange = 'auto'; }, 440);
  } else {                                         // out
    win.style.opacity = '1';
    win.style.transform = 'translateX(' + off + ')';
    const w = win;
    setTimeout(() => {
      // 动画跑完才真正隐藏；若期间又切回本桌面则不误杀（防快速连切）
      if (Number(w.dataset.desk || 0) !== currentDesk) {
        w.style.display = 'none'; w.style.transform = ''; w.style.opacity = ''; w.style.willChange = 'auto';
      }
    }, 430);
  }
}
function applyDesk() {
  document.querySelectorAll('.desk-tab').forEach((t, i) => t.classList.toggle('active', i === currentDesk));
}
function switchDesk(d) {
  const from = currentDesk;
  const to = ((d % DESK_COUNT) + DESK_COUNT) % DESK_COUNT;
  if (to === from) return;
  currentDesk = to;
  applyDesk();
  const forward = to > from;                        // 向右切（下一桌面）还是向左切（上一桌面）
  Object.keys(openWins).forEach(k => {
    const w = openWins[k]; if (!w || !w.el) return;
    const desk = Number(w.el.dataset.desk || 0);
    if (desk === to)      deskAnimWin(w.el, 'in',  forward ? 1 : -1);   // 新桌面：从行进方向那侧滑入
    else if (desk === from) deskAnimWin(w.el, 'out', forward ? -1 : 1);  // 旧桌面：向反方向滑出
    else if (w.el.style.display !== 'none') { w.el.style.display = 'none'; w.el.style.transform = ''; }  // 其它桌面：保持隐藏
  });
  toast('已切换到 桌面 ' + (currentDesk + 1));
}
// 任务栏上方加桌面切换条
// ↑ 原 11 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 注册窗口时把当前桌面打上标
const _origRegister = registerWindow;
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// Win+Ctrl+←/→ 切桌面
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ---- 27 任务视图（窗口缩略图墙：Ctrl+Alt+V / 任务栏按钮） ----
function openTaskView() {
  const wins = getOpenWinList().filter(w => w.el.style.display !== 'none');
  if (wins.length < 2) { toast('至少要开 2 个窗口才显示任务视图'); return; }
  const overlay = document.createElement('div');
  overlay.id = 'taskView';
  overlay.innerHTML = '<div class="tv-grid">' + wins.map((w, i) =>
    `<div class="tv-item" data-i="${i}"><div class="tv-shot"></div><div class="tv-name">${esc(winTitleOf(w))}</div></div>`).join('') + '</div>';
  document.body.appendChild(overlay);
  wins.forEach((w, i) => {
    const shot = overlay.children[0].children[i].querySelector('.tv-shot');
    const clone = w.el.cloneNode(true);
    clone.style.cssText += ';display:flex;position:absolute;left:0;top:0;animation:none;box-shadow:none;z-index:auto';
    clone.querySelectorAll('iframe').forEach(f => f.remove());
    const cw = w.el.offsetWidth || 480, ch = w.el.offsetHeight || 320;
    const s = Math.min(360 / cw, 240 / ch);
    clone.style.transform = 'scale(' + s + ')';
    clone.style.transformOrigin = 'top left';
    shot.appendChild(clone);
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) { overlay.remove(); return; }
    const it = e.target.closest('.tv-item');
    if (it) {
      const w = wins[Number(it.dataset.i)];
      overlay.remove();
      if (w) activate(w.el);
    }
  });
}
// Win+Tab 会被系统拦截，改用 Ctrl+Alt+V；Win+Tab 保留（能收到时生效）
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 任务栏按钮：终端 / 任务视图
// ↑ 原 6 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 桌面右键菜单补：终端 / 浏览器 / 新建项目
// ↑ 原 11 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 桌面固定图标：浏览器（放在项目图标之后的空网格位，可拖动、位置持久化）
function renderBrowserIcon() {
  const existing = document.querySelector('.desk-icon[data-name="__browser"]');
  if (existing) existing.remove();
  const taken = new Set();
  document.querySelectorAll('.desk-icon, .folder-item, .trash-item').forEach(el => {
    taken.add((parseInt(el.style.left) || 0) + ',' + (parseInt(el.style.top) || 0));
  });
  const saved = loadJSON('hub-browser-pos', null);
  let pos = saved ? snapPos(saved.x, saved.y) : nextFree(GRID_X, GRID_Y, taken);
  if (taken.has(pos.x + ',' + pos.y)) pos = nextFree(pos.x + GRID_STEP_X, pos.y, taken);
  const el = document.createElement('div');
  el.className = 'desk-icon';
  el.dataset.name = '__browser';
  el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px';
  el.title = '浏览器（单击打开）';
  el.innerHTML = '<span class="sdot"></span><span class="di-ic" style="font-size:44px">🌐</span><div class="nm">浏览器</div>';
  iconsEl.appendChild(el);
  el.addEventListener('click', () => {
    if (Date.now() < dragBlockUntil) return;
    iconsEl.querySelectorAll('.desk-icon').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    openBrowser();
  });
  makeDesktopDraggable(el, (x, y) => { localStorage.setItem('hub-browser-pos', JSON.stringify({ x, y })); });
}
// renderDesktop 完成后追加浏览器图标
const _origRenderDesktop = renderDesktop;
// ↑ 原 5 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 桌面固定图标：设置（与浏览器图标同一模式：空格位、可拖动、位置持久化）
function renderSettingsIcon() {
  const existing = document.querySelector('.desk-icon[data-name="__settings"]');
  if (existing) existing.remove();
  const taken = new Set();
  document.querySelectorAll('.desk-icon, .folder-item, .trash-item').forEach(el => {
    taken.add((parseInt(el.style.left) || 0) + ',' + (parseInt(el.style.top) || 0));
  });
  const saved = loadJSON('hub-settings-pos', null);
  let pos = saved ? snapPos(saved.x, saved.y) : nextFree(GRID_X, GRID_Y, taken);
  if (taken.has(pos.x + ',' + pos.y)) pos = nextFree(pos.x + GRID_STEP_X, pos.y, taken);
  const el = document.createElement('div');
  el.className = 'desk-icon';
  el.dataset.name = '__settings';
  el.style.left = pos.x + 'px'; el.style.top = pos.y + 'px';
  el.title = '设置（单击打开）';
  el.innerHTML = '<span class="sdot"></span><span class="di-ic" style="font-size:44px">⚙️</span><div class="nm">设置</div>';
  iconsEl.appendChild(el);
  el.addEventListener('click', () => {
    if (Date.now() < dragBlockUntil) return;
    iconsEl.querySelectorAll('.desk-icon').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    openSettings();
  });
  makeDesktopDraggable(el, (x, y) => { localStorage.setItem('hub-settings-pos', JSON.stringify({ x, y })); });
}
