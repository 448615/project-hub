// 当前路由（hash 路由）。纯函数，单独成文件以避免 core ↔ views 的循环依赖。

export function currentRoute() { return location.hash || '#/login'; }
