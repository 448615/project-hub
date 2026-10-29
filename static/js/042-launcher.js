// 042-launcher.js — 全局快速启动（Ctrl+K）
// 由 040-finder-launcher.js 按函数边界切分；只做文件拆分，代码零改动。

// ===== 全局快速启动 / 搜索（Ctrl+K）=====
const launcherEl = document.getElementById('launcher');
const launcherInput = document.getElementById('launcherInput');
const launcherList = document.getElementById('launcherList');
let launcherItems = [];   // 当前筛选后的结果
let launcherIdx = 0;      // 键盘高亮项索引

function renderLauncher(q) {
  q = (q || '').trim().toLowerCase();
  const apps = (DATA.projects || []).filter(p =>
    !q ||
    p.display_name.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    (p.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (p.description || '').toLowerCase().includes(q)
  );
  launcherItems = apps.map(p => ({ type: 'app', p }));
  launcherIdx = 0;
  paintLauncher();
  // 文件搜索（18）：异步追加项目内文件结果
  clearTimeout(renderLauncher._t);
  if (!q) { renderLauncher._files = []; return; }
  renderLauncher._t = setTimeout(async () => {
    try {
      const res = await apiFetch('/api/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      renderLauncher._files = (data.items || []).map(f => ({ type: 'file', f }));
    } catch (e) { renderLauncher._files = []; }
    paintLauncher();
  }, 280);
}
function paintLauncher() {
  const items = launcherItems.concat(renderLauncher._files || []);
  launcherList.innerHTML = '';
  if (!items.length) {
    launcherList.innerHTML = '<li class="empty">无匹配项</li>';
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    if (it.type === 'app') {
      li.innerHTML = `${iconHtml(it.p)}<span class="nm">${esc(it.p.display_name)}</span><span class="tag">${esc(it.p.name)}</span>`;
    } else {
      li.innerHTML = `<span class="li-ic">📄</span><span class="nm">${esc(it.f.name)}</span><span class="tag">📁 ${esc(it.f.project)} · ${esc(it.f.path)}</span>`;
    }
    li.classList.toggle('sel', i === launcherIdx);
    launcherList.appendChild(li);
  });
}
function openLauncherItem(i) {
  const items = launcherItems.concat(renderLauncher._files || []);
  const it = items[i];
  if (!it) return;
  closeLauncher();
  if (it.type === 'app') { openWindow(it.p.name); }
  else { openWindow(it.f.project); toast('已打开 ' + it.f.project + '，文件：' + it.f.path); }
}
function openLauncher() {
  renderLauncher('');
  launcherEl.hidden = false;
  launcherInput.value = '';
  launcherInput.focus();
}
function closeLauncher() { launcherEl.hidden = true; }

// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 7 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 4 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 点击遮罩空白处关闭
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 全局快捷键：Ctrl/Cmd + K 唤起 / 关闭
// ↑ 原 6 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
