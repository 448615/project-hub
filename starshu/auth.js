// 认证：无状态 JWT（密钥来源见下方 resolveSecret）
// 该平台不提供共享数据库，且运行多实例——每个实例各自持有本地 SQLite。
// 因此会话必须“无状态”：JWT 仅依赖密钥做签名/校验，任意实例都可验证任意 token，天然兼容多实例。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const perm = require('./src/lib/permissions');

// jsonwebtoken 延迟加载：仅在登录签发 / 鉴权校验时按需 require 并缓存。
// 启动阶段无需加载，省去其约 50ms 的加载开销；首次调用后命中缓存，零额外损耗。
let _jwt;
function jwt() { if (!_jwt) _jwt = require('jsonwebtoken'); return _jwt; }

// 签名密钥：**绝不再使用写死在源码里的常量**。
// 旧版 `process.env.JWT_SECRET || 'starshu-shared-secret-v1-…'` 的问题是：
// 一旦分发这份代码，任何拿到源码的人都能用这个公开常量自己签一个 role=admin 的
// token，直接通过全部鉴权（实测可读用户列表、改数据）。因此改为三级解析：
//
//   1) 环境变量 JWT_SECRET —— 多实例/容器化部署的推荐方式（各实例显式一致）；
//   2) 密钥文件 data/jwt.secret —— 首次启动随机生成 48 字节并落盘（0600），
//      单机重启后会话不失效，且密钥不随代码分发；
//   3) 落盘失败（只读文件系统等）→ 退化为进程内随机密钥，重启后旧 token 全部失效，
//      仅记录告警而不阻塞启动。
//
// 多实例部署时必须走 1) 或共享 2) 的文件，否则各实例密钥不同、token 互不认。
function resolveSecret() {
  if (process.env.JWT_SECRET) return { secret: process.env.JWT_SECRET, source: 'env' };
  const file = process.env.JWT_SECRET_FILE
    || path.join(__dirname, 'data', 'jwt.secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    // 过短的密钥等于没有（防止历史遗留空文件/占位符把安全降级）
    if (saved.length >= 32) return { secret: saved, source: 'file' };
  } catch (_) { /* 文件不存在 → 走生成分支 */ }
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, generated, { mode: 0o600 });
    return { secret: generated, source: 'generated' };
  } catch (e) {
    console.warn('[auth] 无法写入 JWT 密钥文件，改用进程内随机密钥（重启后需重新登录）:', e.message);
    return { secret: generated, source: 'ephemeral' };
  }
}

const _resolved = resolveSecret();
const SECRET = _resolved.secret;
const SECRET_SOURCE = _resolved.source;

function signToken(user) {
  return jwt().sign(
    { uid: user.id, email: user.email, role: user.role, name: user.display_name },
    SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  try {
    return jwt().verify(token, SECRET);
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  // 优先读取自定义头 X-Auth-Token：平台反代会篡改 Authorization，自定义头可原样透传。
  // 本地开发环境仍兼容 Authorization: Bearer <token>。
  const x = req.headers['x-auth-token'];
  if (x) return x;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function authMiddleware(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: '未登录或会话已失效' });
  }
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: '会话无效或已过期，请重新登录' });
  // 由 roles 表解析权限（经内存缓存），不依赖 token 中携带的权限副本
  const role = perm.getRole(payload.role);
  const permissions = role ? role.permissions : [];
  const isSuper = role ? role.isSuper : false;
  req.user = { uid: payload.uid, email: payload.email, role: payload.role, name: payload.name, permissions, isSuper };
  next();
}

// 权限校验中间件：传入若干权限，命中任意一个即放行；超级管理员直接放行。
function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录或会话已失效' });
    if (req.user.isSuper) return next();
    const ok = perms.some((p) => (req.user.permissions || []).includes(p));
    if (!ok) return res.status(403).json({ error: '权限不足：缺少所需权限' });
    next();
  };
}

// 兼容旧调用：等价于「超级管理员」守卫
function adminOnly(req, res, next) {
  if (!req.user || !req.user.isSuper) {
    return res.status(403).json({ error: '权限不足：需要超级管理员权限' });
  }
  next();
}

// 统一构造返回给前端的用户对象（含角色名与权限列表）
function userPayload(u) {
  const role = perm.getRole(u.role);
  return {
    id: u.id,
    email: u.email,
    name: u.display_name,
    role: u.role,
    roleName: role ? role.name : (u.role || ''),
    isSuper: role ? role.isSuper : false,
    permissions: role ? role.permissions : [],
  };
}

module.exports = { signToken, verifyToken, authMiddleware, requirePermission, adminOnly, userPayload, SECRET, SECRET_SOURCE };
