// 040-fm-helpers.js — 文件管理器的常量与纯函数
// 由 040-finder-launcher.js 按函数边界切分；只做文件拆分，代码零改动。

// ===== 桌面内文件管理器（访达式窗口：懒加载目录树 + 文件列表 + 图片/文本预览） =====
const FM_TEXT_EXTS = ['.md', '.markdown', '.txt', '.json', '.js', '.css', '.html', '.py', '.csv', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.bat', '.xml', '.log'];
const FM_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

function fmExt(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  return i > 0 ? s.slice(i).toLowerCase() : '';
}
function fmIsText(name) { return FM_TEXT_EXTS.indexOf(fmExt(name)) > -1; }
function fmIsImage(name) { return FM_IMAGE_EXTS.indexOf(fmExt(name)) > -1; }
function fmIcon(name, isDir) {
  if (isDir) return '📁';
  const e = fmExt(name);
  if (FM_IMAGE_EXTS.indexOf(e) > -1) return '🖼️';
  if (e === '.md' || e === '.markdown' || e === '.txt') return '📄';
  if (['.js', '.py', '.css', '.html', '.json', '.sh'].indexOf(e) > -1) return '🧾';
  return '📃';
}
function fmSortEntries(entries, mode) {
  mode = mode || 'name';
  const arr = (entries || []).slice();
  const dirFirst = (a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : 0);
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');
  if (mode === 'name') return arr.sort((a, b) => dirFirst(a, b) || byName(a, b));
  if (mode === 'name-desc') return arr.sort((a, b) => dirFirst(a, b) || -byName(a, b));
  if (mode === 'size') return arr.sort((a, b) => dirFirst(a, b) || ((b.size || 0) - (a.size || 0)));
  if (mode === 'time') return arr.sort((a, b) => dirFirst(a, b) || ((b.mtime || 0) - (a.mtime || 0)));
  if (mode === 'type') return arr.sort((a, b) => dirFirst(a, b) || (fmExt(a.name) > fmExt(b.name) ? 1 : fmExt(a.name) < fmExt(b.name) ? -1 : byName(a, b)));
  return arr.sort((a, b) => dirFirst(a, b) || byName(a, b));
}
// 当前目录内按名称筛选（不区分大小写）；空查询返回全部
function fmFilterEntries(entries, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return (entries || []).slice();
  return (entries || []).filter(e => String(e.name).toLowerCase().indexOf(q) > -1);
}
function fmFmtSize(n) {
  if (n == null || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmFmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = x => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmJoin(base, name) { return base ? base + '/' + name : name; }
function fmCrumbs(path) { return path ? path.split('/') : []; }
function fmDocMode(fileRel) { return /\.(md|markdown)$/i.test(fileRel || '') ? 'md' : 'text'; }
