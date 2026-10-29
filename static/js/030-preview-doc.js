// 030-preview-doc.js — 预览窗口、Markdown 渲染、代码高亮
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 桌面内预览窗口（iframe 内嵌 localhost 开发服务） =====
// 网络隔离说明：iframe 加载的是本机 dev server（127.0.0.1:<port>），与枢纽（127.0.0.1:8000）
// 端口不同属跨域，但本枢纽 CSP 的 frame-src 已放行 http://127.0.0.1:* 与 http://localhost:*；
// 被预览服务自身若再发 X-Frame-Options / frame-ancestors 限制则会拒绝嵌套（属其自身设定）。
function openPreview(p) {
  const url = previewUrlFor(p);
  if (!url) { toast('该项目未配置预览地址（请在 config.json 设置 port 或本地预览链接）'); return; }
  const key = '__preview_' + p.name;
  if (openWins[key]) {                       // 已打开：激活即可
    const w = openWins[key];
    w.minimized = false; w.el.style.display = 'flex'; activate(w.el);
    return;
  }
  const win = document.createElement('div');
  win.className = 'win active preview-win';
  win.style.width = '820px';
  win.style.height = '560px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">🌐</span>
      <span class="title">预览 · ${esc(p.display_name)}</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body preview-body">
      <div class="preview-bar">
        <span class="preview-dot ${p.running ? 'on' : ''}" id="pvDot" title="服务状态"></span>
        <input class="preview-url" id="pvUrl" readonly value="${esc(url)}" title="${esc(url)}">
        <button class="btn ghost" id="pvRefresh" title="刷新页面">⟳</button>
        <button class="btn ghost" id="pvOpen" title="在新标签页打开">🪟</button>
      </div>
      <div class="preview-frame-wrap">
        <iframe class="preview-frame" id="pvFrame" ${p.running ? `src="${esc(url)}"` : ''}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-presentation"
          referrerpolicy="no-referrer"></iframe>
        <div class="preview-overlay" id="pvOverlay" ${p.running ? 'hidden' : ''}>
          <div class="pv-card">
            <div class="pv-ico">🛰️</div>
            <div class="pv-title">服务未运行</div>
            <div class="pv-sub">尚未检测到 ${esc(p.port ? ('端口 ' + p.port) : '本地服务')} 在运行。<br>先启动项目，即可在桌面内预览。</div>
            <button class="btn act-run" id="pvStart"><span class="bi">▶</span>启动并预览</button>
          </div>
        </div>
      </div>
    </div>`;
  windowsEl.appendChild(win);
  playSfx('open');

  const frame = win.querySelector('#pvFrame');
  const overlay = win.querySelector('#pvOverlay');
  const dot = win.querySelector('#pvDot');

  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation(); win.style.display = 'none';
    if (openWins[key]) openWins[key].minimized = true;
    syncTaskActive();
  };
  win.querySelector('#pvRefresh').onclick = (e) => {
    e.stopPropagation();
    if (frame.getAttribute('src')) frame.src = frame.src;   // 触发重新加载
    else if (p.running) frame.src = url;
  };
  win.querySelector('#pvOpen').onclick = (e) => {
    e.stopPropagation();
    if (isSafeNavUrl(url)) window.open(url, '_blank', 'noopener');
    else toast('链接被拦截（仅允许 http/https）：' + url);
  };
  win.querySelector('#pvStart').onclick = (e) => {
    e.stopPropagation();
    apiPost(`/api/projects/${encodeURIComponent(p.name)}/start`).then(ok => {
      if (ok) toast('已发送启动指令，正在等待服务就绪…');
      previewWait(win, p.name, url);
    });
  };

  // 若打开时服务已在跑，iframe 已带 src；否则开始轮询等待就绪
  if (!p.running) previewWait(win, p.name, url);

  // 任务栏按钮
  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `🌐<span class="nm">预览 · ${esc(p.display_name)}</span>`;
  taskBtn.onclick = () => {
    const w = openWins[key]; if (!w) return;
    if (w.minimized || win.style.display === 'none') {
      win.style.display = 'flex'; w.minimized = false; activate(win);
    } else if (Number(win.style.zIndex) === zCounter) {
      win.style.display = 'none'; w.minimized = true; syncTaskActive();
    } else activate(win);
  };
  taskItemsEl.appendChild(taskBtn);

  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());
  openWins[key] = { el: win, taskBtn: taskBtn, minimized: false };
  centerWin(win, 820, 560);
  activate(win);
}

// 轮询 projects 状态：当被预览项目端口就绪（running=true）时，给 iframe 加载并隐藏遮罩
function previewWait(win, name, url) {
  const frame = win.querySelector('#pvFrame');
  const overlay = win.querySelector('#pvOverlay');
  const dot = win.querySelector('#pvDot');
  let tries = 0;
  const iv = setInterval(async () => {
    tries++;
    await refreshProjects(true);
    const fresh = (DATA.projects || []).find(x => x.name === name);
    if (fresh && fresh.running) {
      clearInterval(iv);
      dot.classList.add('on');
      frame.src = url;
      overlay.hidden = true;
      toast('服务已就绪，开始预览');
    } else if (tries > 25) {
      clearInterval(iv);
      toast('等待超时：请确认 run 命令能正常启动服务（可在系统终端查看日志）');
    }
  }, 800);
  // 把定时器挂到窗口上，关闭时由 closeWindow 统一 clearInterval 清掉，避免泄漏
  win._pvTimer = iv;
}

// ===== 桌面内文档查看器：迷你 Markdown 渲染器（零依赖） =====
// 安全策略（与 esc() 同一思路）：先把全文转义，再只插入自己产生的标签；
// 链接逐个过 isSafeNavUrl 白名单（仅 http/https），从根上杜绝 XSS。

// ---- 代码高亮（零依赖）：基于已转义文本做 token 着色，绝不破坏转义 ----
const HL_KW = {
  python: ['def','class','import','from','as','return','if','elif','else','for','while','in','not','and','or','with','try','except','finally','raise','yield','lambda','pass','break','continue','global','nonlocal','assert','del','is','None','True','False','self','async','await','print'],
  js: ['function','return','if','else','for','while','var','let','const','class','extends','new','async','await','try','catch','finally','throw','switch','case','break','continue','typeof','instanceof','of','in','this','null','undefined','true','false','import','export','from','default','void','yield'],
  bash: ['if','then','else','fi','for','in','do','done','while','case','esac','function','echo','cd','export','local','return','exit'],
};
const HL_COMMENT = {
  python: /#[^\n]*/,
  bash: /#[^\n]*/,
  js: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
  css: /\/\*[\s\S]*?\*\//,
  html: /<!--[\s\S]*?-->/,
};
function highlightCode(code, lang) {
  if (!code) return '';
  lang = (lang || '').toLowerCase();
  const kw = HL_KW[lang];
  const commentRe = HL_COMMENT[lang] || /#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//;
  const rules = [
    { cls: 'tok-comment', re: commentRe },
    { cls: 'tok-string', re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/ },
    { cls: 'tok-number', re: /\b(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/ },
  ];
  if (kw && kw.length) rules.push({ cls: 'tok-keyword', re: new RegExp('\\b(?:' + kw.join('|') + ')\\b') });
  if (lang === 'html' || lang === 'xml') rules.push({ cls: 'tok-tag', re: /<\/?[a-zA-Z][\w-]*|\/?>/ });
  const combined = new RegExp(rules.map(r => '(' + r.re.source + ')').join('|'), 'g');
  let out = '', last = 0, m;
  while ((m = combined.exec(code))) {
    if (m[0].length === 0) { combined.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    let cls = null;
    for (let k = 1; k < m.length; k++) { if (m[k] != null) { cls = rules[k - 1].cls; break; } }
    out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

// 文档目录锚点生成（中文友好，自动去重）
function slugifyHeading(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[^\w一-龥\- ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}
function mdHeadingId(text, toc) {
  let id = slugifyHeading(text);
  if (toc) {
    const used = new Set(toc.map(t => t.id));
    let n = 2;
    while (used.has(id)) id = slugifyHeading(text) + '-' + (n++);
  }
  return id;
}
function dirnameOf(rel) {
  if (!rel) return '';
  const i = String(rel).lastIndexOf('/');
  return i > 0 ? rel.slice(0, i) : '';
}
// 渲染文档：统一处理 内联图片上下文(ctx) 与 目录收集(toc)
function renderDoc(content, project, base, toc) {
  return mdToHtml(content, {
    ctx: project ? { project: String(project), base: base || '' } : null,
    toc: toc || null,
  });
}

function mdInline(s, ctx) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  // 图片：仅当提供 ctx（文档查看器内）且为相对路径时内联本地图片；
  //      外链 / 无 ctx / 锚点 一律退化为 alt 文本（不拉外链、不注入危险 src）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = url.replace(/&amp;/g, '&');
    if (ctx && !/^[a-z]+:\/\//i.test(u) && !/^data:/i.test(u) && !/^#/.test(u)) {
      const rel = u.replace(/^\.\//, '');
      const full = (ctx.base ? ctx.base + '/' : '') + rel;
      const src = '/api/raw?project=' + encodeURIComponent(ctx.project) +
        '&path=' + encodeURIComponent(full.replace(/\/{2,}/g, '/'));
      return '<img class="doc-img" src="' + esc(src) + '" alt="' + alt + '" loading="lazy">';
    }
    return alt;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const url = u.replace(/&amp;/g, '&');   // esc() 已把 & 转成 &amp;，校验前先还原
    // href 必须经 esc()：否则形如 [x]("onmouseover=…) 的链接会借引号跳出属性，形成 XSS
    return isSafeNavUrl(url) ? '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>' : t;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[+i] + '</code>');
}

function mdToHtml(src, opts) {
  // 双数组并行：raw 用于语法识别，lines（逐行 esc）用于内容输出。
  // 必须分开——esc() 会把 '>' 转成 '&gt;'，若在转义后的文本上判定 '> 引用' 语法会全部失效。
  const ctx = (opts && opts.ctx) || null;
  const toc = (opts && opts.toc) || null;
  const raw = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const lines = raw.map(esc);
  const out = [];
  let para = [], listType = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(t => mdInline(t, ctx)).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; } };
  const flushAll = () => { flushPara(); flushList(); };
  let i = 0;
  while (i < raw.length) {
    const tr = raw[i].trim();       // 原始行：语法判定
    const t = lines[i].trim();      // 转义行：内容输出
    if (/^```/.test(tr)) {                                  // 代码块
      flushAll();
      const lang = tr.slice(3).trim().toLowerCase();
      const buf = [];
      i++;
      while (i < raw.length && !/^```/.test(raw[i].trim())) { buf.push(raw[i]); i++; }
      i++;
      out.push('<pre class="code-block' + (lang ? ' lang-' + esc(lang) : '') + '"><code>' + highlightCode(buf.join('\n'), lang) + '</code></pre>');
      continue;
    }
    if (!tr) { flushAll(); i++; continue; }
    const h = tr.match(/^(#{1,6})\s+(.*)$/);                // 标题
    if (h) {
      flushAll();
      const lv = h[1].length;
      const id = toc ? mdHeadingId(h[2], toc) : '';
      if (toc) toc.push({ lv, text: h[2].trim(), id });
      out.push('<h' + lv + (id ? ' id="' + esc(id) + '"' : '') + '>' + mdInline(esc(h[2]), ctx) + '</h' + lv + '>');
      i++; continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(tr)) { flushAll(); out.push('<hr>'); i++; continue; }   // 分割线
    if (tr.indexOf('|') > -1 && i + 1 < raw.length && /^[\s|:-]+$/.test(raw[i + 1].trim()) && raw[i + 1].indexOf('-') > -1) {
      flushAll();                                            // 表格：表头行 + 分隔行 + 数据行
      const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => esc(c.trim()));
      out.push('<table><thead><tr>' + cells(tr).map(c => '<th>' + mdInline(c, ctx) + '</th>').join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < raw.length && raw[i].trim().indexOf('|') > -1) {
        out.push('<tr>' + cells(raw[i].trim()).map(c => '<td>' + mdInline(c, ctx) + '</td>').join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table>');
      continue;
    }
    if (/^>\s?/.test(tr)) {                                  // 引用块
      flushAll();
      const buf = [];
      while (i < raw.length && /^>\s?/.test(raw[i].trim())) { buf.push(esc(raw[i].trim().replace(/^>\s?/, ''))); i++; }
      out.push('<blockquote>' + buf.map(x => mdInline(x, ctx)).join('<br>') + '</blockquote>');
      continue;
    }
    const ul = tr.match(/^[-*+]\s+(.*)$/), ol = tr.match(/^\d{1,3}[.)]\s+(.*)$/);   // 列表
    if (ul || ol) {
      flushPara();
      const lt = ul ? 'ul' : 'ol';
      if (listType !== lt) { flushList(); out.push(lt === 'ul' ? '<ul>' : '<ol>'); listType = lt; }
      out.push('<li>' + mdInline(esc(ul ? ul[1] : ol[1]), ctx) + '</li>');
      i++;
      continue;
    }
    flushList();                                             // 普通段落行
    para.push(t);
    i++;
  }
  flushAll();
  return out.join('');
}

// 拉取文档内容并打开「文档查看器」窗口（查看文档按钮 / 右键菜单 / 摘要里的"查看完整文档"都走这里）
async function openDocViewer(p) {
  let j = {};
  try {
    const res = await apiFetch('/api/docs?project=' + encodeURIComponent(p.name));
    j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) { toast('打开文档失败：' + (j.error || res.status)); return; }
  } catch (e) {
    toast('请求失败：无法连接后端');
    return;
  }
  showDocWindow(p, j.file || '文档', j.content || '');
}

// 文档窗口内容渲染：.md 走 Markdown 渲染器，其余文本按纯文本 <pre> 展示
// （否则 Python/JSON 里的 '#' 注释会被误渲染成标题、'-' 会被误渲染成列表）
function fmDocHtml(fileRel, content, mode) {
  const m = mode || fmDocMode(fileRel);
  return m === 'md' ? mdToHtml(content) : '<pre class="doc-plain">' + esc(content) + '</pre>';
}

function showDocWindow(p, fileRel, content, mode, extRel) {
  const key = '__doc_' + p.name;
  const m = mode || fmDocMode(fileRel);
  const toc = [];
  const fileName = String(fileRel).split(/[\\/]/).pop();
  const html = m === 'md'
    ? renderDoc(content, p.name, dirnameOf(fileRel), toc)
    : '<pre class="doc-plain">' + esc(content) + '</pre>';
  const docTocHtml = (list) => !list || !list.length ? ''
    : '<div class="doc-toc-hd">目录</div>' + list.map(t =>
        `<a class="doc-toc-item lv${t.lv}" href="#${esc(t.id)}" data-id="${esc(t.id)}">${esc(t.text)}</a>`).join('');
  const bindToc = (w) => w.querySelectorAll('.doc-toc-item').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const sel = '#' + (window.CSS && CSS.escape ? CSS.escape(a.dataset.id) : a.dataset.id);
      const tgt = w.querySelector('.doc-content').querySelector(sel);
      if (tgt) tgt.scrollIntoView({ block: 'start' });
    };
  });
  if (openWins[key]) {                      // 已打开：刷新内容并激活（磁盘上的文档可能已被修改）
    const w = openWins[key];
    w.minimized = false;
    w.el.style.display = 'flex';
    const art = w.el.querySelector('.doc-content');
    if (art) art.innerHTML = html;
    const tocEl = w.el.querySelector('.doc-toc');
    if (tocEl) tocEl.innerHTML = docTocHtml(toc);
    bindToc(w.el);
    activate(w.el);
    return;
  }
  const off = (Object.keys(openWins).length % 6) * 26;
  const win = document.createElement('div');
  win.className = 'win active doc-win';
  win.style.width = '700px';
  win.style.height = '520px';
  win.style.left = (150 + off) + 'px';
  win.style.top = (80 + off) + 'px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">📄</span>
      <span class="title">${esc(fileName)} - 文档</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body doc-body">
      <div class="doc-toolbar">
        <span class="doc-path" title="${esc(fileRel)}">${esc(fileRel)}</span>
        <button class="btn ghost" id="docExternal"><span class="bi">🪟</span>用系统程序打开</button>
      </div>
      <div class="doc-split">
        <nav class="doc-toc">${docTocHtml(toc)}</nav>
        <article class="doc-content">${html}</article>
      </div>
    </div>`;
  windowsEl.appendChild(win);
  playSfx('open');

  win.querySelector('#docExternal').onclick = (e) => {
    e.stopPropagation();
    // extRel 存在（来自文件管理器）→ 用系统程序打开该项目内任意文件；否则打开配置的 docs
    if (extRel) apiPost(`/api/projects/${encodeURIComponent(p.name)}/open?path=${encodeURIComponent(extRel)}`);
    else apiPost(`/api/projects/${encodeURIComponent(p.name)}/docs`);
  };
  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation();
    win.style.display = 'none';
    if (openWins[key]) openWins[key].minimized = true;
    syncTaskActive();
  };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());

  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">📄</span><span class="nm">${esc(fileName)}</span>`;
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

