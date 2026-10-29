// storage-guard 纯逻辑测试（node --test）
//
// 只测不依赖 DOM / localStorage 的部分：版本判定、类型扫描、音乐库检查、修复计划。
// 浏览器接线（提示条、真实 IndexedDB）另由 tests/test_workbench_guard.py 里的静态契约
// 检查与人工实机验证覆盖——这里刻意不引入 jsdom 之类的依赖，保持零安装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../www/storage-guard.js');

// ---------------------------------------------------------------- 常量契约
test('版本号与元数据键：键名必须落在应用导入白名单的前缀内', () => {
  assert.equal(guard.SCHEMA_VERSION, 2);
  assert.equal(guard.META_KEY, 'hm_settingsMeta');
  assert.equal(guard.VERSION_FIELD, 'schemaVersion');
  // 应用导入备份时的白名单判定是 g.startsWith(前缀.slice(0,-1))，settings → "setting"。
  // 若这里改成 hm_schemaVersion，备份恢复后版本号会被丢弃——这条断言就是防那次改动。
  assert.ok(guard.META_KEY.startsWith('hm_setting'),
    '元数据键必须以 hm_setting 开头，否则不被导入白名单接受');
});

// ---------------------------------------------------------------- 版本判定
test('planUpgrade：无版本 → 补标记', () => {
  for (const v of [undefined, null, '']) {
    const p = guard.planUpgrade(v, 2);
    assert.equal(p.action, 'stamp');
    assert.equal(p.from, null);
    assert.equal(p.to, 2);
  }
});

test('planUpgrade：同版本 → 什么都不做', () => {
  assert.equal(guard.planUpgrade(2, 2).action, 'noop');
  assert.equal(guard.planUpgrade('2', 2).action, 'noop', '字符串数字也应被接受');
});

test('planUpgrade：低版本 → 逐级迁移', () => {
  const p = guard.planUpgrade(1, 2);
  assert.equal(p.action, 'migrate');
  assert.deepEqual(p.steps, [1]);
  const p3 = guard.planUpgrade(1, 3);
  assert.deepEqual(p3.steps, [1, 2], '必须逐级，不能一步跳到最新');
});

test('planUpgrade：高版本 → 只读，绝不降级写回', () => {
  const p = guard.planUpgrade(3, 2);
  assert.equal(p.action, 'readonly');
  assert.equal(p.from, 3);
  assert.deepEqual(p.steps, [], 'readonly 不允许产生迁移步骤');
});

test('planUpgrade：非法值按无版本处理，并标记 invalid', () => {
  for (const bad of ['abc', -1, 0, 1.5, {}, []]) {
    const p = guard.planUpgrade(bad, 2);
    assert.equal(p.action, 'stamp', `非法值 ${JSON.stringify(bad)} 应补标记而不是崩`);
    assert.equal(p.invalid, true);
  }
});

// ---------------------------------------------------------------- 类型扫描
const E = (key, value) => ({ key, value });

test('inspectEntries：健康数据不报错', () => {
  const issues = guard.inspectEntries([
    E('hm_todos', '[{"text":"a"}]'),
    E('hm_settings', '{"waterGoal":2000}'),
    E('hm_musicVolume', '0.5'),
    E('hm_darkMode', 'false')
  ]);
  assert.deepEqual(issues, []);
});

test('inspectEntries：内容损坏 → unparsable', () => {
  const issues = guard.inspectEntries([E('hm_todos', '[{"text":')]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'unparsable');
  assert.equal(issues[0].key, 'hm_todos');
  assert.ok(issues[0].raw.length > 0, '必须带回原文，供修复时备份');
});

test('inspectEntries：类型不符 → wrong-type', () => {
  const a = guard.inspectEntries([E('hm_todos', '{"not":"array"}')]);
  assert.equal(a[0].kind, 'wrong-type');
  assert.match(a[0].detail, /应为数组/);

  const b = guard.inspectEntries([E('hm_settings', '[]')]);
  assert.equal(b[0].kind, 'wrong-type');
  assert.match(b[0].detail, /应为对象/);
});

test('inspectEntries：未登记 / 非本应用 / 守卫自身键一律不判', () => {
  const issues = guard.inspectEntries([
    E('hm_futureFeature', '这不是 JSON'),        // 应用将来新增的键
    E('otherAppKey', '乱码'),
    E(guard.META_KEY, '乱码'),                    // 守卫元数据坏了不该刷告警
    E('hm_guard_backup_hm_todos', '乱码')         // 守卫自己的备份
  ]);
  assert.deepEqual(issues, [], '守卫不能对不认识的数据指手画脚');
});

