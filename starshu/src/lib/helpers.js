// 后端通用辅助：标签解析、slug 生成、唯一约束判定
// 这些纯函数被各路由复用，集中于此避免重复实现。

// 把 tag_ids（JSON 字符串）解析为数组；容错：非数组/非 JSON 一律返回 []
function parseTags(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || '[]'); } catch { return []; }
}

// 生成内容 slug（基于时间 + 随机串，保证唯一）
function slugify(title) {
  return 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

// 是否可管理全部内容：超级管理员或拥有「post:manage（全量管理）」权限。
// 权限规则的单一来源——postScope（SQL 片段）与各路由的参数化过滤都由此派生，
// 避免同一规则两处实现、日后改其一漏其二。
function canManageAllPosts(user) {
  const perms = (user && user.permissions) || [];
  return !!(user && user.isSuper) || perms.includes('post:manage');
}

// 从已鉴权用户派生 SQL 作用域片段（供字符串插值场景使用）。
// 注意：uid 来自已签名的 token（不可由客户端伪造），属于可信数据，
// 因此此处直接拼接整数字符串不会引入注入风险；用户传入的查询参数均已参数化处理。
// 参数化过滤场景（动态 WHERE 拼接）请改用 canManageAllPosts + params.push(uid)。
function postScope(user) {
  return canManageAllPosts(user) ? '' : 'AND author_id = ' + user.uid;
}

// 判断 SQLite 错误是否为唯一约束冲突（better-sqlite3 的 code 在不同版本不一致，故同时匹配 message）
function isUniqueViolation(e) {
  if (!e) return false;
  const code = e.code || '';
  const msg = String(e.message || '');
  return code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /constraint/i.test(msg);
}

module.exports = { parseTags, slugify, canManageAllPosts, postScope, isUniqueViolation };
