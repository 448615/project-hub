// 音乐缓存自愈：浏览器 IndexedDB(MusicDB) 里若存着损坏音频（例如历史上被写入的 HTML），
// 应用会一直优先恢复它，表现为「点了播放没反应」或「播放失败：no supported source」。
// 本文件提供两件事：
//   1) window.__hmMusicFail(err) —— 页面播放失败时调用，区分「自动播放被拦」与「音频损坏」，
//      后者清掉坏缓存并重载页面，页面会重新拉取默认音乐。
//   2) 页面加载后给一次结果提示。
(function () {
  'use strict';

  var DB_NAME = 'MusicDB';
  var STORE = 'tracks';
  var REC_ID = 'list';
  var COUNT_KEY = 'hm_musicHealCount';
  var healed = false;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function clearPlaylist() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(REC_ID);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    })['catch'](function () { return false; });
  }

  function setFlag(key, value) {
    try { localStorage.setItem('hm_' + key, String(value)); } catch (e) {}
  }

  function readCount() {
    try { return Number(sessionStorage.getItem(COUNT_KEY) || 0); } catch (e) { return 0; }
  }

  function bumpCount() {
    try { sessionStorage.setItem(COUNT_KEY, String(readCount() + 1)); } catch (e) {}
  }

  function toast(text, kind) {
    try {
      var el = document.createElement('div');
      el.textContent = text;
      el.setAttribute('data-hm-music-toast', '1');
      el.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:64px', 'transform:translateX(-50%)',
        'z-index:2147483000', 'max-width:78vw', 'padding:10px 16px', 'border-radius:10px',
        'font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif', 'color:#fff',
        'background:' + (kind === 'error' ? 'rgba(190,55,55,.96)' : 'rgba(34,38,46,.96)'),
        'box-shadow:0 10px 30px rgba(0,0,0,.38)', 'opacity:0', 'transition:opacity .25s',
        'pointer-events:none', 'white-space:pre-wrap'
      ].join(';');
      (document.body || document.documentElement).appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 320);
      }, 3800);
    } catch (e) {}
  }

  function heal() {
    if (healed) return;
    healed = true;
    if (readCount() >= 2) {
      toast('音频仍无法播放，请点「导入音乐」选择本地文件', 'error');
      return;
    }
    bumpCount();
    toast('检测到本地音频缓存损坏，正在自动重建…', 'info');
    clearPlaylist().then(function () {
      setFlag('musicUserCleared', false);
      setFlag('musicDefaultFailedNotified', false);
      setTimeout(function () { location.reload(); }, 450);
    });
  }

  window.__hmMusicFail = function (err) {
    var name = (err && err.name) || '';
    var msg = (err && err.message) || String(err || '');
    if (name === 'NotAllowedError' || /didn't interact|not allowed to start/i.test(msg)) {
      toast('浏览器已阻止自动播放，点 ▶ 即可开始播放', 'info');
      return;
    }
    if (name === 'NotSupportedError' || /no supported source|Failed to load/i.test(msg)) {
      heal();
      return;
    }
    toast('播放失败：' + msg, 'error');
  };

  // 兼容老路径：某些情况下页面里直接调用会抛在 media 元素上
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'AUDIO') return;
    if (t.error && t.error.code === 4) heal();   // MEDIA_ERR_SRC_NOT_SUPPORTED
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    if (readCount() > 0) toast('已重建音频缓存，点 ▶ 播放即可', 'info');
  });
})();
