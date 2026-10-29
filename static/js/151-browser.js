// 151-browser.js — 内置浏览器
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ---- 24 内置浏览器（主页 = 青柠起始页；站点内容经枢纽代理改写后呈现） ----
// 为什么要代理：iframe 直接嵌外部站点会撞上目标站的 X-Frame-Options /
// CSP frame-ancestors（limestart.cn、结果页、绝大多数新闻站都这样），
// 表现就是「主页能开、点任何链接都空白」。浏览器的这条策略前端改不了，
// 所以统一走 /browse/<真实网址>：服务端取回页面、把链接改写回代理地址，
// iframe 里就永远只加载同源资源，点击可以正常跳转。
// 少数站点在代理下功能不全（登录/支付/强依赖自身域名的 JS），
// 工具栏给了「代理 ⇄ 直连」切换和 ↗ 系统浏览器兜底。
const BR_HOME = 'https://limestart.cn/';                                    // 默认主页（不再用百度）
const BR_ENGINE = { name: '搜狗', url: 'https://www.sogou.com/web?query=%s' };  // 地址栏搜索（非百度）
const BR_LOCAL_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const BR_MODE = {};   // host -> 'direct'（用户手动切换过的站点才记录，默认全部代理）
const BR_LOAD_TIMEOUT = 15000;   // 单页加载超时：超过就判「超时」而不是一直转圈
// 代理页必须是不透明源（不带 allow-same-origin），否则它能拿到枢纽 Origin 去调 /api。
// 直连页是目标站自己的源，加 allow-same-origin 只是让它保留真实 Origin，
// 父窗口才能读到它的 location/title（跨源时仍然读不到，会静默失败）。
const BR_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const BR_SANDBOX_SAME = BR_SANDBOX + ' allow-same-origin';

function brHost(u) {
  try { return new URL(u).hostname; } catch (e) { return ''; }
}
// 默认模式：本机开发服务直连（它们本来就在本机、也不该被代理），其余一律走代理
function brMode(u) {
  const host = brHost(u);
  if (host && BR_MODE[host]) return BR_MODE[host];
  return BR_LOCAL_RE.test(u) ? 'direct' : 'proxy';
}

