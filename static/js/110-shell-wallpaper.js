// 110-shell-wallpaper.js — 关机、开始菜单、壁纸
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 关机：开始菜单里的「关机」→ 全屏关机画面 → 退出网页 =====
function doShutdown() {
  const ov = document.createElement('div');
  ov.id = 'shutdown';
  ov.innerHTML = '<div class="sd-inner"><div class="sd-spin"></div><div class="sd-text">正在关机…</div></div>';
  document.body.appendChild(ov);
  setTimeout(() => {
    try { window.close(); } catch (e) { /* 部分浏览器拦截脚本关闭 */ }
    // window.close 被拦截时：把当前网页替换为空白页，实现“退出网页”
    setTimeout(() => { location.replace('about:blank'); }, 1200);
  }, 2200);
}
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 开始菜单：应用列表 + 搜索 + 电源（左下角弹出，仿 Windows 开始菜单） =====
const startMenuEl = document.createElement('div');
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 搜索过滤（纯函数，便于测试）：匹配 名称/显示名/描述/标签，大小写不敏感；返回新数组
function startMenuFilter(projects, q) {
  const kw = (q || '').trim().toLowerCase();
  const ps = projects || [];
  if (!kw) return ps.slice();
  return ps.filter(p =>
    (p.name + ' ' + (p.display_name || '') + ' ' + (p.description || '') + ' ' + (p.tags || []).join(' '))
      .toLowerCase().includes(kw));
}

// 只重绘应用列表。搜索框输入时调它——input 元素保持存活，
// 焦点/光标/中文输入法（IME）组合过程都不会被打断。
// （旧实现每次按键都重建整个菜单 innerHTML，连正在输入的 <input> 一起换掉，
//   导致光标跳末尾、打字丢字、中文候选被打断——这就是开始菜单"搜索不好用"的根因。）
function renderStartMenuList(filter) {
  const list = startMenuFilter((DATA && DATA.projects) || [], filter);
  const apps = list.length
    ? list.map(p => `
      <div class="sm-app" data-name="${esc(p.name)}" title="${esc(p.display_name || p.name)}">
        <span class="sm-ic">${iconHtml(p)}</span>
        <span class="sm-nm">${esc(p.display_name || p.name)}</span>
      </div>`).join('')
    : '<div class="sm-empty">无匹配应用</div>';
  const box = startMenuEl.querySelector('.sm-list');
  if (box) box.innerHTML = apps;
  startMenuEl.querySelectorAll('.sm-app').forEach(el => {
    el.onclick = () => {
      if (el.dataset.name) { openWindow(el.dataset.name); playSfx('click'); }
      closeStartMenu();
    };
  });
}

// 菜单骨架只在打开时建一次；之后搜索只走 renderStartMenuList
function renderStartMenuShell() {
  startMenuEl.innerHTML = `
    <div class="sm-search"><input id="smSearch" class="sm-search-input" placeholder="搜索应用…"></div>
    <div class="sm-apps">
      <button class="sm-app-item" data-app="browser"><span>🌐</span>浏览器</button>
      <button class="sm-app-item" data-app="terminal" data-admin-only><span>⬛</span>终端</button>
      <button class="sm-app-item" data-app="note"><span>📄</span>新建文本</button>
      <button class="sm-app-item" data-app="sticky"><span>🗒</span>新建便签</button>
      <button class="sm-app-item" data-app="notes"><span>📚</span>便签与记事本</button>
      <button class="sm-app-item" data-app="trash"><span>♻</span>回收站</button>
      <button class="sm-app-item" data-app="settings"><span>⚙</span>设置</button>
    </div>
    <div class="sm-list"></div>
    <div class="sm-power">
      <div class="sm-power-item" data-act="restart"><span class="bi">⟳</span>重启桌面</div>
      <div class="sm-power-item" data-act="shutdown"><span class="bi">⏻</span>关机</div>
    </div>`;
  const input = startMenuEl.querySelector('#smSearch');
  input.oninput = () => renderStartMenuList(input.value);
  input.onkeydown = (e) => { if (e.key === 'Enter') { const f = startMenuEl.querySelector('.sm-app'); if (f) f.click(); } };
  // 常用应用入口
  const APP_OPENERS = {
    browser: () => openBrowser(),
    terminal: () => openTerminal(),
    note: () => openNewWindow(),
    sticky: () => createSticky(),
    notes: () => openNotesCenter(),   // 收起过的便签/记事本都在这里，点一下能重新打开
    trash: () => openTrash(),
    settings: () => openSettings(),
  };
  startMenuEl.querySelectorAll('.sm-app-item').forEach(el => {
    el.onclick = () => {
      closeStartMenu();
      const fn = APP_OPENERS[el.dataset.app];
      if (fn) { fn(); playSfx('click'); }
    };
  });
  startMenuEl.querySelectorAll('.sm-power-item').forEach(el => {
    el.onclick = () => {
      closeStartMenu();
      if (el.dataset.act === 'shutdown') doShutdown();
      else location.reload();
    };
  });
  renderStartMenuList('');
  return input;
}
function openStartMenu() {
  // 互斥：打开开始菜单时收起其它浮层
  hideCtx();
  const la = document.getElementById('launcher'); if (la) la.hidden = true;
  const input = renderStartMenuShell();
  startMenuEl.hidden = false;
  requestAnimationFrame(() => startMenuEl.classList.add('show'));
  setTimeout(() => input.focus(), 0);
}
function closeStartMenu() {
  startMenuEl.classList.remove('show');
  setTimeout(() => { if (!startMenuEl.classList.contains('show')) startMenuEl.hidden = true; }, 160);
}
function toggleStartMenu() { if (startMenuEl.hidden) openStartMenu(); else closeStartMenu(); }

// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 5 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 图标右键菜单：打开目录/查看文档复用窗口内的 onAction，不再弹"功能待接入"（S7）
function iconMenu(p) {
  const items = [
    { icon: '▶', label: '打开', action: () => openWindow(p.name) },
    { icon: '📂', label: '浏览目录', action: () => onAction(p, { dataset: { act: 'open' } }) },
    { icon: '🪟', label: '在系统文件管理器中打开', action: () => apiPost(`/api/projects/${encodeURIComponent(p.name)}/open`) },
    { icon: '📄', label: '查看文档', action: () => onAction(p, { dataset: { act: 'docs' } }) },
  ];
  if (previewUrlFor(p)) {
    items.push({ icon: '🌐', label: '预览', action: () => openPreview(p) });
  }
  return items.concat([
    { sep: true },
    { icon: 'ℹ️', label: '属性', action: () =>
        toast(`「${p.display_name}」 ${p.running ? '运行中' : '离线'}${p.port ? ' · 端口 ' + p.port : ''}`) },
  ]);
}

// 窗口右键菜单
function winMenu(win, name) {
  return [
    { icon: '🗕', label: '最小化', action: () => {
        win.style.display = 'none';
        if (openWins[name]) openWins[name].minimized = true;
        syncTaskActive();
    } },
    { icon: '🗙', label: '关闭', action: () => closeWindow(win) },
    { sep: true },
    { icon: '📌', label: '置顶', action: () => activate(win) },
  ];
}

// 全局右键：拦截浏览器默认菜单，按点击目标弹对应菜单
// ↑ 原 21 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 桌面空白左键点击：取消文件夹选中
// ↑ 原 5 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 关闭菜单：左键点菜单外 / Esc / 窗口失焦（点在菜单内不关，避免 click 丢失）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// 点击窗口外部（桌面空白处）→ 关闭当前最上层窗口
// ↑ 原 14 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 个性化：换壁纸（支持拖入图片） =====
// 壁纸来源白名单：只允许 同源静态图 / data:image（拖入文件压缩后）/ blob:（拖入文件临时URL）/ 本地回环图片。
// 防止 localStorage 被篡改或未来扩展时注入非法地址导致 CSS 注入。
function isSafeWallpaper(src) {
  return (
    /^data:image\/[a-z.+-]+;base64,/i.test(src) ||
    /^blob:/i.test(src) ||
    /^\/static\//.test(src) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(src)
  );
}
function setWallpaper(src) {
  if (!isSafeWallpaper(src)) {
    toast('壁纸地址不合法，已忽略');
    return;
  }
  // 即便通过白名单，仍对引号做转义，避免 url("...") 被意外闭合
  document.body.style.setProperty('--wallpaper', `url("${String(src).replace(/"/g, '\\"')}")`);
}

