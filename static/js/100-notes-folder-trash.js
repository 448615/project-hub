// 100-notes-folder-trash.js — 记事本、文件夹、回收站、启动恢复
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 便签 / 记事本 的启动恢复策略 =====
// 老版本：每条记录开机都自动铺回桌面，点 ✕ 只是“暂时消失”，下次打开又全回来，越攒越多。
// 现在：每个类别最多自动恢复最近改动的一条，其余收进「便签与记事本」；
// 记录上的 open=false 表示用户主动收起过，不再自动回到桌面（内容不会丢）。
const NOTE_RESET_KEY = 'hub-note-reset-v54';   // 一次性清理标记（只跑一次）
function migrateNoteStorageOnce() {
  try {
    if (localStorage.getItem(NOTE_RESET_KEY)) return;
    // 用户确认：升级后第一次打开把历史攒下的便签/记事本清空，从零开始。
    // 只执行一次，之后新建的内容照常保留。
    localStorage.removeItem(NOTES_KEY);
    localStorage.removeItem(STICKY_KEY);        // 定义在 130-lock-sticky.js（运行期才取值，无 TDZ 问题）
    localStorage.setItem(NOTE_RESET_KEY, '1');
  } catch (e) { /* 隐私模式写不了就跳过，不阻塞启动 */ }
}
// 从记录里挑出「还要自动打开」的 id：只按 ts 取最近 limit 条，其余标成收起
function pickAutoOpenIds(records, limit) {
  const ids = Object.keys(records || {}).filter(k => records[k] && records[k].open !== false);
  ids.sort((a, b) => (Number(records[b].ts) || 0) - (Number(records[a].ts) || 0));
  const keep = ids.slice(0, Math.max(0, limit));
  ids.slice(keep.length).forEach(k => { records[k].open = false; });
  return keep;
}
// 记事本记录全量装进内存：saveNote 是「按内存整份回写 localStorage」的，
// 只装载要打开的那几条会在第一次保存时把收起的记录抹掉。
function loadNoteRecords() {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}') || {};
    Object.keys(noteRecords).forEach(k => delete noteRecords[k]);
    Object.keys(raw).forEach(k => {
      if (raw[k] && typeof raw[k] === 'object') noteRecords[k] = raw[k];
    });
  } catch (e) { console.warn('记事本数据解析失败，已忽略:', e); }
}

// ===== 新建窗口：美化版“记事本”（自动保存 + 双击标题重命名 + 支持多开/恢复） =====
function openNewWindow(data) {
  const seq = data ? data.seq : (++noteSeq);
  if (seq > noteSeq) noteSeq = seq;
  const key = '__note_' + seq;
  // 这个记事本已经开着了：抬到最前，别重复开一个一模一样的窗口
  if (openWins[key]) { activate(openWins[key].el); return; }
  const name = data ? data.title : '未命名 ' + seq;
  const content = data ? data.content : '';
  const off = (seq % 6) * 26;
  const win = document.createElement('div');
  win.className = 'win active note-win';
  win.style.width = (data ? data.width : 640) + 'px';
  win.style.height = (data ? data.height : 500) + 'px';
  win.style.left = (data ? data.left : (140 + off)) + 'px';
  win.style.top = (data ? data.top : (90 + off)) + 'px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">📝</span>
      <span class="title">${esc(name)} - 记事本</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body note-body">
      <textarea class="note-area" placeholder="在这里输入文字…" spellcheck="false"></textarea>
      <div class="note-status">
        <span class="dot"></span><span class="st">已自动保存</span>
        <button class="nb" id="nbSave">💾 保存</button>
        <button class="nb" id="nbCopy">复制</button>
        <button class="nb" id="nbExport">导出</button>
        <span class="cnt">0 字</span>
      </div>
    </div>`;
  windowsEl.appendChild(win);
  playSfx('open');

  const ta = win.querySelector('.note-area');
  const status = win.querySelector('.note-status');
  const stLabel = status.querySelector('.st');
  const cntEl = status.querySelector('.cnt');
  ta.value = content;
  cntEl.textContent = content.length + ' 字';

  // 复制 / 导出
  const copyBtn = win.querySelector('#nbCopy');
  const exportBtn = win.querySelector('#nbExport');
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const t = ta.value;
    const done = () => toast('已复制 ' + t.length + ' 字到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
    } else fallbackCopy(t, done);
  };
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    // 重命名时标题可能是 <input class="bar-rename">，先用安全方式取标题
    const tEl = win.querySelector('.bar .title');
    const nm = (tEl ? tEl.textContent : name).replace(/ - 记事本$/, '') || '未命名';
    const blob = new Blob([ta.value], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nm + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 800);
    toast('已导出 ' + nm + '.txt');
  };

  // 自动保存（400ms 防抖）到 localStorage
  const saveNote = () => {
    if (!win.isConnected) return;   // 窗口已关闭：丢弃迟到的防抖保存，防止“僵尸记事本”复活
    // 重命名过程中标题是 <input>，此时 .bar .title 不存在，要取安全默认值
    const tEl = win.querySelector('.bar .title');
    const curTitle = (tEl ? tEl.textContent : name).replace(/ - 记事本$/, '');
    noteRecords[key] = {
      seq, title: curTitle,
      content: ta.value,
      left: parseInt(win.style.left) || 140, top: parseInt(win.style.top) || 90,
      width: win.offsetWidth, height: win.offsetHeight,
      open: true,           // 窗口在桌面上
      ts: Date.now(),       // 最近改动时间（决定启动时恢复哪一条）
    };
    localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
    status.classList.remove('saving');
    stLabel.textContent = '已自动保存';
  };
  let saveTimer;
  // 手动保存：立即落盘并反馈（保存在项目桌面 = 写入本地记录，刷新后自动恢复）
  const saveBtn = win.querySelector('#nbSave');
  saveBtn.onclick = (e) => {
    e.stopPropagation();
    saveNote();
    toast('已保存到项目桌面');
  };
  ta.addEventListener('input', () => {
    cntEl.textContent = ta.value.length + ' 字';
    status.classList.add('saving');
    stLabel.textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNote, 400);
  });
  // 拖拽 / 拉伸结束后记录新位置与新尺寸
  const persistGeom = () => {
    if (noteRecords[key]) {
      noteRecords[key].left = parseInt(win.style.left) || 140;
      noteRecords[key].top = parseInt(win.style.top) || 90;
      noteRecords[key].width = win.offsetWidth;
      noteRecords[key].height = win.offsetHeight;
      localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
    }
  };
  win.addEventListener('mouseup', persistGeom);
  win.addEventListener('winresize', persistGeom);

  // 双击标题 → 内联重命名
  const titleEl = win.querySelector('.bar .title');
  const bindRename = () => {
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.className = 'bar-rename';
      input.value = titleEl.textContent.replace(/ - 记事本$/, '');
      titleEl.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const commit = (apply) => {
        if (done) return; done = true;
        const nm = apply ? (input.value.trim() || name) : name;
        const t = document.createElement('span');
        t.className = 'title';
        t.textContent = nm + ' - 记事本';
        input.replaceWith(t);
        if (openWins[key]) openWins[key].taskBtn.querySelector('.nm').textContent = nm;
        saveNote();
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(true); else if (ev.key === 'Escape') commit(false); });
      input.addEventListener('blur', () => commit(true));
    });
  };
  bindRename();

  win.querySelector('.close').onclick = (e) => {
    e.stopPropagation();
    clearTimeout(saveTimer);   // 取消防抖计时器，避免关闭后迟到写入
    saveNote();                // 关闭前立即落盘（内容/标题/位置/尺寸）
    noteRecords[key].open = false;   // 收起：下次启动不再自动打开，内容留在「便签与记事本」里
    localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
    closeWindow(win);
    toast('记事本已收起，可在「便签与记事本」里找回');
  };
  win.querySelector('.min').onclick = (e) => {
    e.stopPropagation(); win.style.display = 'none';
    if (openWins[key]) openWins[key].minimized = true;
    syncTaskActive();
  };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  win.querySelector('.bar').addEventListener('dblclick', e => e.preventDefault());

  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">📝</span><span class="nm">${esc(name)}</span>`;
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
  saveNote();   // N4：创建即落盘——空记事本（未输入就刷新/重启）也能恢复
}

