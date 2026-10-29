// 1510-browser-store.js — 内置浏览器的本地数据层（书签 / 历史 / 会话 / 快捷入口）
// 由 151-browser.js 调用，本文件只做声明，加载时不产生副作用。
//
// 为什么历史与会话放 IndexedDB：浏览器历史是「一路只增不减」的数据，
// localStorage 单源配额通常 5 MB，几十条还行、上千条就会把整个 localStorage 写爆，
// 连带把设置、便签一起写失败。IndexedDB 走的是另一套配额，且支持游标倒序，
// 取「最近 10 条」不用把全部记录读进内存。
// 书签和快捷入口是用户手写的少量数据（各上限 200 / 8），继续放 localStorage，方便调试与迁移。

const BR_DB_NAME = 'hub_browser';
const BR_DB_VER = 1;
const BR_HIST_KEEP = 500;          // 历史最多保留 500 条，超出按时间删最旧的
const BR_BM_KEY = 'hub_bookmarks'; // 书签：localStorage
const BR_QUICK_KEY = 'hub_browser_shortcuts';

let _brDBP = null;                 // 打开的数据库连接（Promise，复用）
let _brDbOff = false;              // IndexedDB 不可用（隐私模式 / 被策略禁用）时退化为内存
let _brMemHist = [];               // 内存兜底：仅在本次页面生命周期内有效
let _brMemSess = null;
let _brHistAdds = 0;

function brIdbReq(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error || new Error('idb'));
  });
}

function brDB() {
  if (_brDbOff) return Promise.reject(new Error('idb-off'));
  if (_brDBP) return _brDBP;
  _brDBP = new Promise((resolve, reject) => {
    let req;
    try {
      if (!window.indexedDB) throw new Error('no-idb');
      req = indexedDB.open(BR_DB_NAME, BR_DB_VER);
    } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('history')) {
        const st = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        st.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb-open'));
    // 旧版本连接（另一个标签页还开着）会把 upgrade 卡住，这时直接降级到内存实现，
    // 不要用定时器兜底：IDB 的打开通常毫秒级，定时器只会在慢设备上误判。
    req.onblocked = () => reject(new Error('idb-blocked'));
  }).catch(err => {
    // 失败一次就记住，别让每次取历史都重试一遍（隐私模式下会一直失败）
    _brDbOff = true;
    _brDBP = null;
    throw err;
  });
  return _brDBP;
}

// ---- 历史记录 ----
// 相邻重复（同一 URL 60 秒内再次访问）只更新时间不新增，避免刷新一次多一条
function brHistAdd(url, title) {
  const u = String(url || '');
  if (!/^https?:/i.test(u)) return Promise.resolve();
  const row = { url: u, title: String(title || '') || brHost(u), ts: Date.now() };
  if (_brDbOff) {
    const last = _brMemHist[0];
    if (last && last.url === row.url && row.ts - last.ts < 60000) last.ts = row.ts;
    else _brMemHist.unshift(row);
    if (_brMemHist.length > BR_HIST_KEEP) _brMemHist.length = BR_HIST_KEEP;
    return Promise.resolve();
  }
  return brDB().then(db => new Promise(resolve => {
    const tx = db.transaction('history', 'readwrite');
    const st = tx.objectStore('history');
    const cur = st.openCursor(null, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      const last = c && c.value;
      if (last && last.url === row.url && row.ts - last.ts < 60000) {
        last.ts = row.ts;
        if (row.title) last.title = row.title;
        st.put(last);
      } else {
        st.add(row);
      }
      tx.oncomplete = () => resolve();
    };
    cur.onerror = () => resolve();
    tx.onabort = () => resolve();
  })).then(() => {
    // 每 25 次清理一次，避免每次访问都全表扫描
    if (++_brHistAdds % 25 === 0) brHistTrim();
  }).catch(() => {});
}

function brHistTrim() {
  if (_brDbOff) return Promise.resolve();
  return brDB().then(db => new Promise(resolve => {
    const st = db.transaction('history', 'readwrite').objectStore('history');
    st.count().onsuccess = (ev) => {
      let extra = (ev.target.result || 0) - BR_HIST_KEEP;
      if (extra <= 0) { resolve(); return; }
      const cur = st.openCursor();          // 正序 = 最旧的先删
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c || extra-- <= 0) { resolve(); return; }
        c.delete();
        c.continue();
      };
      cur.onerror = () => resolve();
    };
  })).catch(() => {});
}

function brHistRecent(n) {
  const lim = Math.max(1, Number(n) || 10);
  if (_brDbOff) return Promise.resolve(_brMemHist.slice(0, lim));
  return brDB().then(db => new Promise(resolve => {
    const out = [];
    const st = db.transaction('history', 'readonly').objectStore('history');
    const cur = st.index('ts').openCursor(null, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= lim) { resolve(out); return; }
      out.push(c.value);
      c.continue();
    };
    cur.onerror = () => resolve(out);
  })).catch(() => _brMemHist.slice(0, lim));
}

