// 权限与角色矩阵：集中维护「权限目录」「默认角色种子」「内存缓存」。
// 设计要点：
//  - users.role 继续作为「角色标识（key）」使用，零数据迁移即可接入 RBAC。
//  - 权限在每次请求时由 roles 表解析（经内存缓存），不写进无状态 JWT，
//    因此角色权限变更后即时对所有实例生效，天然兼容多实例部署。
//  - 超级管理员（is_super=1）绕过一切权限校验，始终保留最高权限。

// 权限分组目录：前端角色编辑页与后端校验共用同一份定义，避免文案漂移。
const PERMISSION_GROUPS = [
  { key: 'post', label: '内容管理', items: [
    { key: 'post:view', label: '查看内容' },
    { key: 'post:create', label: '创建内容' },
    { key: 'post:edit', label: '编辑内容' },
    { key: 'post:delete', label: '删除内容' },
    { key: 'post:publish', label: '发布内容' },
    { key: 'post:manage', label: '批量 / 全量管理' },
  ] },
  { key: 'media', label: '媒体库', items: [
    { key: 'media:view', label: '查看媒体' },
    { key: 'media:manage', label: '管理媒体' },
  ] },
  { key: 'category', label: '分类', items: [
    { key: 'category:view', label: '查看分类' },
    { key: 'category:manage', label: '管理分类' },
  ] },
  { key: 'tag', label: '标签', items: [
    { key: 'tag:view', label: '查看标签' },
    { key: 'tag:manage', label: '管理标签' },
  ] },
  { key: 'user', label: '用户', items: [
    { key: 'user:view', label: '查看用户' },
    { key: 'user:manage', label: '管理用户' },
  ] },
  { key: 'role', label: '角色权限', items: [
    { key: 'role:view', label: '查看角色' },
    { key: 'role:manage', label: '管理角色' },
  ] },
  { key: 'dashboard', label: '数据看板', items: [
    { key: 'dashboard:view', label: '查看看板' },
  ] },
  { key: 'stats', label: '数据统计', items: [
    { key: 'stats:view', label: '查看阅读与访客统计' },
    { key: 'stats:manage', label: '管理统计数据（清除演示数据）' },
  ] },
];

const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));

// 默认角色种子：首次启动播种；系统内置角色（is_system=1）每次启动同步刷新为种子值，
// 保证「超级管理员始终拥有全部权限」；自定义角色（is_system=0）不被覆盖。
const ROLE_SEEDS = [
  {
    key: 'admin', name: '超级管理员', is_system: 1, is_super: 1,
    description: '拥有系统全部权限，不可删除、不可降权',
    permissions: ALL_PERMISSIONS.slice(),
  },
  {
    key: 'editor', name: '内容编辑', is_system: 1, is_super: 0,
    description: '可管理全部内容与媒体、执行发布，但不能管理用户 / 角色 / 分类 / 标签结构',
    permissions: ['post:view', 'post:create', 'post:edit', 'post:delete', 'post:publish', 'post:manage', 'media:view', 'media:manage', 'dashboard:view', 'stats:view', 'category:view', 'tag:view'],
  },
  {
    key: 'author', name: '作者', is_system: 1, is_super: 0,
    description: '可创建与编辑自己的内容，不可直接发布，不能管理后台结构',
    permissions: ['post:view', 'post:create', 'post:edit', 'post:delete', 'dashboard:view', 'stats:view', 'media:view', 'category:view', 'tag:view'],
  },
  {
    key: 'viewer', name: '只读访客', is_system: 1, is_super: 0,
    description: '仅可浏览内容、媒体与看板，无任何写入权限',
    permissions: ['post:view', 'dashboard:view', 'stats:view', 'media:view', 'category:view', 'tag:view'],
  },
];

// 内存缓存：Map<key, {key,name,description,isSystem,isSuper,permissions}>
let cache = null;

function seedRoles(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    is_super INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // 系统内置角色：存在则按种子刷新（仅同步系统角色，避免覆盖自定义角色）
  const upsertSystem = db.prepare(`INSERT INTO roles (key,name,description,is_system,is_super,permissions)
    VALUES (@key,@name,@description,@is_system,@is_super,@permissions)
    ON CONFLICT(key) DO UPDATE SET
      name=excluded.name, description=excluded.description, is_system=excluded.is_system,
      is_super=excluded.is_super, permissions=excluded.permissions
    WHERE excluded.is_system = 1`);
  // 自定义角色：仅当不存在时插入
  const insertCustom = db.prepare(`INSERT OR IGNORE INTO roles (key,name,description,is_system,is_super,permissions)
    VALUES (@key,@name,@description,@is_system,@is_super,@permissions)`);

  for (const r of ROLE_SEEDS) {
    const row = {
      key: r.key, name: r.name, description: r.description || '',
      is_system: r.is_system, is_super: r.is_super, permissions: JSON.stringify(r.permissions),
    };
    if (r.is_system) upsertSystem.run(row);
    else insertCustom.run(row);
  }
  loadRoleCache(db);
}

function loadRoleCache(db) {
  const rows = db.prepare('SELECT id,key,name,description,is_system,is_super,permissions FROM roles').all();
  const m = new Map();
  for (const r of rows) {
    let perms = [];
    try { perms = JSON.parse(r.permissions || '[]'); } catch { /* 损坏的 JSON 退化为空权限 */ }
    m.set(r.key, {
      id: r.id, key: r.key, name: r.name, description: r.description,
      isSystem: !!r.is_system, isSuper: !!r.is_super, permissions: perms,
    });
  }
  cache = m;
  return m;
}

// 角色变更（创建 / 更新 / 删除）后调用，使内存缓存与数据库保持一致
function invalidateRoleCache(db) { if (db) loadRoleCache(db); else cache = null; }

function getRole(key) { return cache ? (cache.get(key) || null) : null; }
function listRoles() { return cache ? [...cache.values()] : []; }
function isKnownPermission(p) { return ALL_PERMISSIONS.includes(p); }

module.exports = {
  PERMISSION_GROUPS, ALL_PERMISSIONS, ROLE_SEEDS,
  seedRoles, loadRoleCache, invalidateRoleCache, getRole, listRoles, isKnownPermission,
};