// ===== 桌面文件夹：新建 / 重命名 / 删除 / 打开 =====
function createFolder(data) {
  const id = data ? data.id : ('f' + (++folderSeq));
  if (data && /^f(\d+)$/.test(id)) { const n = +id.slice(1); if (n > folderSeq) folderSeq = n; }
  const name = data ? data.name : '新建文件夹';
  const nFolders = Object.keys(folderRecords).length;
  const raw = data ? { left: data.left, top: data.top } : nextFree(GRID_X, GRID_Y, collectTakenAll());
  const pos = { left: (raw.x != null ? raw.x : raw.left), top: (raw.y != null ? raw.y : raw.top) };
  const item = document.createElement('div');
  item.className = 'folder-item';
  item.innerHTML = `<div class="fi-ic">📁</div><div class="fi-nm">${esc(name)}</div>`;
  item.style.left = pos.left + 'px'; item.style.top = pos.top + 'px';
  item.dataset.id = id;
  desktopEl.appendChild(item);

  // 单击 = 选中 + 直接打开文件夹（拖动换位结束后会被 dragBlockUntil 拦掉，不会误开）
  item.addEventListener('click', (e) => {
    if (Date.now() < dragBlockUntil) return;
    selectFolder(item);
    openFolderWin(id);
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    selectFolder(item);
    showCtx(e.clientX, e.clientY, folderMenu(id));
  });
  // 文件夹可拖动换位 / 拖入其他文件夹；右键菜单不受影响
  makeDesktopDraggable(item, (x, y) => {
    folderRecords[id].left = x;
    folderRecords[id].top = y;
    saveFolders();
  });

  folderRecords[id] = { id, name, left: pos.left, top: pos.top, members: (data && data.members) || [] };
  saveFolders();
}
// 把条目加入文件夹（type: icon=项目 | folder=子文件夹）
function addFolderMember(folderId, d) {
  const rec = folderRecords[folderId];
  if (!rec) return;
  if (!rec.members) rec.members = [];
  if (rec.members.some(m => m.type === d.type && m.key === d.key)) { toast('已在该文件夹中'); return; }
  rec.members.push({ type: d.type, key: d.key });
  saveFolders();
  const w = openWins[folderId];
  if (w) renderFolderBody(w.el, rec);
  toast('已加入文件夹');
}
// 渲染文件夹窗口内容（成员列表，支持拖拽排序 / 跨文件夹转移 / 回弹归位）
let dragMemberPending = null;   // 拖拽挂起状态：{fromFolder, index}；成功放置置空，dragend 仍挂起则回弹提示

