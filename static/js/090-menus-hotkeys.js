// 090-menus-hotkeys.js — 右键菜单、Alt+Tab、快捷键、备份导出
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 桌面右键菜单（仿 Windows：空白 / 图标 / 窗口 三类） =====
const ctxEl = document.getElementById('ctxmenu');

function hideCtx() { ctxEl.hidden = true; ctxEl.innerHTML = ''; }

function showCtx(x, y, items) {
  // 菜单项支持 disabled（灰掉且点不动）/ danger（红字，破坏性操作）
  ctxEl.innerHTML = items.map((it, i) => it.sep
    ? '<div class="cm-sep"></div>'
    : `<div class="cm-item${it.disabled ? ' dis' : ''}${it.danger ? ' dg' : ''}" data-i="${i}"${it.adminOnly ? ' data-admin-only' : ''}><span class="bi">${it.icon}</span><span>${esc(it.label)}</span></div>`).join('');
  ctxEl.hidden = false;
  // 定位并防止超出视口
  const w = ctxEl.offsetWidth, h = ctxEl.offsetHeight;
  ctxEl.style.left = Math.max(4, Math.min(x, innerWidth - w - 4)) + 'px';
  ctxEl.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
  ctxEl.querySelectorAll('.cm-item').forEach(el => {
    el.onclick = () => {
      const it = items[+el.dataset.i];
      if (it && it.disabled) return;    // 禁用项保持菜单开着，点了等于没点
      hideCtx();
      if (it && it.action) it.action();
    };
  });
}

// 桌面空白菜单
// 只保留桌面本身的操作：备份导出/导入在「设置 → 系统」里，设置/浏览器/终端在开始菜单里，
// 这里不再重复（右键菜单越短越好点，重复入口反而增加认知负担）。
function desktopMenu() {
  return [
    { icon: '🔄', label: '刷新', action: () => refreshProjects(false) },
    { icon: '⇅', label: '排列图标', action: () => arrangeIcons() },
    { sep: true },
    { icon: '📄', label: '新建文本', action: () => openNewWindow() },
    { icon: '📁', label: '新建文件夹', action: () => createFolder() },
    { icon: '🗒', label: '新建便签', action: () => createSticky() },
    { icon: '📚', label: '便签与记事本', action: () => openNotesCenter() },
    { sep: true },
    { icon: '🎨', label: '个性化', action: () => openPersonalize() },
  ];
}

// ===== 右键「排列图标」：横排 / 竖排 交替 =====
// 记录的是「下一次点击用哪个方向」，默认从竖排开始（桌面原本就是竖排）。
const ARRANGE_DIR_KEY = 'hub-arrange-dir';
function takeArrangeDir() {
  let cur = null;
  try { cur = localStorage.getItem(ARRANGE_DIR_KEY); } catch (e) { /* 隐私模式下读不到也不影响排列 */ }
  const dir = cur === 'row' ? 'row' : 'col';
  try { localStorage.setItem(ARRANGE_DIR_KEY, dir === 'col' ? 'row' : 'col'); } catch (e) {}
  return dir;
}

// 把 count 个图标按 dir 方向铺进可视区，返回每个图标的落点。
//   dir='col'：先从上往下填满一列，再换下一列（竖排，桌面默认观感）
//   dir='row'：先从左往右填满一行，再换下一行（横排）
// 格子数不够时逐步压缩步长（最紧到卡片尺寸 + 6px），保证任何窗口尺寸下都不会重叠；
// 真的压缩到极限还放不下，就顺延到可视区外——宁可溢出也不叠在一起。
function arrangeGrid(count, dir) {
  const CW = ICON_W, CH = ICON_H;                             // 与 CSS 的 --ic-w/--ic-h 同源
  const availW = Math.max(CW, window.innerWidth - GRID_X * 2);
  const availH = Math.max(CH, window.innerHeight - 56 - GRID_Y * 2);
  const minStepX = CW + 6, minStepY = CH + 6;
  let stepX = GRID_STEP_X, stepY = GRID_STEP_Y, maxCol = 1, maxRow = 1;
  for (let guard = 0; guard < 40; guard++) {
    maxCol = Math.max(1, Math.floor((availW - CW) / stepX) + 1);
    maxRow = Math.max(1, Math.floor((availH - CH) / stepY) + 1);
    if (maxCol * maxRow >= count) break;
    if (stepX <= minStepX && stepY <= minStepY) break;
    stepX = Math.max(minStepX, stepX - 8);
    stepY = Math.max(minStepY, stepY - 8);
  }
  const pos = [];
  for (let i = 0; i < count; i++) {
    const row = dir === 'row' ? Math.floor(i / maxCol) : i % maxRow;
    const col = dir === 'row' ? i % maxCol : Math.floor(i / maxRow);
    pos.push({ x: GRID_X + col * stepX, y: GRID_Y + row * stepY });
  }
  return pos;
}

