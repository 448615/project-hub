// 041-fm-window.js — 文件管理器窗口
// 由 040-finder-launcher.js 按函数边界切分；只做文件拆分，代码零改动。

// 打开文件管理器窗口；已打开则激活，startRel 非空则导航到该目录
function openFileManager(p, startRel) {
  const key = '__fm_' + p.name;
  if (openWins[key]) {
    const w = openWins[key];
    w.minimized = false;
    w.el.style.display = 'flex';
    if (startRel) fmNavigate(w.el, startRel);
    activate(w.el);
    return;
  }
  const win = document.createElement('div');
  win.className = 'win active fm-win';
  win.style.width = '780px';
  win.style.height = '560px';
  centerWin(win, 780, 520);          // 首次打开居中；registerWindow 里的 applyLayout 会按需覆盖为记忆位置
  win.style.zIndex = ++zCounter;
  win.innerHTML = `
    <div class="bar">
      <span class="ic">📁</span>
      <span class="title">${esc(p.display_name || p.name)} - 文件管理器</span>
      <span class="x">
        <button class="min" title="最小化">—</button>
        <button class="max" title="最大化">□</button>
        <button class="close" title="关闭">✕</button>
      </span>
    </div>
    <div class="body fm-body">
      <div class="fm-toolbar">
        <button class="fm-tbtn" id="fmBack" title="后退" disabled>‹</button>
        <button class="fm-tbtn" id="fmUp" title="上级目录" disabled>↑</button>
        <button class="fm-tbtn" id="fmRefresh" title="刷新">⟳</button>
        <span class="fm-tool-sep"></span>
        <button class="fm-tbtn" id="fmCopy" data-admin-only title="复制所选" disabled>⧉</button>
        <button class="fm-tbtn" id="fmCut" data-admin-only title="剪切所选" disabled>✂</button>
        <button class="fm-tbtn" id="fmPaste" data-admin-only title="粘贴到当前目录" disabled>📋</button>
        <button class="fm-tbtn" id="fmDel" data-admin-only title="删除所选（进回收站）" disabled>🗑</button>
        <button class="fm-tbtn" id="fmTrash" data-admin-only title="回收站">♻</button>
        <span class="fm-clip" id="fmClip"></span>
        <input class="fm-search" id="fmSearch" type="text" placeholder="筛选当前目录…" />
        <nav class="fm-crumbs" id="fmCrumbs"></nav>
        <button class="fm-tbtn" id="fmSort" title="排序：名称 ↑">⇅</button>
        <button class="fm-tbtn" id="fmView" title="切换为缩略图">▦</button>
        <button class="btn ghost" id="fmExternal" data-admin-only><span class="bi">🪟</span>系统打开</button>
      </div>
      <div class="fm-main">
        <div class="fm-tree" id="fmTree"></div>
        <div class="fm-list" id="fmList"></div>
      </div>
      <div class="fm-status" id="fmStatus"></div>
    </div>`;
  windowsEl.appendChild(win);
  playSfx('open');

  const start = startRel || '';
  win._fm = { proj: p.name, path: start, hist: [start], hi: 0, treeCache: {}, entries: [], truncated: false, filter: '', sort: 'name', view: 'list' };

  // ---- 数据 ----
  const fmFetch = (rel) => apiFetch('/api/files?project=' + encodeURIComponent(p.name) + '&path=' + encodeURIComponent(rel))
    .then(r => r.json().catch(() => ({})))
    .then(j => { if (!j.ok) throw new Error(j.error || '加载失败'); return j; });

  // ---- 面包屑 ----
  const fmRenderCrumbs = () => {
    const st = win._fm;
    const parts = [{ label: st.proj, path: '' }].concat(
      fmCrumbs(st.path).map((seg, i, arr) => ({ label: seg, path: arr.slice(0, i + 1).join('/') })));
    const el = win.querySelector('#fmCrumbs');
    el.innerHTML = parts.map((c, i) =>
      (i ? '<span class="fm-sep">/</span>' : '') +
      `<button class="fm-crumb" data-path="${esc(c.path)}">${esc(c.label)}</button>`).join('');
    el.querySelectorAll('.fm-crumb').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); fmNavigate(b.dataset.path); };
    });
  };

  // ---- 文件列表（列表 / 缩略图 两种视图，应用筛选 + 排序）----
  const fmBindItem = (el) => {
    // 单击 = 选中并立即打开（文件管理器也改成单击打开，不再需要双击）
    el.onclick = (e) => {
      e.stopPropagation();
      const parent = el.parentElement;
      if (parent) parent.querySelectorAll('.fm-row,.fm-card').forEach(x => x.classList.remove('sel'));
      el.classList.add('sel');
      fmSyncOps();
      // 连点两下时忽略第二次，避免同一个文件被连开两次
      const now = Date.now();
      if (el._openAt && now - el._openAt < 350) return;
      el._openAt = now;
      const st = win._fm;
      const name = el.dataset.name;
      if (el.dataset.type === 'dir') { fmNavigate(fmJoin(st.path, name)); return; }
      const rel = fmJoin(st.path, name);
      if (fmIsImage(name)) fmShowImage(rel, name);
      else if (fmIsText(name)) openEditor(st.proj, rel);   // 打开文本 → 详细编辑器（可编辑）
      else toast('暂不支持预览该类型，可点右上角"系统打开"');
    };
    // 右键 = 只选中、不打开：这样「复制 / 剪切 / 删除」仍能作用到某一行
    // （单击就打开的话，选中的行会立刻被跳转走，工具条就没对象可操作了）
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const parent = el.parentElement;
      if (parent) parent.querySelectorAll('.fm-row,.fm-card').forEach(x => x.classList.remove('sel'));
      el.classList.add('sel');
      fmSyncOps();
    };
    // 拖拽到侧边回收站按钮 = 删除（移入回收站）
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      const st = win._fm;
      const rel = fmJoin(st.path, el.dataset.name);
      e.dataTransfer.setData('application/x-hub-file', JSON.stringify({ proj: st.proj, rel, name: el.dataset.name }));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  };
  // 复制/剪切/删除按钮：有选中项才可用
  const fmSyncOps = () => {
    const st = win._fm;
    const sel = win.querySelector('.fm-row.sel, .fm-card.sel');
    win.querySelector('#fmCopy').disabled = !sel;
    win.querySelector('#fmCut').disabled = !sel;
    win.querySelector('#fmDel').disabled = !sel;
  };
  const fmRenderRows = (listEl, entries) => {
    listEl.innerHTML = entries.map(e => `
        <div class="fm-row" data-name="${esc(e.name)}" data-type="${esc(e.type)}" title="${esc(e.name)}">
          <span class="fm-ric">${fmIcon(e.name, e.type === 'dir')}</span>
          <span class="fm-rname">${esc(e.name)}</span>
          <span class="fm-rsize">${e.type === 'dir' ? '—' : fmFmtSize(e.size)}</span>
          <span class="fm-rtime">${fmFmtTime(e.mtime)}</span>
        </div>`).join('');
    listEl.querySelectorAll('.fm-row').forEach(fmBindItem);
  };
  const fmRenderGrid = (listEl, entries) => {
    const st = win._fm;
    listEl.innerHTML = '<div class="fm-grid">' + entries.map(e => {
      const isDir = e.type === 'dir';
      const thumb = fmIsImage(e.name)
        ? `<img class="fm-thumb" src="/api/raw?project=${encodeURIComponent(st.proj)}&path=${encodeURIComponent(fmJoin(st.path, e.name))}" loading="lazy" alt="">`
        : `<span class="fm-thumb-ic">${fmIcon(e.name, isDir)}</span>`;
      return `<div class="fm-card" data-name="${esc(e.name)}" data-type="${esc(e.type)}" title="${esc(e.name)}">
          <div class="fm-thumbbox">${thumb}</div>
          <div class="fm-cname">${esc(e.name)}</div>
        </div>`;
    }).join('') + '</div>';
    listEl.querySelectorAll('.fm-card').forEach(fmBindItem);
  };
  const fmRenderList = () => {
    const st = win._fm;
    const listEl = win.querySelector('#fmList');
    const shown = fmSortEntries(fmFilterEntries(st.entries, st.filter), st.sort);
    if (!shown.length) {
      listEl.innerHTML = '<div class="fm-empty">' + (st.filter ? '无匹配项' : '空目录') + '</div>';
    } else if (st.view === 'grid') {
      fmRenderGrid(listEl, shown);
    } else {
      fmRenderRows(listEl, shown);
    }
    win.querySelector('#fmStatus').textContent =
      shown.length + ' / ' + st.entries.length + ' 项' +
      (st.filter ? '（筛选）' : '') +
      (st.truncated ? '（仅显示前 1000 项）' : '') + ' · ' + (st.path || st.proj);
    fmSyncNav();
  };

  // ---- 目录树（懒加载：只缓存当前路径链上的目录，避免一次拉全树） ----
  const fmTreeChildren = (rel, cb) => {
    const st = win._fm;
    if (st.treeCache[rel]) { cb(st.treeCache[rel]); return; }
    fmFetch(rel).then(j => {
      st.treeCache[rel] = (j.entries || []).filter(e => e.type === 'dir');
      cb(st.treeCache[rel]);
    }).catch(() => cb([]));
  };

  const fmRenderTree = () => {
    const st = win._fm;
    const treeEl = win.querySelector('#fmTree');
    const build = (rel, depth) => {
      const dirs = st.treeCache[rel] || [];
      const seg = rel ? rel.split('/').pop() : st.proj;
      const open = rel === '' || st.path === rel || st.path.indexOf(rel + '/') === 0;
      let html = `<div class="fm-tnode${rel === st.path ? ' sel' : ''}" data-path="${esc(rel)}" ` +
        `style="padding-left:${8 + depth * 14}px" title="${esc(seg)}">` +
        `<span class="fm-tw">${dirs.length ? (open ? '▾' : '▸') : '·'}</span>📁 ${esc(seg)}</div>`;
      if (open && dirs.length) html += dirs.map(d => build(fmJoin(rel, d.name), depth + 1)).join('');
      return html;
    };
    treeEl.innerHTML = build('', 0);
    treeEl.querySelectorAll('.fm-tnode').forEach(node => {
      node.onclick = (e) => { e.stopPropagation(); fmNavigate(node.dataset.path); };
    });
  };

  // 导航后把路径链上的目录逐个补进树缓存，保证祖先节点展开可见
  const fmPrefetchAncestors = () => {
    const st = win._fm;
    const segs = fmCrumbs(st.path);
    const chain = [''];
    let acc = '';
    segs.forEach((s, i) => { acc = segs.slice(0, i + 1).join('/'); chain.push(acc); });
    let idx = 0;
    const next = () => {
      if (idx >= chain.length) { fmRenderTree(); return; }
      fmTreeChildren(chain[idx++], next);
    };
    next();
  };

  const fmSyncNav = () => {
    const st = win._fm;
    win.querySelector('#fmBack').disabled = st.hi <= 0;
    win.querySelector('#fmUp').disabled = !st.path;
  };

  function fmLoad() {
    const st = win._fm;
    win.querySelector('#fmList').innerHTML = '<div class="fm-empty">加载中…</div>';
    fmFetch(st.path).then(j => {
      st.entries = j.entries || [];
      st.truncated = !!j.truncated;
      fmRenderCrumbs();
      fmRenderList();
      fmPrefetchAncestors();
    }).catch(err => {
      win.querySelector('#fmList').innerHTML = '<div class="fm-empty">' + esc(err.message || '加载失败') + '</div>';
      fmSyncNav();
    });
  }

  function fmNavigate(rel) {
    const st = win._fm;
    if (st.path === rel) return;
    if (st.hi > 0 && st.hist[st.hi - 1] === rel) {
      st.hi--;                       // 与上一步相同 = 后退
    } else {
      st.hist = st.hist.slice(0, st.hi + 1);
      st.hist.push(rel);
      st.hi = st.hist.length - 1;
    }
    st.path = rel;
    fmLoad();
  }

  // ---- 图片预览 / 文本预览 ----
  function fmShowImage(rel, name) {
    const st = win._fm;
    const src = '/api/raw?project=' + encodeURIComponent(st.proj) + '&path=' + encodeURIComponent(rel);
    const listEl = win.querySelector('#fmList');
    listEl.innerHTML = `
      <div class="fm-imgview">
        <div class="fm-imgbar">
          <button class="fm-tbtn" id="fmImgBack" title="返回列表">‹</button>
          <span class="fm-imgname">${esc(name)}</span>
          <button class="btn ghost" id="fmImgExt"><span class="bi">🪟</span>系统打开</button>
        </div>
        <div class="fm-imgwrap"><img src="${esc(src)}" alt="${esc(name)}"></div>
      </div>`;
    win.querySelector('#fmImgBack').onclick = (e) => { e.stopPropagation(); fmLoad(); };
    win.querySelector('#fmImgExt').onclick = (e) => {
      e.stopPropagation();
      apiPost(`/api/projects/${encodeURIComponent(st.proj)}/open?path=${encodeURIComponent(rel)}`);
    };
  }

  // ---- 工具栏 ----
  win.querySelector('#fmBack').onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    if (st.hi <= 0) return;
    st.hi--; st.path = st.hist[st.hi]; fmLoad();
  };
  win.querySelector('#fmUp').onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    if (!st.path) return;
    fmNavigate(st.path.split('/').slice(0, -1).join('/'));
  };
  win.querySelector('#fmRefresh').onclick = (e) => {
    e.stopPropagation();
    win._fm.treeCache = {};
    fmLoad();
  };
  win.querySelector('#fmExternal').onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    apiPost(st.path
      ? `/api/projects/${encodeURIComponent(st.proj)}/open?path=${encodeURIComponent(st.path)}`
      : `/api/projects/${encodeURIComponent(st.proj)}/open`);
  };
  win.querySelector('#fmSearch').oninput = (e) => {
    e.stopPropagation();
    win._fm.filter = (e.target.value || '').trim().toLowerCase();
    fmRenderList();
  };
  const FM_SORTS = [
    { k: 'name', label: '名称 ↑' }, { k: 'name-desc', label: '名称 ↓' },
    { k: 'size', label: '大小' }, { k: 'time', label: '时间' }, { k: 'type', label: '类型' },
  ];
  const fmSortBtn = win.querySelector('#fmSort');
  fmSortBtn.onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    const i = FM_SORTS.findIndex(s => s.k === st.sort);
    st.sort = FM_SORTS[(i + 1) % FM_SORTS.length].k;
    fmSortBtn.title = '排序：' + FM_SORTS.find(s => s.k === st.sort).label;
    fmRenderList();
  };
  const fmViewBtn = win.querySelector('#fmView');
  fmViewBtn.onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    st.view = st.view === 'list' ? 'grid' : 'list';
    fmViewBtn.title = st.view === 'list' ? '切换为缩略图' : '切换为列表';
    fmViewBtn.textContent = st.view === 'list' ? '▦' : '☰';
    fmRenderList();
  };

  // ---- 文件操作：复制 / 剪切 / 粘贴 / 删除（进回收站）/ 回收站 ----
  const fmSelRel = () => {
    const st = win._fm;
    const sel = win.querySelector('.fm-row.sel, .fm-card.sel');
    if (!sel) return null;
    return fmJoin(st.path, sel.dataset.name);
  };
  const fmSelName = () => {
    const sel = win.querySelector('.fm-row.sel, .fm-card.sel');
    return sel ? sel.dataset.name : '';
  };
  const fmClipHint = () => {
    const el = win.querySelector('#fmClip');
    el.textContent = fmClipboard
      ? (fmClipboard.action === 'cut' ? '✂ 待剪切：' : '⧉ 待粘贴：') + fmClipboard.name
      : '';
  };
  win.querySelector('#fmCopy').onclick = (e) => {
    e.stopPropagation();
    const rel = fmSelRel(); if (!rel) return;
    fmClipboard = { action: 'copy', proj: win._fm.proj, rel, name: fmSelName() };
    fmClipHint(); win.querySelector('#fmPaste').disabled = false;
    toast('已复制：' + fmSelName());
  };
  win.querySelector('#fmCut').onclick = (e) => {
    e.stopPropagation();
    const rel = fmSelRel(); if (!rel) return;
    fmClipboard = { action: 'cut', proj: win._fm.proj, rel, name: fmSelName() };
    fmClipHint(); win.querySelector('#fmPaste').disabled = false;
    toast('已剪切：' + fmSelName());
  };
  win.querySelector('#fmPaste').onclick = (e) => {
    e.stopPropagation();
    if (!fmClipboard) return;
    const st = win._fm;
    if (fmClipboard.proj !== st.proj) { toast('只能粘贴到同一项目的文件管理器'); return; }
    const dst = fmJoin(st.path, fmClipboard.name);
    apiFetch('/api/fs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: st.proj, action: fmClipboard.action, src: fmClipboard.rel, dst }),
    }).then(r => r.json().catch(() => ({}))).then(j => {
      if (j.ok) {
        toast((fmClipboard.action === 'cut' ? '已移动' : '已复制') + '：' + fmClipboard.name);
        fmClipboard = null; fmClipHint(); win.querySelector('#fmPaste').disabled = true;
        win._fm.treeCache = {}; fmLoad();
      } else {
        toast('操作失败：' + (j.error || '未知错误'));
      }
    }).catch(() => toast('请求失败：无法连接后端'));
  };
  win.querySelector('#fmDel').onclick = async (e) => {
    e.stopPropagation();
    const rel = fmSelRel(); if (!rel) return;
    const ok = await hubConfirm('把「' + fmSelName() + '」移入回收站？', { title: '删除文件', okText: '移入回收站' });
    if (!ok) return;
    apiFetch('/api/fs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: win._fm.proj, action: 'delete', src: rel }),
    }).then(r => r.json().catch(() => ({}))).then(j => {
      if (j.ok) { toast(j.msg || '已移入回收站'); win._fm.treeCache = {}; fmLoad(); }
      else toast('删除失败：' + (j.error || '未知错误'));
    }).catch(() => toast('请求失败：无法连接后端'));
  };
  // 拖文件到侧边回收站按钮 = 删除（移入回收站）
  (function () {
    const tb = win.querySelector('#fmTrash');
    if (!tb) return;
    tb.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes('application/x-hub-file')) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      tb.classList.add('fm-drop');
    });
    tb.addEventListener('dragleave', () => tb.classList.remove('fm-drop'));
    tb.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      tb.classList.remove('fm-drop');
      const raw = e.dataTransfer.getData('application/x-hub-file');
      if (!raw) return;
      let d; try { d = JSON.parse(raw); } catch (_) { return; }
      const st = win._fm;
      apiFetch('/api/fs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: st.proj, action: 'delete', src: d.rel }),
      }).then(r => r.json().catch(() => ({}))).then(j => {
        if (j.ok) { toast(j.msg || '已移入回收站'); win._fm.treeCache = {}; fmLoad(); }
        else toast('删除失败：' + (j.error || '未知错误'));
      }).catch(() => toast('请求失败：无法连接后端'));
    });
  })();
  // 回收站视图：列出服务器回收站（被删除的项目文件），可还原/永久删除/清空
  win.querySelector('#fmTrash').onclick = (e) => {
    e.stopPropagation();
    const st = win._fm;
    apiFetch('/api/trash?project=' + encodeURIComponent(st.proj))
      .then(r => r.json().catch(() => ({})))
      .then(j => {
        const listEl = win.querySelector('#fmList');
        if (!j.ok) { listEl.innerHTML = '<div class="fm-empty">回收站加载失败</div>'; return; }
        const items = j.items || [];
        listEl.innerHTML = `
          <div class="fm-trash-head">
            <span class="tt">🗑 回收站（${items.length} 项）</span>
            <button class="fm-tool-btn" id="fmTrashBack">‹ 返回文件</button>
            <button class="fm-tool-btn" id="fmTrashEmpty" data-admin-only ${items.length ? '' : 'disabled'}>🧹 清空</button>
          </div>
          ${items.length ? items.map(it => `
            <div class="fm-trash-item" data-id="${esc(it.id)}">
              <span>${it.isDir ? '📁' : '📄'}</span>
              <span class="nm">${esc(it.name)}</span>
              <span class="meta">${esc(it.deletedAt)}</span>
              <button class="act" data-admin-only data-a="restore" title="还原">↺</button>
              <button class="act danger" data-admin-only data-a="remove" title="永久删除">✕</button>
            </div>`).join('') : '<div class="fm-empty">回收站是空的</div>'}
        `;
        listEl.querySelector('#fmTrashBack').onclick = (ev) => { ev.stopPropagation(); fmLoad(); };
        listEl.querySelector('#fmTrashEmpty').onclick = async (ev) => {
          ev.stopPropagation();
          const ok = await hubConfirm('确定清空回收站？此操作不可恢复。', { title: '清空回收站', okText: '清空', danger: true });
          if (!ok) return;
          apiFetch('/api/trash/empty', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: st.proj }),
          }).then(r => r.json().catch(() => ({}))).then(rj => {
            toast(rj.ok ? '回收站已清空' : (rj.error || '清空失败'));
            if (rj.ok) fmTrashBtn.onclick({ stopPropagation() {} });
          });
        };
        listEl.querySelectorAll('.fm-trash-item').forEach(row => {
          row.querySelector('.act').onclick = async (ev) => {
            ev.stopPropagation();
            const a = ev.currentTarget.dataset.a;
            const tid = row.dataset.id;
            const body = JSON.stringify({ project: st.proj, id: tid });
            const url = a === 'restore' ? '/api/trash/restore' : '/api/trash/remove';
            if (a === 'remove') {
              const ok = await hubConfirm('永久删除该文件？此操作不可恢复。', { title: '永久删除', okText: '永久删除', danger: true });
              if (!ok) return;
            }
            apiFetch(url, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
            }).then(r => r.json().catch(() => ({}))).then(rj => {
              toast(rj.ok ? (a === 'restore' ? '已还原' : '已永久删除') : (rj.error || '操作失败'));
              if (rj.ok) { win._fm.treeCache = {}; fmTrashBtn.onclick({ stopPropagation() {} }); }
            }).catch(() => toast('请求失败：无法连接后端'));
          };
        });
        win.querySelector('#fmStatus').textContent = '回收站 · ' + st.proj;
        fmSyncNav();
      }).catch(() => toast('请求失败：无法连接后端'));
  };
  const fmTrashBtn = win.querySelector('#fmTrash');
  fmSyncOps();

  // ---- 窗口通用行为（关闭/最小化/置顶/拖拽/任务栏） ----
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
  taskBtn.innerHTML = `<span class="ic">📁</span><span class="nm">${esc(p.display_name || p.name)}</span>`;
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
  fmLoad();
}