// 项目窗口内嵌 README 摘要：取文档前 6 个块渲染，失败静默（不影响窗口本身）
async function loadDocSummary(win, p) {
  try {
    const res = await apiFetch('/api/docs?project=' + encodeURIComponent(p.name));
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false || !j.content) return;
    const box = win.querySelector('.doc-summary');
    if (!box || !win.isConnected) return;    // 窗口可能在请求期间已被关闭
    const blocks = String(j.content).replace(/\r\n?/g, '\n').split(/\n\s*\n/).filter(b => b.trim());
    box.innerHTML =
      '<div class="doc-summary-hd">文档摘要 · ' + esc(String(j.file || '').split(/[\\/]/).pop()) + '</div>' +
      '<div class="doc-summary-bd">' + renderDoc(blocks.slice(0, 6).join('\n\n'), p.name, dirnameOf(j.file || ''), null) +
      (blocks.length > 6 ? '<div class="doc-more">……（共 ' + blocks.length + ' 段）</div>' : '') + '</div>' +
      '<button class="btn ghost doc-summary-btn"><span class="bi">📄</span>查看完整文档</button>';
    box.hidden = false;
    box.querySelector('.doc-summary-btn').onclick = (e) => {
      e.stopPropagation();
      showDocWindow(p, j.file || '文档', j.content || '');
    };
  } catch (e) { /* 摘要加载失败不影响主窗口 */ }
}
