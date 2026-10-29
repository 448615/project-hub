// 070-window-open.js — 打开窗口、分屏与最大化
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 打开窗口 =====
function openWindow(name, forceInfo) {
  const p = (DATA.projects || []).find(x => x.name === name);
  if (!p) return;

  // 声明了 app（同源挂载点，如 /apps/starshu/）的项目：单击图标直接进应用，
  // 不再先弹「信息卡片」再点一次。信息卡片仍可从应用窗口工具栏的 ⓘ 打开
  // （forceInfo=true 时跳过应用窗口，直接渲染详情）。
  if (p.app && !forceInfo) { openAppWindow(p); return; }

  // 已经打开过：直接激活并取消最小化
  if (openWins[name]) {
    const w = openWins[name];
    w.minimized = false;
    w.el.style.display = 'flex';
    activate(w.el);
    return;
  }

  // 根据项目配置动态生成操作按钮：一键运行 / 外链跳转 / 打开目录 / 查看文档
  const actionBtns = buildActions(p);

  // 创建窗口元素
  const win = document.createElement('div');
  win.className = 'win active';
  // 错落摆放，避免多个窗口完全重叠
  const offset = (Object.keys(openWins).length % 6) * 28;
  const c = centerPos(560, 420, offset);     // 首开居中（有布局记忆时 registerWindow 会覆盖）
  win.style.left = c.left + 'px';
  win.style.top = c.top + 'px';
  // 显式设默认尺寸：不设的话 style.width 为空，拖动保存布局时会误存 0 把窗口压扁
  win.style.width = '560px';
  win.style.height = '420px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      ${iconHtml(p)}
      <span class="title">${esc(p.display_name)}</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body">
      <div class="head">
        <div class="icon">${iconHtml(p)}</div>
        <div>
          <h2>${esc(p.display_name)}</h2>
          <div class="desc">${esc(p.description) || '（无描述）'}</div>
        </div>
      </div>
      <div class="tags">${(p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <div class="status-line"><span class="dot ${p.running ? 'on' : ''}"></span>状态：${p.running ? '运行中' : '离线'}${p.port ? (' · 端口 ' + esc(p.port)) : ''}</div>
      <div class="doc-summary" hidden></div>
      <div class="actions">${actionBtns}</div>
    </div>`;

  // 操作按钮：一键启动/停止、外链跳转、打开目录、查看文档
  win.querySelectorAll('.actions .btn').forEach(b => {
    b.onclick = () => onAction(p, b);
  });

  // 配置了 docs 的项目：异步加载 README 摘要进窗口（失败静默，不影响窗口本身）
  if (p.docs) loadDocSummary(win, p);

  // 关闭按钮
  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  // 最小化按钮
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation();
    win.style.display = 'none';
    if (openWins[name]) openWins[name].minimized = true;
    syncTaskActive();
  };

  // 点窗口任意处 -> 置顶；标题栏 -> 拖拽
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  // 双击标题栏不触发文字选中
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());

  windowsEl.appendChild(win);
  playSfx('open');

  // 任务栏按钮
  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `${iconHtml(p)}<span class="nm">${esc(p.display_name)}</span>`;
  taskBtn.onclick = () => {
    const w = openWins[name];
    if (!w) return;
    if (w.minimized || win.style.display === 'none') {
      // 已最小化 -> 还原并置顶
      win.style.display = 'flex'; w.minimized = false; activate(win);
    } else if (Number(win.style.zIndex) === zCounter) {
      // 已是最上层 -> 最小化
      win.style.display = 'none'; w.minimized = true; syncTaskActive();
    } else {
      activate(win);
    }
  };
  taskItemsEl.appendChild(taskBtn);

  registerWindow(name, win, taskBtn);
  activate(win);
}

// 窗口 z-index 归一：递增计数长时间使用会一路涨到 100 以上，把底部任务栏（z-index 100）盖住。
// 超过阈值就按当前堆叠顺序重新从 30 编号，相对层次不变，只把数值压回去。
const Z_BASE = 30, Z_CEIL = 90;
function renumberWindows() {
  const list = Array.prototype.slice.call(windowsEl.querySelectorAll('.win'));
  list.sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
  zCounter = Z_BASE;
  list.forEach(w => { w.style.zIndex = ++zCounter; });
}

// 激活（置顶）窗口：把它提到最上层并标记为 active
function activate(win) {
  if (zCounter >= Z_CEIL) renumberWindows();
  win.classList.add('active');
  win.style.zIndex = ++zCounter;
  // 取消其它窗口的 active 高亮
  windowsEl.querySelectorAll('.win').forEach(w => { if (w !== win) w.classList.remove('active'); });
  syncTaskActive();
}

// 统一关闭窗口：播放关窗音效 + 缩小淡出动画 + 移除元素 + 清理任务栏按钮与 openWins 记录。
// 反向按 win 引用匹配 openWins 条目，避免各 openXxx 重复写清理逻辑（也便于统一加音效）。
function closeWindow(win) {
  if (!win || win._closing) return;
  win._closing = true;
  if (win._pvTimer) clearInterval(win._pvTimer);   // 预览轮询定时器随窗口关闭一并清理，避免泄漏
  playSfx('close');
  hideTaskPreview();            // 清掉可能残留的缩略图预览
  win.classList.add('closing');          // 缩小淡出动画（见 .win.closing）
  setTimeout(() => {
    if (!win.isConnected) return;
    win.remove();
    for (const k in openWins) {
      if (openWins[k] && openWins[k].el === win) {
        if (openWins[k].taskBtn) openWins[k].taskBtn.remove();
        delete openWins[k];
        break;
      }
    }
  }, 175);
}

// 同步任务栏按钮的高亮：只有“最上层且未最小化”的窗口按钮才高亮
function syncTaskActive() {
  Object.keys(openWins).forEach(name => {
    const w = openWins[name];
    if (!w || !w.taskBtn) return;   // 系统窗口（终端/浏览器等）没有任务栏按钮，跳过
    const isTop = Number(w.el.style.zIndex) === zCounter && w.el.style.display !== 'none';
    w.taskBtn.classList.toggle('active', isTop && !w.minimized);
  });
}

// 拖拽：在标题栏按下鼠标并移动，窗口跟着走
// 全局拖拽控制器：整个页面只挂“一套” window 监听，而不是每个窗口各挂一套。
// 这样无论开多少个窗口，全局永远只有这一套监听，窗口关掉也不会残留、越积越多（之前是内存泄漏）。
let dragTarget = null;   // 当前正在拖的窗口及其起点信息，松手即清空
// ===== 窗口贴边分屏 + 双击最大化 =====
const snapEl = document.createElement('div');
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
let curSnapZone = null;
const SNAP_EDGE = 18;   // 鼠标进入距边缘 18px 内即触发吸附预览
function taskbarH() { const tb = document.getElementById('taskbar'); return (tb && tb.offsetHeight) || 54; }
function calcSnapZone(x, y) {
  if (document.body.classList.contains('no-snap')) return null;   // 设置=关闭吸附
  const vw = window.innerWidth, vh = window.innerHeight, e = SNAP_EDGE;
  if (y <= e) return 'max';                 // 顶部 → 全屏
  if (x <= e) return 'left';                // 左边 → 左半屏
  if (x >= vw - e) return 'right';          // 右边 → 右半屏
  return null;
}
function showSnap(zone) {
  const vw = window.innerWidth, vh = window.innerHeight, tb = taskbarH();
  let l = 0, t = 0, w = vw, h = vh;
  if (zone === 'left')  { w = Math.round(vw / 2); h = vh - tb; }
  else if (zone === 'right') { l = Math.round(vw / 2); w = vw - l; h = vh - tb; }
  snapEl.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
  snapEl.classList.add('show');
}
function hideSnap() { curSnapZone = null; snapEl.classList.remove('show'); }
function applySnap(win, zone) {
  const vw = window.innerWidth, vh = window.innerHeight, tb = taskbarH();
  win._maxed = false; win._snapped = zone;
  if (zone === 'left') {
    win.style.left = '0px'; win.style.top = '0px';
    win.style.width = Math.round(vw / 2) + 'px'; win.style.height = (vh - tb) + 'px';
  } else if (zone === 'right') {
    win.style.left = Math.round(vw / 2) + 'px'; win.style.top = '0px';
    win.style.width = (vw - Math.round(vw / 2)) + 'px'; win.style.height = (vh - tb) + 'px';
  } else if (zone === 'max') {
    win.style.left = '0px'; win.style.top = '0px';
    win.style.width = vw + 'px'; win.style.height = vh + 'px'; win._maxed = true;
  }
  win.dispatchEvent(new Event('winresize'));
}
// 窗口首开居中定位：小窗居中略偏上更稳，多窗口错落级联
function centerPos(w, h, off) {
  off = off || 0;
  return {
    left: Math.max(10, Math.round((window.innerWidth - w) / 2) + off),
    top: Math.max(10, Math.round((window.innerHeight - h) / 2 - 36) + off)
  };
}
function toggleMaximize(win) {
  if (win._maxed) {                          // 已最大化 → 还原到拖拽/缩放前尺寸
    const r = win._restore || {};
    win.style.left = r.left || '60px'; win.style.top = r.top || '60px';
    win.style.width = r.width || '640px'; win.style.height = r.height || '480px';
    win._maxed = false;
    win.classList.remove('maxed');
    saveLayoutOfWin(win);                    // 只有还原后的尺寸才是用户布局，才持久化
  } else {                                   // 记录当前几何后最大化（100vw/100vh 铺满，不受 max-width 限制）
    win._restore = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
    win.style.left = '0px'; win.style.top = '0px';
    win.style.width = '100vw'; win.style.height = '100vh';
    win._maxed = true;
    win.classList.add('maxed');
    // 最大化状态不写入 localStorage：否则下次打开窗口会"恢复成 0,0 全屏"而非居中
  }
  updateMaxIcon(win);
  win.dispatchEvent(new Event('winresize'));
}
// 最大化按钮图标：□（最大化） ⇄ ❐（还原）
function updateMaxIcon(win) {
  const b = win.querySelector('.max');
  if (!b) return;
  b.textContent = win._maxed ? '❐' : '□';
  b.title = win._maxed ? '还原' : '最大化';
}
// 所有窗口的「最大化」按钮统一委托绑定（含后续动态创建的窗口）
// ↑ 原 6 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ↑ 原 7 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 9 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

function enableDrag(win) {
  const bar = win.querySelector('.bar');
  // 双击标题栏：在还原 / 最大化之间切换（Windows 习惯）；设置里可关掉
  bar.addEventListener('dblclick', (e) => {
    e.preventDefault();
    if (!SETTINGS.dblMax) return;
    toggleMaximize(win);
  });
  bar.addEventListener('mousedown', (e) => {
    if (win._maxed) return;                  // 最大化时禁止拖动
    if (e.target.closest('.x')) return;   // 点在关闭/最小化按钮上不触发拖拽
    // 读取窗户此刻在屏幕上的“真实坐标”（而非门牌号字符串）。
    // 这样即使某些窗口没设过 left/top（如回收站、个性化），也不会一拖就瞬移到左上角。
    const r = win.getBoundingClientRect();
    dragTarget = { win, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    e.preventDefault();
  });
}

// 拉伸：右下角手柄按住拖动，调整窗口宽高（最小 320×200）
function enableResize(win) {
  const rz = document.createElement('div');
  rz.className = 'resizer';
  win.appendChild(rz);
  rz.addEventListener('mousedown', (e) => {
    if (win._maxed) return;                  // 最大化时禁止缩放
    e.preventDefault(); e.stopPropagation();
    activate(win);
    const sx = e.clientX, sy = e.clientY;
    const sw = win.offsetWidth, sh = win.offsetHeight;
    const onMove = (ev) => {
      const w = Math.max(320, sw + (ev.clientX - sx));
      const h = Math.max(200, sh + (ev.clientY - sy));
      win.style.width = w + 'px';
      win.style.height = h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveLayoutOfWin(win);   // 拉伸结束保存尺寸
      win.dispatchEvent(new Event('winresize'));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
