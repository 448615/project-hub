// 认证密码链路回归测试（登录 / 弱口令判定 / 改密）。
//
// 背景：S-02 把密码哈希改成异步后，登录、/me、改密这三条链路全都受影响。
// 此前测试里**完全没有**改密与 weakPassword 的覆盖，等于改了最敏感的代码却无人看守，
// 所以这里补上完整回归：
//   - 默认口令登录时 weakPassword 必须为 true（前端靠它弹"请立即改密"）；
//   - 改密的每个校验分支（原密码错 / 太短 / 与原型相同）都要拦住；
//   - 改密成功后：新密码能登录、旧密码登不进、weakPassword 变 false。
// 全部通过真实 HTTP 调用验证，不 mock，确保测的是线上真实路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };
const NEW_PWD = 'NewPass@2026';

test('密码链路：弱口令判定 + 改密 + 改密后登录', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());

  // 1) 默认口令登录：成功，且被判定为弱口令
  const first = await srv.call('POST', '/api/auth/login', { body: ADMIN });
  assert.equal(first.status, 200, '默认管理员必须能登录');
  assert.equal(first.json.weakPassword, true, '仍用默认口令时必须提示 weakPassword=true');
  const token = first.json.token;

  // 2) 改密校验分支：原密码错 / 新密码太短 / 新旧相同 —— 都必须 400
  const wrongOld = await srv.call('POST', '/api/auth/password', {
    token, body: { oldPassword: 'not-the-password', newPassword: NEW_PWD },
  });
  assert.equal(wrongOld.status, 400);
  assert.match(wrongOld.json.error, /原密码/);

  const tooShort = await srv.call('POST', '/api/auth/password', {
    token, body: { oldPassword: ADMIN.password, newPassword: 'short' },
  });
  assert.equal(tooShort.status, 400);
  assert.match(tooShort.json.error, /8 位/);

  const samePwd = await srv.call('POST', '/api/auth/password', {
    token, body: { oldPassword: ADMIN.password, newPassword: ADMIN.password },
  });
  assert.equal(samePwd.status, 400);
  assert.match(samePwd.json.error, /不能与原密码相同/);

  // 3) 未登录不能改密（token 是必需的）
  const noAuth = await srv.call('POST', '/api/auth/password', {
    body: { oldPassword: ADMIN.password, newPassword: NEW_PWD },
  });
  assert.equal(noAuth.status, 401);

  // 4) 正常改密：200
  const changed = await srv.call('POST', '/api/auth/password', {
    token, body: { oldPassword: ADMIN.password, newPassword: NEW_PWD },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.ok, true);

  // 5) 改密后：新密码能登录、旧密码登不进、weakPassword 变 false
  const relogin = await srv.call('POST', '/api/auth/login', {
    body: { email: ADMIN.email, password: NEW_PWD },
  });
  assert.equal(relogin.status, 200, '新密码必须能登录');
  assert.equal(relogin.json.weakPassword, false, '改密后不应再提示弱口令');

  const oldPwdLogin = await srv.call('POST', '/api/auth/login', { body: ADMIN });
  assert.equal(oldPwdLogin.status, 401, '旧密码必须失效');

  // 6) /me 也要反映最新状态（这条走的是另一段 verifyPassword）
  const me = await srv.call('GET', '/api/auth/me', { token: relogin.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.weakPassword, false);
});
