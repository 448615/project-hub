// 项目枢纽 Service Worker：networkFirst（开发期总是拿最新代码），离线时用缓存兜底
const CACHE = 'hub-v57';
const SHELL = [
  '/',
  '/static/index.html',
  // 样式已按功能拆到 static/css/（顺序与 index.html 的 link 一致）
  '/static/css/00-base.css',
  '/static/css/10-desktop.css',
  '/static/css/11-window.css',
  '/static/css/12-taskbar.css',
  '/static/css/13-menu.css',
  '/static/css/20-viewers.css',
  '/static/css/21-preview.css',
  '/static/css/22-shell.css',
  '/static/css/30-features.css',
  '/static/css/40-account.css',
  '/static/css/50-subapp.css',
  // 桌面应用逻辑由服务端按 static/js/bundle.order 合并成单个 bundle.js 下发，
  // 这里只需要预缓存这一个文件（源码改动会改变 ETag，networkFirst 会自动取新版）
  '/static/js/bundle.js',
  '/static/bg.jpg',
  '/static/icons/app-512.png',
  '/static/icons/api.png',
  '/static/icons/cursors.png',
  '/static/icons/scripts.png',
  '/static/icons/web.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// networkFirst：先网络，成功就更新缓存；失败才读缓存（离线兜底）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;
  const u = new URL(req.url);
  // 跨域（浏览器 iframe 加载的网页等）不拦截
  if (u.origin !== location.origin) return;
  // /api/* 一律不进缓存，两个原因：
  //   1) 里面有账号明文/会话密钥（如 /api/admin/accounts?reveal=1、/api/browse/key），
  //      写进磁盘缓存等于把敏感数据留在本机可读位置；
  //   2) 缓存会让「短期密钥」拿到过期副本，代理直接 401。
  // 另外离线时不再回退 index.html —— API 返回 HTML 会让前端 JSON.parse 直接炸。
  if (u.pathname === '/api' || u.pathname.indexOf('/api/') === 0) return;
  // /browse/* 是「别人的网页」，缓存下来只会无限膨胀，也可能抓到旧页面
  if (u.pathname === '/browse' || u.pathname.indexOf('/browse/') === 0) return;
  // /apps/* 是子应用（星枢 / 桓梦工作台）自己的资源：交给它自己管缓存策略。
  // 这里若再套一层 networkFirst，会出现「星枢发了新版、枢纽的 SW 还回旧 app.js」
  // 这种跨项目的缓存幽灵，且子应用的 XHR（POST 之外的 GET /apps/starshu/api/*）
  // 也会被写进枢纽的缓存，等于把别人系统的数据留在本机。
  if (u.pathname === '/apps' || u.pathname.indexOf('/apps/') === 0) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