test('inspectEntries：脏输入不抛异常', () => {
  assert.deepEqual(guard.inspectEntries(null), []);
  assert.deepEqual(guard.inspectEntries([null, undefined, 42, { key: 1 }]), []);
});

test('inspectEntries：null 值不被当成对象', () => {
  const issues = guard.inspectEntries([E('hm_reviews', 'null')]);
  assert.equal(issues[0].kind, 'wrong-type');
});

// ---------------------------------------------------------------- 音乐库
test('inspectMusic：无记录 / 空列表 = 正常', () => {
  assert.deepEqual(guard.inspectMusic(null), []);
  assert.deepEqual(guard.inspectMusic(undefined), []);
  assert.deepEqual(guard.inspectMusic({ id: 'list', name: 'playlist', list: [] }), []);
});

test('inspectMusic：data 是文本 → 命中历史损坏形态', () => {
  const issues = guard.inspectMusic({ list: [{ name: 'song.mp3', data: '<!DOCTYPE html><html>...' }] });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'music-corrupt');
  assert.match(issues[0].detail, /song\.mp3/);
});

test('inspectMusic：二进制 data / blob 型 file 都算正常', () => {
  assert.deepEqual(guard.inspectMusic({ list: [{ name: 'a', data: new Uint8Array([1, 2, 3]) }] }), []);
  assert.deepEqual(guard.inspectMusic({ list: [{ name: 'a', data: new ArrayBuffer(8) }] }), []);
  assert.deepEqual(guard.inspectMusic({ list: [{ name: 'a', file: { size: 10, type: 'audio/mpeg' } }] }), []);
});

test('inspectMusic：缺数据 / 缺名字 → 分别报出', () => {
  const miss = guard.inspectMusic({ list: [{ name: 'a' }] });
  assert.equal(miss[0].kind, 'music-missing');

  const noName = guard.inspectMusic({ list: [{ data: new Uint8Array([1]) }] });
  assert.equal(noName[0].kind, 'music-entry');
  assert.match(noName[0].detail, /缺少文件名/);
});

test('inspectMusic：结构不对 → music-shape（单条 issue，不逐项刷屏）', () => {
  assert.equal(guard.inspectMusic({ list: 'oops' })[0].kind, 'music-shape');
  assert.equal(guard.inspectMusic('oops')[0].kind, 'music-shape');
});

// ---------------------------------------------------------------- 修复计划
test('repairPlan：损坏键进删除列表，且带上原文备份', () => {
  const entries = [E('hm_todos', '[]'), E('hm_books', '坏掉了')];
  const issues = guard.inspectEntries(entries);
  const plan = guard.repairPlan(issues, entries);
  assert.deepEqual(plan.remove, ['hm_books']);
  assert.equal(plan.backup['hm_books'], '坏掉了');
  assert.equal(plan.musicReset, false);
});

test('repairPlan：健康键绝不出现在删除列表', () => {
  const entries = [E('hm_todos', '[{"text":"a"}]'), E('hm_reviews', '不是JSON')];
  const plan = guard.repairPlan(guard.inspectEntries(entries), entries);
  assert.equal(plan.remove.includes('hm_todos'), false, '健康数据被误删是不可接受的回归');
  assert.deepEqual(plan.remove, ['hm_reviews']);
});

test('repairPlan：音乐类问题置 musicReset 且不误删 localStorage 键', () => {
  const plan = guard.repairPlan([{ kind: 'music-corrupt', name: 'x' }], []);
  assert.equal(plan.musicReset, true);
  assert.deepEqual(plan.remove, []);
});

test('repairPlan：空入参不抛异常', () => {
  assert.deepEqual(guard.repairPlan(null, null), { remove: [], backup: {}, musicReset: false });
});

// ---------------------------------------------------------------- 不变量
test('纯函数不改写入参（守卫不能成为新的数据破坏源）', () => {
  const entries = [E('hm_todos', '{}'), E('hm_books', '[1,2]')];
  const snapshot = JSON.stringify(entries);
  guard.repairPlan(guard.inspectEntries(entries), entries);
  assert.equal(JSON.stringify(entries), snapshot);
});
