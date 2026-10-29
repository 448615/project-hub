// 草稿与自动保存（纯前端，基于 localStorage）
// 在编辑内容（完整编辑页 / 快速编辑抽屉）时，每隔一小段时间把表单内容暂存到本地；
// 下次重新打开同一篇内容时，如果发现本地草稿与服务端版本不一致，则提示恢复。

const PREFIX = 'starshu_draft_';

// 草稿键：已有内容用其 id，新建内容统一用 'new'
export function draftKey(id) {
  return PREFIX + (id || 'new');
}

export function saveDraft(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch (_) { /* localStorage 不可用时静默降级（自动保存失效，不影响正常保存） */ }
}

export function loadDraft(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && obj.data ? obj : null;
  } catch (_) { return null; }
}

export function clearDraft(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}

// 内容签名：用于判断“本地草稿”与“服务端版本”是否一致（一致则无需提示恢复）
export function draftSig(obj) {
  try {
    const sorted = Object.keys(obj || {}).sort().reduce((a, k) => { a[k] = obj[k]; return a; }, {});
    return JSON.stringify(sorted);
  } catch (_) { return ''; }
}

// 把 Date 格式化为 HH:MM
export function hhmm(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
