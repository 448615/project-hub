// 路由调用器：真正的路由实现由 main.js 注入（setRouter）。
// 这样视图里可以直接 router() 触发跳转，而不必 import main.js 造成循环依赖。
let impl = null;

/** 由 main.js 在启动时注入实际的路由函数。 */
export function setRouter(fn) { impl = fn; }

/** 触发一次路由解析；实现未注入时安全地返回一个已完成的 Promise。 */
export function router() { return impl ? impl() : Promise.resolve(); }


