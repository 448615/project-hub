// 999-boot.js — 引导文件：执行所有「加载即运行」的顶层初始化语句
// 拆分前这些语句夹在函数之间，靠同文件内的函数提升才能调用后文定义的函数；
// 拆成多个 <script> 后提升不再跨文件，故统一收集到这里，确保函数都已定义再执行。
// 顺序 = 原 app.js 出现顺序，改动顺序会改变初始化行为。

// ── 源自 000-core.js 第 24 行 ──
try { trashRecords = JSON.parse(localStorage.getItem(TRASH_KEY) || '[]') || []; } catch (e) { trashRecords = []; }
// 老版本记录只有 {id,name,left,top,members,deletedAt}：这里补齐 deletedTs（排序/过期）、origin（原位置）、tid（唯一键），
// 只在真的缺字段时才回写，避免每次启动都动 localStorage
try { if (trashNorm()) saveTrash(); } catch (e) { /* 数据太脏就跳过，别拦着启动 */ }

// ── 源自 010-window-layout.js 第 275 行 ──
if (notifBtn) {
  notifBtn.onclick = (e) => {
    e.stopPropagation();
    notifPanel.hidden = !notifPanel.hidden;
    if (!notifPanel.hidden) notifDot.hidden = true;   // 打开 = 已读
  };
  document.getElementById('notifClear').onclick = (e) => {
    e.stopPropagation();
    notifications = [];
    refreshNotifPanel();
  };
}

// ── 源自 010-window-layout.js 第 295 行 ──
['click', 'keydown'].forEach(ev => document.addEventListener(ev, initAudioCtx, { once: true }));

// ── 源自 020-settings-core.js 第 316 行 ──
try { SETTINGS = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}); } catch (e) {}

// ── 源自 020-settings-core.js 第 375 行 ──
applySettings();

// ── 源自 040-finder-launcher.js 第 1542 行 ──
launcherInput.addEventListener('input', () => { renderLauncher(launcherInput.value); });

// ── 源自 040-finder-launcher.js 第 1543 行 ──
launcherInput.addEventListener('keydown', (e) => {
  const total = launcherItems.length + (renderLauncher._files || []).length;
  if (e.key === 'ArrowDown') { e.preventDefault(); launcherIdx = Math.min(launcherIdx + 1, Math.max(0, total - 1)); paintLauncher(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); launcherIdx = Math.max(launcherIdx - 1, 0); paintLauncher(); }
  else if (e.key === 'Enter') { e.preventDefault(); openLauncherItem(launcherIdx); }
  else if (e.key === 'Escape') { e.preventDefault(); closeLauncher(); }
});

// ── 源自 040-finder-launcher.js 第 1550 行 ──
launcherList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (li) openLauncherItem(parseInt(li.dataset.i, 10));
});

// ── 源自 040-finder-launcher.js 第 1555 行 ──
launcherEl.addEventListener('mousedown', (e) => { if (e.target === launcherEl) closeLauncher(); });

// ── 源自 040-finder-launcher.js 第 1557 行 ──
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    launcherEl.hidden ? openLauncher() : closeLauncher();
  }
});

// ── 源自 070-window-open.js 第 2492 行 ──
snapEl.id = 'snapPreview';

// ── 源自 070-window-open.js 第 2493 行 ──
snapEl.className = 'snap-preview';

// ── 源自 070-window-open.js 第 2494 行 ──
document.body.appendChild(snapEl);

// ── 源自 070-window-open.js 第 2565 行 ──
document.addEventListener('click', (e) => {
  const b = e.target.closest('.max');
  if (!b) return;
  const win = b.closest('.win');
  if (win) { e.stopPropagation(); toggleMaximize(win); }
});

// ── 源自 070-window-open.js 第 2572 行 ──
window.addEventListener('mousemove', (e) => {
  if (!dragTarget) return;
  dragTarget.win.style.left = (dragTarget.ox + e.clientX - dragTarget.sx) + 'px';
  dragTarget.win.style.top  = (dragTarget.oy + e.clientY - dragTarget.sy) + 'px';
  curSnapZone = calcSnapZone(e.clientX, e.clientY);
  if (curSnapZone) showSnap(curSnapZone); else hideSnap();
});

// ── 源自 070-window-open.js 第 2579 行 ──
window.addEventListener('mouseup', () => {
  if (dragTarget) {
    const zone = curSnapZone;
    snapEl.classList.remove('show'); curSnapZone = null;
    if (zone) applySnap(dragTarget.win, zone);
    else saveLayoutOfWin(dragTarget.win);
    dragTarget = null;
  }
});

// ── 源自 080-clock-volume.js 第 2728 行 ──
authBoot();

