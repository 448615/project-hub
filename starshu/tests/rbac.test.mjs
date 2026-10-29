// RBAC 回归测试：角色/权限矩阵、越权拦截、数据 scope、防自降权、系统角色保护。
// 覆盖此前后被清理的 verify-rbac.cjs 的核心断言，改为 node:test 常驻回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };

test('RBAC：权限矩阵与越权拦截', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  // 未登录 → 401；错误密码 → 401
  assert.equal((await srv.call('GET', '/api/posts')).status, 401);
  assert.equal((await srv.call('POST', '/api/auth/login', { body: { email: ADMIN.email, password: 'wrong' } })).status, 401);

  // 创建只读审计角色（带 post:manage 以验证「管理scope 可见全量」路径）
  const roleRes = await srv.call('POST', '/api/roles', {
    token: admin,
    body: {
      key: 'auditor', name: '审计员', description: '回归测试',
      permissions: ['post:view', 'post:manage', 'stats:view', 'dashboard:view', 'media:view', 'category:view', 'tag:view', 'role:view'],
    },
  });
  assert.equal(roleRes.status, 200);
  assert.equal(roleRes.json.row.key, 'auditor');
  // 重复角色标识 → 409；非法标识 → 400
  assert.equal((await srv.call('POST', '/api/roles', { token: admin, body: { key: 'auditor', name: 'x' } })).status, 409);
  assert.equal((await srv.call('POST', '/api/roles', { token: admin, body: { key: 'a', name: 'x' } })).status, 400);

  // 注册用户并改为审计员角色
  const reg = await srv.call('POST', '/api/auth/register', { body: { email: 'auditor@test.local', password: 'pass1234', display_name: '审计员甲' } });
  assert.equal(reg.status, 200);
  const uid = reg.json.user.id;
  assert.equal((await srv.call('PATCH', '/api/users/' + uid, { token: admin, body: { role: 'auditor' } })).status, 200);
  const auditor = await srv.login('auditor@test.local', 'pass1234');

  // 会话信息反映角色
  const me = await srv.call('GET', '/api/auth/me', { token: auditor });
  assert.equal(me.json.user.role, 'auditor');
  assert.equal(me.json.user.isSuper, false);

  // 有权限的读取全部 200
  assert.equal((await srv.call('GET', '/api/posts', { token: auditor })).status, 200);
  assert.equal((await srv.call('GET', '/api/stats/overview?days=7', { token: auditor })).status, 200);
  assert.equal((await srv.call('GET', '/api/roles', { token: auditor })).status, 200);
  assert.equal((await srv.call('GET', '/api/dashboard', { token: auditor })).status, 200);

  // 越权写入/管理全部 403
  assert.equal((await srv.call('POST', '/api/posts', { token: auditor, body: { title: 'x', content: 'y', category_id: 1 } })).status, 403);
  assert.equal((await srv.call('POST', '/api/stats/demo/clear', { token: auditor })).status, 403);
  assert.equal((await srv.call('GET', '/api/users', { token: auditor })).status, 403);
  assert.equal((await srv.call('PATCH', '/api/roles/1', { token: auditor, body: { permissions: [] } })).status, 403);
  assert.equal((await srv.call('DELETE', '/api/roles/1', { token: auditor })).status, 403);

  // 文章：可读不可删
  const cats = await srv.call('GET', '/api/categories', { token: admin });
  const catId = cats.json.rows[0].id;
  const post = await srv.call('POST', '/api/posts', { token: admin, body: { title: 'RBAC 回归', content: '<p>正文</p>', category_id: catId } });
  assert.equal(post.status, 200);
  const pid = post.json.row.id;
  assert.equal((await srv.call('GET', '/api/posts/' + pid, { token: auditor })).status, 200);
  assert.equal((await srv.call('DELETE', '/api/posts/' + pid, { token: auditor })).status, 403);
  assert.equal((await srv.call('DELETE', '/api/posts/' + pid, { token: admin })).status, 200);

  // 防自降权 / 防删自己 / 不能删超管
  assert.equal((await srv.call('PATCH', '/api/users/1', { token: admin, body: { role: 'viewer' } })).status, 400);
  assert.equal((await srv.call('DELETE', '/api/users/1', { token: admin })).status, 400);

  // 系统角色保护：超管权限不可改、系统角色不可删
  const roles = await srv.call('GET', '/api/roles', { token: admin });
  const adminRole = roles.json.rows.find((r) => r.key === 'admin');
  assert.ok(adminRole, '应存在 admin 系统角色');
  assert.equal((await srv.call('PATCH', '/api/roles/' + adminRole.id, { token: admin, body: { permissions: ['post:view'] } })).status, 400);
  assert.equal((await srv.call('DELETE', '/api/roles/' + adminRole.id, { token: admin })).status, 400);

  // 自定义角色仍有成员时不可删
  assert.equal((await srv.call('DELETE', '/api/roles/' + roleRes.json.row.id, { token: admin })).status, 409);
  // 移除成员后可删
  assert.equal((await srv.call('PATCH', '/api/users/' + uid, { token: admin, body: { role: 'viewer' } })).status, 200);
  assert.equal((await srv.call('DELETE', '/api/roles/' + roleRes.json.row.id, { token: admin })).status, 200);
});