function renderFolderBody(win, rec) {
  const body = win.querySelector('.body');
  const members = rec.members || [];
  if (!members.length) {
    // 空状态也保留接收区（.fw-list 永远存在，保证能拖入）
    body.innerHTML = '<div class="fw-list"><div class="f-empty">📁</div><div class="f-tip">此文件夹为空 · 拖入桌面图标或文件夹图标即可加入</div></div>';
  } else {
    body.innerHTML = '<div class="fw-list">' + members.map((m, i) => {
      const ic = m.type === 'icon' && ICON_MAP[m.key]
        ? `<img class="fw-ic" src="${ICON_MAP[m.key]}" alt="">`
        : `<span class="fw-ic">📁</span>`;
      const nm = m.type === 'icon'
        ? ((DATA.projects || []).find(p => p.name === m.key) || {}).display_name || m.key
        : (folderRecords[m.key] ? folderRecords[m.key].name : m.key);
      return `<div class="fw-item" data-i="${i}">${ic}<span class="fw-nm">${esc(nm)}</span><button class="fw-del" title="移出">✕</button></div>`;
    }).join('') + '</div>';
    body.querySelectorAll('.fw-item').forEach(el => {
      const i = +el.dataset.i;
      el.addEventListener('click', () => {
        if (Date.now() < dragBlockUntil) return;
        const m = members[i];
        if (m.type === 'icon') openWindow(m.key);
        else if (m.type === 'folder' && folderRecords[m.key]) openFolderWin(m.key);
      });
      el.querySelector('.fw-del').onclick = (e) => {
        e.stopPropagation();
        rec.members.splice(i, 1);
        saveFolders();
        renderFolderBody(win, rec);
      };
      // 拖拽：托起微抬 → 经过让位 → 松手排序/转移
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        dragMemberPending = { fromFolder: rec.id, index: i };
        e.dataTransfer.setData('application/x-hub-member', JSON.stringify({ fromFolder: rec.id, index: i }));
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        clearInserts(win);
        if (dragMemberPending) {
          dragMemberPending = null;
          toast('不能放在这里，卡片已回弹原位');
        }
      });
    });
  }
  // 列表是放置目标（空/非空都有）：同列表排序 / 跨文件夹转移
  const list = body.querySelector('.fw-list');
  list.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    list.classList.add('drop-target');
    showInsertAt(list, e.clientY);
  });
  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) list.classList.remove('drop-target');
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    list.classList.remove('drop-target');
    clearInserts(win);
    const raw = e.dataTransfer.getData('application/x-hub-member');
    if (!raw) { dragMemberPending = null; return; }
    let d = null;
    try { d = JSON.parse(raw); } catch (err) { dragMemberPending = null; return; }
    dragMemberPending = null;            // 放置成功，不触发回弹提示
    moveMember(d, rec, calcInsertIndex(list, e.clientY), win);
  });
}
// 计算鼠标位置应插入的索引（经过项让位）
function calcInsertIndex(list, y) {
  const items = list.querySelectorAll('.fw-item');
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return items.length;
}
// 显示插入指示线
function showInsertAt(list, y) {
  const body = list.closest('.body');
  if (body) clearInserts(body.closest('.win'));
  const idx = calcInsertIndex(list, y);
  const items = list.querySelectorAll('.fw-item');
  const line = document.createElement('div');
  line.className = 'fw-insert';
  if (items.length === 0) list.insertBefore(line, list.firstChild);   // 空列表：线画在最上
  else if (idx >= items.length) list.appendChild(line);
  else list.insertBefore(line, items[idx]);
}
function clearInserts(win) { if (win) win.querySelectorAll('.fw-insert').forEach(x => x.remove()); }
// 执行移动：同列表=排序；跨列表=从来源移除并插入目标
function moveMember(d, targetRec, toIndex, targetWin) {
  const srcRec = folderRecords[d.fromFolder];
  if (!srcRec) return;
  const srcMembers = srcRec.members || [];
  const item = srcMembers[d.index];
  if (!item) return;
  const same = d.fromFolder === targetRec.id;
  if (same) {
    let t = toIndex;
    if (d.index < toIndex) t--;          // 移除前一项后索引前移
    srcMembers.splice(d.index, 1);
    srcMembers.splice(t, 0, item);
    saveFolders();
    renderFolderBody(targetWin, targetRec);
    toast('已排序');
  } else {
    srcMembers.splice(d.index, 1);
    const tgt = targetRec.members || (targetRec.members = []);
    tgt.splice(toIndex, 0, item);
    saveFolders();
    renderFolderBody(targetWin, targetRec);
    const srcWin = openWins[d.fromFolder];
    if (srcWin && srcWin.el !== targetWin) renderFolderBody(srcWin.el, srcRec);
    toast('已转移到 ' + targetRec.name);
  }
}
function selectFolder(item) {
  desktopEl.querySelectorAll('.folder-item.sel').forEach(x => x.classList.remove('sel'));
  item.classList.add('sel');
}
function folderMenu(id) {
  return [
    { icon: '🗔', label: '打开', action: () => openFolderWin(id) },
    { icon: '✏️', label: '重命名', action: () => renameFolder(id) },
    { sep: true },
    { icon: '🗑', label: '删除', action: () => deleteFolder(id) },
  ];
}
function renameFolder(id) {
  const item = desktopEl.querySelector(`.folder-item[data-id="${id}"]`);
  if (!item) return;
  const nmEl = item.querySelector('.fi-nm');
  const input = document.createElement('input');
  input.className = 'folder-rename';
  input.value = folderRecords[id].name;
  nmEl.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = (apply) => {
    if (done) return; done = true;
    const name = apply ? (input.value.trim() || '新建文件夹') : folderRecords[id].name;
    const span = document.createElement('div');
    span.className = 'fi-nm';
    span.textContent = name;
    input.replaceWith(span);
    folderRecords[id].name = name;
    saveFolders();
    const w = openWins[id];
    if (w) {
      w.el.querySelector('.bar .title').textContent = name + ' - 文件夹';
      w.taskBtn.querySelector('.nm').textContent = name;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
  input.addEventListener('blur', () => commit(true));
}
function deleteFolder(id) {
  const item = desktopEl.querySelector(`.folder-item[data-id="${id}"]`);
  if (item) item.remove();
  if (openWins[id]) closeWindow(openWins[id].el);   // 复用统一关闭（含动画与清理）
  const rec = folderRecords[id];
  delete folderRecords[id];
  saveFolders();
  // 不彻底删除：移入回收站，可还原
  if (rec) {
    // 记下原位置（所属虚拟桌面 + 父文件夹），回收站的「原位置」列与「打开原位置」都靠它
    const parent = findParentGroup(id);
    if (parent) {
      // 从组里删的：顺手摘掉成员引用，否则组里留一条点不开的幽灵项
      parent.members = (parent.members || []).filter(m => !(m.type === 'folder' && m.key === id));
      saveFolders();
      const pw = openWins[parent.id];
      if (pw) renderFolderBody(pw.el, parent);
    }
    trashRecords.push({
      tid: trashTid(),
      type: 'folder',          // 目前进回收站的只有文件夹；将来有文件条目再写 'file'
      ...rec,
      members: (rec.members || []).slice(),
      deletedAt: new Date().toLocaleString('zh-CN'),
      deletedTs: Date.now(),
      origin: { desk: currentDesk, group: parent ? parent.id : null },
    });
    saveTrash();
    toast('已移入回收站');
  }
}
// 这个文件夹被哪个父文件夹（组）收着？没有则返回 null
function findParentGroup(folderId) {
  return Object.keys(folderRecords)
    .map(k => folderRecords[k])
    .find(f => f && (f.members || []).some(m => m.type === 'folder' && m.key === folderId)) || null;
}
// ===== 回收站：数据层 =====
// 一条回收站记录 = 被删文件夹的快照（id/name/left/top/members）+ 删除时间 + 原位置。
//   删除时间：deletedAt（给人看的字符串，保留老字段）+ deletedTs（时间戳，排序 / 过期判断用）
//   原位置：  origin = { desk: 虚拟桌面下标, group: 父文件夹 id（从组里删的才有） }
//   唯一键：  tid —— id 是文件夹 id，还原时可能撞（备份导入、同名副本），tid 才不会重复
// 老版本数据只有 {id,name,left,top,members,deletedAt}，trashNorm() 在启动时补齐缺的字段。
const TRASH_UI = { query: '', sel: new Set() };   // 搜索词 + 勾选集合（只活在内存里）
function trashTid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function trashParseTime(s) {
  if (!s) return 0;
  // "2026/10/28 20:00:00" 与 "2026-10-28 20:00:00" 在部分浏览器解析不一致，统一成斜杠
  const t = new Date(String(s).replace(/-/g, '/')).getTime();
  return isFinite(t) ? t : 0;
}
function trashNorm() {
  if (!Array.isArray(trashRecords)) trashRecords = [];
  let dirty = false;
  trashRecords.forEach(t => {
    if (!t || typeof t !== 'object') return;
    if (!t.tid) { t.tid = trashTid(); dirty = true; }
    if (!t.deletedTs) { t.deletedTs = trashParseTime(t.deletedAt) || Date.now(); dirty = true; }
    if (!t.deletedAt) { t.deletedAt = new Date(t.deletedTs).toLocaleString('zh-CN'); dirty = true; }
    if (!t.origin || typeof t.origin !== 'object') { t.origin = { desk: 0, group: null }; dirty = true; }
    if (!Array.isArray(t.members)) { t.members = []; dirty = true; }
  });
  return dirty;
}
// 条目占用：按 localStorage 的 UTF-16 双字节估算，与「设置→系统→存储占用」同一套算法
function trashItemBytes(t) {
  try { return (JSON.stringify(t) || '').length * 2; } catch (e) { return 0; }
}
function fmtBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
  const kb = b / 1024;
  if (kb >= 100) return Math.round(kb) + ' KB';
  return (kb < 0.1 ? '< 0.1' : kb.toFixed(1)) + ' KB';
}
function fmtTrashTime(ts) {
  const d = new Date(Number(ts) || 0);
  if (isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// 原位置文案：桌面 2 · 组：设计稿（组已被删就标注出来，避免点「打开原位置」找不到地方）
function trashOriginText(t) {
  const o = t.origin || {};
  const out = ['桌面 ' + ((Number(o.desk) || 0) + 1)];
  if (o.group) out.push(folderRecords[o.group] ? ('组：' + folderRecords[o.group].name) : '组已删除');
  return out.join(' · ');
}
function trashOriginGroup(t) {
  const gid = (t.origin || {}).group;
  return gid && folderRecords[gid] ? folderRecords[gid] : null;
}
// 按删除时间倒序（新的在上）。同一毫秒内连删两条时用数组下标兜底：后删的排前面，
// 否则 sort 在「时间戳相同」时结果不稳定，列表顺序会随机跳动。
function trashSorted() {
  return trashRecords
    .map((t, i) => ({ t, i }))
    .sort((a, b) => ((Number(b.t.deletedTs) || 0) - (Number(a.t.deletedTs) || 0)) || (b.i - a.i))
    .map(x => x.t);
}
function trashFiltered() {
  const q = TRASH_UI.query.trim().toLowerCase();
  const list = trashSorted();
  if (!q) return list;
  return list.filter(t => String(t.name || '').toLowerCase().indexOf(q) >= 0);
}
function trashFind(tid) { return trashRecords.find(t => t.tid === tid) || null; }

// ===== 回收站：还原 =====
// 同名不再报错：自动变成「原名 (2)」「原名 (3)」…（只跟桌面上现存的文件夹比，回收站里的不算）
function uniqueFolderName(base) {
  const name = base || '未命名文件夹';
  const used = new Set(Object.keys(folderRecords).map(k => folderRecords[k].name));
  if (!used.has(name)) return name;
  const stem = name.replace(/\s*\(\d+\)$/, '');
  for (let i = 2; i < 1000; i++) {
    const cand = stem + ' (' + i + ')';
    if (!used.has(cand)) return cand;
  }
  return stem + ' (' + Date.now() + ')';
}
function nextFolderId() {
  for (let i = 0; i < 5000; i++) {
    folderSeq += 1;
    const id = 'f' + folderSeq;
    if (!folderRecords[id]) return id;
  }
  return 'f' + Date.now().toString(36);
}
// 还原落点：原坐标空着就回原位，被别的图标占了就让 nextFree 找最近空格
function trashRestorePos(t) {
  const x = Number(t.left), y = Number(t.top);
  const taken = collectTakenAll();
  if (!isFinite(x) || !isFinite(y) || taken.has(x + ',' + y)) {
    const p = nextFree(GRID_X, GRID_Y, taken);
    return { left: p.x, top: p.y };
  }
  return { left: x, top: y };
}
// 还原一条，返回 { name, renamed, oldName }；找不到返回 null
function restoreTrashItem(tid) {
  const i = trashRecords.findIndex(t => t.tid === tid);
  if (i < 0) return null;
  const t = trashRecords[i];
  const oldName = t.name || '未命名文件夹';
  const name = uniqueFolderName(oldName);
  const id = (t.id && !folderRecords[t.id]) ? t.id : nextFolderId();
  const pos = trashRestorePos(t);
  trashRecords.splice(i, 1);
  saveTrash();
  createFolder({ id, name, left: pos.left, top: pos.top, members: (t.members || []).slice() });
  return { name, renamed: name !== oldName, oldName };
}
function restoreTrashBatch(tids) {
  let n = 0, renamed = 0;
  tids.forEach(tid => {
    const r = restoreTrashItem(tid);
    if (r) { n++; if (r.renamed) renamed++; }
  });
  return { n, renamed };
}
async function restoreAllTrash() {
  if (!trashRecords.length) { toast('回收站是空的'); return; }
  const n = trashRecords.length;
  const r = restoreTrashBatch(trashRecords.map(t => t.tid));
  TRASH_UI.sel.clear();
  refreshTrashWin();
  toast('已还原 ' + r.n + ' 项' + (r.renamed ? '（' + r.renamed + ' 项同名，已自动加序号）' : ''));
}
async function restoreSelectedTrash() {
  const tids = Array.from(TRASH_UI.sel);
  if (!tids.length) return;
  const r = restoreTrashBatch(tids);
  TRASH_UI.sel.clear();
  refreshTrashWin();
  toast('已还原 ' + r.n + ' 项' + (r.renamed ? '（' + r.renamed + ' 项同名，已自动加序号）' : ''));
}

// ===== 回收站：彻底删除 / 清空 / 自动清理 =====
function purgeTrashItem(tid) {
  const i = trashRecords.findIndex(t => t.tid === tid);
  if (i < 0) return false;
  trashRecords.splice(i, 1);
  TRASH_UI.sel.delete(tid);
  saveTrash();
  return true;
}
async function purgeOneTrash(tid) {
  const t = trashFind(tid);
  if (!t) return;
  const ok = await hubConfirm('「' + (t.name || '未命名') + '」将被永久删除，无法恢复。', {
    title: '彻底删除', okText: '永久删除', danger: true,
  });
  if (!ok) return;
  purgeTrashItem(tid);
  refreshTrashWin();
  toast('已彻底删除：' + (t.name || '未命名'));
}
async function purgeSelectedTrash() {
  const tids = Array.from(TRASH_UI.sel).filter(tid => trashFind(tid));
  if (!tids.length) return;
  const ok = await hubConfirm('选中的 ' + tids.length + ' 项将被永久删除，无法恢复。', {
    title: '彻底删除', okText: '永久删除', danger: true,
  });
  if (!ok) return;
  tids.forEach(purgeTrashItem);
  TRASH_UI.sel.clear();
  refreshTrashWin();
  toast('已彻底删除 ' + tids.length + ' 项');
}
async function emptyTrash() {
  if (!trashRecords.length) { toast('回收站已经是空的'); return; }
  const n = trashRecords.length;
  const ok = await hubConfirm('回收站里的 ' + n + ' 项将被永久删除，无法恢复。', {
    title: '清空回收站', okText: '永久删除', danger: true,
  });
  if (!ok) return;
  trashRecords = [];
  TRASH_UI.sel.clear();
  saveTrash();
  refreshTrashWin();
  toast('已清空回收站（' + n + ' 项）');
}
// 打开回收站时按设置清理过期条目（保留 0 = 不自动清理）
function trashAutoPurge(silent) {
  const days = Number(SETTINGS.trashDays) || 0;
  if (days <= 0) return 0;
  const cut = Date.now() - days * 86400000;
  const keep = [];
  let n = 0;
  trashRecords.forEach(t => {
    if ((Number(t.deletedTs) || 0) < cut) n++;
    else keep.push(t);
  });
  if (!n) return 0;
  trashRecords = keep;
  TRASH_UI.sel.forEach(tid => { if (!trashFind(tid)) TRASH_UI.sel.delete(tid); });
  saveTrash();
  if (!silent) toast('已自动清理 ' + n + ' 项过期条目（保留 ' + days + ' 天）');
  return n;
}
// 桌面回收站图标右上角的小红点徽标：显示待清理条目数
function updateTrashBadge() {
  const box = desktopEl && desktopEl.querySelector('.trash-item .fi-ic');
  if (!box) return;
  const n = Array.isArray(trashRecords) ? trashRecords.length : 0;
  let b = box.querySelector('.tr-badge');
  if (!n) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('span'); b.className = 'tr-badge'; box.appendChild(b); }
  b.textContent = n > 99 ? '99+' : String(n);
  b.title = n + ' 项待清理';
}
// 回收站窗口开着时重画列表（关着就只更新徽标）
function refreshTrashWin() {
  const w = openWins['__trash'];
  if (w && w.el && w.el.querySelector('.tr-list')) renderTrashList(w.el);
  updateTrashBadge();
}

// ===== 回收站：窗口 =====
function openTrash() {
  const key = '__trash';
  const exist = openWins[key];
  // 正在关闭中的残影不算「已打开」：closeWindow 要等 175ms 动画才把引用摘掉，
  // 这期间再双击回收站图标不能直接 return（否则什么都没发生）
  if (exist && exist.el && exist.el.isConnected && !exist.el._closing) {
    trashNorm();
    trashAutoPurge();          // 每次打开都检查一次过期项（设置里配了保留天数才生效）
    refreshTrashWin();
    activate(exist.el);
    return;
  }
  if (exist) delete openWins[key];
  const win = document.createElement('div');
  win.className = 'win active trash-win';
  win.style.width = '660px'; win.style.height = '480px';
  win.style.left = (Math.max(24, (window.innerWidth - 660) / 2)) + 'px';
  win.style.top = '110px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">🗑</span>
      <span class="title">回收站</span>
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
  win.querySelector('.min').onclick = (e) => { e.stopPropagation(); win.style.display = 'none'; if (openWins[key]) openWins[key].minimized = true; syncTaskActive(); };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">🗑</span><span class="nm">回收站</span>`;
  taskBtn.onclick = () => {
    const w = openWins[key];
    if (!w) return;
    if (w.minimized || win.style.display === 'none') { win.style.display = 'flex'; w.minimized = false; activate(win); }
    else if (Number(win.style.zIndex) === zCounter) { win.style.display = 'none'; w.minimized = true; syncTaskActive(); }
    else activate(win);
  };
  taskItemsEl.appendChild(taskBtn);
  registerWindow(key, win, taskBtn);
  trashNorm();                      // 老数据补齐 deletedTs / origin / tid
  TRASH_UI.query = '';
  TRASH_UI.sel.clear();             // 每次开窗都是干净的选择状态
  trashAutoPurge();                 // 「定时自动清空」：打开时清掉超过保留期的条目
  renderTrashBody(win);
  updateTrashBadge();
  activate(win);
}
// 窗口骨架：顶部搜索/全局操作 → 选中操作条 → 列表 → 底部全选与状态栏
function renderTrashBody(win) {
  const body = win.querySelector('.body');
  body.innerHTML = `
    <div class="tr-top">
      <div class="tr-search">
        <span class="tr-mag">🔍</span>
        <input class="tr-q" type="text" placeholder="搜索名称…" spellcheck="false" autocomplete="off">
        <button class="tr-qx" title="清除搜索" hidden>✕</button>
      </div>
      <button class="tr-btn" data-act="restoreAll" title="把回收站里的条目全部还原">↺ 全部还原</button>
      <button class="tr-btn danger" data-act="empty" title="永久删除全部条目">🧹 清空</button>
    </div>
    <div class="tr-selbar idle">
      <span class="tr-seln"></span>
      <button class="tr-btn sm" data-act="restoreSel">↺ 还原选中</button>
      <button class="tr-btn sm danger" data-act="purgeSel">✕ 彻底删除</button>
      <button class="tr-btn sm ghost" data-act="clearSel">取消选择</button>
    </div>
    <div class="tr-head">
      <span></span><span></span>
      <span>名称 / 原位置</span>
      <span class="tr-hn">项数</span>
      <span>删除时间</span>
      <span></span><span></span>
    </div>
    <div class="tr-list"></div>
    <div class="tr-foot">
      <label class="tr-all"><input type="checkbox" class="tr-chk"><span>全选</span></label>
      <button class="tr-invert" data-act="invert">反选</button>
      <span class="tr-stat"></span>
    </div>`;

  const q = body.querySelector('.tr-q');
  const qx = body.querySelector('.tr-qx');
  q.value = TRASH_UI.query;
  qx.hidden = !TRASH_UI.query;
  q.oninput = () => {
    TRASH_UI.query = q.value;
    qx.hidden = !TRASH_UI.query;
    renderTrashList(win);
  };
  qx.onclick = () => { q.value = ''; TRASH_UI.query = ''; qx.hidden = true; renderTrashList(win); q.focus(); };

  body.querySelector('.tr-chk').onchange = (e) => {
    const list = trashFiltered();
    if (e.target.checked) list.forEach(t => TRASH_UI.sel.add(t.tid));
    else list.forEach(t => TRASH_UI.sel.delete(t.tid));
    renderTrashList(win);
  };
  body.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = () => trashAction(btn.dataset.act);
  });

  // 列表用事件委托：每次搜索/勾选都会重建行，绑在容器上就不必重复绑定
  const listEl = body.querySelector('.tr-list');
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tr-row');
    if (!row) return;
    const tid = row.dataset.tid;
    if (e.target.closest('.tr-act')) {
      const a = e.target.closest('.tr-act').dataset.a;
      if (a === 'restore') {
        const r = restoreTrashItem(tid);
        if (r) {
          refreshTrashWin();
          toast('已还原：' + r.name + (r.renamed ? '（同名，已改为「' + r.name + '」）' : ''));
        }
        return;
      }
      if (a === 'purge') { purgeOneTrash(tid); return; }
    }
    if (e.target.closest('.tr-c')) {
      if (e.target.checked) TRASH_UI.sel.add(tid); else TRASH_UI.sel.delete(tid);
      renderTrashList(win);
    }
  });
  listEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tr-row');
    if (!row) return;
    e.preventDefault(); e.stopPropagation();
    trashRowMenu(row.dataset.tid, e.clientX, e.clientY);
  });

  renderTrashList(win);
}
// 类型图标用内联 SVG：emoji 在不同系统下有的渲染成单色、有的直接缺字形（只剩方块），
// 用路径 + currentColor 才能保证浅色/深色主题都清楚。
const TRASH_SVG = {
  folder: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3.4 8.1c0-1.1.9-2 2-2h2.9c.53 0 1.04.21 1.41.59l1.24 1.24h7.65c1.1 0 2 .9 2 2v6.17c0 1.1-.9 2-2 2H5.4c-1.1 0-2-.9-2-2V8.1Z" fill="currentColor"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6.2 3.6h6.3l5.3 5.3v11.5c0 .55-.45 1-1 1H6.2c-.55 0-1-.45-1-1V4.6c0-.55.45-1 1-1Z" fill="currentColor" opacity=".55"/><path d="M12.5 3.9v4.2c0 .5.4.9.9.9h4.2" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
};
// 列表重绘 + 顶部/底部状态同步（搜索、勾选、增删都走这里，不重建整个 body，输入框焦点不丢）
function renderTrashList(win) {
  const body = win.querySelector('.body');
  if (!body) return;
  // 过期/已被删除的勾选先清掉，避免「已选 3 项」但实际只剩 1 项
  TRASH_UI.sel.forEach(tid => { if (!trashFind(tid)) TRASH_UI.sel.delete(tid); });

  const list = trashFiltered();
  const listEl = body.querySelector('.tr-list');
  if (!list.length) {
    listEl.innerHTML = trashRecords.length
      ? '<div class="tr-empty">没有匹配「' + esc(TRASH_UI.query.trim()) + '」的条目</div>'
      : '<div class="tr-empty"><div class="tr-eic">🗑</div>回收站是空的<div class="tr-etip">删除的文件夹会先放到这里，可随时还原</div></div>';
  } else {
    listEl.innerHTML = list.map(t => {
      const nMember = (t.members || []).length;
      const sel = TRASH_UI.sel.has(t.tid);
      const g = trashOriginGroup(t);
      // 老数据没有 type 字段：回收站里只有文件夹，默认按文件夹画
      const isFolder = t.type !== 'file';
      return `<div class="tr-row${sel ? ' on' : ''}" data-tid="${esc(t.tid)}">
        <input type="checkbox" class="tr-c"${sel ? ' checked' : ''} aria-label="选择 ${esc(t.name)}">
        <span class="tr-ic${g ? ' in-group' : ''}" title="${isFolder ? '文件夹' : '文件'}">${isFolder ? TRASH_SVG.folder : TRASH_SVG.file}</span>
        <span class="tr-nm">
          <span class="tr-name">${esc(t.name || '未命名文件夹')}</span>
          <span class="tr-sub">${esc(trashOriginText(t))}</span>
        </span>
        <span class="tr-size">${nMember} 项</span>
        <span class="tr-time" title="删除于 ${esc(t.deletedAt || '')}">${esc(fmtTrashTime(t.deletedTs))}</span>
        <button class="tr-act" data-a="restore" title="还原">↺</button>
        <button class="tr-act danger" data-a="purge" title="彻底删除">✕</button>
      </div>`;
    }).join('');
  }

  // 空站时不显示列头（没有数据，列名反而碍眼）
  body.querySelector('.tr-head').hidden = !trashRecords.length;

  // 全选：只对「当前搜索结果」生效，勾一半时显示半选
  const chk = body.querySelector('.tr-chk');
  const picked = list.filter(t => TRASH_UI.sel.has(t.tid)).length;
  chk.checked = list.length > 0 && picked === list.length;
  chk.indeterminate = picked > 0 && picked < list.length;
  chk.disabled = list.length === 0;

  // 选中操作条：始终占位（只切 idle 态），勾选时列表不会整体下移，免得「刚勾完马上点还原」点偏
  const bar = body.querySelector('.tr-selbar');
  const nSel = TRASH_UI.sel.size;
  bar.classList.toggle('idle', nSel === 0);
  bar.querySelector('.tr-seln').innerHTML = nSel
    ? '已选 <b>' + nSel + '</b> 项'
    : (trashRecords.length ? '勾选左侧方框可批量还原 / 删除' : '');

  // 状态栏：N 项 · 共 X KB（搜索时同时给出命中数）
  const bytes = list.reduce((s, t) => s + trashItemBytes(t), 0);
  const stat = body.querySelector('.tr-stat');
  if (!trashRecords.length) stat.textContent = '0 项';
  else if (TRASH_UI.query.trim()) stat.textContent = '匹配 ' + list.length + ' / ' + trashRecords.length + ' 项 · 共 ' + fmtBytes(bytes);
  else stat.textContent = list.length + ' 项 · 共 ' + fmtBytes(bytes);

  // 空站时全局按钮置灰
  body.querySelectorAll('[data-act="restoreAll"], [data-act="empty"], [data-act="invert"]').forEach(b => {
    b.disabled = !trashRecords.length;
  });
}
// 顶部/底部按钮统一入口
async function trashAction(act) {
  if (act === 'restoreAll') return restoreAllTrash();
  if (act === 'empty') return emptyTrash();
  if (act === 'restoreSel') return restoreSelectedTrash();
  if (act === 'purgeSel') return purgeSelectedTrash();
  if (act === 'clearSel') { TRASH_UI.sel.clear(); refreshTrashWin(); return; }
  if (act === 'invert') {
    const list = trashFiltered();
    list.forEach(t => { if (TRASH_UI.sel.has(t.tid)) TRASH_UI.sel.delete(t.tid); else TRASH_UI.sel.add(t.tid); });
    refreshTrashWin();
  }
}
// 单条右键菜单：还原 / 彻底删除 / 打开原位置（原文件夹还在时可用）
function trashRowMenu(tid, x, y) {
  const t = trashFind(tid);
  if (!t) return;
  const g = trashOriginGroup(t);
  showCtx(x, y, [
    { icon: '↺', label: '还原', action: () => {
        const r = restoreTrashItem(tid);
        if (r) { refreshTrashWin(); toast('已还原：' + r.name + (r.renamed ? '（同名，已改为「' + r.name + '」）' : '')); }
      } },
    { icon: '📂', label: g ? '打开原位置（' + g.name + '）' : '打开原位置', disabled: !g,
      action: () => { if (g) { openFolderWin(g.id); toast('已打开原位置：' + g.name); } } },
    { sep: true },
    { icon: '✕', label: '彻底删除', danger: true, action: () => purgeOneTrash(tid) },
  ]);
}
// 桌面回收站图标（可拖动换位，位置持久化）
function renderTrash() {
  const item = document.createElement('div');
  item.className = 'trash-item';
  const saved = loadJSON(TRASH_POS_KEY, null);
  const n = (DATA && DATA.projects || []).length;
  const wantY = GRID_Y + n * GRID_STEP_Y;   // 图标竖排之后的下一行
  const maxRow = Math.floor((window.innerHeight - 56 - GRID_Y - ICON_H) / GRID_STEP_Y);
  const defPos = (saved)
    ? snapPos(saved.x, saved.y)
    : (Math.round((wantY - GRID_Y) / GRID_STEP_Y) <= maxRow
        ? { x: GRID_X, y: wantY }
        : { x: GRID_X + GRID_STEP_X, y: GRID_Y + maxRow * GRID_STEP_Y });   // 矮视口：放底部第二列
  const pos = defPos;
  item.style.left = pos.x + 'px'; item.style.top = pos.y + 'px';
  item.innerHTML = `<div class="fi-ic"><img src="/static/icons/trash.png" alt=""></div><div class="fi-nm">回收站</div>`;
  desktopEl.appendChild(item);
  // 单击 = 选中 + 直接打开回收站窗口（拖拽后的 0.5 秒内会被 dragBlockUntil 拦掉，不会误开）
  item.addEventListener('click', () => {
    if (Date.now() < dragBlockUntil) return;
    desktopEl.querySelectorAll('.trash-item.sel, .folder-item.sel').forEach(x => x.classList.remove('sel'));
    iconsEl.querySelectorAll('.desk-icon.selected').forEach(x => x.classList.remove('selected'));
    item.classList.add('sel');
    openTrash();
  });
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showCtx(e.clientX, e.clientY, [
      { icon: '🗑', label: '打开回收站', action: openTrash },
      { sep: true },
      { icon: '🧹', label: '清空回收站', action: emptyTrash },
    ]);
  });
  makeDesktopDraggable(item, (x, y) => {
    localStorage.setItem(TRASH_POS_KEY, JSON.stringify({ x, y }));
  }, { noDrop: true });
  updateTrashBadge();   // 图标建好后再挂数量徽标（renderTrash 只在启动/刷新时跑）
}
function openFolderWin(id) {
  const rec = folderRecords[id];
  if (!rec) return;
  if (openWins[id]) { activate(openWins[id].el); return; }
  const off = (Object.keys(openWins).length % 6) * 26;
  const win = document.createElement('div');
  win.className = 'win active folder-win';
  win.style.width = '420px'; win.style.height = '280px';
  win.style.left = (260 + off) + 'px';
  win.style.top = (120 + off) + 'px';
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">📁</span>
      <span class="title">${esc(rec.name)} - 文件夹</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body"></div>`;
  windowsEl.appendChild(win);
  playSfx('open');
  renderFolderBody(win, rec);
  win.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeWindow(win); };
  win.querySelector('.min').onclick = (e) => { e.stopPropagation(); win.style.display = 'none'; if (openWins[id]) openWins[id].minimized = true; syncTaskActive(); };
  win.addEventListener('mousedown', () => activate(win));
  enableDrag(win);
  enableResize(win);
  const taskBtn = document.createElement('div');
  taskBtn.className = 'task-btn active';
  taskBtn.innerHTML = `<span class="ic">📁</span><span class="nm">${esc(rec.name)}</span>`;
  taskBtn.onclick = () => {
    const w = openWins[id];
    if (!w) return;
    if (w.minimized || win.style.display === 'none') { win.style.display = 'flex'; w.minimized = false; activate(win); }
    else if (Number(win.style.zIndex) === zCounter) { win.style.display = 'none'; w.minimized = true; syncTaskActive(); }
    else activate(win);
  };
  taskItemsEl.appendChild(taskBtn);
  registerWindow(id, win, taskBtn);
  activate(win);
}
function saveFolders() { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folderRecords)); }

