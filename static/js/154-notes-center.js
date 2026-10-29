// 154-notes-center.js — 「便签与记事本」收纳盒
// 背景：便签和记事本以前是「关掉只是暂时藏起来」，而且每次打开页面把所有记录都铺回桌面，
// 攒多了每次都得手动关一遍。现在启动最多自动恢复最近 1 张便签 + 1 个记事本，
// 其余（含手动收起过的）都躺在这里，点一下就能重新打开，内容不会丢。
// 依赖：createSticky / stickyRecords（130-lock-sticky.js）、openNewWindow / noteRecords（100-notes-folder-trash.js）

const NOTES_CENTER_KEY = '__notescenter';
const STICKY_DOT = { yellow: '#ffe98a', pink: '#ffb9cf', green: '#b7ecc0', blue: '#b7d8ff' };

function ncFmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' : '') + n;
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 便签预览：取第一行非空文字，太长就截断
function ncStickyPreview(rec) {
  const line = String(rec.text || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const plain = line.replace(/^- \[[xX ]\]\s*/, '');
  return plain ? (plain.length > 34 ? plain.slice(0, 34) + '…' : plain) : '空便签';
}
function ncNotePreview(rec) {
  const line = String(rec.content || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return line ? (line.length > 34 ? line.slice(0, 34) + '…' : line) : '空白记事本';
}
// 便签/记事本列表：按最近改动排序
function ncStickyList() {
  return Object.keys(stickyRecords)
    .map(id => stickyRecords[id])
    .filter(r => r && r.id)
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
}
function ncNoteList() {
  return Object.keys(noteRecords)
    .map(k => Object.assign({ __key: k }, noteRecords[k]))
    .filter(r => r && r.seq != null)
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
}

function openNotesCenter() {
  if (openWins[NOTES_CENTER_KEY]) {
    activate(openWins[NOTES_CENTER_KEY].el);
    renderNotesCenter(openWins[NOTES_CENTER_KEY].el);
    return;
  }
  const win = document.createElement('div');
  win.className = 'win active notes-center-win';
  win.style.width = '468px';
  win.style.height = '452px';
  win.style.left = (300 + (Object.keys(openWins).length % 6) * 26) + 'px';
  win.style.top = (130 + (Object.keys(openWins).length % 6) * 26) + 'px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">📚</span>
      <span class="title">便签与记事本</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body"></div>`;
  windowsEl.appendChild(win);
  playSfx('open');
  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation(); win.style.display = 'none';
    if (openWins[NOTES_CENTER_KEY]) openWins[NOTES_CENTER_KEY].minimized = true;
    syncTaskActive();
  };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());

  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">📚</span><span class="nm">便签与记事本</span>`;
  taskBtn.onclick = () => {
    const w = openWins[NOTES_CENTER_KEY];
    if (!w) return;
    if (w.minimized || win.style.display === 'none') { win.style.display = 'flex'; w.minimized = false; activate(win); }
    else if (Number(win.style.zIndex) === zCounter) { win.style.display = 'none'; w.minimized = true; syncTaskActive(); }
    else activate(win);
  };
  taskItemsEl.appendChild(taskBtn);
  registerWindow(NOTES_CENTER_KEY, win, taskBtn);
  renderNotesCenter(win);
  activate(win);
}

function renderNotesCenter(win) {
  if (!win || !win.isConnected) return;
  const body = win.querySelector('.body');
  const stickies = ncStickyList();
  const notes = ncNoteList();

  const rowSticky = (rec) => `
    <div class="nc-row" data-k="sticky" data-id="${esc(rec.id)}">
      <span class="nc-dot" style="background:${STICKY_DOT[rec.color] || STICKY_DOT.yellow}"></span>
      <span class="nc-main">
        <span class="nc-tt">${esc(ncStickyPreview(rec))}</span>
        <span class="nc-meta">${esc(ncFmtTime(rec.ts))}${rec.text ? ' · ' + rec.text.length + ' 字' : ''}</span>
      </span>
      ${rec.open === false ? '' : '<span class="nc-tag">桌面上</span>'}
      <button class="nc-del" title="删除这条便签">✕</button>
    </div>`;
  const rowNote = (rec) => `
    <div class="nc-row" data-k="note" data-key="${esc(rec.__key)}" data-id="${rec.seq}">
      <span class="nc-ic">📄</span>
      <span class="nc-main">
        <span class="nc-tt">${esc(rec.title || '未命名 ' + rec.seq)}</span>
        <span class="nc-meta">${esc(ncFmtTime(rec.ts))}${rec.content ? ' · ' + rec.content.length + ' 字' : ''}</span>
      </span>
      ${rec.open === false ? '' : '<span class="nc-tag">桌面上</span>'}
      <button class="nc-del" title="删除这个记事本">✕</button>
    </div>`;

  body.innerHTML = `
    <div class="nc-top">
      <button class="nc-new" data-k="sticky">🗒 新建便签</button>
      <button class="nc-new" data-k="note">📄 新建文本</button>
    </div>
    <div class="nc-hd">便签 <span class="nc-cnt">${stickies.length}</span></div>
    <div class="nc-list">${stickies.length ? stickies.map(rowSticky).join('') : '<div class="nc-empty">还没有便签</div>'}</div>
    <div class="nc-hd">记事本 <span class="nc-cnt">${notes.length}</span></div>
    <div class="nc-list">${notes.length ? notes.map(rowNote).join('') : '<div class="nc-empty">还没有记事本</div>'}</div>`;

  // 新建
  body.querySelectorAll('.nc-new').forEach(btn => {
    btn.onclick = () => {
      if (btn.dataset.k === 'sticky') createSticky();
      else openNewWindow();
      renderNotesCenter(win);
    };
  });

  body.querySelectorAll('.nc-row').forEach(row => {
    const kind = row.dataset.k;
    // 打开：便签贴回桌面 / 记事本重开窗口
    row.onclick = (e) => {
      if (e.target.closest('.nc-del')) return;
      if (kind === 'sticky') {
        const rec = stickyRecords[row.dataset.id];
        if (!rec) return;
        rec.open = true; saveStickies();
        createSticky(rec);
        toast('便签已贴回桌面');
      } else {
        const rec = noteRecords[row.dataset.key];
        if (!rec) return;
        rec.open = true;
        localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
        openNewWindow(rec);
      }
      renderNotesCenter(win);
    };
    // 删除：便签/记事本内容一并删掉（走站内确认框，避免原生 confirm 被吞）
    row.querySelector('.nc-del').onclick = async (e) => {
      e.stopPropagation();
      const id = row.dataset.id;
      const label = kind === 'sticky'
        ? ncStickyPreview(stickyRecords[id] || {})
        : ((noteRecords[row.dataset.key] || {}).title || '未命名');
      const ok = await hubConfirm('「' + label + '」将被永久删除，内容不可恢复。', {
        title: kind === 'sticky' ? '删除便签？' : '删除记事本？',
        okText: '删除', cancelText: '取消', danger: true,
      });
      if (!ok) return;
      if (kind === 'sticky') {
        const el = document.querySelector('.sticky[data-sid="' + id + '"]');
        if (el) el.remove();
        delete stickyRecords[id];
        saveStickies();
      } else {
        const key = row.dataset.key;
        const open = openWins['__note_' + id];
        if (open) closeWindow(open.el);
        delete noteRecords[key];
        localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
      }
      toast('已删除');
      renderNotesCenter(win);
    };
  });
}
