// 反向代理信任策略解析（S-04）。
//
// 【为什么这一项决定「限流到底有没有用」】
// Express 默认不信任 X-Forwarded-For，req.ip 永远是「直连对端」的地址：
//   - 本地直连：正好就是真实客户端，没问题；
//   - 藏在枢纽 / 平台反代后面：所有请求都来自 127.0.0.1 或网关 IP，req.ip 恒定，
//     按 IP 限流就退化成「全站共用一个桶」——正常用户被误伤，而真正的攻击者
//     换个 IP 也没人拦得住。
// 反过来，在被直接访问时不加判断就信任 XFF 同样糟糕：客户端自己加一个头，
// 就能伪装成任意 IP，等于把限流键交给攻击者填。
//
// 所以策略定为：**默认不信任（安全优先），由部署方显式声明前面有几层反代**。
//
// 【支持写法】
//   TRUST_PROXY 未设 / 0 / false        → 不信任（直连部署，默认）
//   TRUST_PROXY = 1 / 2 / 3 …           → 信任 N 跳（1 = 枢纽或单层平台反代；2 = 平台 + 枢纽）
//   TRUST_PROXY = "loopback,10.0.0.0/8" → Express 原生 IP/CIDR 列表，原样透传
//   TRUST_PROXY = true                  → 信任任意跳数（仅当整条链路都可控时使用，调用方会告警）
//
// 写错时（比如手滑打成 TRUST_PROX=1 的拼写变体、或写成 yes）一律按「不信任」处理，
// 由调用方打一条告警。宁可限流失效也不要让一个坏配置把服务带崩——
// Express 拿到无法解析的字符串会在**每个请求**上抛错，那是全体 500。

// 允许的字符：数字、字母（loopback 之类的子网名）、点、冒号、下划线、斜杠、逗号、空格、连字符
const SAFE_LIST_RE = /^[0-9a-zA-Z.:/_ ,-]+$/;

function resolveTrustProxy(raw) {
  const v = String(raw == null ? '' : raw).trim(); // 统一成字符串，容忍 undefined / 数字
  if (!v) return false;                            // 没配 → 不信任
  const lower = v.toLowerCase();                   // 大小写不敏感，避免 FALSE / True 漏判
  if (lower === 'false' || v === '0') return false;
  if (lower === 'true') return true;               // Express 语义：信任所有跳
  if (/^\d+$/.test(v)) return Number(v);           // 纯数字 → 跳数
  if (SAFE_LIST_RE.test(v)) return v;              // IP / CIDR / 子网名列表
  return false;                                    // 含非法字符 → 当作没配
}

module.exports = { resolveTrustProxy };
