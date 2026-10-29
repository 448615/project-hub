// 请求日志中间件单测（P2-2）：降噪策略与输出格式。
// 用假 req/res 直接驱动中间件，不起服务；console.log 打桩捕获输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import requestLog from '../src/lib/requestLog.js';

function drive({ method = 'GET', path = '/api/posts', status = 200 }) {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    // 模拟 Express：originalUrl 保留原始路径；路由挂载会把 req.url 改写为
    // 挂载内相对路径（/api/track 进入 router 后变成 '/'）。中间件必须在
    // 入口处取证，否则 finish 时读到的是改写后的路径。
    const req = { method, originalUrl: path, url: path };
    const res = new EventEmitter();
    res.statusCode = status;
    let nextCalled = false;
    requestLog(req, res, () => { nextCalled = true; });
    req.url = '/'; // 路由改写发生在 next() 之后、finish 之前
    res.emit('finish');
    assert.ok(nextCalled, '中间件必须调用 next()');
  } finally {
    console.log = origLog;
  }
  return logs;
}

test('请求日志：路由改写 req.url 后仍记录原始路径（回归）', () => {
  // 曾因在 finish 里读 req.path 导致：成功的 /api/* 被漏记、失败请求记错路径
  const logs = drive({ method: 'POST', path: '/api/track', status: 400 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[req\] POST \/api\/track 400 /);
  const ok = drive({ method: 'GET', path: '/api/dashboard', status: 200 });
  assert.equal(ok.length, 1);
  assert.match(ok[0], /^\[req\] GET \/api\/dashboard 200 /);
});

test('请求日志：/api/* 请求记录单行（方法/路径/状态/耗时）', () => {
  const logs = drive({ path: '/api/posts', status: 200 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[req\] GET \/api\/posts 200 \d+\.\d+ms$/);
});

test('请求日志：/api/track 成功不记（高频信标降噪）', () => {
  assert.equal(drive({ path: '/api/track', status: 200 }).length, 0);
});

test('请求日志：/api/track 失败仍记（便于发现刷量/滥用）', () => {
  const logs = drive({ path: '/api/track', status: 429 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /429/);
});

test('请求日志：静态资源成功不记、失败记', () => {
  assert.equal(drive({ path: '/js/main.js', status: 200 }).length, 0);
  assert.equal(drive({ path: '/js/main.js', status: 304 }).length, 0);
  assert.equal(drive({ path: '/js/missing.js', status: 404 }).length, 1);
});

test('请求日志：非 API 的 5xx 也记录', () => {
  const logs = drive({ method: 'POST', path: '/workbench/', status: 500 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[req\] POST \/workbench\/ 500 /);
});
