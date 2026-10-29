// 轻量内存限流中间件（零依赖，固定窗口 + 定期清扫）。
// 设计要点：
//  - 固定窗口计数，超限返回 429 + Retry-After；Map 定期清扫过期桶，避免无限增长；
//  - blockMs：超限后**固定封禁**多久（默认 0＝封到窗口结束）。两者只在「窗口长度恰好
//    等于封禁时长」时才等价，一旦有人单独调整窗口就会静默改变封禁时长，所以显式区分；
//    登录限流用 blockMs，与枢纽的「封禁 N 秒」语义保持一致；
//  - skipSuccessful 模式仅计数失败响应（status >= 400），成功即清零——
//    登录场景使用：正常用户反复登录不会被误锁，暴力破解才会触发；
//  - 单实例维度：平台多实例各自计数（与本地 SQLite 的部署形态一致），
//    意在抬高暴力破解 / 滥用成本，非分布式绝对防御；
//  - 客户端标识取 req.ip（由 Express 按 `trust proxy` 配置算出），**不再手工解析
//    X-Forwarded-For**。此前取 XFF 首跳，而首跳正是客户端自己可以随便写的字段，
//    等于把限流键交给攻击者填：换个 header 就换一个桶，限流形同虚设。
//    现在：未配置 trust proxy 时 req.ip 是直连对端（伪造头无效）；
//    配置了跳数时 req.ip 从 XFF 右端往前数，可信链之外的值一概不采信。
//    实测注意：CloudStudio Gateway 的 XFF 首跳随边缘节点逐连接轮换，
//    因此按 IP 计数的限流在线上会被打散（各桶都攒不够阈值）。
//    结论：关键限流（登录/注册/track 细粒度）的键一律使用业务标识
//    （邮箱 / visitor_id），IP 仅用于粗粒度兜底（loginCoarse/trackCoarse）。
const buckets = new Map();
let lastSweep = Date.now();

function clientIp(req) {
  // req.ip 由 Express 依据 `trust proxy` 计算：未配置时＝socket 对端地址，
  // 配置了跳数时＝从 X-Forwarded-For 右端剥掉可信跳后剩下的地址。
  // 两种情况下客户端都无法靠伪造 XFF 首跳换身份，这正是相比旧实现的关键改进。
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  // IPv4-mapped IPv6（::ffff:127.0.0.1）归一成 IPv4：
  // 同一个客户端在两种写法下会落到两个桶里，计数被稀释
  return String(raw).replace(/^::ffff:/i, '').slice(0, 64);
}

function sweep(now) {
  for (const [k, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(k);
  }
  lastSweep = now;
}

function rateLimit({ windowMs, max, blockMs = 0, keyFn, message, skipSuccessful = false }) {
  const keyOf = keyFn || clientIp;
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > 60000) sweep(now);
    const key = keyOf(req);
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const retryAfter = () => res.set('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
    if (b.count > max) {
      // 固定封禁（blockMs > 0）：只在「刚越过阈值」那一刻把到期时间推到 现在+blockMs，
      // 语义＝封禁固定时长后自动放开，与枢纽一致（原来是「封到窗口结束」，只有窗口
      // 恰好等于封禁时长时两者才等价，改窗口长度就会静默改变封禁时长）。
      // 封禁期内的后续请求**不再延长**它，否则等于滑动封禁，永远解不开。
      if (blockMs > 0 && !b.blockApplied) {
        b.resetAt = now + blockMs;
        b.blockApplied = true;
      }
      if (skipSuccessful) {
        // 已超限的「失败计数」键：放行请求，仅当最终响应失败时改写为 429。
        // 这样真实用户（密码正确）永不会被锁死，暴力破解（持续失败）依旧被拦截。
        const origStatus = res.status.bind(res);
        const origJson = typeof res.json === 'function' ? res.json.bind(res) : null;
        res.status = (code) => {
          if (code >= 400) { retryAfter(); return origStatus(429); }
          return origStatus(code);
        };
        if (origJson) {
          // 失败响应统一替换为限流提示，避免把业务错误信息（如「账号或密码错误」）
          // 以 429 状态返回造成困惑
          res.json = (body) => {
            if (res.statusCode >= 400) return origJson({ error: message || '请求过于频繁，请稍后再试' });
            return origJson(body);
          };
        }
        res.on('finish', () => {
          if (res.statusCode < 400) buckets.delete(key); // 成功即清零失败计数
        });
        return next();
      }
      retryAfter();
      return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
    }
    if (skipSuccessful) {
      // 未超限：成功响应不计入且清零历史失败，避免误伤正常用户
      res.on('finish', () => {
        if (res.statusCode < 400) buckets.delete(key);
      });
    }
    next();
  };
}

// 测试辅助：清空所有桶（避免用例间互相影响）
function resetAll() { buckets.clear(); }

module.exports = { rateLimit, clientIp, resetAll };