// ===== 启动恢复：记事本 + 文件夹 =====
function restoreAll() {
  // 逐条恢复：单条数据损坏只跳过那条并提示，绝不让整段恢复失败
  migrateNoteStorageOnce();   // 一次性清理老版本攒下的记录（只跑一次）
  loadNoteRecords();          // 先把全部记事本记录装进内存，避免保存时把收起的抹掉
  try {
    // 只自动打开最近改动的那 1 个记事本，其余收起
    const keep = pickAutoOpenIds(noteRecords, 1);
    localStorage.setItem(NOTES_KEY, JSON.stringify(noteRecords));
    keep.forEach(k => {
      try { openNewWindow(noteRecords[k]); }
      catch (e) { console.warn('恢复记事本失败:', k, e); toast('有一条记事本数据损坏，已跳过'); }
    });
  } catch (e) {
    console.warn('记事本数据解析失败，已忽略:', e);
  }
  try {
    const folders = JSON.parse(localStorage.getItem(FOLDERS_KEY) || '{}');
    Object.keys(folders).forEach(id => {
      try { createFolder(folders[id]); }
      catch (e) { console.warn('恢复文件夹失败:', id, e); toast('有一个文件夹数据损坏，已跳过'); }
    });
  } catch (e) {
    console.warn('文件夹数据解析失败，已忽略:', e);
  }
}
// restoreAll() 已在 load() 中数据就绪后调用，避免文件夹抢占图标默认格子