function brNormalize(input) {
  var s = String(input || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  // 形如 example.com / a.b.c/path / localhost:8080 的，补协议
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([\/?#]|$)/.test(s) || /^localhost(:\d+)?/i.test(s)) {
    return 'https://' + s;
  }
  if (s.charAt(0) === '/') return location.origin + s;   // 站内路径
  return BR_ENGINE.url.replace('%s', encodeURIComponent(s));   // 否则当搜索词
}

// 代理密钥：代理页被降级成「不透明源」（不带 Cookie），子请求靠 URL 里的这个密钥
// 通过 /browse 的鉴权。只对 /browse 有效，拿它打 /api 一律 401。
var _brKey = '', _brKeyAt = 0, _brKeyP = null;
function brKey() {
  var now = Date.now();
  if (_brKey && now - _brKeyAt < 25 * 60 * 1000) return Promise.resolve(_brKey);
  if (_brKeyP) return _brKeyP;
  _brKeyP = apiFetch('/api/browse/key').then(function (r) { return r.json(); })
    .then(function (d) {
      _brKey = (d && d.key) || '';
      // 空密钥不能缓存：否则一次失败会把「拿不到 key」锁定 25 分钟，
      // 期间每次导航都退化成无密钥地址 → 代理页 401 / 空白。
      _brKeyAt = _brKey ? Date.now() : 0;
      _brKeyP = null;
      return _brKey;
    })
    .catch(function () { _brKeyP = null; _brKey = ''; _brKeyAt = 0; return ''; });
  return _brKeyP;
}
function brShareCode() {
  // 云端平台分享码：必须挂到 /browse 的 URL 上。
  // 沙箱 iframe 是不透明源，浏览器把它的子资源请求当第三方请求，Cookie 可能被拦；
  // 而平台网关只要 URL 带 sharecode 就放行，否则 403「链接不完整」→ 页面只剩深色底。
  var s = '';
  try { s = new URLSearchParams(location.search).get('sharecode') || ''; } catch (e) { s = ''; }
  if (s) {
    // 记到 sessionStorage（同标签页刷新用）和 localStorage（关掉再打开也别丢），
    // 这样即使之后地址栏没有 sharecode，API 请求仍能带上它过网关。
    try { sessionStorage.setItem('hub_share', s); } catch (e) { /* 隐私模式忽略 */ }
    try { localStorage.setItem('hub_share', s); } catch (e) { /* 隐私模式忽略 */ }
    return s;
  }
  try { s = sessionStorage.getItem('hub_share') || ''; } catch (e) { s = ''; }
  if (!s) { try { s = localStorage.getItem('hub_share') || ''; } catch (e) { s = ''; } }
  return s;
}
function brProxyUrl(u, key) {
  var s = brShareCode();
  var tail = '';
  // sharecode 给平台网关放行；_hs 是同一份值给服务端自己看（网关会把 sharecode 剔掉）
  if (s) tail = (String(u).indexOf('?') >= 0 ? '&' : '?') + 'sharecode=' + encodeURIComponent(s) + '&_hs=' + encodeURIComponent(s);
  return '/browse/' + (key ? key + '/' : '') + u + tail;
}
// 从 /browse/<key>/<真实网址> 里剥出真实网址（key 段可缺省）
function brStripShare(u) {
  // 分享码只是给平台网关看的，不能显示到地址栏、更不能二次拼进代理地址
  var s = String(u || '');
  if (s.indexOf('sharecode=') < 0 && s.indexOf('_hs=') < 0) return s;
  var hash = '';
  var h = s;
  var k = h.indexOf('#');
  if (k >= 0) { hash = h.slice(k); h = h.slice(0, k); }
  var q = h.indexOf('?');
  if (q < 0) return s;
  var parts = h.slice(q + 1).split('&').filter(function (p) { return p && p.indexOf('sharecode=') !== 0 && p.indexOf('_hs=') !== 0; });
  return h.slice(0, q) + (parts.length ? '?' + parts.join('&') : '') + hash;
}
function brRealOf(pathname) {
  var k = String(pathname || '').indexOf('/browse/');
  if (k < 0) return '';
  var rest = String(pathname).slice(k + 8);
  if (/^https?:\/\//i.test(rest)) return brStripShare(rest);
  var j = rest.indexOf('/');
  return j > 0 ? brStripShare(rest.slice(j + 1)) : '';
}

// 浏览器支持多标签页 + 多窗口：每个标签页独立历史 / iframe；点击浏览器图标若已开则聚焦并新开标签；
// 工具栏「▢」可再开一个独立浏览器窗口。窗口标题随活动标签变化，方便在任务栏区分。
let brWinSeq = 0;

function openBrowser(url) {
  // 主浏览器窗口（key 固定为 __browser）：已开则聚焦，并在新标签页打开传入网址
  if (openWins['__browser']) {
    const w = openWins['__browser'].el;
    activate(w);
    if (w.__brCtrl) w.__brCtrl.newTab(url);
    return;
  }
  createBrowserWindow('__browser', url || '');
}

function openBrowserWindow(url) {
  createBrowserWindow('__browser_win_' + (++brWinSeq), url || '');
}

function createBrowserWindow(winKey, initialUrl) {
  const win = makeWin(winKey, '浏览器', '🌐', `
    <div class="br-bar">
      <button class="br-nav br-back" title="后退">←</button>
      <button class="br-nav br-fwd" title="前进">→</button>
      <button class="br-nav br-reload" title="刷新（Ctrl+R）">⟳</button>
      <button class="br-nav br-home" title="主页：青柠起始页">⌂</button>
      <input class="br-url" spellcheck="false" autocomplete="off" placeholder="输入网址或搜索词，回车访问">
      <button class="br-star" title="收藏当前页（Ctrl+D）">☆</button>
      <button class="br-go" title="访问 / 搜索">前往</button>
      <button class="br-mode" title="切换 代理 / 直连（代理兼容性最好；直连适合本机服务和少数功能异常的站点）">代理</button>
      <button class="br-ext" title="在系统浏览器打开（登录、支付等场景建议用系统浏览器）">↗</button>
      <button class="br-win" title="新窗口（独立浏览器窗口）">▢</button>
      <div class="br-bmpop">
        <div class="bmp-h"><span>书签</span><span class="bmp-n">0</span></div>
        <div class="bmp-list"></div>
        <div class="bmp-foot">右键或 Delete 移除书签</div>
      </div>
    </div>
    <div class="br-tabs">
      <div class="br-tablist"></div>
      <button class="br-tabadd" title="新标签页（Ctrl+T）">＋</button>
    </div>
    <div class="br-tip"><span class="br-badge loading">连接中…</span><span class="br-hint"></span></div>
    <div class="br-stack"></div>`,
    { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight - taskbarH() });

  const stack = win.querySelector('.br-stack');
  const tablist = win.querySelector('.br-tablist');
  const urlIn = win.querySelector('.br-url');
  const badge = win.querySelector('.br-badge');
  const hint = win.querySelector('.br-hint');
  const modeBtn = win.querySelector('.br-mode');
  const starBtn = win.querySelector('.br-star');
  const bmPop = win.querySelector('.br-bmpop');
  const titleEl = win.querySelector('.title');
  const isMain = winKey === '__browser';

  let tabs = [];
  let activeId = 0;
  let tabSeq = 0;
  let closedTabs = [];        // 最近关闭的标签（Ctrl+Shift+T 恢复）
  let restoring = false;      // 恢复会话期间不回写会话，避免把半截状态存进去
  let saveTimer = 0;
  let urlDirty = false;       // 用户正在地址栏里敲字时，别用旧地址覆盖他

  const activeTab = () => tabs.find(t => t.id === activeId) || null;
  const isFront = () => win.isConnected && !win._closing && win.style.display !== 'none' && Number(win.style.zIndex) === zCounter;
  const pretty = (u) => { try { return decodeURI(u); } catch (e) { return u; } };

  // 站点能否被 iframe 直接嵌入：结果按 host 缓存
  const BR_EMBED = {};
  function brPickMode(u) {
    return new Promise(function (resolve) {
      const host = brHost(u);
      if (!host || BR_LOCAL_RE.test(u)) return resolve('direct');
      if (BR_EMBED[host] === true) return resolve('direct');
      if (BR_EMBED[host] === false) return resolve('proxy');
      const sc = brShareCode();
      const q = '?u=' + encodeURIComponent(u) + (sc ? '&sharecode=' + encodeURIComponent(sc) : '');
      apiFetch('/api/browse/check' + q).then(r => r.json())
        .then(d => { BR_EMBED[host] = !!(d && d.embeddable); resolve(BR_EMBED[host] ? 'direct' : 'proxy'); })
        .catch(() => resolve('proxy'));
    });
  }

  // ---- 标签页外观 ----
  // 加载中显示「连接中…」+ 呼吸点；加载完成换成站点图标 + 真实标题。
  // 图标取自 <link rel=icon>（由代理注入脚本上报），取不到就退成域名 favicon，
  // 再取不到退成 🌐 —— 不能让标签上挂裂图。
  function renderChip(tab) {
    const tx = tab.chip.querySelector('.br-tab-tx');
    const ic = tab.chip.querySelector('.br-tab-ic');
    const loading = tab.mode !== 'start' && tab.loading;
    tab.chip.classList.toggle('loading', loading);
    if (tab.mode === 'start') {
      tx.textContent = '新标签页';
      ic.innerHTML = '<span class="br-tab-emo">🗂</span>';
    } else if (loading) {
      tx.textContent = '连接中…';
      ic.innerHTML = '<span class="br-dot"></span>';
    } else {
      tx.textContent = tab.title || brHost(tab.url) || '标签页';
      const src = tab.icon || brIconSrc(tab.url, tab.mode);
      ic.innerHTML = src
        ? '<img alt="" src="' + esc(src) + '">'
        : '<span class="br-tab-emo">🌐</span>';
      const img = ic.querySelector('img');
      if (img) img.onerror = () => { ic.innerHTML = '<span class="br-tab-emo">🌐</span>'; };
    }
    tab.chip.title = tab.mode === 'start'
      ? '新标签页'
      : (tab.title ? tab.title + '\n' + tab.url : (tab.url || ''));
    if (tab.id === activeId) {
      titleEl.textContent = tab.mode === 'start' ? '浏览器' : (tab.title || brHost(tab.url) || '浏览器');
    }
    fillBar(tab);
  }

  function setBadge(tab, mode, note) {
    tab.badgeCls = (mode === 'proxy' ? 'proxy' : mode === 'direct' ? 'direct'
      : mode === 'start' ? 'start' : 'loading');
    tab.badgeText = mode === 'proxy' ? '代理模式' : (mode === 'direct' ? '直连模式'
      : mode === 'start' ? '本地面板' : '连接中…');
    tab.hintText = note || '';
    fillBar(tab);
  }

  // 把当前标签的状态刷到工具栏（只有活动标签才需要）
  function fillBar(tab) {
    if (!tab || tab.id !== activeId) return;
    badge.className = 'br-badge ' + tab.badgeCls;
    badge.textContent = tab.badgeText;
    hint.textContent = tab.hintText;
    modeBtn.textContent = tab.mode === 'direct' ? '直连' : '代理';
    modeBtn.classList.toggle('on-proxy', tab.mode === 'proxy');
    updateStar();
  }

  function updateStar() {
    const t = activeTab();
    const on = !!(t && t.mode !== 'start' && t.url && brBmHas(t.url));
    starBtn.textContent = on ? '★' : '☆';
    starBtn.classList.toggle('on', on);
    starBtn.title = on ? '已收藏，点击取消（Ctrl+D）' : '收藏当前页（Ctrl+D）';
  }

  // 地址栏实时同步：用户正在输入时不覆盖，回车/切标签/页面跳转后才回填
  function syncBar(tab) {
    if (!tab || tab.id !== activeId || urlDirty) return;
    urlIn.value = tab.mode === 'start' ? '' : (tab.url || '');
  }

  // ---- 起始页（新标签页） ----
  // 与青柠主页互不干扰：点 ⌂ 才去青柠，新标签页是本地面板（搜索 / 快捷入口 / 最近访问）。
  function renderStart(tab) {
    const my = ++tab.startSeq;
    const qs = brQuickAll();
    const qBox = tab.startEl.querySelector('.bs-quick');
    const tiles = qs.map((q, i) => {
      const letter = esc(brInitial(q.url, q.name));
      const icon = brIconSrc(q.url, 'proxy');
      return '<button type="button" class="bs-tile" data-i="' + i + '" data-url="' + esc(q.url) + '"'
        + ' title="' + esc((q.name || brHost(q.url)) + '\n' + q.url) + '">'
        + '<span class="t-ic"><span class="t-lt">' + letter + '</span>'
        + (icon ? '<img alt="" src="' + esc(icon) + '">' : '') + '</span>'
        + '<span class="t-nm">' + esc(q.name || brHost(q.url)) + '</span></button>';
    }).join('');
    qBox.innerHTML = tiles + (qs.length < BR_QUICK_MAX
      ? '<button type="button" class="bs-tile bs-add" title="添加快捷入口（最多 8 个）"><span class="t-ic">＋</span><span class="t-nm">添加</span></button>'
      : '');

    const hBox = tab.startEl.querySelector('.bs-hist');
    hBox.innerHTML = '<div class="bs-empty">读取最近访问…</div>';
    brHistRecent(10).then(rows => {
      if (tab.startSeq !== my || !hBox.isConnected) return;
      if (!rows.length) {
        hBox.innerHTML = '<div class="bs-empty">还没有浏览记录。打开过的页面会出现在这里（最近 10 条）。</div>';
        return;
      }
      hBox.innerHTML = rows.map(r => {
        const host = brHost(r.url);
        const title = r.title || host || r.url;
        return '<div class="bs-row" data-url="' + esc(r.url) + '" title="' + esc(title + '\n' + r.url) + '">'
          + '<span class="r-ic">' + esc(brInitial(r.url, host)) + '</span>'
          + '<span class="r-t">' + esc(title) + '</span>'
          + '<span class="r-u">' + esc(host || '') + '</span>'
          + '<span class="r-d">' + esc(brTimeText(r.ts)) + '</span></div>';
      }).join('');
    });
  }

  function showStart(tab) {
    tab.navSeq += 1;
    clearTimeout(tab.loadTimer);
    tab.mode = 'start';
    tab.url = '';
    tab.title = '';
    tab.icon = '';
    tab.loading = false;
    tab.failed = false;
    tab.badgeCls = 'start';
    tab.badgeText = '本地面板';
    tab.hintText = '新标签页：搜索、快捷入口、最近访问；点 ⌂ 进青柠主页';
    tab.frame.style.display = 'none';
    try { tab.frame.src = 'about:blank'; } catch (e) { /* 忽略 */ }
    hideFail(tab);
    tab.startEl.style.display = 'flex';
    renderStart(tab);
    renderChip(tab);
    syncBar(tab);
    fillBar(tab);
    syncNav();
    saveSessionSoon();
  }

  // ---- 失败提示：区分超时 / 站点拒绝代理 / 网络断开 ----
  function showFail(tab, title, detail, kind) {
    tab.failBox.querySelector('.bf-title').textContent = title || '页面没能打开';
    tab.failDetail.textContent = detail || '';
    tab.failBox.dataset.kind = kind || '';
    // 离线 / 登录失效时「改用直连」没有意义，隐藏掉少点误导
    tab.failBox.querySelector('.bf-direct').style.display = (kind === 'offline' || kind === 'auth') ? 'none' : '';
    tab.failBox.classList.add('on');
  }
  function hideFail(tab) {
    tab.failBox.classList.remove('on');
    tab.failBox.dataset.kind = '';
  }
  function kindText(kind) {
    return kind === 'timeout' ? '加载超时' : kind === 'offline' ? '网络已断开'
      : kind === 'blocked' ? '站点拒绝代理' : kind === 'upstream' ? '站点无响应'
      : kind === 'auth' ? '登录状态已失效' : '页面没能打开';
  }

  function failOffline(tab) {
    tab.loading = false;
    clearTimeout(tab.loadTimer);
    tab.failed = true;
    setBadge(tab, 'proxy', '网络已断开');
    showFail(tab, '网络已断开',
      '设备当前处于离线状态（navigator.onLine = false）：枢纽页面还能显示是因为本地缓存，但取不到任何站点内容。恢复网络后点「重试」。',
      'offline');
    renderChip(tab);
  }

  function onLoadTimeout(tab, seq) {
    if (seq !== tab.navSeq || !tab.loading) return;
    if (!navigator.onLine) return failOffline(tab);
    tab.loading = false;
    tab.failed = true;
    setBadge(tab, 'proxy', '加载超时');
    showFail(tab, '加载超时',
      '目标站点在 ' + Math.round(BR_LOAD_TIMEOUT / 1000) + ' 秒内没有返回内容。可能是网络较慢、站点拒绝被代理，或该页面需要登录后才能访问。可点「重试」，或点右上角 ↗ 用系统浏览器打开。',
      'timeout');
    renderChip(tab);
  }

  // 代理层返回的错误页会 postMessage 报错码（见 hub/handlers/browse.py），
  // 这里按码分类，避免把「站点拒绝代理」和「网络断了」都显示成同一句「打不开」。
  function onProxyError(tab, code, msg) {
    tab.loading = false;
    clearTimeout(tab.loadTimer);
    tab.failed = true;
    if (code === 401) {
      setBadge(tab, 'proxy', '登录状态已失效');
      showFail(tab, '登录状态已失效',
        '代理密钥没能取到或已过期，通常是登录已过期、会话丢失。请回到枢纽页面按 Ctrl+F5 强制刷新并重新登录，再点「重试」。',
        'auth');
    } else if (!navigator.onLine) {
      return failOffline(tab);
    } else if (code === 403) {
      setBadge(tab, 'proxy', '站点拒绝代理');
      showFail(tab, '站点拒绝被代理',
        (msg ? msg + '。' : '') + '这次请求被代理层拦下了：目标站可能拒绝被代理访问，或该地址解析到了内网 / 本机地址。可点「改用直连」再试，或用系统浏览器打开。',
        'blocked');
    } else if (code === 502 || code === 504) {
      setBadge(tab, 'proxy', '站点无响应');
      showFail(tab, '站点拒绝了这次请求',
        '代理连上了网关，但目标站点没有正常响应（' + (msg || '上游超时或拒绝连接') + '）。可能是站点在做访问限制或临时故障，可点「重试」，或用系统浏览器打开。',
        'upstream');
    } else {
      setBadge(tab, 'proxy', '页面没能打开');
      showFail(tab, '页面没能打开', msg || ('代理返回 ' + code + '。'), 'other');
    }
    renderChip(tab);
  }

  // ---- 导航 ----
  function loadProxy(tab, u, seq) {
    brKey().then(k => {
      if (seq !== tab.navSeq) return;
      if (!k) {
        clearTimeout(tab.loadTimer);
        setBadge(tab, 'proxy', '登录状态已失效');
        showFail(tab, '登录状态已失效',
          '没能取到代理密钥，通常是登录已过期或会话丢失。请回到枢纽页面按 Ctrl+F5 强制刷新并重新登录，再打开浏览器。',
          'auth');
        tab.loading = false;
        renderChip(tab);
        return;
      }
      tab.frame.src = brProxyUrl(u, k);
    }).catch(err => {
      if (seq !== tab.navSeq) return;
      clearTimeout(tab.loadTimer);
      tab.loading = false;
      if (err && err.code === 401) {
        setBadge(tab, 'proxy', '登录状态已失效');
        showFail(tab, '登录状态已失效', '登录已过期或已退出。请先在这个页面重新登录，然后在浏览器窗口里点「重试」。', 'auth');
      } else {
        setBadge(tab, 'proxy', '取密钥失败');
        showFail(tab, '没能连上枢纽服务', '获取代理密钥失败，可能是枢纽服务已停止或网络中断。请确认本页能正常刷新，然后点「重试」。', 'offline');
      }
      renderChip(tab);
    });
  }

  function nav(tab, input, opts) {
    opts = opts || {};
    const u = brNormalize(input);
    if (!u) { showStart(tab); return; }
    tab.url = pretty(u);
    tab.rawUrl = u;
    tab.title = '';
    tab.icon = '';
    tab.loading = true;
    tab.failed = false;
    tab.mode = 'loading';
    const seq = ++tab.navSeq;
    clearTimeout(tab.loadTimer);
    hideFail(tab);
    tab.startEl.style.display = 'none';
    tab.frame.style.display = 'block';
    setBadge(tab, 'loading', '正在通过枢纽取回页面…');
    renderChip(tab);
    syncBar(tab);
    tab.loadTimer = setTimeout(() => onLoadTimeout(tab, seq), BR_LOAD_TIMEOUT);

    brPickMode(u).then(pick => {
      if (seq !== tab.navSeq) return;
      const host = brHost(u);
      const isLocal = BR_LOCAL_RE.test(u);
      let useProxy;
      if (isLocal) useProxy = false;
      else if (BR_MODE[host] === 'direct') {
        if (pick === 'direct') useProxy = false;
        else { BR_EMBED[host] = false; delete BR_MODE[host]; toast(host + ' 禁止被嵌入，已自动改用代理'); useProxy = true; }
      } else useProxy = true;
      tab.mode = useProxy ? 'proxy' : 'direct';
      let crossOrigin = true;
      try { crossOrigin = new URL(u).origin !== location.origin; } catch (e) { crossOrigin = true; }
      // 沙箱必须在设置 src 之前定下来（加载后再改不生效）
      tab.frame.setAttribute('sandbox', (!useProxy && crossOrigin) ? BR_SANDBOX_SAME : BR_SANDBOX);
      if (useProxy) {
        setBadge(tab, 'proxy', '页面经枢纽代理渲染：能点、能翻页；登录/支付等敏感操作建议点 ↗ 用系统浏览器');
        loadProxy(tab, u, seq);
      } else {
        setBadge(tab, 'direct', '直连模式：站点允许被嵌入，功能最完整');
        tab.frame.src = u;
      }
      renderChip(tab);
    });

    if (opts.record !== false) {
      tab.hist = tab.hist.slice(0, tab.hi + 1);
      tab.hist.push(u);
      tab.hi = tab.hist.length - 1;
    }
    syncNav();
    saveSessionSoon();
  }

  // 直连页读 location / title：只有同源时才读得到，跨源会抛 SecurityError，静默放弃。
  // 返回是否发生变化，供轮询决定要不要重绘（避免每秒重排一次标签）。
  function readDirectMeta(tab) {
    if (tab.mode !== 'direct') return false;
    let changed = false;
    let href = '', title = '', icon = '';
    try {
      const w = tab.frame.contentWindow;
      const d = tab.frame.contentDocument;
      href = (w && w.location && w.location.href) || '';
      title = (d && d.title) || '';
      const link = d && d.querySelector ? d.querySelector('link[rel~="icon"],link[rel="shortcut icon"]') : null;
      icon = (link && link.href) || '';
    } catch (e) { return false; }
    if (href && href !== 'about:blank') {
      const clean = brStripShare(href);
      if (clean && clean !== tab.rawUrl) { tab.rawUrl = clean; tab.url = pretty(clean); changed = true; }
    }
    if (title && title !== tab.title) { tab.title = title.slice(0, 120); changed = true; }
    if (icon && icon !== tab.icon) { tab.icon = icon; changed = true; }
    return changed;
  }

  // 直连页的「地址栏跟随」靠轮询：SPA 用 pushState 换地址时不会触发 load，
  // 代理页有注入脚本上报，直连页只能自己看。只查活动标签，1.2 秒一次，代价可忽略。
  const pollTimer = setInterval(() => {
    // 窗口被别处移除（比如整页刷新/异常关闭）时把监听和定时器一并收掉
    if (!win.isConnected) { cleanup(); return; }
    const t = activeTab();
    if (!t || t.mode !== 'direct' || t.loading || t.frame.style.display === 'none') return;
    if (readDirectMeta(t)) { renderChip(t); syncBar(t); }
  }, 1200);

  function makeTab() {
    const id = ++tabSeq;
    const page = document.createElement('div');
    page.className = 'br-page';
    page.dataset.tab = id;
    page.innerHTML = `
      <div class="br-start">
        <div class="bs-wrap">
          <div class="bs-brand"><span class="bs-mark">🧭</span><span>新标签页</span></div>
          <form class="bs-form" autocomplete="off">
            <input class="bs-q" spellcheck="false" autocomplete="off" placeholder="搜索网页，或输入网址后回车">
            <button class="bs-go" type="submit">搜索</button>
          </form>
          <div class="bs-quick"></div>
          <div class="bs-histwrap">
            <div class="bs-h"><span>最近访问</span><button class="bs-clear" type="button">清空历史</button></div>
            <div class="bs-hist"></div>
          </div>
        </div>
      </div>
      <div class="br-wrap">
        <div class="br-fail">
          <div class="bf-ico">!</div>
          <div class="bf-title">页面没能打开</div>
          <div class="bf-detail"></div>
          <div class="bf-acts">
            <button class="bf-btn primary bf-retry">重试</button>
            <button class="bf-btn bf-direct">改用直连</button>
            <button class="bf-btn bf-ext">用系统浏览器打开</button>
          </div>
        </div>
        <iframe class="br-frame" sandbox="${BR_SANDBOX}"></iframe>
      </div>`;
    stack.appendChild(page);

    const chip = document.createElement('div');
    chip.className = 'br-tab';
    chip.dataset.tab = id;
    chip.innerHTML = '<span class="br-tab-ic">🌐</span><span class="br-tab-tx">新标签页</span><button class="br-tab-x" title="关闭">×</button>';
    tablist.appendChild(chip);

    const tab = {
      id, url: '', rawUrl: '', title: '', icon: '',
      mode: 'start', loading: false, failed: false,
      hist: [], hi: -1, navSeq: 0, loadTimer: 0, startSeq: 0,
      badgeCls: 'loading', badgeText: '连接中…', hintText: '',
      el: page, frame: page.querySelector('.br-frame'),
      startEl: page.querySelector('.br-start'),
      failBox: page.querySelector('.br-fail'), failDetail: page.querySelector('.bf-detail'),
      chip,
    };
    tab.frame.style.display = 'none';

    page.querySelector('.bf-retry').onclick = () => {
      hideFail(tab); tab.failed = false;
      nav(tab, tab.rawUrl || tab.hist[tab.hi] || tab.url || BR_HOME, { record: false });
    };
    page.querySelector('.bf-direct').onclick = () => {
      const cur = tab.rawUrl || tab.hist[tab.hi] || tab.url || BR_HOME;
      const host = brHost(cur);
      if (host) BR_MODE[host] = 'direct';
      hideFail(tab); nav(tab, cur, { record: false });
    };
    page.querySelector('.bf-ext').onclick = () => {
      window.open(brNormalize(urlIn.value || tab.url || BR_HOME) || BR_HOME, '_blank');
    };

    // 起始页：搜索 / 快捷入口 / 最近访问 / 清空历史
    const form = page.querySelector('.bs-form');
    const q = page.querySelector('.bs-q');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = q.value.trim();
      if (v) nav(tab, v);
    });
    const quickBox = page.querySelector('.bs-quick');
    quickBox.addEventListener('click', (e) => {
      if (e.target.closest('.bs-add')) { addQuick(tab); return; }
      const tile = e.target.closest('.bs-tile[data-url]');
      if (tile) nav(tab, tile.dataset.url);
    });
    quickBox.addEventListener('contextmenu', (e) => {
      const tile = e.target.closest('.bs-tile[data-url]');
      if (!tile) return;
      e.preventDefault();
      brQuickSave(brQuickAll().filter(x => x.url !== tile.dataset.url));
      renderStart(tab);
      toast('已移除快捷入口');
    });
    // favicon 取不到时把 <img> 摘掉，露出底下的首字母
    quickBox.addEventListener('error', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG') t.remove();
    }, true);
    page.querySelector('.bs-clear').onclick = async () => {
      const ok = await hubConfirm('清空全部浏览历史？书签和快捷入口不受影响。', {
        title: '清空历史记录', okText: '清空', danger: true,
      });
      if (!ok) return;
      brHistClear().then(() => { renderStart(tab); toast('历史已清空'); });
    };
    page.querySelector('.bs-hist').addEventListener('click', (e) => {
      const row = e.target.closest('.bs-row[data-url]');
      if (row) nav(tab, row.dataset.url);
    });

    chip.addEventListener('mousedown', (e) => { if (e.target.classList.contains('br-tab-x')) return; switchTab(id); });
    chip.querySelector('.br-tab-x').onclick = (e) => { e.stopPropagation(); closeTab(id); };

    tab.frame.addEventListener('load', () => {
      const src = tab.frame.getAttribute('src') || '';
      if (!src || src === 'about:blank' || tab.mode === 'start') return;
      clearTimeout(tab.loadTimer);
      // 错误页也会触发 load：等 postMessage 报错码来判定，这里不抢着把失败面板关掉
      if (tab.failed) { tab.loading = false; renderChip(tab); return; }
      tab.loading = false;
      if (tab.mode === 'loading') tab.mode = 'proxy';
      readDirectMeta(tab);
      renderChip(tab);
      brHistAdd(tab.url, tab.title || brHost(tab.url));
      saveSessionSoon();
    });

    tabs.push(tab);
    return tab;
  }

  async function addQuick(tab) {
    const list = brQuickAll();
    if (list.length >= BR_QUICK_MAX) { toast('最多 ' + BR_QUICK_MAX + ' 个快捷入口'); return; }
    const raw = String(await hubPrompt('输入网址，名称自动取域名。', {
      title: '添加快捷入口', value: 'https://', placeholder: 'https://github.com',
    }) || '').trim();
    if (!raw) return;
    let u = raw;
    if (!/^https?:\/\//i.test(u)) {
      if (!/^[\w-]+(\.[\w-]+)+(:\d+)?([\/?#]|$)/.test(u)) { toast('请填写网址，例如 github.com'); return; }
      u = 'https://' + u;
    }
    if (list.some(x => x.url === u)) { toast('这个入口已经存在'); return; }
    list.push({ name: brHost(u) || u, url: u });
    brQuickSave(list);
    renderStart(tab);
    toast('已添加快捷入口');
  }

  function switchTab(id) {
    activeId = id;
    tabs.forEach(t => {
      t.el.style.display = (t.id === id) ? 'flex' : 'none';
      t.chip.classList.toggle('active', t.id === id);
    });
    const t = activeTab();
    if (!t) return;
    urlDirty = false;
    syncBar(t);
    fillBar(t);
    renderChip(t);
    syncNav();
    closeBmPanel();
  }

  function newTab(url, opts) {
    opts = opts || {};
    const t = makeTab();
    if (opts.background) t.el.style.display = 'none';
    nav(t, url || '');
    if (!opts.background) switchTab(t.id);
    else renderChip(t);
    saveSessionSoon();
    return t;
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const t = tabs[idx];
    if (t.url && t.mode !== 'start') {
      closedTabs.push({ url: t.rawUrl || t.url, title: t.title });
      if (closedTabs.length > 12) closedTabs.shift();
    }
    t.el.remove();
    t.chip.remove();
    clearTimeout(t.loadTimer);
    tabs.splice(idx, 1);
    if (activeId === id) {
      if (!tabs.length) newTab('');
      else switchTab(tabs[Math.max(0, idx - 1)].id);
    }
    saveSessionSoon();
  }

  function reopenClosed() {
    const last = closedTabs.pop();
    if (!last) { toast('没有可恢复的标签'); return; }
    newTab(last.url);
  }

  function syncNav() {
    const t = activeTab();
    win.querySelector('.br-back').disabled = !t || t.hi <= 0;
    win.querySelector('.br-fwd').disabled = !t || t.hi >= t.hist.length - 1;
  }

  function reloadActive() {
    const t = activeTab();
    if (!t) return;
    if (t.mode === 'start') { renderStart(t); return; }
    if (t.mode === 'direct') {
      try {
        t.frame.contentWindow.location.reload();
        return;
      } catch (e) { /* 跨源读不到就整页重载 */ }
    }
    nav(t, t.rawUrl || t.url || BR_HOME, { record: false });
  }

  // ---- 书签面板 ----
  function renderBmPanel() {
    const list = brBmAll();
    bmPop.querySelector('.bmp-n').textContent = String(list.length);
    const box = bmPop.querySelector('.bmp-list');
    if (!list.length) {
      box.innerHTML = '<div class="bmp-empty">还没有书签。<br>打开页面后按 Ctrl+D 收藏（☆ 打开这个面板）。</div>';
      return;
    }
    box.innerHTML = list.map(b => {
      const host = brHost(b.url) || '';
      return '<div class="bmp-row" tabindex="0" data-url="' + esc(b.url) + '"'
        + ' title="' + esc((b.title || host) + '\n' + b.url + '\n右键或 Delete 移除') + '">'
        + '<span class="bmp-ic">' + esc(brInitial(b.url, host)) + '</span>'
        + '<span class="bmp-tx"><span class="bmp-t">' + esc(b.title || host) + '</span>'
        + '<span class="bmp-u">' + esc(host) + '</span></span></div>';
    }).join('');
  }
  function openBmPanel() { renderBmPanel(); bmPop.classList.add('on'); }
  function closeBmPanel() { bmPop.classList.remove('on'); }

  bmPop.querySelector('.bmp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.bmp-row[data-url]');
    if (!row) return;
    const t = activeTab() || newTab('');
    closeBmPanel();
    nav(t, row.dataset.url);
  });
  function dropBookmark(row) {
    brBmRemove(row.dataset.url);
    renderBmPanel();
    updateStar();
    toast('已移除书签');
  }
  bmPop.querySelector('.bmp-list').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.bmp-row[data-url]');
    if (!row) return;
    e.preventDefault();
    dropBookmark(row);
  });
  bmPop.querySelector('.bmp-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const row = e.target.closest('.bmp-row[data-url]');
    if (!row) return;
    e.preventDefault();
    dropBookmark(row);
  });

  function toggleBookmark() {
    const t = activeTab();
    if (!t || t.mode === 'start' || !t.url) { toast('先打开一个页面再收藏'); return; }
    if (brBmHas(t.url)) { brBmRemove(t.url); toast('已取消收藏'); }
    else { brBmAdd(t.url, t.title); toast('已收藏：' + (t.title || brHost(t.url))); }
    updateStar();
    if (bmPop.classList.contains('on')) renderBmPanel();
  }

  // ---- 会话：关窗口后下次打开恢复（只记主窗口） ----
  function saveSessionNow() {
    if (!isMain) return;
    // 起始页不入库，所以「活动标签下标」也必须在过滤后的那份列表里算，
    // 否则从 tabs 里取到的下标会把恢复时的选中项带偏（3 个标签全开会越界）
    const live = tabs.filter(t => t.url && t.mode !== 'start');
    const list = live.map(t => ({ url: t.rawUrl || t.url, title: t.title || brHost(t.url) }));
    const idx = live.findIndex(t => t.id === activeId);
    brSessionSave({ tabs: list, active: idx < 0 ? 0 : idx });
  }
  // 标签切换 / 标题变化很密集，写库做 500ms 防抖；关窗口时必须落盘（见下方 close）
  function saveSessionSoon() {
    if (restoring || !isMain) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSessionNow, 500);
  }

  // ---- 代理页 → 父窗口的消息 ----
  const onMsg = (e) => {
    const t = tabs.find(x => x.frame.contentWindow === e.source);
    if (!t) return;
    const d = e.data;
    if (!d || d.__hubBrowse !== 1) return;
    if (d.nav) { nav(t, d.nav); return; }
    // Ctrl+点击 / 中键：新标签打开，当前页不跳走
    if (d.open) { newTab(d.open, { background: true }); toast('已在新标签页打开'); return; }
    if (d.title) {
      const tx = String(d.title).trim().slice(0, 120);
      if (tx && tx !== t.title) {
        t.title = tx;
        clearTimeout(t.loadTimer);
        t.loading = false;
        renderChip(t);
        brHistAdd(t.url, tx);
        saveSessionSoon();
      }
      return;
    }
    if (d.icon) { t.icon = String(d.icon); renderChip(t); return; }
    if (d.here) {
      const u = brStripShare(String(d.here || ''));
      if (u && u !== t.url) {
        t.url = pretty(u);
        t.rawUrl = u;
        syncBar(t);
        renderChip(t);
      }
      return;
    }
    if (d.dl) { toast('已开始下载'); return; }
    if (d.key) { shimKey(t, String(d.key)); return; }
    if (d.err) { onProxyError(t, Number(d.err) || 0, d.msg || ''); return; }
  };
  window.addEventListener('message', onMsg);

  // 代理页里按下的快捷键：iframe 内的按键不会冒泡到父窗口，只能由注入脚本转发
  function shimKey(tab, key) {
    if (tab && tab.id !== activeId) switchTab(tab.id);
    if (key === 'ctrl+t') newTab('');
    else if (key === 'ctrl+w') closeTab(tab.id);
    else if (key === 'ctrl+l') { urlIn.focus(); urlIn.select(); }
    else if (key === 'ctrl+r') reloadActive();
    else if (key === 'ctrl+d') toggleBookmark();
    else if (key === 'ctrl+shift+t') reopenClosed();
  }

  // ---- 窗口内的快捷键（焦点在枢纽页面上时） ----
  const onKey = (e) => {
    if (!isFront()) return;
    const k = String(e.key || '').toLowerCase();
    if (!(e.ctrlKey || e.metaKey)) {
      if (k === 'f5') { e.preventDefault(); reloadActive(); }
      return;
    }
    if (e.shiftKey && k === 't') { e.preventDefault(); reopenClosed(); return; }
    if (k === 'l') { e.preventDefault(); urlDirty = false; urlIn.focus(); urlIn.select(); }
    else if (k === 't') { e.preventDefault(); newTab(''); }
    else if (k === 'w') { e.preventDefault(); if (tabs.length) closeTab(activeId); }
    else if (k === 'r') { e.preventDefault(); reloadActive(); }
    else if (k === 'd') { e.preventDefault(); toggleBookmark(); }
  };
  document.addEventListener('keydown', onKey, true);

  // 点面板外面收起书签面板
  const onDocDown = (e) => {
    if (!bmPop.classList.contains('on')) return;
    if (bmPop.contains(e.target) || starBtn.contains(e.target)) return;
    closeBmPanel();
  };
  document.addEventListener('mousedown', onDocDown, true);

  // ---- 工具栏 ----
  win.querySelector('.br-go').onclick = () => { const t = activeTab(); if (t) { urlDirty = false; nav(t, urlIn.value); } };
  win.querySelector('.br-home').onclick = () => { const t = activeTab(); if (t) nav(t, BR_HOME); };
  win.querySelector('.br-reload').onclick = reloadActive;
  win.querySelector('.br-back').onclick = () => {
    const t = activeTab(); if (!t || t.hi <= 0) return;
    t.hi -= 1; nav(t, t.hist[t.hi], { record: false });
  };
  win.querySelector('.br-fwd').onclick = () => {
    const t = activeTab(); if (!t || t.hi >= t.hist.length - 1) return;
    t.hi += 1; nav(t, t.hist[t.hi], { record: false });
  };
  starBtn.onclick = (e) => {
    e.stopPropagation();
    if (bmPop.classList.contains('on')) closeBmPanel();
    else if (activeTab() && activeTab().mode !== 'start') openBmPanel();
    else toast('先打开一个页面再收藏');
  };
  modeBtn.onclick = () => {
    const t = activeTab(); if (!t || t.mode === 'start') return;
    const cur = t.rawUrl || t.hist[t.hi] || t.url || BR_HOME;
    const host = brHost(cur); if (!host) return;
    BR_MODE[host] = brMode(cur) === 'proxy' ? 'direct' : 'proxy';
    toast(host + ' 已切换为「' + (BR_MODE[host] === 'proxy' ? '代理' : '直连') + '」模式');
    nav(t, cur, { record: false });
  };
  win.querySelector('.br-ext').onclick = (e) => {
    e.stopPropagation();
    const t = activeTab();
    const u = brNormalize(urlIn.value || (t ? t.url : '')) || BR_HOME;
    window.open(u, '_blank'); toast('已在系统浏览器打开');
  };
  win.querySelector('.br-win').onclick = (e) => { e.stopPropagation(); openBrowserWindow(); };
  win.querySelector('.br-tabadd').onclick = () => newTab('');
  urlIn.addEventListener('input', () => { urlDirty = true; });
  urlIn.addEventListener('blur', () => { urlDirty = false; });
  urlIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      urlIn.value = urlIn.value.trim();
      urlDirty = false;
      const t = activeTab();
      if (t) nav(t, urlIn.value);
    } else if (e.key === 'Escape') {
      const t = activeTab();
      urlDirty = false;
      if (t) syncBar(t);
      urlIn.blur();
    }
  });

  // ---- 关闭：直接关（不确认），并把清理做干净 ----
  function cleanup() {
    window.removeEventListener('message', onMsg);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDocDown, true);
    clearInterval(pollTimer);
    clearTimeout(saveTimer);
    tabs.forEach(t => clearTimeout(t.loadTimer));
  }
  win.querySelector('.close').onclick = () => {
    // 直接关，不做二次确认（多标签也照关）：标签已经落盘，下次打开浏览器会自动恢复上次会话，
    // 也可以用 Ctrl+Shift+T 找回刚关掉的标签，所以确认框只会碍事。
    saveSessionNow();          // 先落盘再清理，别让防抖定时器被 cleanup 掐掉
    cleanup();
    closeWindow(win);
  };

  // ---- 启动：有初址就直达，否则恢复上次会话（仅主窗口） ----
  function boot() {
    if (initialUrl) {
      const t = makeTab();
      switchTab(t.id);
      nav(t, initialUrl);
      return;
    }
    if (!isMain) {
      const t = makeTab();
      switchTab(t.id);
      showStart(t);
      return;
    }
    restoring = true;
    brSessionLoad().then(sess => {
      const list = (sess && Array.isArray(sess.tabs) ? sess.tabs : []).filter(x => x && /^https?:/i.test(x.url || ''));
      if (!list.length) {
        restoring = false;
        const t = makeTab();
        switchTab(t.id);
        showStart(t);
        return;
      }
      const made = list.map(x => { const t = makeTab(); nav(t, x.url); return t; });
      const idx = Math.min(list.length - 1, Math.max(0, (sess.active | 0)));
      switchTab(made[idx].id);
      restoring = false;
      saveSessionSoon();
      toast('已恢复上次打开的 ' + list.length + ' 个标签');
    }).catch(() => {
      restoring = false;
      const t = makeTab();
      switchTab(t.id);
      showStart(t);
    });
  }
  boot();

  win.__brCtrl = { newTab: (u) => newTab(u) };
}
