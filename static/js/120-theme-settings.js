// 120-theme-settings.js — 主题切换 + 设置中心骨架 + 各面板共用的绑定器
// 由原 static/app.js 拆分；面板模板见 119-settings-panels.js，
// 五个分类页各自的回填与绑定见 121-settings-appearance.js ~ 125-settings-account.js。
// 本文件只放声明，加载时不产生副作用。

// ===== 主题配色：角色蓝 / 暗黑 / 樱花粉 =====
const THEME_KEY = 'hub-theme';
function applyTheme(t) {
  document.body.dataset.theme = t || '';
  try { localStorage.setItem(THEME_KEY, t || ''); } catch (e) { /* 忽略 */ }
}
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 共用绑定器：开关 / 分段选择器 / 强调色，供 121–125 复用 =====
// 一律先取元素再判空：面板被裁剪或模板改动时静默跳过，不会让整个设置中心抛错。

// 开关：回填当前值 + 变更即保存生效
function settingsBindToggle(win, id, key) {
  const el = win.querySelector('#' + id);
  if (!el) return;
  el.checked = !!SETTINGS[key];
  el.onchange = (e) => {
    SETTINGS[key] = e.target.checked;
    saveSettings(); applySettings();
    toast('已保存设置');
  };
}

// 分段选择器：按 data-v 与当前值对齐选中态（data-v 为字符串，布尔/数字都已转成字符串）
function settingsSyncSeg(container, key) {
  if (!container) return;
  const cur = String(SETTINGS[key]);
  container.querySelectorAll('.seg-btn').forEach(b => {
    b.classList.toggle('sel', b.dataset.v === cur);
  });
}

// 分段选择器：回填 + 绑定点击
function settingsBindSeg(win, sel, key) {
  const container = win.querySelector(sel);
  if (!container) return;
  settingsSyncSeg(container, key);
  container.querySelectorAll('.seg-btn').forEach(b => {
    b.onclick = () => {
      let v = b.dataset.v;
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else { const n = Number(v); if (!Number.isNaN(n)) v = n; }   // 数字档转数字，其余保留字符串
      SETTINGS[key] = v;
      saveSettings(); applySettings();
      settingsSyncSeg(container, key);
      if (key === 'clock24' || key === 'clockSecs' || key === 'clockDate') syncClockTick();
      toast('已保存设置');
    };
  });
}

// 百分比滑杆：按当前值回填滑杆位置、右侧数值和已填充的轨道长度
function settingsSyncRange(box, key) {
  if (!box) return;
  const inp = box.querySelector('input[type=range]');
  if (!inp) return;
  const out = box.querySelector('.range-out');
  const v = pctOf(SETTINGS[key], DEFAULT_SETTINGS[key]);
  inp.value = v;
  if (out) out.textContent = v + '%';
  inp.style.setProperty('--fill', ((v - 1) / 99 * 100).toFixed(2) + '%');
  inp.setAttribute('aria-valuetext', v + '%');
}

// 百分比滑杆：拖动即时生效（applySettings），停手 220ms 后才落盘，避免拖动中反复写 localStorage
let _rangeSaveTimer = 0;
function settingsBindRange(win, sel, key) {
  const box = win.querySelector(sel);
  if (!box) return;
  const inp = box.querySelector('input[type=range]');
  if (!inp) return;
  settingsSyncRange(box, key);
  inp.oninput = () => {
    SETTINGS[key] = pctOf(inp.value, DEFAULT_SETTINGS[key]);
    settingsSyncRange(box, key);
    applySettings();
    clearTimeout(_rangeSaveTimer);
    _rangeSaveTimer = setTimeout(saveSettings, 220);
  };
  // 松手 / 键盘调整结束：立刻落盘（拖动中途直接关窗口也不会丢）
  inp.onchange = () => { clearTimeout(_rangeSaveTimer); saveSettings(); };
}

// 强调色圆点：按当前设置同步选中态
function settingsSyncAccent(win) {
  const box = win.querySelector('#setAccent');
  if (!box) return;
  box.querySelectorAll('.ac-swat').forEach(el => {
    el.classList.toggle('sel', (el.dataset.a || '') === (SETTINGS.accent || ''));
  });
}

// 全部布尔开关的 元素 id ↔ SETTINGS 键 对照表（回填与「恢复默认」共用一份，避免两处漏改）
const SETTINGS_TOGGLE_MAP = [
  ['setAutoHide', 'autoHideTaskbar'],
  ['setSfx', 'sfx'],
  ['setNotif', 'notif'],
  ['setLock', 'lockScreen'],
  ['setAnim', 'winAnim'],
  ['setSnap', 'snap'],
  ['setWinShadow', 'winShadow'],
  ['setDblMax', 'dblMax'],
];

// 把上表所有开关按 SETTINGS 重新回填（打开面板时 / 恢复默认后）
function settingsRefillToggles(win) {
  SETTINGS_TOGGLE_MAP.forEach(pair => {
    const el = win.querySelector('#' + pair[0]);
    if (el) el.checked = !!SETTINGS[pair[1]];
  });
}

// ===== 设置中心：左分类右选项，全部开关即时生效并持久化 =====
function openSettings() {
  const win = makeWin('__settings', '设置', '⚙', settingsPanelsHtml(),
    { width: 780, height: 600 });

  // 左导航切换
  win.querySelectorAll('.set-nav-item').forEach(b => {
    b.onclick = () => {
      win.querySelectorAll('.set-nav-item').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      win.querySelectorAll('.set-panel').forEach(p => { p.hidden = p.dataset.panel !== b.dataset.panel; });
    };
  });

  // 五个分类页各自完成「回填 + 绑定」，本函数只负责组装
  bindSettingsAppearance(win);
  bindSettingsPersonal(win);
  bindSettingsWindow(win);
  bindSettingsSystem(win);
  bindSettingsAccount(win);
}
