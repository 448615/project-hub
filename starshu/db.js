// 数据库初始化：SQLite 持久化 + 建表 + 初始化数据
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
// 这里只取同步版：db.js 在进程启动时同步建表/播种，此时还没有任何请求，
// 用 hashPasswordSync 阻塞几十毫秒不影响任何人。业务代码（路由）一律用异步版。
const { hashPasswordSync } = require('./pwd');
const { seedRoles } = require('./src/lib/permissions');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 主库文件路径：默认 data/starshu.db；DB_FILE 环境变量可指向独立库文件
// （测试隔离、运维迁移用），不改变默认部署行为。
const dbFile = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'starshu.db');
// DB_FILE 可指向全新路径（如测试/E2E 的临时目录），父目录不存在时先建，
// 否则 better-sqlite3 打开阶段即 "unable to open database file" 启动失败。
const dbFileDir = path.dirname(dbFile);
if (!fs.existsSync(dbFileDir)) fs.mkdirSync(dbFileDir, { recursive: true });
// 启动自愈：数据库损坏时（典型场景：部署同步了新的主库文件，但运行环境残留着
// 旧服务未清理的 -wal，两者不匹配导致 "database disk image is malformed"），
// 按「清 WAL 重开 → 隔离损坏文件并按种子重建」两级恢复，保证服务可启动。
// 损坏文件隔离保留（.corrupt-<时间戳>），30 天后由下次启动自动清理，最大限度保留现场。
// 轻量健康探测：quick_check 仅做页级结构校验（足以发现 WAL 不匹配导致的
// "database disk image is malformed"），比完整 integrity_check 快数倍。
// 正常启动只跑 quick_check；仅当它不通过时才退回完整校验 + 自愈流程，
// 避免每次冷启动都为「可能损坏」的全库完整性校验付出固定开销。
function quickOk(d) {
  try {
    const r = d.prepare('PRAGMA quick_check').get();
    return !!r && r.quick_check === 'ok';
  } catch (e) { return false; }
}
// 完整完整性校验：仅在恢复路径使用（比 quick_check 更严格，额外校验索引一致性等）。
function integrityOk(d) {
  try {
    const r = d.prepare('PRAGMA integrity_check').get();
    return !!r && r.integrity_check === 'ok';
  } catch (e) { return false; }
}
function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try { if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix); } catch (e) { /* 忽略 */ }
  }
}
function openDatabase(file) {
  // 正常路径：轻量 quick_check 通过即返回，省去每次启动的全库完整校验。
  let d = new Database(file);
  if (quickOk(d)) return d;

  // 疑似损坏：进入完整自愈（清 WAL 重开 → 完整校验 → 隔离损坏文件并种子重建）。
  console.error('[db] quick_check 未通过，进入恢复流程');
  try { d.close(); } catch (e) { /* 忽略 */ }
  removeSidecars(file);
  d = new Database(file);
  if (integrityOk(d)) { console.error('[db] 清除 WAL 后恢复成功'); return d; }
  console.error('[db] 主库已损坏，隔离并按种子重建');
  try { d.close(); } catch (e) { /* 忽略 */ }
  try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e) { /* 忽略 */ }
  removeSidecars(file);
  return new Database(file);
}

// 清理 30 天前的损坏隔离文件（.corrupt-<毫秒时间戳>）。
// 隔离文件名由 openDatabase 生成：`<原文件名>.corrupt-<Date.now()>`，
// 因此用文件名里的时间戳判断隔离时长，比 mtime 更可靠（rename 不改变原文件 mtime）。
// 只删本模块生成的 .corrupt-* 文件，不碰其他文件；任何异常静默忽略。
function cleanupOldCorrupt(file, days = 30) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.corrupt-';
  const cutoff = Date.now() - days * 86400000;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(prefix)) continue;
      const ts = Number(f.slice(prefix.length));
      if (!Number.isFinite(ts) || ts >= cutoff) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* 忽略 */ }
    }
  } catch (_) { /* 目录不存在或不可读时忽略 */ }
}

const db = openDatabase(dbFile);
cleanupOldCorrupt(dbFile); // 启动时清理 30 天前的隔离文件；失败不影响启动
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// 遇锁等待上限（毫秒）。WAL 允许「读写并发」，但「写写」仍然互斥：
// 没设这一项时，第二个写事务会立刻拿到 SQLITE_BUSY 并抛错（表现为偶发 500，
// 日志里是 "database is locked"，很难复现）。设了它之后，后到的写入会等锁释放
// 而不是直接失败，最多等 5 秒；5 秒还拿不到才报错——正常情况下写事务都是毫秒级，
// 5 秒足够覆盖「调度器扫描 + 用户保存文章 + 后台备份」撞在一起的场景。
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'editor',
  status TEXT NOT NULL DEFAULT 'active',
  avatar_url TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  parent_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'article',
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  summary TEXT,
  content TEXT NOT NULL,
  cover_image TEXT,
  category_id INTEGER,
  author_id INTEGER,
  tag_ids TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT,
  url TEXT,
  path TEXT,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER,
  related_post_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
