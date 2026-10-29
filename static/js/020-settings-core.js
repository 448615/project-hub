// 020-settings-core.js — 设置默认值与加载、系统音效、子链接动作
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 设置中心：默认值 + 启动加载（任务栏隐藏 / 音效 / 锁屏 / 窗口动画 / 边缘吸附） =====
const SETTINGS_KEY = 'ph.settings';
const DEFAULT_SETTINGS = {
  autoHideTaskbar: true, sfx: true, lockScreen: true, winAnim: true, snap: true, sfxVol: 1,
  clock24: true, clockSecs: true, clockDate: true,
  iconSize: 'md', winSolid: false, notif: true, toastMs: 2600,
  density: 'md', fontSize: 'md', wallBlur: 1,   // wallBlur：百分比，1% = 不模糊
  // —— 以下为「设置中心 2.0」新增项 ——
  accent: '',          // 强调色：''=跟随主题，其余见 ACCENT_PRESET
  shade: 'auto',       // 桌面背景明暗：auto(跟随主题) / none / light / mid / strong
  iconLabel: true,     // 桌面图标是否显示名字
  dblMax: true,        // 双击标题栏是否最大化
  winShadow: true,     // 窗口是否投影
  animSpeed: 'normal', // 动画速度：fast / normal / slow
  refreshSecs: 20,     // 项目状态自动刷新间隔（秒），0=关闭
  idleLock: 0,         // 空闲自动锁屏（分钟），0=关闭
  trashDays: 0,        // 回收站自动清理：保留天数（0=关闭），打开回收站时清掉过期条目
  // 玻璃质感（窗口 / 任务栏）：统一用 1~100 的百分比，拖动即时生效
  glassA: 81,          // 透明度：81% = 原「高透」观感（alpha .199）
  glassBlur: 65,       // 玻璃模糊：65% = 26px
  glassLift: 1         // 玻璃提亮：1% = 不提亮（1.00）
};
let SETTINGS = Object.assign({}, DEFAULT_SETTINGS);
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {} }

// 强调色预设：rgb 三元组供 rgba() 使用，另两个是主色/副色（渐变、按钮底色）
const ACCENT_PRESET = {
  blue:   { rgb: '91, 140, 255',  a1: '#5B8CFF', a2: '#67E8F9', name: '角色蓝' },
  violet: { rgb: '139, 116, 249', a1: '#8B74F9', a2: '#C4B5FD', name: '星河紫' },
  teal:   { rgb: '32, 190, 178',  a1: '#20BEB2', a2: '#67E8F9', name: '薄荷青' },
  green:  { rgb: '34, 181, 115',  a1: '#22B573', a2: '#A7F3D0', name: '森野绿' },
  amber:  { rgb: '230, 150, 20',  a1: '#E69614', a2: '#FDE68A', name: '暖阳橙' },
  rose:   { rgb: '232, 86, 140',  a1: '#E8568C', a2: '#FFB3C9', name: '玫瑰粉' }
};

// 背景明暗档：用内联 CSS 变量覆盖 body::after 的纱罩颜色
const SHADE_PRESET = {
  none:   { a: 'rgba(0, 0, 0, 0)',        b: 'rgba(0, 0, 0, 0)' },          // 原图直出
  light:  { a: 'rgba(0, 0, 0, .14)',      b: 'rgba(0, 0, 0, .06)' },
  mid:    { a: 'rgba(0, 0, 0, .30)',      b: 'rgba(0, 0, 0, .16)' },
  strong: { a: 'rgba(0, 0, 0, .48)',      b: 'rgba(0, 0, 0, .30)' }
};
const ANIM_PRESET = { fast: '.12s', normal: '.22s', slow: '.42s' };

// ===== 连续值统一用 1~100 百分比 =====
// 存进 SETTINGS 的是百分比，落到 CSS 时才换算成 rgba alpha / px / brightness。
// 换算的两端按「肉眼刚好能分辨」定：再往外要么看不出差别，要么画面糊掉。
//   窗口透明度：81% → alpha .199（与旧版「高透」一致）／100% → .100（最透）／1% → .615（接近实心）
//   玻璃模糊：  65% → 26px／100% → 40px／1% → 0.4px
//   玻璃提亮：  1% → brightness 1.00（不提亮）／100% → 1.30
//   壁纸模糊：  1% → 0px／100% → 30px
function pctOf(v, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(100, Math.max(1, Math.round(n)));
}
function glassAlphaOf(pct) { return (0.62 - 0.52 * pctOf(pct, 81) / 100).toFixed(3); }
function glassBlurOf(pct) { return (pctOf(pct, 65) * 0.4).toFixed(1) + 'px'; }
function glassLiftOf(pct) { return (1 + (pctOf(pct, 1) - 1) / 99 * 0.30).toFixed(3); }
function wallBlurOf(pct) { return ((pctOf(pct, 1) - 1) / 99 * 30).toFixed(1) + 'px'; }

