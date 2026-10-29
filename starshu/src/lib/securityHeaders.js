// 安全响应头中间件（零依赖，不为此引入 helmet）
//
// 为什么手写而不是用 helmet：这几个头是纯 setHeader，多引一个依赖就多一份
// 供应链风险，而 helmet 的大部分能力我们用不上。
//
// 各头的取舍：
//   X-Content-Type-Options: nosniff
//     禁止浏览器嗅探 MIME。否则用户上传的 .txt 里若含 HTML，可能被当页面执行。
//   X-Frame-Options: SAMEORIGIN
//     防点击劫持。**不能用 DENY**：枢纽用同源 iframe 嵌子应用（/apps/starshu/，
//     见 static/js/150-subapp-terminal.js），DENY 会把自己也拦在外面。
//   Content-Security-Policy
//     **脚本严格、样式放宽**。
//     script-src 只留 'self'：前端所有 JS 都是外链文件，inline script / on* 事件属性 /
//     eval / new Function 实测均为 0 处，所以不需要 'unsafe-inline'——XSS 的主通道被堵死。
//     style-src 带 'unsafe-inline'：前端 JS 在运行时拼了 51 处 style="..."（分布见下），
//     不给这个关键字，页面会缺样式（CDP 实测会报 "Applying inline style violates..."）。
//     全改成 class 涉及 charts / dashboard / post-editor 等 10 个页面的布局重构与逐页
//     视觉回归，收益（样式注入的危害远低于脚本注入）不抵成本。
//     ⚠ 51 处内联样式分布：post-editor 16、dashboard 10、stats 6、charts 5、
//       media 3、posts 3、login 3、roles 2、dom 1、drawer 1、shell 1。
//     注意 CSP 只看「运行时是否产生内联样式」，只看 public/index.html 会误判为 0 处。
//   Referrer-Policy: no-referrer
//     URL 里可能带查询参数，跳外链时不外泄。
//   Permissions-Policy
//     摄像头/麦克风/定位/支付本应用都用不到，直接关掉，缩小被滥用的面。
//
// ⚠ 与枢纽保持一致：经枢纽 /apps/starshu/ 访问时，这里发的 X-Frame-Options 与
// CSP 会被枢纽的 _DROP_HEADERS 丢弃（否则枢纽自己嵌不进去），改由
// subapps.py::_subapp_sec_headers 统一补发。两处内容必须一致，改一处请同步另一处。

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

module.exports = function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
};

module.exports.CSP = CSP;
