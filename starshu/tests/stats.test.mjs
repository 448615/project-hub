// 统计与埋点回归测试：track 去重/参数校验/限流、overview 结构与默认周期、
// 权限拦截、演示数据清除后重启不复活（_meta 标记）、埋点数据重启后仍在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers.mjs';

// 阈值从 auth-policy.json 读，不写死在断言里——否则改了策略这份测试还在断言旧数字，
// 变成"测试通过但描述是假的"。
const require = createRequire(import.meta.url);
const { policy: AUTH_POLICY } = require('../src/lib/authPolicy.js');
const LOGIN_MAX = AUTH_POLICY.loginAccount.maxFails;
const LOGIN_WINDOW_MIN = Math.round(AUTH_POLICY.loginAccount.windowSec / 60);

const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };

test('埋点 track：去重与参数校验', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  const r1 = await srv.call('POST', '/api/track', { body: { visitor_id: 'v-test-1', source: 'https://www.baidu.com/s?w=1' } });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.deduped, false);
  // 60 秒内同访客同页面 → 去重
  const r2 = await srv.call('POST', '/api/track', { body: { visitor_id: 'v-test-1' } });
  assert.equal(r2.json.deduped, true);
  // 不同访客 → 分别计数
  const r3 = await srv.call('POST', '/api/track', { body: { visitor_id: 'v-test-2' } });
  assert.equal(r3.json.deduped, false);
  // 参数校验
  assert.equal((await srv.call('POST', '/api/track', { body: { visitor_id: '' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/track', { body: { visitor_id: 'v', post_id: 'abc' } })).status, 400);
  assert.equal((await srv.call('POST', '/api/track', { body: { visitor_id: 'v', post_id: -1 } })).status, 400);
});

test('埋点 track：异常来源归一化为 direct', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  // source 传非法值时应归一化而非报错（normalizeSource 兜底）
  const r = await srv.call('POST', '/api/track', { body: { visitor_id: 'v-src-1', source: '::not a url::' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.deduped, false);
});

test('登录限流：连续失败触发 429，成功后清零且不锁死真实用户', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  let last;
  for (let i = 0; i < LOGIN_MAX + 2; i++) {
    last = await srv.call('POST', '/api/auth/login', { body: { email: 'admin@cms.local', password: 'wrong-' + i } });
  }
  assert.equal(last.status, 429, `连续失败超过 ${LOGIN_MAX} 次（窗口 ${LOGIN_WINDOW_MIN} 分钟）应被限流`);
  assert.match(last.json.error, /频繁/);
  // Retry-After 与枢纽对齐：客户端/网关据此退避，而不是盲目重试
  assert.ok(Number(last.retryAfter) > 0, '限流响应必须带 Retry-After 秒数');
  // 超限后正确密码仍可登录（防爆破不锁死真实用户），成功后失败计数清零
  const ok = await srv.call('POST', '/api/auth/login', { body: { email: 'admin@cms.local', password: 'Admin@123456' } });
  assert.equal(ok.status, 200, '超限后正确密码应放行');
  // 清零后再次失败应回到 401（而非继续 429）
  const afterClear = await srv.call('POST', '/api/auth/login', { body: { email: 'admin@cms.local', password: 'wrong-again' } });
  assert.equal(afterClear.status, 401, '成功后应清零失败计数');
});

test('登录限流：平台 IP 轮换（XFF 逐请求变化）下仍按邮箱累积触发', async (t) => {
  // 复现线上缺陷：CloudStudio Gateway 的 XFF 首跳逐连接轮换，
  // 若限流键含 IP 则桶被打散、暴力破解可绕过。键改为邮箱后必须依旧触发。
  const srv = await startServer();
  t.after(() => srv.stop());
  let last;
  for (let i = 0; i < LOGIN_MAX + 2; i++) {
    last = await srv.call('POST', '/api/auth/login', {
      body: { email: 'admin@cms.local', password: 'wrong-' + i },
      headers: { 'X-Forwarded-For': `10.9.${i}.${i + 1}` }, // 每次不同的假 IP
    });
  }
  assert.equal(last.status, 429, `IP 轮换下连续失败超过 ${LOGIN_MAX} 次仍应被限流（键为邮箱）`);
  assert.match(last.json.error, /频繁/);
  // 超限后正确密码放行并清零
  const ok = await srv.call('POST', '/api/auth/login', {
    body: { email: 'admin@cms.local', password: 'Admin@123456' },
    headers: { 'X-Forwarded-For': '10.9.99.99' },
  });
  assert.equal(ok.status, 200, '超限后正确密码应放行');
  const afterClear = await srv.call('POST', '/api/auth/login', {
    body: { email: 'admin@cms.local', password: 'wrong-again' },
    headers: { 'X-Forwarded-For': '10.9.99.100' },
  });
  assert.equal(afterClear.status, 401, '成功后应清零失败计数');
});

test('埋点 track：限流在 IP 轮换下按 visitor_id 触发（120/分钟）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  let last;
  for (let i = 0; i < 121; i++) {
    last = await srv.call('POST', '/api/track', {
      body: { visitor_id: 'v-rl', path: '/p' },
      headers: { 'X-Forwarded-For': `10.8.${i % 250}.${(i * 7) % 250}` },
    });
  }
  assert.equal(last.status, 429, '第 121 次同访客上报应被限流（阈值 120/分钟）');
  assert.match(last.json.error, /频繁/);
});

test('统计 overview：结构、默认周期与权限', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  const r = await srv.call('GET', '/api/stats/overview?days=7', { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.days, 7);
  assert.ok(r.json.summary && typeof r.json.summary.pv === 'number');
  assert.ok(Array.isArray(r.json.trend) && Array.isArray(r.json.sources) && Array.isArray(r.json.topPosts));
  assert.equal(r.json.summary.hasDemo, true, '新库应播种演示数据');

  // 非法 days 回退 30
  assert.equal((await srv.call('GET', '/api/stats/overview?days=999', { token: admin })).json.days, 30);

  // 无 stats:view 权限 → 403
  const reg = await srv.call('POST', '/api/auth/register', { body: { email: 'nostat@test.local', password: 'pass1234' } });
  const roleRes = await srv.call('POST', '/api/roles', { token: admin, body: { key: 'nostat', name: '无统计权', permissions: ['post:view'] } });
  assert.equal(roleRes.status, 200);
  await srv.call('PATCH', '/api/users/' + reg.json.user.id, { token: admin, body: { role: 'nostat' } });
  const nostat = await srv.login('nostat@test.local', 'pass1234');
  assert.equal((await srv.call('GET', '/api/stats/overview', { token: nostat })).status, 403);
});

test('演示数据：清除后重启不复活，真实埋点重启后仍在', async (t) => {
  const srv = await startServer();
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  // 清除前有演示数据
  const before = await srv.call('GET', '/api/stats/overview?days=7', { token: admin });
  assert.equal(before.json.summary.hasDemo, true);

  // 写入一条真实埋点
  await srv.call('POST', '/api/track', { body: { visitor_id: 'persist-1', source: 'direct' } });

  // 清除演示数据
  const cleared = await srv.call('POST', '/api/stats/demo/clear', { token: admin });
  assert.equal(cleared.status, 200);
  assert.ok(cleared.json.removed > 0, '应删除演示埋点');
  const after = await srv.call('GET', '/api/stats/overview?days=7', { token: admin });
  assert.equal(after.json.summary.hasDemo, false);

  // 用同一库文件重启：演示数据不得复种（_meta 标记生效）
  await srv.stop(false);
  const srv2 = await startServer({ dbFile: srv.dbFile });
  const admin2 = await srv2.login(ADMIN.email, ADMIN.password);
  const afterRestart = await srv2.call('GET', '/api/stats/overview?days=7', { token: admin2 });
  assert.equal(afterRestart.json.summary.hasDemo, false, '重启后不得复种演示数据');

  // 真实埋点仍在：同一访客 60 秒内应去重（证明数据落库且重启后仍可查）
  const dup = await srv2.call('POST', '/api/track', { body: { visitor_id: 'persist-1' } });
  assert.equal(dup.json.deduped, true, '重启后真实埋点应仍在（去重窗口生效）');

  await srv2.stop();
});
