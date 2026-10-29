// 152-editor-wizard.js — 编辑器与新建项目向导
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ---- 25 代码/文档编辑器（详细版：行号 / 语法高亮 / 查找替换 / 状态栏） ----
const ED_FILES = {};   // key -> {project, path}
function openEditor(project, path) {
  const key = '__editor_' + project + '_' + path;
  if (openWins[key]) { activate(openWins[key].el); return; }
  ED_FILES[key] = { project, path };
  const ext = (path.split('.').pop() || '').toLowerCase();
  const win = makeWin(key, '编辑 ' + path, '📝', `
    <div class="ed-toolbar">
      <span class="ed-file">${esc(project + '/' + path)}</span>
      <span class="ed-tools">
        <button class="ed-find" title="查找 (Ctrl+F)">🔎 查找</button>
        <button class="ed-save" data-admin-only title="保存 (Ctrl+S)">💾 保存</button>
      </span>
    </div>
    <div class="ed-findbar" hidden>
      <input class="ed-find-in" placeholder="查找…">
      <span class="ed-find-count"></span>
      <button class="ed-find-prev">↑</button><button class="ed-find-next">↓</button>
      <button class="ed-find-close">✕</button>
    </div>
    <div class="ed-wrap">
      <div class="ed-gutter"></div>
      <div class="ed-hl" aria-hidden="true"></div>
      <textarea class="ed-area" spellcheck="false" data-ext="${ext}"></textarea>
    </div>
    <div class="ed-status"><span class="ed-pos">行 1, 列 1</span><span class="ed-len">0 字</span><span class="ed-saved">已加载</span></div>`);
  const area = win.querySelector('.ed-area');
  const gutter = win.querySelector('.ed-gutter');
  const hl = win.querySelector('.ed-hl');
  const posEl = win.querySelector('.ed-pos');
  const lenEl = win.querySelector('.ed-len');
  const savedEl = win.querySelector('.ed-saved');
  apiFetch('/api/file?project=' + encodeURIComponent(project) + '&path=' + encodeURIComponent(path))
    .then(r => r.json()).then(d => {
      area.value = d.content || '';
      renderCode();
    }).catch(() => { area.value = ''; renderCode(); });
  // 语法高亮（轻量正则，按扩展名）
  const HL_RULES = {
    py: [[/^(\s*)(#.*)$/gm, 'cmt'], [/(^|\s)("""[\s\S]*?"""|'''[\s\S]*?''')/g, 'str'], [/(^|[^\w])(#[0-9a-fA-F]{6})/g, 'str'],
      [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, 'str'], [/\b(def|class|return|import|from|if|elif|else|for|while|try|except|with|as|pass|break|continue|lambda|async|await|True|False|None)\b/g, 'kw'],
      [/\b(print|len|range|open|int|str|float|list|dict|set|enumerate|zip|map|filter|type|isinstance)\b/g, 'fn'],
      [/\b(\d+\.?\d*)\b/g, 'num']],
    js: [[/\/\/.*$/gm, 'cmt'], [/(\/\*[\s\S]*?\*\/)/g, 'cmt'], [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, 'str'],
      [/\b(function|const|let|var|return|if|else|for|while|class|new|import|export|from|async|await|try|catch|throw|typeof|instanceof|this|null|undefined|true|false)\b/g, 'kw'],
      [/\b(console|document|window|fetch|JSON|Math|Object|Array|String|Number)\b/g, 'fn'],
      [/\b(\d+\.?\d*)\b/g, 'num']],
    json: [[/"(?:[^"\\]|\\.)*"(?=\s*:)/g, 'key'], [/"(?:[^"\\]|\\.)*"/g, 'str'], [/\b(true|false|null)\b/g, 'kw'], [/\b(-?\d+\.?\d*)\b/g, 'num']],
    html: [[/<!--[\s\S]*?-->/g, 'cmt'], [/<\/?[a-zA-Z][^>]*>/g, 'tag'], [/"(?:[^"\\]|\\.)*"/g, 'str'], [/\b(style|class|id|src|href|type|name|value|placeholder)\b/g, 'attr']],
    css: [[/\/\*[\s\S]*?\*\//g, 'cmt'], [/#[0-9a-fA-F]{3,8}\b/g, 'num'], [/[a-zA-Z-]+(?=\s*:)/g, 'attr'], [/[a-zA-Z][a-zA-Z0-9-]*(?=\s*\{)/g, 'tag']],
    md: [[/^#{1,6}\s.*$/gm, 'kw'], [/\*\*[\s\S]*?\*\*/g, 'str'], [/`[^`]*`/g, 'str'], [/^[-*]\s/gm, 'num'], [/\[[^\]]*\]\([^)]*\)/g, 'fn']],
  };
  const rules = HL_RULES[ext] || HL_RULES.txt || [];
  const escTxt = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function renderCode() {
    const lines = area.value.split('\n');
    gutter.innerHTML = lines.map((_, i) => `<div>${i + 1}</div>`).join('');
    const raw = area.value;
    // 单次合并 tokenizer：把全部规则的命中区间一次性收集，按位置排序后拼接，
    // 避免顺序 replace 把已插入的 <span> 标记再次匹配而嵌套错位（损坏高亮层）。
    const hits = [];
    rules.forEach(([re, cls]) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        hits.push([m.index, m.index + m[0].length, cls, m[0]]);
        if (!re.global) break;
      }
    });
    hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
    let html = '', last = 0;
    for (const [s, e, cls, txt] of hits) {
      if (s < last) continue;                       // 跳过被更长命中覆盖的重叠区间
      html += escTxt(raw.slice(last, s));
      html += `<span class="ed-${cls}">${escTxt(txt)}</span>`;
      last = e;
    }
    html += escTxt(raw.slice(last));
    hl.innerHTML = html.replace(/\n$/, '\n ');
    hl.scrollTop = area.scrollTop; hl.scrollLeft = area.scrollLeft;
    gutter.scrollTop = area.scrollTop;
    lenEl.textContent = area.value.length + ' 字';
  }
  area.addEventListener('input', () => {
    renderCode();
    savedEl.textContent = '未保存';
    savedEl.classList.add('dirty');
    const li = area.value.slice(0, area.selectionStart).split('\n').length;
    const ci = area.selectionStart - area.value.lastIndexOf('\n', area.selectionStart - 1);
    posEl.textContent = '行 ' + li + ', 列 ' + ci;
  });
  area.addEventListener('keyup', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      const li = area.value.slice(0, area.selectionStart).split('\n').length;
      const ci = area.selectionStart - area.value.lastIndexOf('\n', area.selectionStart - 1);
      posEl.textContent = '行 ' + li + ', 列 ' + ci;
    }
  });
  area.addEventListener('scroll', () => { hl.scrollTop = area.scrollTop; hl.scrollLeft = area.scrollLeft; gutter.scrollTop = area.scrollTop; });
  // Tab → 两个空格
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = area.selectionStart, e2 = area.selectionEnd;
      area.value = area.value.slice(0, s) + '  ' + area.value.slice(e2);
      area.selectionStart = area.selectionEnd = s + 2;
      renderCode();
    }
  });
  // 保存
  const save = async () => {
    const r = await apiFetch('/api/file/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, path, content: area.value }) });
    const d = await r.json();
    if (d.ok) { savedEl.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); savedEl.classList.remove('dirty'); toast('已保存：' + path); }
    else toast('保存失败');
  };
  win.querySelector('.ed-save').onclick = save;
  area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
  // 查找 / 替换（Ctrl+F 打开查找条）
  const findbar = win.querySelector('.ed-findbar');
  const findIn = win.querySelector('.ed-find-in');
  const findCount = win.querySelector('.ed-find-count');
  let lastFind = '';
  function doFind(dir) {
    const q = findIn.value;
    if (!q) return;
    if (q !== lastFind) { lastFind = q; }
    const val = area.value;
    const idx = dir === -1 ? val.lastIndexOf(q, area.selectionStart - 1) : val.indexOf(q, area.selectionStart + (dir === 1 && val.slice(area.selectionStart, area.selectionStart + q.length) === q ? q.length : 0));
    if (idx >= 0) { area.focus(); area.setSelectionRange(idx, idx + q.length); renderCode(); area.scrollTop = area.scrollTop; }
    // 高亮全部匹配
    const matches = val.split(q).length - 1;
    findCount.textContent = matches ? (Math.min(Math.max(idx, 0) / q.length, matches - 1) + 1) + ' / ' + matches : '无结果';
  }
  win.querySelector('.ed-find').onclick = () => { findbar.hidden = !findbar.hidden; if (!findbar.hidden) { findIn.focus(); } };
  win.querySelector('.ed-find-close').onclick = () => { findbar.hidden = true; };
  win.querySelector('.ed-find-next').onclick = () => doFind(1);
  win.querySelector('.ed-find-prev').onclick = () => doFind(-1);
  findIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doFind(1); } else if (e.key === 'Escape') findbar.hidden = true; });
  area.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findbar.hidden = false; findIn.focus(); findIn.select(); } });
}