// ── 源自 080-clock-volume.js 第 2731 行 ──
(function autoHideTaskbar() {
  const bar = document.getElementById('taskbar');
  const ZONE = 80;          // 距屏幕底部多少像素内算“靠近”（含任务栏高度，避免移上就藏）
  let shown = false;

  // 首屏引导：先显示 3 秒，让用户看到关机按钮/时钟位置，再自动隐藏（设置=常显时跳过隐藏）
  bar.classList.add('show'); shown = true;
  setTimeout(() => { if (taskbarAutoHide) { bar.classList.remove('show'); shown = false; } }, 3000);

  // 鼠标在这些 UI 上时任务栏保持显示：任务栏本体、通知面板、音量、关机画面、
  // 开始菜单、日历、任务视图、右键菜单（它们都在任务栏上方，仅靠底部距离判断会误收起）
  const KEEP = '#taskbar, #notifPanel, #volume, #shutdown, #startMenu, #cal, #taskView, #ctxmenu';
  // 任务栏收起时只关开始菜单；通知面板不在这里关——它的显隐完全由通知按钮点击控制
  // （用户要求：只有点通知中心才开/关，鼠标移开、点别处、任务栏收起都不自动关）。
  function closeTaskbarPopups() {
    const sm = document.getElementById('startMenu');
    if (sm) { sm.hidden = true; sm.classList.remove('show'); }
  }
  document.addEventListener('mousemove', (e) => {
    if (!taskbarAutoHide) { bar.classList.add('show'); shown = true; return; }   // 设置=常显：不隐藏
    const overUi = !!(e.target.closest && e.target.closest(KEEP));
    // 通知面板打开期间，强制任务栏保持显示，避免面板跟着任务栏滑走“看起来像自动消失”
    const near = e.clientY > window.innerHeight - ZONE || overUi || !notifPanel.hidden;   // 靠近底部 / 操作弹出 UI / 通知面板打开中，都不隐藏
    if (near !== shown) {
      if (!near) closeTaskbarPopups();   // 正在收起 → 同步关闭弹出的通知面板 / 开始菜单
      shown = near;
      bar.classList.toggle('show', shown);
    }
  });
})();

// ── 源自 090-menus-hotkeys.js 第 2833 行 ──
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); openNewWindow(); }
    return;
  }
  // 有窗口处于前台时，Enter/Del 只作用于窗口内部，不误触桌面图标
  const hasTopWin = Object.keys(openWins).some(k => {
    const w = openWins[k];
    return w && w.el && Number(w.el.style.zIndex) === zCounter && w.el.style.display !== 'none' && !w.minimized;
  });
  if (hasTopWin) return;
  if (e.key === 'Enter') {
    const proj = iconsEl.querySelector('.desk-icon.selected');
    if (proj) { e.preventDefault(); openWindow(proj.dataset.name); return; }
    const folder = desktopEl.querySelector('.folder-item.sel');
    if (folder) { e.preventDefault(); openFolderWin(folder.dataset.id); return; }
    const trash = desktopEl.querySelector('.trash-item.sel');
    if (trash) { e.preventDefault(); openTrash(); return; }
  }
  if (e.key === 'Delete' || e.key === 'Del') {
    const folder = desktopEl.querySelector('.folder-item.sel');
    if (folder) { e.preventDefault(); deleteFolder(folder.dataset.id); return; }
    const trash = desktopEl.querySelector('.trash-item.sel');
    if (trash) { e.preventDefault(); toast('回收站不能删除'); return; }
    const proj = iconsEl.querySelector('.desk-icon.selected');
    if (proj) { e.preventDefault(); toast('项目图标不能删除'); return; }
  }
});

// ── 源自 090-menus-hotkeys.js 第 2922 行 ──
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'Tab') {
    e.preventDefault();
    if (!altTabState) showAltTab();
    stepAltTab();
  } else if (e.altKey && e.key === 'Escape' && altTabState) {
    e.preventDefault();
    hideAltTab(true);
  }
});

// ── 源自 090-menus-hotkeys.js 第 2932 行 ──
document.addEventListener('keyup', (e) => {
  if (e.key === 'Alt' && altTabState) hideAltTab(false);
});

// ── 源自 090-menus-hotkeys.js 第 2937 行 ──
document.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  const k = e.key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const wins = [...windowsEl.querySelectorAll('.win')].filter(w => w.style.display !== 'none' && !w._closing);
  if (!wins.length) return;
  const top = wins.sort((a, b) => (Number(b.style.zIndex) || 0) - (Number(a.style.zIndex) || 0))[0];
  e.preventDefault();
  applySnap(top, k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : 'max');
});

// ── 源自 110-shell-wallpaper.js 第 3597 行 ──
document.getElementById('searchBtn').addEventListener('click', openLauncher);

// ── 源自 110-shell-wallpaper.js 第 3601 行 ──
startMenuEl.id = 'startMenu';

// ── 源自 110-shell-wallpaper.js 第 3602 行 ──
startMenuEl.className = 'start-menu';

