// 星枢 · 内容运营中枢 —— 前端 SPA 入口
// ---------------------------------------------------------------------------
// 这里只做两件事：把视图挂到路由上、在页面就绪时启动。
// 具体实现按层拆开，避免单文件膨胀：
//   core/   基础设施（会话、API、常量、权限、时间格式、路由调用器、共享状态）
//   ui/     通用组件（DOM 助手、弹窗、抽屉、图表、拖拽、富文本编辑器、表单校验）
//   views/  页面视图（登录、外壳、仪表盘、内容、编辑器、分类、标签、媒体、用户、角色、统计、错误页）
import { state, setWeakPassword } from './core/session.js';
import { api } from './core/api.js';
import { currentRoute } from './core/route.js';
import { setRouter, router } from './core/router.js';
import { appRef, shellState } from './core/runtime.js';
import { renderLogin } from './views/login.js';
import { renderShell, updateNav } from './views/shell.js';
import { renderDashboard } from './views/dashboard.js';
import { renderPosts } from './views/posts.js';
import { renderEditor } from './views/post-editor.js';
import { renderCategories } from './views/categories.js';
import { renderTags } from './views/tags.js';
import { renderMedia } from './views/media.js';
import { renderUsers } from './views/users.js';
import { renderRoles } from './views/roles.js';
import { renderStats } from './views/stats.js';
import { renderError, dismissOverlays } from './views/error.js';
import { installDnd } from './ui/dnd.js';

// ---------- 路由 ----------
const publicRoutes = { '#/login': true };

async function route() {
  const r = currentRoute();
  if (!state.token && !publicRoutes[r]) { location.hash = '#/login'; return; }
  if (state.token && r === '#/login') { location.hash = '#/'; return; }

  if (r === '#/login') { renderLogin(); return; }

  if (!state.user) {
    try {
      const me = await api('/auth/me');
      state.user = me.user;
      // 弱口令状态由服务端判定（拿默认口令校验库里的哈希），刷新/换设备也不会漏
      setWeakPassword(!!me.weakPassword);
    }
    catch (e) { renderLogin(); return; }
  }
  // 侧边栏/顶栏外壳只渲染一次，之后仅切换视图，保证滑动高亮块可跨路由持续动画
  if (!shellState.chromeReady) { renderShell(); shellState.chromeReady = true; }
  updateNav(shellState.navInitialized); shellState.navInitialized = true;
  const view = r.split('?')[0];
  if (view === '#/' || view === '#/dashboard') return renderDashboard();
  if (view === '#/posts') return renderPosts();
  if (view === '#/posts/new') return renderEditor(null);
  if (view.startsWith('#/posts/')) {
    const id = view.split('/')[2];
    if (id === 'new') return renderEditor(null);
    return renderEditor(id);
  }
  if (view === '#/categories') return renderCategories();
  if (view === '#/tags') return renderTags();
  if (view === '#/media') return renderMedia();
  if (view === '#/users') return renderUsers();
  if (view === '#/roles') return renderRoles();
  if (view === '#/stats') return renderStats();
  if (view === '#/403') return renderError(403, '权限不足', '你没有访问该页面的权限，请联系管理员。');
  return renderError(404, '页面不存在', '你访问的页面不存在或已被移动。');
}

// 把路由实现交给 core/router.js：视图里可以放心 router() 跳转，不会反向依赖本文件
setRouter(route);

function init() {
  appRef.el = document.getElementById('app');
  installDnd();
  window.addEventListener('hashchange', () => { dismissOverlays(); router(); });
  router();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
