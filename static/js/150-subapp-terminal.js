// 150-subapp-terminal.js — 子应用窗口与终端
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ============================================================
// 大功能包（22-27）：虚拟桌面 / 终端 / 浏览器 / 编辑器 / 新建项目 / 任务视图
// ============================================================

// 通用开窗辅助：标题 + body HTML + 返回窗口元素
function makeWin(key, title, iconHtml, bodyHtml, opts) {
  opts = opts || {};
  if (openWins[key]) { activate(openWins[key].el); return openWins[key].el; }
  const off = (Object.keys(openWins).length % 6) * 24;
  const win = document.createElement('div');
  win.className = 'win active';
  const cw = opts.width || 560, ch = opts.height || 420;
  const c = centerPos(cw, ch, off);          // 首开居中（有布局记忆时 registerWindow 会覆盖）
  win.style.width = cw + 'px';
  win.style.height = ch + 'px';
  win.style.left = (opts.left != null ? opts.left : c.left) + 'px';
  win.style.top = (opts.top != null ? opts.top : c.top) + 'px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar"><span class="ic">${iconHtml}</span><span class="title">${esc(title)}</span>
      <span class="x"><button class="min" title="最小化">—</button><button class="max" title="最大化">□</button><button class="close" title="关闭">✕</button></span></div>
    <div class="body" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden">${bodyHtml}</div>`;
  windowsEl.appendChild(win);
  win.querySelector('.close').onclick = () => closeWindow(win);
  win.querySelector('.min').onclick = () => { win.style.display = 'none'; if (openWins[key]) openWins[key].minimized = true; syncTaskActive(); };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  registerWindow(key, win);
  activate(win);
  return win;
}

// ---- 22.5 子应用窗口（星枢 / 桓梦工作台） ----
// 与「预览」的区别：预览开的是 127.0.0.1:<port>（跨源，云端会撞混合内容），
// 这里开的是同源挂载点 /apps/xxx/，由枢纽反向代理到子应用，
// 所以本地和云端同一套逻辑、Cookie 与 CSP 语义也一致。
// iframe 不加 sandbox：这是我们自己的子应用，需要 localStorage / 同源请求。
function openAppWindow(p) {
  const key = '__app_' + p.name;
  const url = String(p.app || '');
  const win = makeWin(key, p.display_name, iconHtml(p), `
    <div class="app-bar">
      <button class="app-nav app-reload" title="重新加载">⟳</button>
      <span class="app-path" title="${esc(url)}">${esc(url)}</span>
      <span class="app-state loading">连接中…</span>
      <button class="app-nav app-ext" title="在新标签页打开">↗</button>
      <button class="app-nav app-info" title="项目详情 / 启动状态">ⓘ</button>
    </div>
    <div class="app-wrap">
      <div class="app-fail">
        <div class="af-ico">!</div>
        <div class="af-title">子应用没能加载</div>
        <div class="af-detail"></div>
        <div class="af-acts">
          <button class="bf-btn primary af-retry">重试</button>
          <button class="bf-btn af-info2">查看项目详情</button>
        </div>
      </div>
      <iframe class="app-frame" src="${esc(url)}" title="${esc(p.display_name)}"></iframe>
    </div>`,
    {
      left: 26, top: 26,
      width: Math.min(1240, Math.max(860, window.innerWidth - 120)),
      height: Math.min(860, Math.max(560, window.innerHeight - 130)),
    });

  const frame = win.querySelector('.app-frame');
  const stateEl = win.querySelector('.app-state');
  const failBox = win.querySelector('.app-fail');
  const failDetail = win.querySelector('.af-detail');
  let timer = 0;

  function setState(text, cls) {
    stateEl.className = 'app-state ' + (cls || '');
    stateEl.textContent = text;
  }
  function showFail(detail) {
    failDetail.textContent = detail || '';
    failBox.classList.add('on');
    setState('加载失败', 'bad');
  }
  function load() {
    failBox.classList.remove('on');
    setState('连接中…', 'loading');
    frame.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
    clearTimeout(timer);
    // 兜底：子应用没响应时（Node 未启动/启动失败）iframe 不会触发 load，
    // 界面上必须自己给出解释，否则用户只看到一个空窗口。
    timer = setTimeout(() => {
      if (!frame.dataset.ok) showFail('20 秒内没有响应。若为首次打开，后端可能仍在启动；也可点「重试」，或查看项目详情里的日志路径。');
    }, 20000);
  }
  frame.addEventListener('load', () => {
    frame.dataset.ok = '1';
    clearTimeout(timer);
    setState('已就绪', 'ok');
    failBox.classList.remove('on');
  });
  win.querySelector('.app-reload').onclick = load;
  win.querySelector('.app-ext').onclick = () => window.open(url, '_blank', 'noopener');
  win.querySelector('.app-info').onclick = () => openWindow(p.name, true);   // 打开项目详情卡片
  win.querySelector('.af-retry').onclick = load;
  win.querySelector('.af-info2').onclick = () => openWindow(p.name, true);
  // 最大化/还原（makeWin 的 □ 按钮默认没有绑定行为，这里补上）
  const maxBtn = win.querySelector('.max');
  if (maxBtn) {
    maxBtn.onclick = (e) => {
      e.stopPropagation();
      const on = win.classList.toggle('app-maxed');
      win.dataset.prev = win.dataset.prev || JSON.stringify({
        left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height,
      });
      if (on) {
        win.style.left = '8px'; win.style.top = '8px';
        win.style.width = (window.innerWidth - 16) + 'px';
        win.style.height = (window.innerHeight - taskbarH() - 16) + 'px';
      } else {
        try {
          const prev = JSON.parse(win.dataset.prev || '{}');
          Object.keys(prev).forEach(k => { if (prev[k]) win.style[k] = prev[k]; });
        } catch (err) { /* 忽略布局记忆损坏 */ }
      }
    };
  }
  load();
}

// ---- 23 内置终端 ----
function openTerminal() {
  const win = makeWin('__terminal', '终端', '⬛', `
    <div class="term-out"></div>
    <div class="term-in-row"><span class="term-prompt">$</span><input class="term-in" placeholder="输入命令，回车执行…" autocomplete="off"></div>`);
  const out = win.querySelector('.term-out');
  const tin = win.querySelector('.term-in');
  const print = (txt) => { const d = document.createElement('div'); d.textContent = txt; out.appendChild(d); out.scrollTop = out.scrollHeight; };
  print('项目枢纽终端 · cwd = 项目根目录 · 输入 help');
  tin.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const cmd = tin.value.trim();
    if (!cmd) return;
    print('$ ' + cmd);
    tin.value = '';
    try {
      const r = await apiFetch('/api/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd }) });
      const d = await r.json();
      if (d.out) print(d.out.trimEnd());
      if (!d.ok) print('错误：' + (d.error || ''));
    } catch (err) { print('请求失败：' + err); }
  });
}
