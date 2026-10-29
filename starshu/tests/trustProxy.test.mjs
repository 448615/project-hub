// 反向代理信任策略回归测试（S-04）。
//
// 这一项不像功能那样"看得见"，但它决定了 IP 维度限流是真拦截还是摆设，
// 而且还藏着一个反向风险：配错时 Express 会在**每个请求**上抛错（全体 500）。
// 所以分两层测：
//   1) 纯函数层：配置解析与 IP 提取的每个分支（快、确定、不需要起服务）；
//   2) HTTP 层：无论配置正确还是写错，服务都必须能正常启动并响应。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrustProxy } from '../src/lib/trustProxy.js';
import { clientIp } from '../src/lib/rateLimit.js';
import { startServer } from './helpers.mjs';

test('配置解析：未设 / 0 / false 一律「不信任」', () => {
  // 默认必须是安全的：直连部署时不能相信客户端带来的任何转发头
  for (const v of [undefined, null, '', '   ', '0', 'false', 'FALSE', 'False']) {
    assert.equal(resolveTrustProxy(v), false, `${JSON.stringify(v)} 应解析为 false`);
  }
});

test('配置解析：数字按「信任跳数」处理', () => {
  assert.equal(resolveTrustProxy('1'), 1, '单层反代（枢纽 / 平台）');
  assert.equal(resolveTrustProxy('2'), 2, '两层反代（平台 + 枢纽）');
  assert.equal(resolveTrustProxy(' 3 '), 3, '两侧空白应被忽略');
});

test('配置解析：IP / CIDR 列表原样透传', () => {
  // 交给 Express 原生支持，不自作聪明改写
  assert.equal(resolveTrustProxy('loopback'), 'loopback');
  assert.equal(resolveTrustProxy('loopback,10.0.0.0/8'), 'loopback,10.0.0.0/8');
});

test('配置解析：写错的值按「不信任」兜底，不能把坏配置交给 Express', () => {
  // 这些值如果直接 app.set 进去，Express 会在每个请求上抛错 → 全体 500。
  // 宁可限流失效，也不能让服务不可用。
  for (const v of ['yes!', '信任一层', '1 层', '<script>', 'a;b']) {
    assert.equal(resolveTrustProxy(v), false, `${JSON.stringify(v)} 应兜底为 false`);
  }
});

test('配置解析：true 表示信任任意跳数（会用，但值本身要认得）', () => {
  assert.equal(resolveTrustProxy('true'), true);
  assert.equal(resolveTrustProxy('TRUE'), true);
});

test('IP 提取：以 req.ip 为准，伪造的 X-Forwarded-For 首跳骗不到限流键', () => {
  // 场景还原：攻击者带 XFF=9.9.9.9 打进来，但真正的直连来源是 1.2.3.4。
  // 旧实现手工取 XFF 首跳 → 返回 9.9.9.9（换个头就换一个桶，限流失效）；
  // 新实现只看 req.ip（Express 已按可信跳数算好）→ 返回 1.2.3.4。
  const req = {
    ip: '1.2.3.4',
    headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '1.2.3.4' },
  };
  assert.equal(clientIp(req), '1.2.3.4', '必须无视客户端自造的 XFF 首跳');
});

test('IP 提取：没有 req.ip 时回退 socket 地址，仍然不读 XFF', () => {
  const req = {
    headers: { 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '10.0.0.7' },
  };
  assert.equal(clientIp(req), '10.0.0.7');
});

test('IP 提取：IPv4-mapped IPv6 归一为 IPv4，避免同一客户端分裂成两个桶', () => {
  assert.equal(clientIp({ ip: '::ffff:127.0.0.1' }), '127.0.0.1');
  assert.equal(clientIp({ ip: '::ffff:192.168.1.9' }), '192.168.1.9');
});

test('IP 提取：极端输入不抛异常，且长度截断到 64', () => {
  assert.equal(clientIp({}), 'unknown', '空对象也要有个确定的键');
  assert.equal(clientIp({ ip: 'x'.repeat(200) }).length, 64, '超长地址必须截断，防内存被撑大');
});

test('HTTP 层：TRUST_PROXY=1 时服务正常启动并响应', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: '1' } });
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('HTTP 层：TRUST_PROXY 写成非法值时仍能启动（按不信任兜底，不炸服务）', async (t) => {
  const srv = await startServer({ env: { TRUST_PROXY: '不是数字' } });
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200, '坏配置只能让限流退化，不能把服务带崩');
  assert.equal(r.json.ok, true);
});

test('端到端：默认配置下伪造 X-Forwarded-For 换不到新的限流桶（S-04 的真正风险）', async (t) => {
  // 这是唯一能从外部"看见" IP 的窗口：限流桶的键就是 clientIp 的结果。
  //
  // 旧实现的致命之处：clientIp 手工取 XFF 首跳，而首跳是客户端自己写的。
  // 于是攻击者每发一个请求换一个 XFF，就能换到一个全新的空桶——
  // 粗粒度 IP 限流（200 次/5 分钟）永远不会触发，等于形同虚设。
  //
  // 现在：默认不信任转发头，req.ip 恒为直连对端（127.0.0.1），
  // 无论 XFF 怎么变，都落在同一个桶里，第 201 次必然 429。
  //
  // 为避免「按邮箱」的细粒度限流先触发（10 次/5 分钟），每次用不同邮箱；
  // 邮箱不存在时登录会短路返回 401，不会触发 scrypt 计算，跑得很快。
  const srv = await startServer(); // 不设 TRUST_PROXY → 默认不信任
  t.after(() => srv.stop());

  const MAX = 200;       // loginCoarse 的阈值（5 分钟 200 次）
  const TOTAL = MAX + 5; // 多发几个，确保越过阈值
  let firstBlocked = null;

  for (let i = 0; i < TOTAL; i++) {
    const r = await srv.call('POST', '/api/auth/login', {
      // 关键：每次换一个伪造的来源 IP，看它能不能"洗白"成新桶
      headers: { 'X-Forwarded-For': `10.9.${Math.floor(i / 256)}.${i % 256}` },
      body: { email: `nobody${i}@test.local`, password: 'whatever' },
    });
    if (r.status === 429 && firstBlocked === null) firstBlocked = i + 1;
  }

  assert.notEqual(firstBlocked, null, '伪造 XFF 不应绕过粗粒度限流：始终没被拦说明限流键被骗穿了');
  assert.ok(
    firstBlocked > MAX && firstBlocked <= MAX + 1,
    `应在第 ${MAX + 1} 次触发限流，实际首次拦截于第 ${firstBlocked} 次`
  );
});

