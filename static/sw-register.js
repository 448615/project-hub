// PWA：注册 Service Worker（localhost/HTTPS 才生效），支持"安装到桌面"+ 离线打开
// 独立成外部文件：项目 CSP 是 script-src 'self'（禁内联），内联注册脚本会被拦截。
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/static/sw.js', { scope: '/', updateViaCache: 'none' })   // 别用 HTTP 缓存里的旧 sw.js
      .then((reg) => { reg.update().catch(() => {}); })
      .catch((e) => console.warn('SW 注册失败', e));

    // 新版 SW 接管后【不能立刻刷新】。
    // 以前是 controllerchange 直接 location.reload()：用户正在注册/登录界面敲密码时，
    // 一次自动刷新会把表单清空、把界面弹回登录页（表现为「密码还没输完自己跳走了」）。
    // 现在只在安全时机刷新：页面切到后台，或完全没有填写中的输入框。
    // 等不到安全时机就一直不刷新——sw.js 是 networkFirst，不刷新也能拿到最新代码。
    let pending = false, reloading = false;

    // 是否存在「正在填写、不可打断」的状态
    function typingInProgress() {
      var veil = document.getElementById('loginVeil');
      var ae = document.activeElement;
      function isField(el) {
        return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
      }
      if (veil && !veil.hidden) {
        // 登录/注册遮罩：任一输入框有内容，或焦点还在遮罩内的输入框上，都不打断
        var inputs = veil.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) { if (inputs[i].value) return true; }
        if (isField(ae) && veil.contains(ae)) return true;
        return false;
      }
      return isField(ae);
    }

    function tryReload(force) {
      if (reloading || !pending) return;
      if (!force && typingInProgress()) return;      // 用户正在输入：先不动
      reloading = true;
      try {
        // 同一次会话只自动刷新一次，避免反复刷新死循环
        if (sessionStorage.getItem('hub_sw_reloaded') === '1') return;
        sessionStorage.setItem('hub_sw_reloaded', '1');
      } catch (e) { return; }                        // 隐私模式写不了 → 放弃刷新
      location.reload();
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || pending) return;
      pending = true;
      setTimeout(function () { tryReload(false); }, 3000);   // 稍等，避开刚好在敲字的瞬间
    });

    // 切到后台是最安全的刷新时机（用户看不到闪烁，也不丢输入焦点）
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') tryReload(true);
    });

    // 输入结束（失焦）后再找一次机会
    document.addEventListener('focusout', function () {
      if (!pending) return;
      setTimeout(function () { tryReload(false); }, 2000);
    }, true);
  });
}