`);

// 站内通知表（用于驳回理由通知、定时发布到点通知等）
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'system',
  title TEXT NOT NULL,
  body TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);
`);

// 阅读埋点表：PV 明细（UV 按 visitor_id 去重统计）。
// post_id 可空（站点级访问）；is_demo=1 为演示数据，可在「数据统计」页一键清除。
db.exec(`
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  visitor_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'direct',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(created_at);
CREATE INDEX IF NOT EXISTS idx_pv_post ON page_views(post_id);
CREATE INDEX IF NOT EXISTS idx_pv_visitor ON page_views(visitor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pv_demo ON page_views(is_demo);
`);

// 键值元数据表：记录一次性标记（如「演示数据已清除」），避免重启后复种
db.exec(`
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);

// 元数据读写（挂在 db 实例上，供 seed / stats 等模块复用）
function getMeta(key) {
  try {
    const r = db.prepare('SELECT value FROM _meta WHERE key = ?').get(key);
    return r ? r.value : null;
  } catch (e) { return null; }
}
function setMeta(key, value) {
  db.prepare(
    "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
db.getMeta = getMeta;
db.setMeta = setMeta;

// ---------- Schema 迁移（P2-1） ----------
// 建表基线由上面的 CREATE TABLE IF NOT EXISTS 负责（幂等，自愈重建依赖）；
// 列级演进统一走 migrations/ 编号迁移（_migrations 记录，重启不重放）。
// 旧库字段已存在时按「已应用」无缝接管（见 migrate.js 注释）。
try {
  require('./src/lib/migrate').runMigrations(db);
} catch (e) {
  // 迁移失败意味着 schema 与代码预期不符，继续启动只会在请求层 500。
  // fail fast：让平台重启循环 + 明确日志暴露问题，好过带病服务。
  console.error('[db] Schema 迁移失败:', e.message);
  throw e;
}

// 演示数据：page_views 为空时播种 30 天合成埋点（is_demo=1，可在「数据统计」页一键清除）。
// 仅生成站点级（post_id 为空）与现有文章的访问明细，不伪造内容本身。
function seedDemoViews() {
  try {
    // 用户主动清除过演示数据后不再复种（标记持久化于 _meta，重启不丢失）
    if (getMeta('demo_views_cleared') === '1') return;
    if (db.prepare('SELECT COUNT(*) c FROM page_views').get().c > 0) return;
  } catch (e) { return; } // 表异常时跳过演示数据，不影响主流程
  const posts = db.prepare('SELECT id FROM posts WHERE is_deleted=0').all();
  const sources = ['direct', 'baidu.com', 'google.com', 'weixin.com', 'zhihu.com'];
  const ins = db.prepare(
    'INSERT INTO page_views (post_id, visitor_id, source, is_demo, created_at) VALUES (?,?,?,1,?)'
  );
  const targets = [null, ...posts.map((p) => p.id)];
  const rnd = (n) => Math.floor(Math.random() * n);
  const now = Date.now();
  const rows = [];
  for (let d = 29; d >= 0; d--) {
    const dayStart = new Date(now - d * 86400000);
    dayStart.setHours(0, 0, 0, 0);
    const pv = Math.max(8, 40 + (30 - d) * 6 + rnd(30)); // 缓慢上升趋势
    const uv = Math.max(4, Math.round(pv * (0.55 + Math.random() * 0.2)));
    for (let i = 0; i < pv; i++) {
      const vid = 'demo_v' + rnd(uv) + '_d' + d; // 同人同日同 id，保证 UV 去重口径
      const t = new Date(dayStart.getTime() + rnd(86400000));
      rows.push([targets[rnd(targets.length)], vid, sources[rnd(sources.length)],
        t.toISOString().slice(0, 19).replace('T', ' ')]);
    }
  }
  const tx = db.transaction(() => rows.forEach((r) => ins.run(...r)));
  tx();
  // 同步 posts.views，使内容列表的浏览量与埋点明细一致
  const perPost = db.prepare(
    'SELECT post_id, COUNT(*) c FROM page_views WHERE post_id IS NOT NULL AND is_demo=1 GROUP BY post_id'
  ).all();
  const upd = db.prepare('UPDATE posts SET views = views + ? WHERE id = ?');
  const tx2 = db.transaction(() => perPost.forEach((r) => upd.run(r.c, r.post_id)));
  tx2();
}

// 初始化参考数据
function seed() {
  // 角色与权限矩阵：先于用户播种，确保默认管理员可被识别为超级管理员
  seedRoles(db);

  const catCount = db.prepare('SELECT COUNT(*) c FROM categories').get().c;
  if (catCount === 0) {
    const ins = db.prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?,?,?,?)');
    const cats = [
      ['公告', 'notice', '平台公告与通知', 1],
      ['教程', 'tutorial', '使用教程与指南', 2],
      ['新闻', 'news', '行业与产品新闻', 3],
      ['产品', 'product', '产品介绍', 4],
    ];
    const tx = db.transaction(() => cats.forEach((r) => ins.run(...r)));
    tx();
  }

  const tagCount = db.prepare('SELECT COUNT(*) c FROM tags').get().c;
  if (tagCount === 0) {
    const ins = db.prepare('INSERT INTO tags (name, slug) VALUES (?,?)');
    const tags = [['热门', 'hot'], ['置顶', 'top'], ['活动', 'event'], ['更新日志', 'changelog']];
    const tx = db.transaction(() => tags.forEach((r) => ins.run(...r)));
    tx();
  }

  // 默认管理员账号：仅在「系统中没有任何活跃超级管理员」时才创建 / 恢复。
  // 旧逻辑每次启动都强制把该账号恢复为 admin/active，会覆盖管理员的主动决策
  // （例如主动禁用它），也让这个已知凭据的账号无法被彻底关闭；
  // 无超管时才恢复，既保证系统永远有路可走（不会因误操作锁死自己），
  // 又不再反复推翻管理员的有意设置。
  // 邮箱/密码常量放在 src/shared/defaultAdmin.js，供 routes/auth.js 判定「仍在使用默认口令」。
  const { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PWD } = require('./src/shared/defaultAdmin');
  const superAlive = db.prepare(
    "SELECT COUNT(*) AS c FROM users u JOIN roles r ON u.role = r.key WHERE r.is_super = 1 AND u.status = 'active'"
  ).get().c > 0;
  if (!superAlive) {
    const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL);
    if (!existingAdmin) {
      db.prepare(
        "INSERT INTO users (email, password_hash, display_name, role, status) VALUES (?,?,?,?,?)"
      ).run(DEFAULT_ADMIN_EMAIL, hashPasswordSync(DEFAULT_ADMIN_PWD), '系统管理员', 'admin', 'active');
    } else {
      // 保底恢复：无任何活跃超管时，把默认管理员修复为可用状态
      db.prepare(
        "UPDATE users SET role = 'admin', status = 'active' WHERE id = ? AND (role <> 'admin' OR status <> 'active')"
      ).run(existingAdmin.id);
    }
  }
  // 演示埋点：仅在无任何埋点数据时播种，避免覆盖真实统计
  seedDemoViews();
}
try {
  seed();
} catch (e) {
  // 种子失败不应导致服务无法启动（自愈流程已保证库文件健康；此处仅防御极端情况）
  console.error('[db] 种子数据初始化失败:', e.message);
}

module.exports = db;

// 可选：首次启动播种示例文章（仅当 posts 为空）
const postCount = db.prepare('SELECT COUNT(*) c FROM posts').get().c;
if (postCount === 0 && process.env.SEED_DEMO !== '0') {
  const cat = db.prepare("SELECT id FROM categories WHERE slug='tutorial'").get();
  const admin = db.prepare("SELECT id FROM users WHERE email='admin@cms.local'").get();
  const ins = db.prepare(
    `INSERT INTO posts (type,title,slug,summary,content,category_id,author_id,status,published_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))`
  );
  ins.run('article', '欢迎使用 CMS 管理后台', 'p-welcome',
    '这是一篇示例文章，可直接编辑或删除。',
    '<h2>欢迎</h2><p>这是示例内容，演示了标题、列表与链接。</p><ul><li>左侧菜单切换模块</li><li>「内容管理」可增删改查</li></ul>',
    cat ? cat.id : null, admin ? admin.id : null, 'published');
  ins.run('article', '如何创建你的第一篇内容', 'p-first-post',
    '从草稿到发布的完整流程。',
    '<p>新建 → 填写标题/分类/正文 → 保存草稿 → 提交审核 → 通过发布。</p>',
    cat ? cat.id : null, admin ? admin.id : null, 'published');
}