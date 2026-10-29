// 管理员名单一致性：枢纽的 admins（config.json）与星枢的 users.role='admin'。
//
// 为什么需要：两个子项目各有自己的账号体系（枢纽 HMAC Cookie + 本地账号库，
// 星枢无状态 JWT + 自己的 users 表）。同一个人要维护两个账号，于是很容易出现
// 「在枢纽里只是普通用户，在星枢里却是超管」这种错配——权限大的那一侧没人复核过。
//
// 这一层的职责边界（重要）：
//   **只判断、只告警，绝不改数据。**
//   自动降权/自动建号看起来"顺便把名单对齐了"，但真实风险是把唯一的管理员降成
//   普通用户或改错邮箱，直接把自己锁在门外——那是一次自伤型故障，比错配更难恢复。
//   名单要不要改、怎么改，必须由人在看到告警后决定。
function normalizeEmails(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    if (typeof raw !== 'string') continue;
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    // 只做最基本的形状校验：不是邮箱就忽略，避免把一堆脏数据当成"名单"去比对
    if (!email.includes('@') || email.startsWith('@') || email.endsWith('@')) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// 环境变量里的名单（枢纽注入 HUB_ADMIN_EMAILS），逗号/分号/空白都接受
function parseEmailList(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return normalizeEmails(raw.split(/[,;\s]+/));
}

function compareAdmins(hubEmails, starshuAdminEmails) {
  const hub = normalizeEmails(hubEmails);
  const starshu = normalizeEmails(starshuAdminEmails);
  const hubSet = new Set(hub);
  const starshuSet = new Set(starshu);

  // escalated：星枢里是超管、但在枢纽名单里查无此人 —— 权限被放大，最需要复核
  const escalated = starshu.filter((e) => !hubSet.has(e)).sort();
  // missing：枢纽管理员在星枢没有超管权限 —— 只是不便，不构成风险
  const missing = hub.filter((e) => !starshuSet.has(e)).sort();

  return {
    hubAdmins: hub.slice().sort(),
    starshuAdmins: starshu.slice().sort(),
    escalated,
    missing,
    aligned: escalated.length === 0 && missing.length === 0,
  };
}

module.exports = { compareAdmins, normalizeEmails, parseEmailList };