// ===== 内置壁纸库：零外部文件，用内联 SVG（base64）生成角色主题壁纸 =====
// 用 base64 编码以便通过 isSafeWallpaper 的白名单（仅放行 data:image/...;base64, / /static/ 等）。
function svgWallpaper(c1, c2, c3) {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'>" +
    "<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='" + c1 + "'/><stop offset='1' stop-color='" + c2 + "'/>" +
    "</linearGradient></defs>" +
    "<rect width='1280' height='720' fill='url(#g)'/>" +
    "<circle cx='1000' cy='200' r='200' fill='" + c3 + "' opacity='0.4'/>" +
    "<circle cx='260' cy='560' r='130' fill='#ffffff' opacity='0.14'/>" +
    "<rect x='0' y='600' width='1280' height='120' fill='#ffffff' opacity='0.08'/>" +
  "</svg>";
  return 'data:image/svg+xml;base64,' + btoa(svg);
}
const BUILTIN_WALLPAPERS = [
  { name: '经典', src: '/static/bg.jpg' },
  { name: '晨曦', src: svgWallpaper('#ffd6e7', '#b8c6ff', '#ff9ec4') },
  { name: '深海', src: svgWallpaper('#1e3a8a', '#0ea5e9', '#67e8f9') },
  { name: '暮光', src: svgWallpaper('#7c3aed', '#f472b6', '#fbbf24') },
  { name: '森野', src: svgWallpaper('#065f46', '#a7f3d0', '#34d399') },
];
function isCurWall(src) {
  const saved = localStorage.getItem('hub-wallpaper');
  if (src === '/static/bg.jpg') return !saved;     // 经典 = 默认且未自定义
  return saved === src;
}
function selectBuiltinWallpaper(src) {
  setWallpaper(src);
  localStorage.setItem('hub-wallpaper', src);
}
function refreshWallLibSel() {
  const w = openWins['__personalize'];
  if (!w) return;
  const lib = w.el.querySelector('#wallLib');
  if (!lib) return;
  lib.querySelectorAll('.wall-thumb').forEach(el => el.classList.toggle('sel', isCurWall(el.dataset.src)));
}
function applyWallpaperFile(file) {
  const objectUrl = URL.createObjectURL(file);
  setWallpaper(objectUrl);
  // 压缩后持久化（最大边 1920，JPEG 0.82），刷新后仍生效
  const img = new Image();
  img.onload = () => {
    const MAX = 1920;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.82);
    try {
      localStorage.setItem('hub-wallpaper', dataUrl);
      toast(`壁纸已应用：${c.width}×${c.height}（已保存，刷新不丢）`);
    } catch (err) {
      toast('壁纸过大，本次生效但刷新后恢复默认');
    }
    // 同步更新个性化窗口里的预览图
    const pw = openWins['__personalize'];
    if (pw && pw.el.querySelector('#wallPrev')) {
      pw.el.querySelector('#wallPrev').src = dataUrl;
      pw.el.querySelector('#wallPrev').parentElement.classList.add('has-img');
    }
    URL.revokeObjectURL(objectUrl);
  };
  img.onerror = () => toast('无法读取该图片');
  img.src = objectUrl;
}
function resetWallpaper() {
  localStorage.removeItem('hub-wallpaper');
  document.body.style.removeProperty('--wallpaper');
  const w = openWins['__personalize'];
  if (w && w.el.querySelector('#wallPrev')) { w.el.querySelector('#wallPrev').src = '/static/bg.jpg'; w.el.querySelector('#wallPrev').parentElement.classList.remove('has-img'); }
  refreshWallLibSel();
  toast('已恢复默认壁纸');
}

