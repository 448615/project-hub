// 工作流状态机回归测试：合法流转、非法流转 409、权限 403、驳回理由必填、通知触达。
// 覆盖此前后被清理的 verify-stage3.cjs 的核心断言，改为 node:test 常驻回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };

test('工作流：完整状态机流转', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  // 编辑者：默认注册角色为 editor（含 post:publish，可审核）
  const reg = await srv.call('POST', '/api/auth/register', { body: { email: 'ed@test.local', password: 'pass1234', display_name: '编辑者' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.user.role, 'editor');
  // 改用 author 角色（有 post:edit、无 post:publish）验证权限边界
  assert.equal((await srv.call('PATCH', '/api/users/' + reg.json.user.id, { token: admin, body: { role: 'author' } })).status, 200);
  const ed = await srv.login('ed@test.local', 'pass1234');

  const cats = await srv.call('GET', '/api/categories', { token: admin });
  const catId = cats.json.rows[0].id;
  const created = await srv.call('POST', '/api/posts', { token: ed, body: { title: '流转回归', content: '<p>正文</p>', category_id: catId } });
  assert.equal(created.status, 200);
  assert.equal(created.json.row.status, 'draft');
  const pid = created.json.row.id;

  // 草稿不可直接审核 → 409；未知操作 → 400
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'approve' } })).status, 409);
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'fly' } })).status, 400);

  // 编辑者提交审核 → pending
  const submitted = await srv.call('POST', '/api/posts/' + pid + '/transition', { token: ed, body: { action: 'submit' } });
  assert.equal(submitted.json.row.status, 'pending');

  // 编辑者无发布权限不可审核 → 403
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: ed, body: { action: 'approve' } })).status, 403);

  // 驳回必须填理由 → 400；带理由驳回 → rejected 且记录理由
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'reject' } })).status, 400);
  const rejected = await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'reject', reason: '内容需补充引用' } });
  assert.equal(rejected.json.row.status, 'rejected');
  assert.equal(rejected.json.row.reject_reason, '内容需补充引用');

  // 驳回到点通知应送达作者
  const notif = await srv.call('GET', '/api/notifications', { token: ed });
  assert.equal(notif.status, 200);
  assert.ok(notif.json.rows.some((n) => n.type === 'review' && n.ref_id === pid), '驳回应通知作者');

  // 被驳回后可重新提交 → pending → 通过 → published（记录 published_at）
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: ed, body: { action: 'submit' } })).json.row.status, 'pending');
  const approved = await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'approve' } });
  assert.equal(approved.json.row.status, 'published');
  assert.ok(approved.json.row.published_at, '通过审核应记录 published_at');
  assert.equal(approved.json.row.reject_reason, null, '通过审核应清除驳回理由');

  // 下线 → offline → 恢复 → draft；draft 不可下线 → 409
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'offline' } })).json.row.status, 'offline');
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'restore' } })).json.row.status, 'draft');
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: admin, body: { action: 'offline' } })).status, 409);

  // 他人内容不可流转：ed2 同为 author（无 post:manage），scope 外 → 404
  const other = await srv.call('POST', '/api/auth/register', { body: { email: 'ed2@test.local', password: 'pass1234' } });
  assert.equal(other.status, 200);
  assert.equal((await srv.call('PATCH', '/api/users/' + other.json.user.id, { token: admin, body: { role: 'author' } })).status, 200);
  const ed2 = await srv.login('ed2@test.local', 'pass1234');
  assert.equal((await srv.call('POST', '/api/posts/' + pid + '/transition', { token: ed2, body: { action: 'submit' } })).status, 404);
});

test('工作流：定时发布创建与到点转换', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  const cats = await srv.call('GET', '/api/categories', { token: admin });
  const catId = cats.json.rows[0].id;

  // 定时发布时间必填（有发布权限者）
  const noTime = await srv.call('POST', '/api/posts', { token: admin, body: { title: '定时缺时间', content: 'x', category_id: catId, status: 'scheduled' } });
  assert.equal(noTime.status, 400);

  // 设置 3 秒后的计划时间 → scheduled（调度器每 30s 扫描，到点自动发布）
  const soon = new Date(Date.now() + 3000).toISOString().slice(0, 19).replace('T', ' ');
  const scheduled = await srv.call('POST', '/api/posts', { token: admin, body: { title: '定时发布', content: 'x', category_id: catId, status: 'scheduled', scheduled_at: soon } });
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.json.row.status, 'scheduled');
  assert.equal(scheduled.json.row.scheduled_at, soon);

  // 轮询等待调度器到点转换（最多 50s）
  let published = false;
  for (let i = 0; i < 10 && !published; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const row = await srv.call('GET', '/api/posts/' + scheduled.json.row.id, { token: admin });
    if (row.json && row.json.row && row.json.row.status === 'published') published = true;
  }
  assert.ok(published, '到点后调度器应自动发布');
});