// 旧版档位（'high' / 14 / 1.15 …）一次性折算成百分比，避免升级后设置被悄悄改掉
const PCT_LEGACY = {
  glassA: { soft: 31, mid: 58, high: 81, xhigh: 96 },
  glassBlur: { 0: 1, 14: 35, 28: 70, 32: 80, 40: 100 },
  glassLift: { 1.06: 21, 1.15: 51, 1.25: 84 },
  wallBlur: { 0: 1, 8: 28, 16: 50 }
};
const PCT_VER = 2;
function normalizePctSettings() {
  const keys = Object.keys(PCT_LEGACY);
  if (SETTINGS.__pctV !== PCT_VER) {
    keys.forEach(k => {
      const hit = PCT_LEGACY[k][SETTINGS[k]];
      if (hit != null) SETTINGS[k] = hit;
    });
    SETTINGS.__pctV = PCT_VER;
    saveSettings();   // 折算结果落盘，避免每次启动重新折算
  }
  keys.forEach(k => { SETTINGS[k] = pctOf(SETTINGS[k], DEFAULT_SETTINGS[k]); });
}

let taskbarAutoHide = SETTINGS.autoHideTaskbar;
let _sfxVol = SETTINGS.sfxVol;
function applySettings() {
  setSfxOn(SETTINGS.sfx);
  _sfxVol = SETTINGS.sfxVol;
  taskbarAutoHide = SETTINGS.autoHideTaskbar;
  document.body.classList.toggle('no-anim', !SETTINGS.winAnim);
  document.body.classList.toggle('no-snap', !SETTINGS.snap);
  document.body.classList.toggle('win-solid', SETTINGS.winSolid);
  document.body.classList.toggle('icon-sm', SETTINGS.iconSize === 'sm');
  document.body.classList.toggle('icon-lg', SETTINGS.iconSize === 'lg');
  document.body.classList.toggle('text-sm', SETTINGS.fontSize === 'sm');
  document.body.classList.toggle('text-lg', SETTINGS.fontSize === 'lg');
  document.body.classList.toggle('hide-icon-label', !SETTINGS.iconLabel);
  document.body.classList.toggle('no-shadow', !SETTINGS.winShadow);
  document.body.style.setProperty('--wallpaper-blur', wallBlurOf(SETTINGS.wallBlur));
  document.body.style.setProperty('--anim-dur', ANIM_PRESET[SETTINGS.animSpeed] || ANIM_PRESET.normal);
  // 强调色：选了预设就内联覆盖主题变量（内联优先级高于主题选择器），选「跟随主题」则移除
  const ac = ACCENT_PRESET[SETTINGS.accent];
  const bst = document.body.style;
  if (ac) {
    bst.setProperty('--acc-rgb', ac.rgb);
    bst.setProperty('--accent', ac.a1);
    bst.setProperty('--accent2', ac.a2);
  } else {
    bst.removeProperty('--acc-rgb'); bst.removeProperty('--accent'); bst.removeProperty('--accent2');
  }
  // 背景明暗：auto = 交给主题自带纱罩
  const sh = SHADE_PRESET[SETTINGS.shade];
  if (sh) { bst.setProperty('--shade-a', sh.a); bst.setProperty('--shade-b', sh.b); }
  else { bst.removeProperty('--shade-a'); bst.removeProperty('--shade-b'); }
  // 玻璃质感：透明度 / 模糊 / 提亮，三项都由百分比换算成 CSS 变量
  normalizePctSettings();
  bst.setProperty('--glass-a', glassAlphaOf(SETTINGS.glassA));
  bst.setProperty('--glass-blur', glassBlurOf(SETTINGS.glassBlur));
  bst.setProperty('--glass-lift', glassLiftOf(SETTINGS.glassLift));
  applyDensity();
  const bar = document.getElementById('taskbar');
  if (bar && !SETTINGS.autoHideTaskbar) bar.classList.add('show');   // 常显时立即生效，不等 mousemove
  restartAutoRefresh();   // 刷新间隔改了就按新值重新计时
  syncClockTick();        // 时钟制式/秒/日期改了就立刻重画一次
}
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
function playSfx(type) {
  if (!_sfxOn) return;
  if (!_audioCtx) initAudioCtx();
  if (!_audioCtx) return;
  const ac = _audioCtx, t = ac.currentTime;
  const beep = (freq, start, dur, wave, peak) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = wave || 'sine';
    o.frequency.setValueAtTime(freq, t + start);
    g.gain.setValueAtTime(0.0001, t + start);
    g.gain.linearRampToValueAtTime((peak || 0.05) * _sfxVol, t + start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t + start); o.stop(t + start + dur + 0.02);
  };
  if (type === 'open')      { beep(523.25, 0, 0.12, 'sine', 0.05); beep(783.99, 0.06, 0.13, 'sine', 0.04); }
  else if (type === 'close'){ beep(440.00, 0, 0.10, 'sine', 0.05); beep(261.63, 0.05, 0.13, 'sine', 0.04); }
  else if (type === 'error'){ beep(220.00, 0, 0.16, 'square', 0.05); beep(174.61, 0.09, 0.18, 'square', 0.04); }
  else if (type === 'click'){ beep(659.25, 0, 0.05, 'triangle', 0.03); }
}