// 桌面上的「内置图标」不在 DATA.projects 里，位置各自存在独立的键下。
// 排列时必须一并处理：漏掉它们，网格就会把格子分给它们已经占住的位，一按排列就叠在一起。
const FIXED_ICON_POS_KEY = { __browser: 'hub-browser-pos', __settings: 'hub-settings-pos' };

// 项目 / 文件夹 / 回收站 / 内置图标一起按名称排序，再统一按同一套网格落位。
// 枚举以 DOM 为准：DOM 才是「桌面上现在到底有哪些图标」的事实来源。
function arrangeIcons() {
  const dir = takeArrangeDir();
  const items = [];
  iconsEl.querySelectorAll('.desk-icon').forEach((el) => {
    if (el.hidden || el.offsetParent === null) return;   // 看不见的图标不该占格子
    const nm = el.querySelector('.nm');
    items.push({ kind: 'proj', el, id: el.dataset.name,
                 name: (nm ? nm.textContent : el.dataset.name || '').trim() });
  });
  desktopEl.querySelectorAll('.folder-item').forEach((el) => {
    const nm = el.querySelector('.fi-nm');
    items.push({ kind: 'folder', el, id: el.dataset.id,
                 name: (nm ? nm.textContent : el.dataset.id || '').trim() });
  });
  const trashEl = desktopEl.querySelector('.trash-item');
  if (trashEl) items.push({ kind: 'trash', el: trashEl, id: '', name: '回收站' });
  if (!items.length) return;
  items.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
  const cells = arrangeGrid(items.length, dir);
  const projPos = {};
  items.forEach((it, i) => {
    const pos = cells[i];
    if (!pos) return;
    it.el.style.left = pos.x + 'px';
    it.el.style.top = pos.y + 'px';
    if (it.kind === 'trash') {
      localStorage.setItem(TRASH_POS_KEY, JSON.stringify(pos));
    } else if (it.kind === 'folder') {
      if (folderRecords[it.id]) { folderRecords[it.id].x = pos.x; folderRecords[it.id].y = pos.y; }
    } else if (FIXED_ICON_POS_KEY[it.id]) {
      localStorage.setItem(FIXED_ICON_POS_KEY[it.id], JSON.stringify(pos));
    } else {
      projPos[it.id] = pos;
    }
  });
  if (Object.keys(projPos).length) localStorage.setItem(ICON_POS_KEY, JSON.stringify(projPos));
  saveFolders();
  toast('已按名称' + (dir === 'col' ? '竖排' : '横排') + ' · 再点一次切换为' + (dir === 'col' ? '横排' : '竖排'));
}

