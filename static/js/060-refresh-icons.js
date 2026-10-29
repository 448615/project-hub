// 060-refresh-icons.js — 自动刷新、桌面图标
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 项目状态自动刷新（间隔可配，改设置后即时重排） =====
// 注意：必须用 var —— applySettings() 在文件靠前处就会调用本函数，
// 若用 let 声明，页面初始化时会撞上 TDZ（Cannot access before initialization）。
var autoRefreshTimer = 0;
function restartAutoRefresh() {
  if (autoRefreshTimer) { clearTimeout(autoRefreshTimer); autoRefreshTimer = 0; }
  const start = () => {
    const secs = Number(SETTINGS.refreshSecs) || 0;
    if (secs <= 0) return;                      // 0 = 关闭自动刷新
    // 未登录时不轮询：既省请求，也避免 401 冒出来打断登录/注册输入。
    // 访客视图也要算进「未登录」——它虽然收起了遮罩，但一个需要登录的接口都没开，
    // 轮询只会每 20 秒撞一次 401。
    const gv = document.getElementById('guestView');
    const guestOpen = !!(gv && !gv.hidden);
    if (authVeilVisible() || guestOpen) { autoRefreshTimer = setTimeout(start, 5000); return; }
    autoRefreshTimer = setTimeout(async () => {
      autoRefreshTimer = 0;
      try { await refreshProjects(true); } catch (e) { /* 网络抖动忽略，下一轮继续 */ }
      start();
    }, Math.max(5, secs) * 1000);
  };
  start();
}

// 就地更新各项目的“运行中/离线”状态：只改状态点和小窗里的状态行，不重排桌面、不丢窗口。
// 用于手动刷新与定时轮询，避免整页 reload 把用户正在用的窗口关掉。
function updateRunningStates() {
  const ps = DATA.projects || [];
  // 图标查询提到循环外建 Map：原写法每个项目都全量 querySelectorAll，
  // 项目上百时每 20 秒一轮是 O(n²)（N5）
  const iconMap = {};
  iconsEl.querySelectorAll('.desk-icon').forEach(el => { iconMap[el.dataset.name] = el; });
  ps.forEach(p => {
    // 桌面图标上的小圆点
    const el = iconMap[p.name];
    if (el) {
      const s = el.querySelector('.sdot');
      if (s) s.classList.toggle('on', !!p.running);
    }
    // 已打开窗口里的状态行 + 一键运行按钮，随最新状态同步
    const w = openWins[p.name];
    if (w && w.el) {
      const sl = w.el.querySelector('.status-line');
      if (sl) {
        const st = p.running ? '运行中' : (p.started ? '启动中…' : '离线');
        sl.innerHTML = `<span class="dot ${p.running || p.started ? 'on' : ''}"></span>状态：${st}${p.port ? (' · 端口 ' + esc(p.port)) : ''}`;
      }
      const runBtn = w.el.querySelector('.act-run');
      if (runBtn) {
        runBtn.innerHTML = `<span class="bi">${p.started ? '⏹' : '▶'}</span>${p.started ? '停止' : '一键运行'}`;
      }
      // 预览窗口：跟随运行状态显示/隐藏"未运行"遮罩，避免停在旧页面
      const pv = openWins['__preview_' + p.name];
      if (pv && pv.el) {
        const overlay = pv.el.querySelector('#pvOverlay');
        const dot = pv.el.querySelector('#pvDot');
        const frame = pv.el.querySelector('#pvFrame');
        if (overlay) overlay.hidden = !!p.running;
        if (dot) dot.classList.toggle('on', !!p.running);
        if (!p.running && frame && frame.getAttribute('src')) {
          frame.removeAttribute('src');   // 服务已停，清掉 iframe 内容
        }
      }
    }
  });
}

