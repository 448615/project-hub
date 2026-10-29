// 管理员名单一致性（X-01 短期项）：纯函数比对 + health 暴露方式。
//
// 守三件事：
//   1. 比对方向不能反——"星枢超管但不在枢纽名单"和"枢纽管理员在星枢没权限"
//      是两种完全不同的问题，前者是权限被放大，后者只是不便；
//   2. 名单规范化要一致（大小写/空格/重复/非法值），否则会出现假告警；
//   3. health 是匿名接口：生产环境只能吐布尔值，不能吐管理员邮箱清单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { compareAdmins, normalizeEmails, parseEmailList } = require('../src/lib/adminPolicy.js');
const { DEFAULT_ADMIN_EMAIL } = require('../src/shared/defaultAdmin.js');

test('名单规范化：小写、去空白、去重，丢掉不像邮箱的值', () => {
  assert.deepEqual(
    normalizeEmails(['Boss@X.com', ' boss@x.com ', 'BOSS@X.COM', '', '   ', 'not-an-email', '@x.com', 'a@']),
    ['boss@x.com'],
  );
  assert.deepEqual(normalizeEmails([]), []);
  assert.deepEqual(normalizeEmails(undefined), []);
  assert.deepEqual(normalizeEmails([1, null, {}]), [], '非字符串一律忽略，不能把数字当邮箱');
});

test('环境变量名单：逗号/分号/空白分隔都接受', () => {
  assert.deepEqual(parseEmailList('a@x.com,b@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(parseEmailList('a@x.com; b@x.com\tc@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.deepEqual(parseEmailList(''), []);
  assert.deepEqual(parseEmailList(undefined), []);
});

test('完全一致：aligned=true，两类差异都为空', () => {
  const r = compareAdmins(['a@x.com', 'b@x.com'], ['B@X.com', 'a@x.com ']);
  assert.equal(r.aligned, true);
  assert.deepEqual(r.escalated, []);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.hubAdmins, ['a@x.com', 'b@x.com']);
});

test('星枢超管不在枢纽名单 → escalated（权限被放大，最需要复核）', () => {
  const r = compareAdmins(['boss@x.com'], ['boss@x.com', 'sneaky@x.com']);
  assert.equal(r.aligned, false);
  assert.deepEqual(r.escalated, ['sneaky@x.com']);
  assert.deepEqual(r.missing, []);
});

test('枢纽管理员在星枢没有超管 → missing（只是不便，不是风险）', () => {
  const r = compareAdmins(['boss@x.com', 'new@x.com'], ['boss@x.com']);
  assert.equal(r.aligned, false);
  assert.deepEqual(r.escalated, []);
  assert.deepEqual(r.missing, ['new@x.com'], '方向不能反：这条不该出现在 escalated 里');
});

test('两侧都为空也算一致（没有管理员 vs 没有管理员）', () => {
  const r = compareAdmins([], []);
  assert.equal(r.aligned, true);
});

test('HTTP：注入名单后 health 返回 adminAligned=true（种子管理员在名单里）', async (t) => {
  const srv = await startServer({ env: { HUB_ADMIN_EMAILS: DEFAULT_ADMIN_EMAIL } });
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.adminAligned, true);
});

test('HTTP：名单缺人时 adminAligned=false，且非生产探针带明细', async (t) => {
  const srv = await startServer({ env: { HUB_ADMIN_EMAILS: 'someone-else@x.com' } });
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.json.adminAligned, false);
  assert.deepEqual(r.json.adminAudit.escalated, [DEFAULT_ADMIN_EMAIL],
    '种子管理员在星枢是超管、却不在枢纽名单里 → 应报 escalated');
  assert.deepEqual(r.json.adminAudit.missing, ['someone-else@x.com']);
});

test('HTTP：生产环境只吐布尔值，不吐管理员邮箱（匿名接口不能给撞库清单）', async (t) => {
  const srv = await startServer({
    env: { HUB_ADMIN_EMAILS: 'someone-else@x.com', NODE_ENV: 'production' },
  });
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.json.adminAligned, false);
  assert.equal(r.json.adminAudit, undefined, '生产环境不得返回 adminAudit 明细');
  assert.ok(!JSON.stringify(r.json).includes('@'), 'health 响应里不应出现任何邮箱');
});

test('HTTP：未注入名单（独立运行）时不返回该字段，也不报错', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.adminAligned, undefined, '无从比对时应省略字段，而不是谎报 true');
});