function brHistClear() {
  _brMemHist = [];
  if (_brDbOff) return Promise.resolve();
  return brDB().then(db => new Promise(resolve => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').clear();
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  })).catch(() => {});
}

// ---- 会话（上次关窗口时开着哪些标签） ----
function brSessionSave(data) {
  const row = { key: 'last', tabs: (data && data.tabs) || [], active: (data && data.active) | 0, ts: Date.now() };
  _brMemSess = row;
  if (_brDbOff) return Promise.resolve();
  return brDB().then(db => new Promise(resolve => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').put(row);
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  })).catch(() => {});
}

function brSessionLoad() {
  if (_brDbOff) return Promise.resolve(_brMemSess);
  return brDB().then(db => new Promise(resolve => {
    const req = db.transaction('session', 'readonly').objectStore('session').get('last');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })).catch(() => _brMemSess);
}

function brSessionClear() {
  _brMemSess = null;
  if (_brDbOff) return Promise.resolve();
  return brDB().then(db => new Promise(resolve => {
    const tx = db.transaction('session', 'readwrite');
    tx.objectStore('session').delete('last');
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
  })).catch(() => {});
}

// ---- 书签（localStorage，键 hub_bookmarks） ----
function brBmAll() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(BR_BM_KEY) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) return [];
  return list.filter(b => b && /^https?:/i.test(b.url || '')).slice(0, 200);
}
function brBmSave(list) {
  try { localStorage.setItem(BR_BM_KEY, JSON.stringify(list.slice(0, 200))); } catch (e) { /* 配额满就静默 */ }
}
function brBmHas(url) { return brBmAll().some(b => b.url === url); }
function brBmAdd(url, title) {
  const u = String(url || '');
  if (!/^https?:/i.test(u)) return brBmAll();
  const list = brBmAll().filter(b => b.url !== u);
  list.unshift({ url: u, title: String(title || '') || brHost(u), ts: Date.now() });
  brBmSave(list);
  return list;
}
function brBmRemove(url) {
  const list = brBmAll().filter(b => b.url !== url);
  brBmSave(list);
  return list;
}

// ---- 新标签页的快捷入口（4~8 个） ----
const BR_QUICK_DEF = [
  { name: '青柠主页', url: 'https://limestart.cn/' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { name: '知乎', url: 'https://www.zhihu.com/' },
  { name: 'GitHub', url: 'https://github.com/' },
  { name: '必应', url: 'https://cn.bing.com/' },
  { name: '掘金', url: 'https://juejin.cn/' },
];
const BR_QUICK_MAX = 8;

function brQuickAll() {
  let raw = null;
  try { raw = localStorage.getItem(BR_QUICK_KEY); } catch (e) { raw = null; }
  if (raw == null) return BR_QUICK_DEF.map(x => ({ name: x.name, url: x.url }));
  let list = [];
  try { list = JSON.parse(raw); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  return list.filter(x => x && /^https?:/i.test(x.url || '')).slice(0, BR_QUICK_MAX);
}
function brQuickSave(list) {
  try { localStorage.setItem(BR_QUICK_KEY, JSON.stringify(list.slice(0, BR_QUICK_MAX))); } catch (e) { /* 忽略 */ }
}

// ---- 展示用的小工具 ----
// 站点图标：代理页的 favicon 也走代理取（目标站常按 Referer 拦外链），
// 拿不到就退成 🌐，不能让标签页上挂一个裂图。
function brIconSrc(url, mode) {
  const host = brHost(url);
  if (!host) return '';
  const raw = 'https://' + host + '/favicon.ico';
  if (mode === 'proxy' && typeof _brKey !== 'undefined' && _brKey) {
    try { return brProxyUrl(raw, _brKey); } catch (e) { return raw; }
  }
  return raw;
}

// 列表里那个首字母方块：优先取名称的首个字母/汉字，
// 纯数字域名（127.0.0.1、192.168.1.1）取不到就退成 🌐，不然一列全是「1」
function brInitial(url, name) {
  const s = String(name || '').trim() || brHost(url);
  const m = s.match(/[A-Za-z\u4e00-\u9fa5]/);
  return m ? m[0].toUpperCase() : '🌐';
}

// 历史列表里的时间：今天显示 HH:MM，今年显示 M月D日，更早显示 YYYY-MM-DD
function brTimeText(ts) {
  const d = new Date(Number(ts) || 0);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const p2 = (n) => (n < 10 ? '0' + n : '' + n);
  if (d.toDateString() === now.toDateString()) return p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}