// ── 源自 110-shell-wallpaper.js 第 3603 行 ──
startMenuEl.hidden = true;

// ── 源自 110-shell-wallpaper.js 第 3604 行 ──
document.body.appendChild(startMenuEl);

// ── 源自 110-shell-wallpaper.js 第 3700 行 ──
document.getElementById('startBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleStartMenu(); });

// ── 源自 110-shell-wallpaper.js 第 3701 行 ──
document.addEventListener('mousedown', (e) => {
  if (startMenuEl.hidden) return;
  if (e.target.closest('#startMenu') || e.target.closest('#startBtn')) return;
  closeStartMenu();
});

// ── 源自 110-shell-wallpaper.js 第 3706 行 ──
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeStartMenu(); });

// ── 源自 110-shell-wallpaper.js 第 3741 行 ──
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const icon = e.target.closest('.desk-icon');
  if (icon) {
    const p = (DATA.projects || []).find(x => x.name === icon.dataset.name);
    if (p) { showCtx(e.clientX, e.clientY, iconMenu(p)); return; }
  }
  const folder = e.target.closest('.folder-item');
  if (folder) {
    selectFolder(folder);
    showCtx(e.clientX, e.clientY, folderMenu(folder.dataset.id));
    return;
  }
  const win = e.target.closest('.win');
  if (win) {
    const entry = Object.entries(openWins).find(([, w]) => w.el === win);
    showCtx(e.clientX, e.clientY, winMenu(win, entry ? entry[0] : null));
    return;
  }
  showCtx(e.clientX, e.clientY, desktopMenu());
});

// ── 源自 110-shell-wallpaper.js 第 3763 行 ──
desktopEl.addEventListener('mousedown', (e) => {
  if (e.button === 0 && !e.target.closest('.folder-item') && !e.target.closest('.desk-icon')) {
    desktopEl.querySelectorAll('.folder-item.sel').forEach(x => x.classList.remove('sel'));
  }
});

// ── 源自 110-shell-wallpaper.js 第 3770 行 ──
document.addEventListener('mousedown', (e) => { if (e.button !== 2 && !e.target.closest('#ctxmenu')) hideCtx(); });

// ── 源自 110-shell-wallpaper.js 第 3773 行 ──
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 窗口内、桌面图标/文件夹/回收站、任务栏、右键菜单、日历、关机遮罩、
  // 搜索启动器（#launcher 是全屏遮罩）与提示条（#toast）都不触发关闭（S1）
  const t = (e.target instanceof Element) ? e.target : null;
  if (!t) return;   // target 不是元素（如 document 本身）视为桌面空白
  if (t.closest('.win, .desk-icon, .folder-item, .trash-item, #taskbar, #ctxmenu, #cal, #shutdown, #launcher, #toast')) return;
  const wins = [...document.querySelectorAll('.win')].filter(w => w.style.display !== 'none' && w.isConnected);
  if (!wins.length) return;
  wins.sort((a, b) => (+b.style.zIndex || 0) - (+a.style.zIndex || 0));   // 最上层优先
  const top = wins[0];
  const cb = top.querySelector('.close');
  if (cb) cb.click();   // 复用各窗口自己的关闭逻辑
});

// ── 源自 110-shell-wallpaper.js 第 3787 行 ──
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtx(); });

// ── 源自 110-shell-wallpaper.js 第 3788 行 ──
window.addEventListener('blur', hideCtx);

// ── 源自 110-shell-wallpaper.js 第 4013 行 ──
(function restoreWallpaper() {
  const saved = localStorage.getItem('hub-wallpaper');
  if (saved) setWallpaper(saved);
})();

// ── 源自 120-theme-settings.js 第 4024 行 ──
(function restoreTheme() {
  const t = localStorage.getItem(THEME_KEY);
  if (t) applyTheme(t);
})();

// ── 源自 120-theme-settings.js 第 4506 行 ──
(function initIdleLock() {
  let last = Date.now();
  const bump = () => { last = Date.now(); };
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'].forEach(ev =>
    document.addEventListener(ev, bump, { passive: true }));
  setInterval(() => {
    const mins = Number(SETTINGS.idleLock) || 0;
    if (mins <= 0) return;
    if (!SETTINGS.lockScreen) return;       // 没开启动锁屏时无锁可回，避免莫名刷新
    if (Date.now() - last < mins * 60000) return;
    last = Date.now();
    try { localStorage.setItem('ph.idle-at', String(Date.now())); } catch (e) { /* 忽略 */ }
    location.reload();                      // 刷新即回到锁屏页
  }, 20000);
})();

