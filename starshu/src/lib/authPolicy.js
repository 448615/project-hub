// 认证限流策略：读取项目根的 auth-policy.json（与枢纽共用同一份）。
//
// 为什么要有这个模块：此前枢纽与星枢各写一套数字（6 次/10 分钟 vs 10 次/5 分钟），
// 同一个系统里两套规则，用户在枢纽被锁 5 分钟、在星枢还能再试 10 次，等于给了
// 攻击者一个更宽松的入口。把数字收进一份带说明的配置、两端读同一份，改一处同时生效。
//
// 读取失败（文件被删、JSON 写坏、字段非法）一律回退到 DEFAULTS 而不是抛错：
// 限流退化成默认值总好过整个登录接口 500。DEFAULTS 必须与 auth-policy.json 里的
// 值完全一致，否则「文件丢了」会静默变成另一套策略——跨语言一致性用例守这条。
const fs = require('fs');
const path = require('path');

// 允许用环境变量覆盖路径，仅用于测试（正常运行时就是项目根那一份）
const POLICY_PATH =
  process.env.AUTH_POLICY_FILE || path.resolve(__dirname, '../../../auth-policy.json');

const DEFAULTS = {
  loginAccount: { windowSec: 600, maxFails: 6, blockSec: 300 },
  loginIpCoarse: { windowSec: 300, maxFails: 200, blockSec: 0 },
  register: { windowSec: 3600, maxFails: 5 },
};

// 一节策略要么全用文件值，要么全用默认值——不允许「窗口取新的、次数取旧的」
// 这种半新半旧的组合，那比两边都不对更难排查。
function cleanSection(raw, fallback) {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const { windowSec, maxFails } = raw;
  const blockSec = raw.blockSec === undefined ? 0 : raw.blockSec;
  const intOk = (v) => Number.isInteger(v);
  if (!intOk(windowSec) || !intOk(maxFails) || !intOk(blockSec)) return { ...fallback };
  if (windowSec <= 0 || maxFails < 1 || blockSec < 0) return { ...fallback };
  return { windowSec, maxFails, blockSec };
}

function loadPolicy(file) {
  const target = file || POLICY_PATH;
  let loaded = {};
  let source = 'default';
  let error = null;
  try {
    loaded = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!loaded || typeof loaded !== 'object') throw new Error('auth-policy.json 顶层必须是对象');
    source = 'file';
  } catch (e) {
    loaded = {};
    error = e.code === 'ENOENT' ? 'ENOENT' : String(e.message || e);
    if (error !== 'ENOENT') {
      // 缺文件是正常回退，写坏文件才是需要看见的问题
      console.warn(`[starshu] auth-policy.json 读取失败，限流使用内置默认值：${error}`);
    }
  }
  const policy = {};
  for (const key of Object.keys(DEFAULTS)) policy[key] = cleanSection(loaded[key], DEFAULTS[key]);
  return { policy, source, error, path: target };
}

const loaded = loadPolicy();

module.exports = {
  policy: loaded.policy,
  source: loaded.source,
  error: loaded.error,
  path: loaded.path,
  DEFAULTS,
  loadPolicy,
};
