// 认证路由：/api/auth/*
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { hashPassword, verifyPassword } = require('../../pwd');
const asyncHandler = require('../lib/asyncHandler');
const { signToken, authMiddleware, userPayload } = require('../../auth');
const { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PWD } = require('../shared/defaultAdmin');
const { rateLimit, clientIp } = require('../lib/rateLimit');

// 登录防护（P0 安全基线）：阈值不写在这里，全部来自项目根的 auth-policy.json
// ——与枢纽读同一份，改阈值只改那一个文件（见 src/lib/authPolicy.js 的说明）。
//  - 细粒度按「邮箱」计数失败尝试：默认 10 分钟 6 次，成功后自动清零（不误伤正常用户），
//    超限后固定封禁 5 分钟（固定窗口在超限那一刻把到期时间推后，不是"封到窗口结束"）；
//    键故意不含客户端 IP：实测 CloudStudio Gateway 透传的 X-Forwarded-For 首跳
//    随边缘节点逐连接轮换，按 IP 计数会被打散而失效（线上复验 20+ 次失败不触发）；
//    按邮箱计数对「针对已知账号的暴力破解」同样有效，且不受 IP 轮换影响。
//  - 粗粒度按 IP 计数：默认 5 分钟 200 次，防对大量账号的撞库；
//    平台 IP 轮换下命中率下降，属尽力而为的纵深防御（直连/自建反代部署下完全有效）。
const { policy: AUTH_POLICY } = require('../lib/authPolicy');
const span = (sec) => (sec >= 60 ? `${Math.round(sec / 60)} 分钟` : `${sec} 秒`);
const LOGIN_BLOCK_SPAN = span(AUTH_POLICY.loginAccount.blockSec || AUTH_POLICY.loginAccount.windowSec);

const loginFine = rateLimit({
  windowMs: AUTH_POLICY.loginAccount.windowSec * 1000,
  max: AUTH_POLICY.loginAccount.maxFails,
  blockMs: AUTH_POLICY.loginAccount.blockSec * 1000,
  skipSuccessful: true,
  keyFn: (req) => 'login:' + String((req.body || {}).email || '').toLowerCase().slice(0, 64),
  message: `登录尝试过于频繁，请 ${LOGIN_BLOCK_SPAN}后再试`,
});
const loginCoarse = rateLimit({
  windowMs: AUTH_POLICY.loginIpCoarse.windowSec * 1000,
  max: AUTH_POLICY.loginIpCoarse.maxFails,
  message: '该 IP 登录尝试过多，请稍后再试',
});
// 注册防护：按「邮箱」每小时 5 次，防批量注册（同上，IP 维度在平台下不可靠，
// 保留邮箱键；成功注册即清零，不影响正常用户）
const registerLimiter = rateLimit({
  windowMs: AUTH_POLICY.register.windowSec * 1000,
  max: AUTH_POLICY.register.maxFails,
  skipSuccessful: true,
  keyFn: (req) => 'register:' + String((req.body || {}).email || '').toLowerCase().slice(0, 64),
  message: '注册过于频繁，请稍后再试',
});

// 登录
// 注意：处理函数必须是 async（密码校验改成了异步，避免 scrypt 阻塞主线程），
// 并且要用 asyncHandler 包一层，否则 await 期间抛错会导致请求永久挂起。
router.post('/login', loginCoarse, loginFine, asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  // 等哈希校验完成（计算在线程池里跑，这期间主线程仍能处理其他请求）
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (user.status === 'disabled') return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const token = signToken(user);
  // weakPassword：仍在使用源码内置的默认口令 → 前端提示立即修改（不阻断登录）。
  // 用哈希比对而非明文常量比较：避免把默认口令以明文形式在代码里做相等判断，
  // 也兼容「通过环境变量覆盖默认口令」后仍能正确识别弱口令。
  res.json({ token, user: userPayload(user), weakPassword: await verifyPassword(DEFAULT_ADMIN_PWD, user.password_hash) });
}));

// 注册（首个注册用户自动成为管理员）
router.post('/register', registerLimiter, asyncHandler(async (req, res) => {
  const { email, password, display_name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '请输入邮箱和密码' });
  if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: '该邮箱已注册' });
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  // 首注册即管理员是 fail-open：云端 serverless 冷启动会清空本地库，公网上第一个
  // 注册的人就成了管理员，可直接调用敏感接口。种子管理员（DEFAULT_ADMIN_EMAIL）在
  // 每次启动时由 db.js 播种，正常情况它一定存在，故注册一律给普通角色；仅当「库空
  // 且种子管理员也尚未建立」这种异常启动状态下，才让首注册者成为管理员作为兜底，
  // 避免彻底无法初始化。
  const seeded = db.prepare('SELECT id FROM users WHERE email = ?').get(DEFAULT_ADMIN_EMAIL);
  const role = (!seeded && userCount === 0) ? 'admin' : 'editor';
  // 先把哈希算完（异步，不阻塞其他请求），再一次性写库
  const passwordHash = await hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, display_name, role, status) VALUES (?,?,?,?,?)'
  ).run(String(email).toLowerCase(), passwordHash, display_name || '新用户', role, 'active');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.json({ token, user: userPayload(user) });
}));

// 当前用户信息
// weakPassword 由服务端判定：拿内置默认口令去校验库里存的哈希。
// 比「只信登录响应的标记」可靠——刷新页面、换设备、用 API 直接登录都不会漏掉。
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  res.json({
    user: userPayload(user),
    weakPassword: await verifyPassword(DEFAULT_ADMIN_PWD, user.password_hash),
  });
}));

// 登出（无状态 JWT，前端丢弃 token 即可，此处仅作约定）
router.post('/logout', authMiddleware, (req, res) => res.json({ ok: true }));

// 修改自己的密码（此前系统完全没有改密入口，只能用 node -e 脚本改库，
// 公网部署时默认口令几乎必然长期不改 —— 这是与「默认管理员」并列的风险点）。
// 校验：必须登录 + 原密码正确 + 新密码 ≥8 位且不同于原密码。
router.post('/password', authMiddleware, asyncHandler(async (req, res) => {
  const oldPassword = String((req.body || {}).oldPassword || '');
  const newPassword = String((req.body || {}).newPassword || '');
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入原密码与新密码' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  if (newPassword === oldPassword) return res.status(400).json({ error: '新密码不能与原密码相同' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (!(await verifyPassword(oldPassword, user.password_hash))) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  // 新哈希同样是异步算完再写库；哈希格式与旧版一致，改密后立即可用
  const passwordHash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  res.json({ ok: true });
}));

module.exports = router;