// ── 源自 130-lock-sticky.js 第 4523 行 ──
(function initLockScreen() {
  const ls = document.getElementById('lockscreen');
  if (!ls) return;
  if (!SETTINGS.lockScreen) { ls.remove(); return; }   // 设置=关闭锁屏：直接进桌面
  const tEl = document.getElementById('lockTime');
  const dEl = document.getElementById('lockDate');
  const fmt2 = n => (n < 10 ? '0' : '') + n;
  const tick = () => {
    const d = new Date();
    tEl.textContent = fmt2(d.getHours()) + ':' + fmt2(d.getMinutes());
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    dEl.textContent = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${wd}`;
  };
  tick();
  setInterval(tick, 1000);
  ls.addEventListener('click', () => {
    ls.classList.add('hide');
    playSfx('click');
    setTimeout(() => ls.remove(), 550);
  });
})();

// ── 源自 130-lock-sticky.js 第 4549 行 ──
migrateNoteStorageOnce();   // 一次性清理（必须在读 stickyRecords 之前，否则读到的是旧数据）
try { stickyRecords = JSON.parse(localStorage.getItem(STICKY_KEY) || '{}') || {}; } catch (e) { stickyRecords = {}; }

// ── 源自 130-lock-sticky.js 第 4585 行 ──
document.addEventListener('mousemove', _stickyDragMove);

// ── 源自 130-lock-sticky.js 第 4586 行 ──
document.addEventListener('mouseup', _stickyDragUp);

// ── 源自 130-lock-sticky.js 第 4739 行 ──
// 桌面只恢复「最近改动」的那 1 张便签：其余（包括手动收起过的）都躺在「便签与记事本」里，
// 不再每次打开页面就铺满一屏。stickySeq 仍按全部记录推进，避免新建时 id 撞车。
(function restoreStickies() {
  Object.keys(stickyRecords).forEach(id => {
    const n = +id.slice(1);
    if (n > stickySeq) stickySeq = n;
  });
  const keep = pickAutoOpenIds(stickyRecords, 1);
  keep.forEach(id => {
    try { createSticky(stickyRecords[id]); }
    catch (e) { console.warn('恢复便签失败:', id, e); }
  });
  saveStickies();   // 把「其余已收起」的状态落盘，下次启动保持一致
})();

// ── 源自 140-calendar.js 第 4933 行 ──
clockEl.addEventListener('click', (e) => { e.stopPropagation(); toggleCal(); });

// ── 源自 140-calendar.js 第 4935 行 ──
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#cal') && !e.target.closest('#clock')) hideCal();
});

// ── 源自 140-calendar.js 第 4938 行 ──
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCal(); });

// ── 源自 153-desktop-views.js 第 5693 行 ──
(function initDeskBar() {
  const bar = document.createElement('div');
  bar.id = 'deskBar';
  bar.innerHTML = Array.from({ length: DESK_COUNT }, (_, i) =>
    `<button class="desk-tab${i === 0 ? ' active' : ''}" data-d="${i}">桌面 ${i + 1}</button>`).join('');
  document.body.appendChild(bar);
  bar.addEventListener('click', (e) => {
    const t = e.target.closest('.desk-tab');
    if (t) switchDesk(Number(t.dataset.d));
  });
})();

// ── 源自 153-desktop-views.js 第 5706 行 ──
registerWindow = function (key, win, taskBtn) {
  win.dataset.desk = String(currentDesk);
  _origRegister(key, win, taskBtn);
};

// ── 源自 153-desktop-views.js 第 5711 行 ──
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.ctrlKey && e.key === 'ArrowLeft') { e.preventDefault(); switchDesk(currentDesk - 1); }
  else if (e.metaKey && e.ctrlKey && e.key === 'ArrowRight') { e.preventDefault(); switchDesk(currentDesk + 1); }
});

// ── 源自 153-desktop-views.js 第 5747 行 ──
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key === 'Tab') { e.preventDefault(); openTaskView(); }
  else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'v') { e.preventDefault(); openTaskView(); }
});

// ── 源自 153-desktop-views.js 第 5753 行 ──
(function bindTaskbarButtons() {
  const tb = document.getElementById('termBtn');
  if (tb) tb.onclick = () => openTerminal();
  const tvb = document.getElementById('taskviewBtn');
  if (tvb) tvb.onclick = () => openTaskView();
})();

// ── 源自 153-desktop-views.js 第 5761 行 ──
(function patchDesktopMenu() {
  const orig = desktopMenu;
  desktopMenu = function () {
    const items = orig();
    items.push({ sep: true });
    // 「终端」「浏览器」已从右键菜单移除：开始菜单顶部的常用应用区已有入口，不再重复
    items.push({ icon: '📦', label: '新建项目', adminOnly: true, action: () => openNewProject() });
    return items;
  };
})();

// ── 源自 153-desktop-views.js 第 5801 行 ──
renderDesktop = function () {
  _origRenderDesktop();
  renderBrowserIcon();
  renderSettingsIcon();
};
