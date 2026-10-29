// 密码哈希工具（使用 Node 内置 crypto，无原生依赖）
//
// 【为什么要改成异步】
// crypto.scryptSync 会在主线程上算 50~100ms。Node 只有一个主线程，这段时间里
// 整个进程的所有请求（登录、静态资源、其他 API）全部排队 —— 表现就是
// "只要有人在登录，全站都卡一下"。并发 10 个人登录，第 10 个人要等 10×80ms。
// 改用 promisify 后的 crypto.scrypt：真正的计算被丢到线程池（libuv），
// 主线程立刻空出来继续处理别的请求，只等结果回来再往下走。
//
// 【哈希格式不变】
// 仍然是 `盐:派生密钥`，两段都是 hex。库里已有的账号不需要任何迁移。
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt); // 异步版 scrypt：计算在线程池，不占用主线程
const KEY_LEN = 64;                      // 派生密钥长度（字节），与旧版保持一致
const SALT_BYTES = 16;                   // 盐长度（字节），与旧版保持一致

// 生成密码哈希（异步）：调用方必须 await
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex'); // 每个用户一个随机盐，防止彩虹表
  const buf = await scrypt(String(password), salt, KEY_LEN);    // 等计算完成（此时主线程已让出）
  return `${salt}:${buf.toString('hex')}`;                      // 拼成 `盐:密钥` 存库
}

// 校验密码（异步）：stored 是库里存的 `盐:密钥` 字符串
async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false; // 格式不对（空值/老数据）直接判失败
  const [salt, hash] = stored.split(':');             // 拆出盐和库里的密钥
  if (!salt || !hash) return false;                   // 任一段为空 → 失败
  const expect = Buffer.from(hash, 'hex');            // 库里的密钥从 hex 转回二进制
  if (!expect.length) return false;                   // 转换后为空（非法 hex）→ 失败
  const actual = await scrypt(String(password), salt, KEY_LEN); // 用同一个盐重算一遍
  // timingSafeEqual 要求两段长度一致，否则会抛错，所以先比长度
  if (actual.length !== expect.length) return false;
  // 等长比较且耗时与内容无关，避免"逐字节比较"泄露信息（时序侧信道）
  return crypto.timingSafeEqual(actual, expect);
}

// 同步版：**只给进程启动时的种子管理员用**。
// 启动阶段还没有任何请求在跑，阻塞这 80ms 不会影响其他用户；
// 保留它，db.js 才能继续用同步方式初始化数据库（不用把整个启动流程改成 async）。
function hashPasswordSync(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

module.exports = { hashPassword, verifyPassword, hashPasswordSync };
