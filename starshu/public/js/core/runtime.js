// 跨视图共享的少量运行时状态：集中一处，避免各模块各存一份副本。
// 只放「多模块读写」的状态；单一视图私有的状态仍留在各自模块内。

// #app 根节点（init 时挂上，渲染前一定已就绪）
export const appRef = { el: null };

// 桌面外壳（侧边栏 + 顶栏）是否已经渲染过
export const shellState = { chromeReady: false, navInitialized: false };

// 渲染世代：异步渲染 await 之后据此判断「是否已切到别的页面」，丢弃过期写入
export const viewState = { epoch: 0 };


