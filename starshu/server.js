// CMS 后台管理系统 · 服务主程序（Express + SQLite + 文件存储）
// 入口保持为 server.js（部署以此启动），内部已拆分为 src/routes/* 模块化路由。
const path = require('path');
const express = require('express');
const auth = require('./auth');
const { resolveTrustProxy } = require('./src/lib/trustProxy');

const app = express();
const PORT = process.env.PORT || 3000;
// 监听地址：默认 0.0.0.0（所有网卡）；HOST=127.0.0.1 则仅本机可访问。
// 与 scripts/start.js 的 banner 输出保持同一来源，避免"打印了但没生效"。
const HOST = process.env.HOST || '0.0.0.0';
// 生产判定：用于决定「哪些内部实现细节不对外说」（见 /api/health 的 secretSrc）。
// 枢纽拉起子应用时会显式注入 NODE_ENV=production，因此该路径下自动收紧。
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// 反向代理信任（S-04）：决定 req.ip 是「直连对端」还是「X-Forwarded-For 里的真实来源」。
// 默认不信任（直连部署安全）；挂在枢纽/平台反代后必须由部署方声明跳数，
// 否则所有请求的 req.ip 都是 127.0.0.1，按 IP 限流等于全站共用一个桶。
// 写错时按「不信任」处理并告警，绝不把无法解析的值交给 Express（那会让每个请求都 500）。
const TRUST_PROXY_RAW = process.env.TRUST_PROXY;
const TRUST_PROXY = resolveTrustProxy(TRUST_PROXY_RAW);
if (TRUST_PROXY === true) {
  console.warn('[starshu] TRUST_PROXY=true：将信任任意跳数的 X-Forwarded-For，'
    + '客户端可伪造该头绕过 IP 维度限流，仅在整条链路均可控时使用');
} else if (String(TRUST_PROXY_RAW || '').trim() && TRUST_PROXY === false) {
  console.warn(`[starshu] TRUST_PROXY="${TRUST_PROXY_RAW}" 无法识别，已按「不信任」处理（限流将按直连 IP 计数）`);
}
app.set('trust proxy', TRUST_PROXY);
// 启动日志：排障时最常问的是「到底信了几层反代」——写进日志就不用猜。
// 平台日志里出现 `off` 却仍期望按真实 IP 限流，就是这条配置没给到。
console.log(`[starshu] trust proxy = ${TRUST_PROXY === false ? 'off' : JSON.stringify(TRUST_PROXY)}`);

// ---------- 管理员名单一致性（X-01 短期项） ----------
// 两个子项目各有账号体系，同一个人要维护两个账号，容易出现「枢纽里是普通用户、
// 星枢里却是超管」的错配。枢纽拉起本应用时把 config.json 的 admins 注入
// HUB_ADMIN_EMAILS，这里只比对与告警，**绝不改角色**——自动降权可能把唯一的
// 管理员锁在门外，那是比错配更难恢复的自伤型故障（见 src/lib/adminPolicy.js）。
const { compareAdmins, parseEmailList } = require('./src/lib/adminPolicy');
const HUB_ADMINS = parseEmailList(process.env.HUB_ADMIN_EMAILS || '');

function auditAdmins() {
  if (!HUB_ADMINS.length) return null; // 未注入（独立运行）→ 无从比对，静默跳过
  try {
    const rows = require('./db')
      .prepare("SELECT email FROM users WHERE role = 'admin' AND (status IS NULL OR status != 'disabled')")
      .all();
    return compareAdmins(HUB_ADMINS, rows.map((r) => r.email));
  } catch (e) {
    return null; // 审计失败绝不能影响服务本身
  }
}

// 安全响应头：**必须在所有路由与静态目录之前**，否则先挂载的
// express.static 会把文件直接吐出去，中间件根本轮不到。
app.use(require('./src/lib/securityHeaders'));

app.use(express.json({ limit: '5mb' }));
app.use(require('./src/lib/requestLog')); // 请求日志（/api/* 与失败请求，降噪策略见文件注释）

