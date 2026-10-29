// 全局错误处理中间件：兜底所有未被捕获的异常，返回安全的 JSON 错误，避免泄露堆栈。
// 需在最后注册（位于静态资源与路由之后）。
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err && err.status ? err.status : 500;
  if (status >= 500) {
    console.error('[server error]', err && err.stack ? err.stack : err);
  }
  res.status(status).json({ error: err && err.message ? err.message : '服务器内部错误' });
};
