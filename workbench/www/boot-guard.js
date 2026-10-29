/* 启动兜底：脚本加载失败 / 通过 file:// 直接打开时，在顶部显示红色告警条。
 *
 * 为什么单独成文件、且必须放在所有 <script> 之前：
 *
 *   1. 外链而非内联。
 *      内联脚本要靠 CSP 放行 'unsafe-inline'。枢纽的 CSP 是 script-src 'self'，
 *      子应用将来一旦收紧策略，整块内联代码会静默失效（连报错都没有）。
 *
 *   2. 必须最早执行。
 *      'error' 监听虽然用捕获阶段，但「注册监听器」这个动作本身必须早于出问题的脚本。
 *      旧实现把这段写在 body 末尾（index.html:824），而模块脚本在 head 第 9 行——
 *      模块加载失败时错误早已触发完，监听器才刚注册上，告警条永远不会出现。
 *      这才是「兜底机制本身失效」的真实原因，不是 CSP。
 */
(function () {
  'use strict';

  // 主应用启动成功后会把这里置 true；目前没有消费方，保留以兼容既有引用。
  window.__appLoaded = false;

  var SERVE_HINT =
    '在目录下运行 <code>node _serve.js</code>，然后访问 ' +
    '<a href="http://localhost:8848/" style="color:#fff;text-decoration:underline;">' +
    'http://localhost:8848/</a>';

  function showFatalBanner(msg) {
    var b = document.getElementById('fatalBanner');
    if (!b) return;
    b.innerHTML = msg;
    b.style.display = 'block';
  }

  // 本脚本在 <head> 里执行时 #fatalBanner 尚未解析出来，需要等 DOM 就绪
  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  if (window.location.protocol === 'file:') {
    whenReady(function () {
      showFatalBanner('⚠ 检测到通过 file:// 直接打开本页。本项目需启动本地服务器：' + SERVE_HINT);
    });
  }

  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') {
      whenReady(function () {
        showFatalBanner(
          '⚠ 核心脚本加载失败。请刷新页面 (Ctrl+F5)；若通过 file:// 打开，请运行 ' +
          '<code>node _serve.js</code> 后访问 ' +
          '<a href="http://localhost:8848/" style="color:#fff;text-decoration:underline;">' +
          'http://localhost:8848/</a>'
        );
      });
    }
  }, true);
})();