// 全局快捷键：Enter 打开选中项、Del 删除选中项、Ctrl+N 新建记事本
// 输入框/编辑态不拦截（记事本、搜索、重命名等）
// ↑ 原 30 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== Alt+Tab 窗口切换器（仿 Windows：按住 Alt 反复 Tab 循环，松开 Alt 确认） =====
let altTabState = null;   // {panel, wins, idx}
function getOpenWinList() {
  return Object.keys(openWins)
    .map(k => openWins[k])
    .filter(w => w && w.el && w.el.isConnected && !w._closing)
    .sort((a, b) => Number(b.el.style.zIndex || 0) - Number(a.el.style.zIndex || 0));   // 前台在前
}
function winTitleOf(w) {
  const nm = w.taskBtn && w.taskBtn.querySelector('.nm');
  if (nm && nm.textContent) return nm.textContent;
  const t = w.el.querySelector('.title');
  return t ? t.textContent.replace(/\s*-\s*.*$/, '') : '窗口';
}
function showAltTab() {
  const wins = getOpenWinList();
  if (wins.length < 2) return;
  hideAltTab(true);
  const panel = document.createElement('div');
  panel.id = 'alt-tab';
  panel.innerHTML = wins.map((w, i) =>
    `<div class="at-item${i === 0 ? ' active' : ''}" data-i="${i}"><div class="at-shot"></div><div class="at-name">${esc(winTitleOf(w))}</div></div>`
  ).join('');
  document.body.appendChild(panel);
  wins.forEach((w, i) => {
    const shot = panel.children[i].querySelector('.at-shot');
    const clone = w.el.cloneNode(true);
    clone.style.cssText += ';display:flex;position:absolute;left:0;top:0;animation:none;box-shadow:none;z-index:auto';
    clone.querySelectorAll('iframe').forEach(f => f.remove());
    const cw = w.el.offsetWidth || 480, ch = w.el.offsetHeight || 320;
    const s = Math.min(180 / cw, 120 / ch);
    clone.style.transform = 'scale(' + s + ')';
    clone.style.transformOrigin = 'top left';
    shot.appendChild(clone);
  });
  altTabState = { panel, wins, idx: 0 };
}
function stepAltTab() {
  if (!altTabState) return;
  altTabState.idx = (altTabState.idx + 1) % altTabState.wins.length;
  altTabState.panel.querySelectorAll('.at-item').forEach((it, i) =>
    it.classList.toggle('active', i === altTabState.idx));
}
function hideAltTab(cancel) {
  if (!altTabState) return;
  const st = altTabState;
  altTabState = null;
  st.panel.remove();
  if (cancel) return;
  const w = st.wins[st.idx];
  if (w && w.el && w.el.isConnected) {
    if (w.minimized || w.el.style.display === 'none') {
      w.el.style.display = '';
      w.minimized = false;
    }
    activate(w.el);
  }
}
// ↑ 原 10 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 3 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== Win+←/→/↑ 键盘分屏（19）：最上层窗口左半/右半/最大化 =====
// ↑ 原 12 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 数据备份导出（20）：把 hub-* localStorage 打包成 JSON 下载 =====
function exportDataBackup() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.startsWith('hub-')) data[k] = localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hub-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 800);   // 延迟释放，避免个别浏览器下载被提前打断
  toast('已导出数据备份（' + Object.keys(data).length + ' 项）');
}

// 导入备份：选择 hub-backup JSON → 写回 localStorage hub-* 项 → 刷新生效
function importDataBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async () => {
      let data;
      try { data = JSON.parse(rd.result); } catch { toast('备份文件格式错误，不是有效的 JSON'); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { toast('备份文件格式不正确'); return; }
      const keys = Object.keys(data).filter(k => k.startsWith('hub-'));
      if (!keys.length) { toast('备份里没有 hub-* 数据'); return; }
      const ok = await hubConfirm('将导入 ' + keys.length + ' 项备份数据并覆盖当前数据，确定？', { title: '导入数据备份', okText: '导入' });
      if (!ok) return;
      keys.forEach(k => localStorage.setItem(k, data[k]));
      toast('已导入 ' + keys.length + ' 项，正在刷新…');
      setTimeout(() => location.reload(), 700);
    };
    rd.readAsText(f);
  };
  inp.click();
}

// 剪贴板兜底：navigator.clipboard 不可用时走 execCommand
function fallbackCopy(t, done) {
  const tmp = document.createElement('textarea');
  tmp.value = t;
  tmp.style.position = 'fixed'; tmp.style.opacity = '0';
  document.body.appendChild(tmp);
  tmp.select();
  try { document.execCommand('copy'); done(); } catch (err) { toast('复制失败，请手动选择文字复制'); }
  tmp.remove();
}