// ===== 子链接跳转 / 一键启动 的真实动作 =====

// 只允许 http/https 外链跳转，杜绝 javascript:/data:/file: 等危险协议被注入执行
function isSafeNavUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) { return false; }
}

// 取出项目的桌面内预览地址：优先用后端算好的 preview_url（config.port 或 localhost 外链）
function previewUrlFor(p) {
  return (p && p.preview_url) ? String(p.preview_url) : '';
}

// 统一的 POST 请求封装：成功/失败都给提示，避免静默失败（审计项里“端口校验失败静默结束”同类问题）
async function apiPost(path) {
  try {
    const res = await apiFetch(path, { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { toast('操作失败：' + (j.error || res.status)); return false; }
    if (j.ok === false) { toast('操作失败：' + (j.error || '未知错误')); return false; }
    return true;
  } catch (e) {
    toast('请求失败：无法连接后端');
    return false;
  }
}

// 根据项目配置拼出操作按钮区
function buildActions(p) {
  const btns = [];
  // 子应用（config 里声明了 app）：主按钮，点开就是可用界面
  if (p.app) {
    btns.push(`<button class="btn primary act-app" data-act="app" data-name="${esc(p.name)}"><span class="bi">▣</span>打开应用</button>`);
  }
  if (p.run) {
    // 已启动显示“停止”，未启动显示“一键运行”（启停子进程 = 管理员功能）
    btns.push(`<button class="btn act-run" data-admin-only data-act="run" data-name="${esc(p.name)}"><span class="bi">${p.started ? '⏹' : '▶'}</span>${p.started ? '停止' : '一键运行'}</button>`);
  }
  // 配置了可预览地址（端口或本地外链）：提供“桌面内预览”按钮，点开玻璃窗口内嵌 iframe
  // 已是同源子应用（p.app）时不再给「预览」：那会走 127.0.0.1:<port> 跨源路径，
  // 与「打开应用」重复且在 https 下会被混合内容拦掉。
  const pv = p.app ? '' : previewUrlFor(p);
  if (pv) {
    btns.push(`<button class="btn act-preview" data-act="preview" data-name="${esc(p.name)}"><span class="bi">🌐</span>预览</button>`);
  }
  (p.links || []).forEach((lk) => {
    btns.push(`<button class="btn" data-act="link" data-url="${esc(lk.url || '')}"><span class="bi">🔗</span>${esc(lk.label || lk.url || '外链')}</button>`);
  });
  if (p.name) {
    btns.push(`<button class="btn" data-admin-only data-act="open" data-name="${esc(p.name)}" title="在桌面内浏览项目文件"><span class="bi">📂</span>浏览目录</button>`);
  }
  if (p.docs) {
    btns.push(`<button class="btn" data-act="docs" data-name="${esc(p.name)}"><span class="bi">📄</span>查看文档</button>`);
  }
  return btns.join('') || '<span class="hint">该项目暂无可执行操作</span>';
}

// 按钮点击分发
async function onAction(p, btn) {
  // 从最新 DATA 取该项目，避免窗口打开后状态已变而本地 p 仍是旧快照
  const fresh = (DATA.projects || []).find(x => x.name === p.name) || p;
  const act = btn.dataset.act;
  if (act === 'run') {
    // 声明了 panel 的项目：一键运行 = 跑一遍脚本 + 弹出对应面板（如账号数据）
    if (fresh.panel === 'accounts') {
      if (!(ME && ME.role === 'admin')) { toast('仅管理员可打开账号数据'); return; }
      const url = `/api/projects/${encodeURIComponent(fresh.name)}/start`;
      await apiPost(url);           // 真跑一次数据处理脚本（脚本内部同样校验管理员）
      refreshProjects(false);
      openAccountsPanel();
      return;
    }
    const url = `/api/projects/${encodeURIComponent(fresh.name)}/${fresh.started ? 'stop' : 'start'}`;
    if (await apiPost(url)) toast(fresh.started ? '已发送停止指令' : '已发送启动指令，稍候刷新状态…');
    refreshProjects(false);   // 立即拉一次最新状态（started / running）
  } else if (act === 'link') {
    const u = btn.dataset.url || '';
    if (isSafeNavUrl(u)) {
      window.open(u, '_blank', 'noopener');
    } else {
      toast('链接被拦截（仅允许 http/https）：' + u);
    }
  } else if (act === 'open') {
    openFileManager(fresh);   // 桌面内文件管理器；系统打开降级为窗口工具栏按钮
  } else if (act === 'app') {
    openAppWindow(fresh);     // 子应用窗口（同源 /apps/…，由枢纽反代）
  } else if (act === 'preview') {
    openPreview(fresh);       // 桌面内预览窗口（iframe 内嵌 localhost 开发服务）
  } else if (act === 'docs') {
    openDocViewer(fresh);   // 桌面内文档查看器；外部打开降级为窗口内的次级按钮
  }
}
