// 冒烟测试（依赖无关）：使用 Node 内置 node:test + 全局 fetch，
// 本地启动 Express 应用并覆盖核心链路。无需 supertest / jest。
// 注意：DB_FILE 必须在 import server.js（及其依赖的 db.js）之前设置，
// 因此使用动态 import——用例跑在临时 SQLite 库上，不触碰开发库 data/starshu.db。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-smoke-'));
process.env.DB_FILE = path.join(tmpDir, 'smoke.db');
const { default: app } = await import('../server.js');

let server;
let base;
const ADMIN = { email: 'admin@cms.local', password: 'Admin@123456' };

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
});

async function jget(path, token) {
  const res = await fetch(base + path, token ? { headers: { 'X-Auth-Token': token } } : {});
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, path, token, body) {
  const headers = { 'X-Auth-Token': token };
  let payload;
  if (body instanceof FormData) { payload = body; } else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('健康检查', async () => {
  const { status, body } = await jget('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.version.includes('jwt-xauth'));
  // P2-2 扩展字段：DB 连通 / 运行时长 / 调度器状态
  assert.equal(body.db, 'ok');
  assert.ok(typeof body.uptime === 'number' && body.uptime >= 0);
  assert.ok(['running', 'stopped'].includes(body.scheduler));
});

test('登录获取 token', async () => {
  const { status, body } = await jsend('POST', '/api/auth/login', null, ADMIN);
  assert.equal(status, 200);
  assert.ok(body.token, '登录应返回 token');
});

let token;
test('错误 token → 401', async () => {
  const { status } = await jget('/api/dashboard', 'deadbeef');
  assert.equal(status, 401);
});

test('看板 / 列表 / 创建 / 删除 全链路', async () => {
  const login = await jsend('POST', '/api/auth/login', null, ADMIN);
  token = login.body.token;
  assert.ok(token);

  const dash = await jget('/api/dashboard?range=30', token);
  assert.equal(dash.status, 200);
  assert.ok(Array.isArray(dash.body.byStatus));
  assert.ok(Array.isArray(dash.body.recent), 'dashboard 应附带 recent，免去额外列表请求');

  const list = await jget('/api/posts?page=1&pageSize=5', token);
  assert.equal(list.status, 200);
  assert.ok(!('content' in (list.body.rows[0] || {})), '列表不应包含 content 字段');

  // 需要一个分类
  const cats = await jget('/api/categories', token);
  assert.equal(cats.status, 200);
  const catId = cats.body.rows[0].id;

  const created = await jsend('POST', '/api/posts', token, {
    title: '冒烟测试文章', content: '正文内容', category_id: catId, status: 'published',
  });
  assert.equal(created.status, 200);
  const pid = created.body.row.id;

  const detail = await jget('/api/posts/' + pid, token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.row.title, '冒烟测试文章');

  const del = await jsend('DELETE', '/api/posts/' + pid, token);
  assert.equal(del.status, 200);

  // 批量删除（空 ids 应 400）
  const batchBad = await jsend('PATCH', '/api/posts/batch', token, { ids: [], action: 'delete' });
  assert.equal(batchBad.status, 400);
});

test('分类重复 slug → 409', async () => {
  const cats = await jget('/api/categories', token);
  const existing = cats.body.rows[0];
  const dup = await jsend('POST', '/api/categories', token, { name: existing.name + '_x', slug: existing.slug });
  assert.equal(dup.status, 409, '重复 slug 应返回 409');
});

test('导出 CSV', async () => {
  const res = await fetch(base + '/api/posts/export', { headers: { 'X-Auth-Token': token } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /标题|ID/);
});

test('媒体上传 + 删除', async () => {
  // 1x1 PNG
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f4d0000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 't.png');
  const up = await jsend('POST', '/api/media', token, fd);
  assert.equal(up.status, 200, '上传应成功');
  const mid = up.body.row.id;
  const del = await jsend('DELETE', '/api/media/' + mid, token);
  assert.equal(del.status, 200);
});

test('退出登录（无状态：仅约定）', async () => {
  const { status } = await jsend('POST', '/api/auth/logout', token);
  assert.equal(status, 200);
});