// 桌面右键「刷新」的 Windows 风格反馈：图标区快速重绘一次（淡出回弹），即时响应用户点击。
// 用回流技巧保证连点时动画可重复触发；定时轮询（silent）不调用，避免每 20 秒闪屏。
let _refreshPulseTimer = null;
function pulseDesktopRefresh() {
  const el = iconsEl;
  el.classList.remove('refreshing');
  void el.offsetWidth;          // 强制回流，重启动画
  el.classList.add('refreshing');
  clearTimeout(_refreshPulseTimer);
  _refreshPulseTimer = setTimeout(() => el.classList.remove('refreshing'), 400);
}

// 重新拉取项目列表并刷新运行状态。silent=true 时不弹提示（给定时轮询用，避免每 20 秒打扰）
async function refreshProjects(silent) {
  // 未登录（登录/注册遮罩可见）时不做后台刷新：401 会触发登录遮罩并把正在填写的表单清空
  if (authVeilVisible()) return;
  if (!silent) pulseDesktopRefresh();   // 先给即时视觉反馈，再（或同时）拉数据
  try {
    const res = await apiFetch('/api/projects?t=' + Date.now());  // 加时间戳防浏览器缓存
    DATA = await res.json();
    updateRunningStates();
    if (!silent) toast('已刷新项目状态');
  } catch (e) {
    if (!silent) toast('刷新失败：无法连接后端');
  }
}

// ===== 桌面图标（可拖动排序，位置持久化） =====
function renderDesktop() {
  const ps = DATA.projects || [];
  if (!ps.length) {
    iconsEl.innerHTML = '<div class="empty">未扫描到子项目。请在项目根目录放置子项目文件夹，或在 config.json 中配置。</div>';
    return;
  }
  const savedPos = loadJSON(ICON_POS_KEY, {});
  // 计算每个图标落点：保存过则吸附网格；被占用则找空格（历史歪位置自动对齐，且不重叠）
  const taken = new Set();
  document.querySelectorAll('.folder-item, .trash-item').forEach(el => {
    taken.add((parseInt(el.style.left) || 0) + ',' + (parseInt(el.style.top) || 0));
  });
  const positions = ps.map((p, i) => {
    const saved = savedPos[p.name];
    let pos = saved ? snapPos(saved.x, saved.y) : { x: GRID_X, y: GRID_Y + i * GRID_STEP_Y };
    if (taken.has(pos.x + ',' + pos.y)) pos = nextFree(pos.x + GRID_STEP_X, pos.y, taken);
    taken.add(pos.x + ',' + pos.y);
    return pos;
  });
  // 每个项目生成一个“玻璃小图标”：状态点 + 角色主题图标 + 名称；默认竖排，保存过则用保存位置
  iconsEl.innerHTML = ps.map((p, i) => {
    const pos = positions[i];
    return `
    <div class="desk-icon" data-name="${esc(p.name)}" style="left:${pos.x}px;top:${pos.y}px" title="${esc(p.display_name)}（单击打开，可拖动）">
      <span class="sdot ${p.running ? 'on' : ''}"></span>
      ${iconHtml(p)}
      <div class="nm">${esc(p.display_name)}</div>
    </div>`;
  }).join('');

  // 给每个图标绑事件：单击=选中并立即打开窗口，按住拖动=移动位置/拖入文件夹
  // （拖动结束后的 0.5 秒内 dragBlockUntil 会拦掉这次 click，所以拖图标不会误开窗口）
  iconsEl.querySelectorAll('.desk-icon').forEach(el => {
    el.addEventListener('click', () => {
      if (Date.now() < dragBlockUntil) return;
      iconsEl.querySelectorAll('.desk-icon').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
      openWindow(el.dataset.name);
    });
    makeDesktopDraggable(el, (x, y) => {
      const pos = loadJSON(ICON_POS_KEY, {});
      pos[el.dataset.name] = { x, y };
      localStorage.setItem(ICON_POS_KEY, JSON.stringify(pos));
    });
  });
}