// 打开个性化小窗（复用窗口系统：可拖拽、最小化、任务栏按钮）
function openPersonalize() {
  const key = '__personalize';
  if (openWins[key]) {
    const w = openWins[key];
    w.minimized = false; w.el.style.display = 'flex'; activate(w.el); return;
  }
  const win = document.createElement('div');
  win.className = 'win active personalize';
  win.style.left = '180px'; win.style.top = '110px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">🎨</span>
      <span class="title">个性化</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body">
      <div class="wall-label">壁纸（拖入图片，或点击下方按钮选择）</div>
      <div id="wallDrop" class="wall-drop" title="拖入图片或点击选择">
        <div class="wall-hint">🖼 把图片拖到这里<br>或点击选择文件</div>
        <img id="wallPrev" class="wall-prev" alt="">
      </div>
      <div class="wall-actions">
        <button class="btn" id="wallPick">📂 选择文件</button>
        <button class="btn ghost" id="wallReset">↺ 恢复默认壁纸</button>
      </div>
      <div class="wall-label">壁纸库（点击一键切换）</div>
      <div id="wallLib" class="wall-lib"></div>
      <div class="wall-label">主题配色</div>
      <div class="theme-picker" id="themePicker">
        <div class="theme-swat" data-t=""><span class="sw-chip sw-blue"></span><span class="sw-name">角色蓝</span></div>
        <div class="theme-swat" data-t="dark"><span class="sw-chip sw-dark"></span><span class="sw-name">暗黑</span></div>
        <div class="theme-swat" data-t="pink"><span class="sw-chip sw-pink"></span><span class="sw-name">樱花粉</span></div>
      </div>
      <input type="file" id="wallFile" accept="image/*" hidden>
    </div>`;
  windowsEl.appendChild(win);
  playSfx('open');

  // 关闭 / 最小化
  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation(); win.style.display = 'none';
    if (openWins[key]) openWins[key].minimized = true;
    syncTaskActive();
  };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());

  // 壁纸交互：拖放 + 点击选择
  const drop = win.querySelector('#wallDrop');
  const prev = win.querySelector('#wallPrev');
  const cur = localStorage.getItem('hub-wallpaper');
  if (cur) { prev.src = cur; drop.classList.add('has-img'); }
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) applyWallpaperFile(f);
    else toast('请拖入图片文件（png / jpg / webp）');
  });
  win.querySelector('#wallPick').onclick = () => win.querySelector('#wallFile').click();
  win.querySelector('#wallFile').onchange = e => {
    const f = e.target.files[0];
    if (f) applyWallpaperFile(f);
    e.target.value = '';
  };
  win.querySelector('#wallReset').onclick = () => resetWallpaper();
  // 壁纸库：渲染缩略图并绑定一键切换（含高亮当前已选）
  const lib = win.querySelector('#wallLib');
  const renderLib = () => {
    lib.innerHTML = BUILTIN_WALLPAPERS.map(p => {
      const bg = p.src.startsWith('data:') ? `url("${p.src}")` : `url(${p.src})`;
      return `<div class="wall-thumb${isCurWall(p.src) ? ' sel' : ''}" data-src="${esc(p.src)}" title="${esc(p.name)}" style="background-image:${bg}"><span class="wt-nm">${esc(p.name)}</span></div>`;
    }).join('');
    lib.querySelectorAll('.wall-thumb').forEach(el => {
      el.onclick = () => {
        selectBuiltinWallpaper(el.dataset.src);
        lib.querySelectorAll('.wall-thumb').forEach(x => x.classList.remove('sel'));
        el.classList.add('sel');
        playSfx('click');
      };
    });
  };
  renderLib();

  // 主题切换：角色蓝 / 暗黑 / 樱花粉（持久化 hub-theme）
  const picker = win.querySelector('#themePicker');
  const renderTheme = () => {
    picker.querySelectorAll('.theme-swat').forEach(el => {
      el.classList.toggle('sel', (el.dataset.t || '') === (document.body.dataset.theme || ''));
    });
  };
  picker.querySelectorAll('.theme-swat').forEach(el => {
    el.onclick = () => {
      applyTheme(el.dataset.t);
      renderTheme();
      playSfx('click');
    };
  });
  renderTheme();

  // 任务栏按钮 + 注册
  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">🎨</span><span class="nm">个性化</span>`;
  taskBtn.onclick = () => {
    const w = openWins[key];
    if (!w) return;
    if (w.minimized || win.style.display === 'none') { win.style.display = 'flex'; w.minimized = false; activate(win); }
    else if (Number(win.style.zIndex) === zCounter) { win.style.display = 'none'; w.minimized = true; syncTaskActive(); }
    else activate(win);
  };
  taskItemsEl.appendChild(taskBtn);
  registerWindow(key, win, taskBtn);
  activate(win);
}

// 页面加载时恢复上次保存的壁纸
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
