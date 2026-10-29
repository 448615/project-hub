// /api/health 暴露面回归测试（S-05）。
//
// 健康检查是**匿名可访问**的，任何放进去的字段都等于公开信息。
// 这里锁住的是「生产环境不透露密钥来源」——secretSrc 会说明会话密钥来自
// 环境变量 / 文件 / 临时生成，攻击者据此可以挑攻击策略（比如盯着临时密钥等重启）。
//
// 同时确认「该留的都还在」：就绪探测依赖 ok / db / uptime / scheduler，
// 别为了藏一个字段把这几个一起弄丢，那会让监控直接失效。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

test('生产环境：不返回密钥来源，但就绪探测字段齐全', async (t) => {
  // 枢纽拉起子应用时正是注入 NODE_ENV=production，这里还原该路径
  const srv = await startServer({ env: { NODE_ENV: 'production' } });
  t.after(() => srv.stop());

  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200, '健康检查必须匿名可访问');
  assert.equal(r.json.ok, true);

  // 核心断言：密钥来源不得出现在生产响应里
  assert.equal('secretSrc' in r.json, false, '生产环境不得返回 secretSrc');

  // 该留的都要在，否则监控/就绪探测会失灵
  for (const k of ['version', 'auth', 'db', 'uptime', 'scheduler']) {
    assert.ok(k in r.json, `生产环境也必须保留 ${k} 字段`);
  }
  assert.equal(r.json.db, 'ok', '数据库连通性必须如实反映');
});

test('非生产环境：保留密钥来源，便于本地排查「密钥从哪来」', async (t) => {
  // 显式置空 NODE_ENV，避免受运行测试的机器环境影响（本地开发即此形态）
  const srv = await startServer({ env: { NODE_ENV: 'development' } });
  t.after(() => srv.stop());

  const r = await srv.call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.ok('secretSrc' in r.json, '开发环境应返回 secretSrc');
  assert.ok(
    ['env', 'file', 'generated', 'ephemeral'].includes(r.json.secretSrc),
    `secretSrc 取值应为已知枚举，实际=${r.json.secretSrc}`
  );
});
