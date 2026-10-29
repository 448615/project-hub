// async 路由兜底包装器。
//
// 【为什么需要】
// Express 4 只捕获「同步抛出的异常」，不会自动处理 async 函数里的 Promise 拒绝。
// 一旦路由函数改成 async（比如等密码哈希算完），中间抛错就会变成
// 「未处理的 Promise 拒绝」：进程不崩，但请求永远收不到响应，客户端只能等超时。
// 这比直接返回 500 更难排查，所以每个 async 路由都要包这一层。
//
// 【用法】
//   router.post('/x', asyncHandler(async (req, res) => { ... }));
//
// 同步抛出的错不需要这层（Express 自己会接住），但包上也无副作用，
// 因此不用区分，统一包即可。
module.exports = function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    // Promise.resolve 兼容「普通函数」与「async 函数」两种返回值
    // .catch(next) 把异常交给 Express 的错误处理链（最终到 errorHandler）
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
