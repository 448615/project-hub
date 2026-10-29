/* 本地存储守卫：版本标记 + 通用健康检查 + 一键修复
 *
 * 背景（为什么需要这个文件）
 * -------------------------
 * 本应用的数据全部在浏览器本地（localStorage 的 hm_* 键 + IndexedDB 的 MusicDB）。
 * 换浏览器、清缓存、配额超限、结构变更都会造成数据问题，而应用自身的读取逻辑是
 * 「读到非空就当正常」——历史上音乐播放永久卡死，正源于此：IndexedDB 里存着损坏的
 * 音频条目，应用每次都优先恢复它，于是每次播放都失败。
 *
 * 本文件补三件应用里没有的事：
 *   1) 版本标记：在 hm_settingsMeta 里写 schemaVersion，让「数据是哪个版本写的」
 *      成为可判定的事实，而不是靠猜字段有没有。
 *   2) 通用健康检查：按类型表扫描全部 hm_* 键 + 音乐库记录，把「坏在哪」说出来。
 *      不再像 heal-music.js 那样只能等播放失败才发现。
 *   3) 一键修复：**必须先备份再删**，且只在用户点击时执行——守卫绝不静默删数据。
 *
 * 三个关键决策（改代码前先读）
 * ---------------------------
 * A. 版本号为什么叫 hm_settingsMeta 而不是 hm_schemaVersion
 *    应用自身的「导入数据备份」有一份键名白名单，判定方式是
 *    `g === y || g.startsWith(y.substring(0, y.length - 1))`（注意最后一位被截掉）。
 *    白名单里有 settings，于是只有以 "setting" 开头的键会被接受。
 *    若用 hm_schemaVersion，导入备份时它会被当成「无效数据」跳过 → 恢复出来的数据
 *    永远没有版本号，迁移钩子形同虚设。这不是洁癖，是实机验证过的行为。
 *
 * B. 为什么不把版本号塞进 hm_settings
 *   应用的设置读取是「存的是对象就直接用」，不做默认值合并。若在 hm_settings 尚不
 *    存在时先写一个只含 schemaVersion 的对象，应用就会读到缺字段的设置（主题、
 *    透明度等全部 undefined）。所以版本号必须独立成键。
 *
 * C. 为什么默认只提示、不自愈
 *   自动删数据比「坏了但还在」更危险：用户可能正想手动抢救。启动阶段只报告；
 *   修复必须由用户点击，且删除前把原始字符串写进 sessionStorage（键名
 *   hm_guard_backup_<原键名>），本次会话内还能取回。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.__hmStorageGuard = api;
    // 仅在真实浏览器里接线；Node 测试只取上面的纯函数
    if (root.document && root.localStorage) {
      try {
        api.__boot(root);
      } catch (e) {
        // 守卫自身绝不能影响主应用启动
        try { console.warn('[StorageGuard] boot failed:', e); } catch (e2) {}
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  //: 当前数据结构版本。v1 = 未标记版本的历史数据（结构与 v2 相同），v2 = 起版标记。
  var SCHEMA_VERSION = 2;

  //: 版本号所在的键（见文件头决策 A/B）
  var META_KEY = 'hm_settingsMeta';
  var VERSION_FIELD = 'schemaVersion';

  var KEY_PREFIX = 'hm_';
  var BACKUP_PREFIX = 'hm_guard_backup_';

  //: 类型表：由主 bundle 里 `b("<key>", <默认值>)` 的默认值反推，不是凭印象写的。
  //: 只有登记在册的键才会被检查——未知键一律放过，避免「应用升级了、守卫还在报警」。
  var TYPE_RULES = {
    // 数组
    hm_todos: 'array',
    hm_books: 'array',
    hm_excerpts: 'array',
    hm_exercises: 'array',
    hm_goals: 'array',
    hm_habits: 'array',
    hm_inspirations: 'array',
    hm_signins: 'array',
    hm_weights: 'array',
    // 对象
    hm_alerted_today: 'object',
    hm_moods: 'object',
    hm_readDaily: 'object',
    hm_reminders: 'object',
    hm_reviews: 'object',
    hm_settings: 'object',
    hm_water_history: 'object',
    // 标量（布尔/数字/字符串）——只需能 JSON 解析，值类型不约束
    hm_darkMode: 'scalar',
    hm_musicDefaultFailedNotified: 'scalar',
    hm_musicMode: 'scalar',
    hm_musicUserCleared: 'scalar',
    hm_musicVolume: 'scalar',
    hm_sidebarCollapsed: 'scalar',
    hm_water_last_date: 'scalar',
    hm_weightGoal: 'scalar'
  };

  //: 音乐库（IndexedDB）——与 heal-music.js / 主 bundle 使用同一组名字
  var MUSIC_DB = { name: 'MusicDB', store: 'tracks', id: 'list' };

  //: 迁移钩子：from → 升级函数。目前 1→2 只补版本号，不改数据。
  //: 将来真要改结构时在这里登记，启动时会按序执行；**绝不**在钩子里删用户数据。
  var MIGRATIONS = {
    1: function (meta) {
      meta.migratedFrom = 1;
      return meta;
    }
  };

  // ---------------------------------------------------------------------
  // 纯函数（Node 可直接测，不依赖 DOM/localStorage）
  // ---------------------------------------------------------------------
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function isBlobLike(v) {
    return !!v && typeof v === 'object' && typeof v.size === 'number' && typeof v.type === 'string';
  }

  function isBinaryLike(v) {
    if (!v || typeof v !== 'object') return false;
    if (isBlobLike(v)) return true;
    if (typeof v.byteLength === 'number') return true;      // ArrayBuffer / TypedArray / Node Buffer
    if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return true;
    return false;
  }

  /**
   * 由「已存版本」推断该做什么。**绝不修改入参**。
   * @returns {{action:string, from:*, to:number, steps:number[]}}
   *   action: 'stamp'（无版本，补标记）| 'migrate'（版本偏低）| 'noop' | 'readonly'（数据比程序新）
   */
  function planUpgrade(stored, current) {
    var to = typeof current === 'number' ? current : SCHEMA_VERSION;
    if (stored === undefined || stored === null || stored === '') {
      return { action: 'stamp', from: null, to: to, steps: [] };
    }
    var n = Number(stored);
    // 非整数 / 非有限 / 小于 1：说明这个字段被人手改过或写坏了，按「无版本」处理但不静默覆盖。
    // 必须用 Number.isInteger 而不是 parseInt：parseInt(1.5) = 1，会把"版本 1.5"当成 v1 去迁移。
    if (!isFinite(n) || !Number.isInteger(n) || n < 1) {
      return { action: 'stamp', from: stored, to: to, steps: [], invalid: true };
    }
    if (n > to) return { action: 'readonly', from: n, to: to, steps: [] };
    if (n === to) return { action: 'noop', from: n, to: to, steps: [] };
    var steps = [];
    for (var v = n; v < to; v++) steps.push(v);
    return { action: 'migrate', from: n, to: to, steps: steps };
  }

  /** 检查单条 localStorage 记录。**未登记的键直接放过**——应用将来新增的键可能是
   *  任意格式，守卫对它一无所知，报"不是合法 JSON"只会制造误报。 */
  function inspectEntry(key, raw) {
    var rule = Object.prototype.hasOwnProperty.call(TYPE_RULES, key) ? TYPE_RULES[key] : null;
    if (!rule) return null;
    var value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      return { key: key, kind: 'unparsable', detail: '内容不是合法 JSON', raw: raw };
    }
    if (rule === 'scalar') return null;
    if (rule === 'array' && !Array.isArray(value)) {
      return { key: key, kind: 'wrong-type', detail: '应为数组，实际是 ' + describe(value), raw: raw };
    }
    if (rule === 'object' && !isPlainObject(value)) {
      return { key: key, kind: 'wrong-type', detail: '应为对象，实际是 ' + describe(value), raw: raw };
    }
    return null;
  }

  function describe(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    var t = typeof v;
    if (t === 'string') return 'string';
    return t;
  }

  /**
   * 扫描一批记录。
   * @param {Array<{key:string, value:string}>} entries
   * @returns {Array<Object>} issue 列表（空数组 = 健康）
   */
  function inspectEntries(entries) {
    var issues = [];
    if (!Array.isArray(entries)) return issues;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.key !== 'string') continue;
      if (e.key.indexOf(KEY_PREFIX) !== 0) continue;       // 不是本应用的键
      if (e.key === META_KEY) continue;                    // 守卫自己的元数据
      if (e.key.indexOf(BACKUP_PREFIX) === 0) continue;    // 守卫自己的备份
      var issue = inspectEntry(e.key, e.value);
      if (issue) issues.push(issue);
    }
    return issues;
  }

  /**
   * 检查音乐库记录（IndexedDB 里 id='list' 的那条）。
   * 正常结构：{id:'list', name:'playlist', list:[{name, file?|data?}]}
   * 历史故障：data 里被写进了 HTML 文本 → 播放时 "no supported source"，且永远优先恢复。
   */
  function inspectMusic(record) {
    var issues = [];
    if (record === null || record === undefined) return issues;   // 没有自定义列表 = 正常
    if (!isPlainObject(record)) {
      return [{ kind: 'music-shape', detail: '播放列表记录应为对象，实际是 ' + describe(record) }];
    }
    if (!Array.isArray(record.list)) {
      return [{ kind: 'music-shape', detail: '播放列表 list 字段应为数组，实际是 ' + describe(record.list) }];
    }
    for (var i = 0; i < record.list.length; i++) {
      var t = record.list[i];
      if (!isPlainObject(t)) {
        issues.push({ kind: 'music-entry', index: i, detail: '第 ' + (i + 1) + ' 项不是对象' });
        continue;
      }
      if (typeof t.name !== 'string' || !t.name) {
        issues.push({ kind: 'music-entry', index: i, detail: '第 ' + (i + 1) + ' 项缺少文件名' });
        continue;
      }
      if (typeof t.data === 'string') {
        // 关键判据：二进制被当作文本存进去了，这正是历史上那次卡死的样子
        issues.push({ kind: 'music-corrupt', index: i, name: t.name, detail: '「' + t.name + '」的音频数据是文本（历史损坏）' });
        continue;
      }
      if (!isBinaryLike(t.file) && !isBinaryLike(t.data)) {
        issues.push({ kind: 'music-missing', index: i, name: t.name, detail: '「' + t.name + '」没有可用的音频数据' });
      }
    }
    return issues;
  }

  /** 从原始条目 + issue 列表生成修复计划：先备份、再删除。 */
  function repairPlan(issues, entries) {
    var byKey = {};
    if (Array.isArray(entries)) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i] && typeof entries[i].key === 'string') byKey[entries[i].key] = entries[i].value;
      }
    }
    var plan = { remove: [], backup: {}, musicReset: false };
    if (!Array.isArray(issues)) return plan;
    for (var j = 0; j < issues.length; j++) {
      var it = issues[j];
      if (!it) continue;
      if (it.kind === 'unparsable' || it.kind === 'wrong-type') {
        if (plan.remove.indexOf(it.key) === -1) {
          plan.remove.push(it.key);
          if (typeof byKey[it.key] === 'string') plan.backup[it.key] = byKey[it.key];
        }
      } else if (it.kind === 'music-shape' || it.kind === 'music-corrupt' ||
                 it.kind === 'music-missing' || it.kind === 'music-entry') {
        plan.musicReset = true;
      }
    }
    return plan;
  }

  // ---------------------------------------------------------------------
  // 浏览器接线
  // ---------------------------------------------------------------------
  var state = {
    storage: null,
    meta: null,
    plan: null,
    lastIssues: []
  };

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }

  function readMeta(storage) {
    var raw = safeGet(storage, META_KEY);
    if (!raw) return null;
    try {
      var v = JSON.parse(raw);
      return isPlainObject(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function writeMeta(storage, meta) {
    try {
      storage.setItem(META_KEY, JSON.stringify(meta));
      return true;
    } catch (e) {
      // 配额满 / 隐私模式：版本标记失败不算致命，绝不能因此挡住应用启动
      try { console.warn('[StorageGuard] 写入版本标记失败:', e && e.name); } catch (e2) {}
      return false;
    }
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (e) { return ''; }
  }

  /** 应用启动时判定并（必要时）补版本号。返回实际执行的 plan。 */
  function ensureVersion(storage) {
    var meta = readMeta(storage);
    var stored = meta ? meta[VERSION_FIELD] : undefined;
    var plan = planUpgrade(stored, SCHEMA_VERSION);
    state.meta = meta;
    state.plan = plan;

    if (plan.action === 'noop') return plan;

    if (plan.action === 'readonly') {
      // 数据来自更新版本：只提示，不迁移、不改写，避免把新结构降级破坏掉
      banner('检测到本地数据来自更新版本的桓梦工作台（数据 v' + plan.from +
             '，当前程序支持 v' + plan.to + '）。为避免损坏数据，本次不自动迁移，' +
             '请刷新或更新到最新版本后再使用。', [{ label: '知道了', dismiss: true }]);
      return plan;
    }

    var next = meta || {};
    next[VERSION_FIELD] = plan.to;
    next.updatedAt = nowIso();

    if (plan.action === 'migrate') {
      for (var i = 0; i < plan.steps.length; i++) {
        var from = plan.steps[i];
        var fn = MIGRATIONS[from];
        if (typeof fn === 'function') {
          try {
            next = fn(next) || next;
          } catch (e) {
            // 迁移失败就停在旧版本，下次启动会重试；绝不半途写入「已升级」
            try { console.error('[StorageGuard] 迁移 v' + from + ' 失败，已中止:', e); } catch (e2) {}
            banner('数据升级（v' + from + ' → v' + (from + 1) + '）失败，已保留原数据。' +
                   '可导出备份后联系维护者。', [{ label: '知道了', dismiss: true }]);
            return plan;
          }
        }
      }
    }

    if (!meta) next.createdAt = next.updatedAt;   // 首次标记：记录起点
    writeMeta(storage, next);
    state.meta = next;
    return plan;
  }

  function collectEntries(storage) {
    var out = [];
    try {
      for (var i = 0; i < storage.length; i++) {
        var k = storage.key(i);
        if (typeof k === 'string') out.push({ key: k, value: storage.getItem(k) });
      }
    } catch (e) {}
    return out;
  }

  function openMusicDB() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(MUSIC_DB.name, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(MUSIC_DB.store)) {
          db.createObjectStore(MUSIC_DB.store, { keyPath: 'id' });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function readMusicRecord() {
    return openMusicDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(MUSIC_DB.store, 'readonly');
        var r = tx.objectStore(MUSIC_DB.store).get(MUSIC_DB.id);
        r.onsuccess = function () { resolve(r.result === undefined ? null : r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  function clearMusicRecord() {
    return readMusicRecord().then(function () {
      return openMusicDB();
    }).then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(MUSIC_DB.store, 'readwrite');
        tx.objectStore(MUSIC_DB.store).delete(MUSIC_DB.id);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    })['catch'](function () { return false; });
  }

  /** 诊断：返回 {version, issues, music}。IndexedDB 不可用时 music 标为 skipped。 */
  function diagnose(opts) {
    var storage = state.storage;
    var out = { version: SCHEMA_VERSION, stored: null, issues: [], music: { status: 'skipped', issues: [] } };
    if (!storage) return Promise.resolve(out);

    var meta = readMeta(storage);
    out.stored = meta ? meta[VERSION_FIELD] : null;
    out.issues = inspectEntries(collectEntries(storage));

    var skipMusic = opts && opts.localStorageOnly;
    if (skipMusic) return Promise.resolve(out);

    return readMusicRecord().then(function (rec) {
      out.music = { status: 'ok', issues: inspectMusic(rec) };
      if (rec && Array.isArray(rec.list)) out.music.tracks = rec.list.length;
      return out;
    })['catch'](function (e) {
      out.music = { status: 'unavailable', issues: [], error: (e && e.message) || String(e) };
      return out;
    });
  }

  /** 修复：先备份原文到 sessionStorage，再删除；音乐走清空播放列表。 */
  function heal() {
    var storage = state.storage;
    if (!storage) return Promise.resolve({ removed: [], musicReset: false });
    return diagnose().then(function (report) {
      var plan = repairPlan(report.issues, collectEntries(storage));
      if (report.music && report.music.issues && report.music.issues.length) plan.musicReset = true;

      var backedUp = 0;
      Object.keys(plan.backup).forEach(function (k) {
        try {
          sessionStorage.setItem(BACKUP_PREFIX + k, plan.backup[k]);
          backedUp++;
        } catch (e) {}
      });
      plan.remove.forEach(function (k) {
        try { storage.removeItem(k); } catch (e) {}
      });

      var done = function (musicReset) {
        return { removed: plan.remove, musicReset: musicReset, backedUp: backedUp };
      };
      if (!plan.musicReset) return done(false);
      return clearMusicRecord().then(done);
    });
  }

  // ---- 提示条 -----------------------------------------------------------
  function banner(text, actions) {
    try {
      var doc = document;
      var el = doc.getElementById('hmGuardBanner');
      if (!el) {
        el = doc.createElement('div');
        el.id = 'hmGuardBanner';
        el.setAttribute('role', 'status');
        el.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483001',
          'padding:10px 14px', 'box-sizing:border-box',
          'background:rgba(120,53,15,.97)', 'color:#fff',
          'font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif',
          'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'display:flex', 'gap:10px',
          'align-items:flex-start', 'flex-wrap:wrap'
        ].join(';');
        (doc.body || doc.documentElement).appendChild(el);
      }
      el.textContent = '';
      var span = doc.createElement('span');
      span.style.cssText = 'flex:1 1 320px;min-width:0;white-space:pre-wrap';
      span.textContent = text;                     // textContent：不解析 HTML，天然免疫注入
      el.appendChild(span);

      (actions || []).forEach(function (a) {
        var btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = a.label;
        btn.style.cssText = [
          'background:rgba(255,255,255,.16)', 'color:#fff', 'border:1px solid rgba(255,255,255,.5)',
          'border-radius:8px', 'padding:4px 12px', 'font:inherit', 'cursor:pointer', 'flex:0 0 auto'
        ].join(';');
        // 只挂事件监听，不用 onclick 属性：CSP 收紧后内联事件会被直接拦掉
        btn.addEventListener('click', function () {
          try { a.onClick && a.onClick(); } catch (e) {}
          if (a.dismiss) el.remove();
        });
        el.appendChild(btn);
      });
      return el;
    } catch (e) {
      return null;
    }
  }

  function summarize(report) {
    var parts = [];
    if (report.issues.length) {
      parts.push('localStorage 有 ' + report.issues.length + ' 处异常：' +
                 report.issues.slice(0, 3).map(function (i) { return i.key.replace(KEY_PREFIX, '') + '（' + i.detail + '）'; }).join('、') +
                 (report.issues.length > 3 ? ' 等' : ''));
    }
    var mi = report.music && report.music.issues ? report.music.issues : [];
    if (mi.length) {
      parts.push('音乐库有 ' + mi.length + ' 处异常（' + mi[0].detail + '）');
    }
    return parts.join('；');
  }

  function checkAndReport() {
    return diagnose().then(function (report) {
      state.lastIssues = report.issues;
      var extra = [];
      var mi = report.music && report.music.issues ? report.music.issues.length : 0;
      if (!report.issues.length && !mi) return report;

      if (report.issues.length) {
        extra.push({ label: '修复并重载', onClick: function () {
          if (!window.confirm('将删除 ' + report.issues.length + ' 处无法读取的本地数据（会先备份到本次会话）。确定继续？')) return;
          heal().then(function () { location.reload(); });
        }});
      } else if (mi) {
        extra.push({ label: '重建音乐库', onClick: function () {
          if (!window.confirm('将清空本地音乐播放列表（音乐文件需重新导入）。确定继续？')) return;
          heal().then(function () { location.reload(); });
        }});
      }
      extra.push({ label: '知道了', dismiss: true });
      banner('本地数据检查发现问题：' + summarize(report) + '。' +
             '建议先「设置 → 导出全部数据」备份，再修复。', extra);
      return report;
    })['catch'](function () { return null; });
  }

  // ---- 对外 API ---------------------------------------------------------
  var api = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    META_KEY: META_KEY,
    VERSION_FIELD: VERSION_FIELD,
    TYPE_RULES: TYPE_RULES,
    // 纯函数（Node 测）
    planUpgrade: planUpgrade,
    inspectEntry: inspectEntry,
    inspectEntries: inspectEntries,
    inspectMusic: inspectMusic,
    repairPlan: repairPlan,
    // 浏览器
    diagnose: diagnose,
    heal: heal
  };

  api.__boot = function (root) {
    state.storage = root.localStorage;
    var plan = ensureVersion(state.storage);
    if (plan.action === 'stamp' || plan.action === 'migrate') {
      try {
        console.info('[StorageGuard] 数据版本 v' + (plan.from === null ? '未标记 → v' + plan.to : plan.from + ' → v' + plan.to));
      } catch (e) {}
    }
    var run = function () { checkAndReport(); };
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  };

  return api;
});