// ---------- 路由模块 ----------
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/posts', require('./src/routes/posts'));
app.use('/api/categories', require('./src/routes/categories'));
app.use('/api/tags', require('./src/routes/tags'));
app.use('/api/media', require('./src/routes/media'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/roles', require('./src/routes/roles'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/stats', require('./src/routes/stats'));
app.use('/api/track', require('./src/routes/track')); // 公开埋点信标，须置于静态资源之前

// ---------- 同源 RSS 代理（工作台「实时资讯」用；绕过浏览器 CORS） ----------
const RSS_ALLOW = new Set([
  'https://sspai.com/feed',
  'https://36kr.com/feed',
  'https://news.cctv.com/rss/scrolla.xml',
  'https://www.v2ex.com/index.xml',
]);
app.get('/api/rss', async (req, res) => {
  const target = String(req.query.url || '');
  if (!RSS_ALLOW.has(target)) return res.status(400).json({ error: 'bad target' });
  try {
    const r = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WorkbenchRSS/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return res.status(502).json({ error: 'upstream HTTP ' + r.status });
    const xml = await r.text();
    res.set('Content-Type', 'text/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(xml);
  } catch (e) {
    res.status(502).json({ error: 'upstream error: ' + e.message });
  }
});

// 健康检查：版本/鉴权形态 + DB 连通 + 运行时长 + 调度器状态（就绪探测友好）
// 注意：这个接口是**匿名可访问**的，只放「运维判断存活」必需的信息。
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try { dbOk = !!require('./db').prepare('SELECT 1 AS ok').get(); } catch (e) { dbOk = false; }
  const adminAudit = auditAdmins();
  res.json({
    ok: true,
    version: 'jwt-xauth-v9-hardened',
    auth: 'stateless-jwt-xauth',
    // secretSrc 会说明会话密钥来自环境变量 / 文件 / 临时生成 —— 这是内部实现细节，
    // 告诉匿名访问者等于帮对方挑攻击策略（比如盯着 ephemeral 状态等重启）。
    // 生产环境直接不返回该字段；本地开发保留，便于排查「密钥到底从哪来的」。
    ...(IS_PRODUCTION ? {} : { secretSrc: auth.SECRET_SOURCE }),
    // 管理员名单是否与枢纽一致：生产只吐布尔值，非生产才带明细——
    // 管理员邮箱对外就是一份撞库目标清单，匿名接口不能给。
    ...(adminAudit ? { adminAligned: adminAudit.aligned } : {}),
    ...(adminAudit && !IS_PRODUCTION ? { adminAudit } : {}),
    db: dbOk ? 'ok' : 'error',
    uptime: Math.round(process.uptime()),
    scheduler: require('./src/lib/scheduler').schedulerStatus(),
  });
});

// 并列挂载：桓梦工作台（独立静态前端，须置于 CMS 兜底路由之前）
app.get(/^\/workbench$/, (req, res) => res.redirect('/workbench/'));
app.use('/workbench/', express.static(path.join(__dirname, 'workbench', 'www'), { redirect: false }));
app.get('/workbench/*', (req, res) => res.sendFile(path.join(__dirname, 'workbench', 'www', 'index.html')));

// 静态前端
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 全局错误处理（需注册在最后）
app.use(require('./src/lib/errorHandler'));

// 仅当作为主模块直接运行时才监听端口；被测试 import 时不自动监听。
if (require.main === module) {
  const db = require('./db');
  // 名单错配只在真有差异时才吵：一致时不往日志里刷噪音，否则真正的告警会被淹掉。
  const startupAudit = auditAdmins();
  if (startupAudit && !startupAudit.aligned) {
    console.warn(`[starshu] 管理员名单与枢纽不一致（枢纽 ${startupAudit.hubAdmins.length} 个 / 星枢 ${startupAudit.starshuAdmins.length} 个）`);
    if (startupAudit.escalated.length) {
      console.warn(`  · 星枢超管但不在枢纽 admins：${startupAudit.escalated.join(', ')} ← 权限被放大，需人工确认`);
    }
    if (startupAudit.missing.length) {
      console.warn(`  · 枢纽管理员在星枢没有超管权限：${startupAudit.missing.join(', ')}`);
    }
  }
  const { startScheduler } = require('./src/lib/scheduler');
  startScheduler(db, 30000); // 每 30 秒扫描一次计划发布内容
  app.listen(PORT, HOST, () => {
    console.log(`[starshu] running on port ${PORT}`);
    // 每日自动备份：listen 之后异步触发，零启动阻塞；失败仅告警
    const { runBackup } = require('./src/lib/backup');
    runBackup(db);
  });
}

module.exports = app;