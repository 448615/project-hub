// 轻量请求日志中间件（零依赖）：单行输出 方法/路径/状态/耗时。
// 设计要点：
//  - 路径必须在「进入中间件时」取证：Express 路由挂载会沿途改写 req.url
//    （如 /api/track 进入 router 后 req.url 变为 '/'），若在 res.on('finish')
//    里读 req.path 会得到挂载内相对路径——成功的 API 请求会被误判为静态资源
//    而漏记，失败请求也会记错路径。req.originalUrl 由 Express 保留、不被改写。
//  - 只记录路径、不记录查询串（可能含搜索词/敏感参数）。
//  - 降噪：只记录 /api/* 的请求与「失败的非 API 请求」；静态资源成功（含 304 缓存
//    协商）一律不记；
//    /api/track 是公开高频信标（正常浏览每次页面访问都会打），仅记录失败（>=400），
//    否则日志会被埋点刷爆——失败仍记，便于发现刷量/滥用。
//  - 慢请求（>1000ms）标记 [SLOW]，为容量判断与启动优化收益提供线上佐证。
//  - 不记录请求体/请求头/token，避免敏感信息落日志。
//  - 任何异常只吞掉不影响主流程（日志永远不应搞挂服务）。
module.exports = function requestLog(req, res, next) {
  const start = process.hrtime.bigint();
  const rawUrl = req.originalUrl || req.url || '';
  const path = rawUrl.split('?')[0]; // 入口取证：路由改写前的原始路径
  const method = req.method;
  res.on('finish', () => {
    try {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      const isApi = path.startsWith('/api/');
      if (path.startsWith('/api/track') && status < 400) return; // 高频信标：仅记失败
      if (!isApi && status < 400) return; // 静态资源（含 304）：仅记失败
      const slow = durMs > 1000 ? ' [SLOW]' : '';
      console.log(`[req] ${method} ${path} ${status} ${durMs.toFixed(1)}ms${slow}`);
    } catch (e) { /* 忽略：日志失败不影响响应 */ }
  });
  next();
};