// ---- 26 新建项目向导（详细版） ----
function openNewProject() {
  const win = makeWin('__newproj', '新建项目', '📦', `
    <div class="np-body">
      <label>项目名（英文/数字/-/_）</label><input class="np-name" placeholder="例如 my-app">
      <label>显示名（桌面上显示的名字）</label><input class="np-display" placeholder="例如 我的应用">
      <label>模板</label>
      <select class="np-tpl">
        <option value="blank">空项目（仅 README）</option>
        <option value="python">Python 脚本（main.py）</option>
        <option value="node">Node.js（index.js）</option>
        <option value="web">网页应用（index.html + style.css + app.js）</option>
      </select>
      <label>描述（写进 README 和卡片）</label>
      <input class="np-desc" placeholder="这个项目是做什么的…">
      <button class="np-ok">创建</button>
    </div>`);
  win.querySelector('.np-ok').onclick = async () => {
    const name = win.querySelector('.np-name').value.trim();
    const display = win.querySelector('.np-display').value.trim() || name;
    const tpl = win.querySelector('.np-tpl').value;
    const desc = win.querySelector('.np-desc').value.trim() || (display + ' 项目');
    if (!name) { toast('请输入项目名'); return; }
    const r = await apiFetch('/api/project/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, display, template: tpl, description: desc }) });
    const d = await r.json();
    if (d.ok) { toast('已创建项目：' + display); closeWindow(win); load(); }
    else toast(d.error || '创建失败');
  };
}