test('默认管理员恢复策略：仅无活跃超管时才创建/恢复', async (t) => {
  const srv = await startServer();
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  // 创建第二个超级管理员
  const reg = await srv.call('POST', '/api/auth/register', { body: { email: 'super2@test.local', password: 'pass1234', display_name: '二号超管' } });
  assert.equal(reg.status, 200);
  const uid2 = reg.json.user.id;
  assert.equal((await srv.call('PATCH', '/api/users/' + uid2, { token: admin, body: { role: 'admin' } })).status, 200);
  const super2 = await srv.login('super2@test.local', 'pass1234');

  // 有活跃超管（super2）时，禁用默认管理员 → 重启后应保持禁用（不被强制恢复）
  assert.equal((await srv.call('PATCH', '/api/users/1', { token: super2, body: { status: 'disabled' } })).status, 200);
  await srv.stop(false);
  let srv2 = await startServer({ dbFile: srv.dbFile });
  const disabledLogin = await srv2.call('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(disabledLogin.status, 403, '有其他活跃超管时，被禁用的默认管理员重启后不应被恢复');

  // 仅剩的超管也禁用后 → 无活跃超管 → 重启恢复默认管理员为可用状态
  assert.equal((await srv2.call('PATCH', '/api/users/' + uid2, { token: super2, body: { status: 'disabled' } })).status, 200);
  await srv2.stop(false);
  srv2 = await startServer({ dbFile: srv.dbFile });
  const revived = await srv2.call('POST', '/api/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } });
  assert.equal(revived.status, 200, '无活跃超管时，重启应恢复默认管理员（保证有路可走）');
  assert.equal(revived.json.user.isSuper, true);

  await srv2.stop();
});

test('RBAC：作者仅能访问自己的内容（postScope）', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = await srv.login(ADMIN.email, ADMIN.password);

  async function createAuthor(email) {
    const reg = await srv.call('POST', '/api/auth/register', { body: { email, password: 'pass1234', display_name: email } });
    assert.equal(reg.status, 200);
    assert.equal((await srv.call('PATCH', '/api/users/' + reg.json.user.id, { token: admin, body: { role: 'author' } })).status, 200);
    return srv.login(email, 'pass1234');
  }
  const a1 = await createAuthor('author1@test.local');
  const a2 = await createAuthor('author2@test.local');

  const cats = await srv.call('GET', '/api/categories', { token: admin });
  const catId = cats.json.rows[0].id;
  const created = await srv.call('POST', '/api/posts', { token: a1, body: { title: '作者一的内容', content: '<p>x</p>', category_id: catId, status: 'published' } });
  assert.equal(created.status, 200);
  // 无发布权限者请求 published → 自动降级 pending
  assert.equal(created.json.row.status, 'pending');
  const pid = created.json.row.id;

  // 作者二看不到、改不了作者一的内容（scope → 404）
  assert.equal((await srv.call('GET', '/api/posts/' + pid, { token: a2 })).status, 404);
  assert.equal((await srv.call('PUT', '/api/posts/' + pid, { token: a2, body: { title: 't', content: 'c', category_id: catId } })).status, 404);
  assert.equal((await srv.call('DELETE', '/api/posts/' + pid, { token: a2 })).status, 404);
  // 列表也只含自己的
  const list2 = await srv.call('GET', '/api/posts', { token: a2 });
  assert.ok(!list2.json.rows.some((r) => r.id === pid), '作者二列表不应包含他人内容');
  const list1 = await srv.call('GET', '/api/posts', { token: a1 });
  assert.ok(list1.json.rows.some((r) => r.id === pid), '作者一应看到自己的内容');
  // 作者一可以修改自己的
  assert.equal((await srv.call('PUT', '/api/posts/' + pid, { token: a1, body: { title: '改过后', content: '<p>x</p>', category_id: catId } })).status, 200);
  // 超管可见全量
  const listAdmin = await srv.call('GET', '/api/posts', { token: admin });
  assert.ok(listAdmin.json.rows.some((r) => r.id === pid), '超管应看到全部内容');
});
