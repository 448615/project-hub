// 密码哈希工具回归测试（对应 S-02：scryptSync → 异步）
//
// 为什么值得单独测：这是**破坏性改动** —— hashPassword / verifyPassword 从同步
// 变成了 async，一旦漏了某个 await，密码校验就会「永远返回 true 的 Promise」，
// 所有登录都变成"密码错误"或者更糟的"谁都能进"。所以这里锁三件事：
//   1) 哈希格式没变（库里已有账号必须能继续登录，不需要迁移）；
//   2) 校验逻辑的每个分支（对/错/脏数据）都符合预期；
//   3) 关键收益真的拿到了 —— 计算期间主线程没有被堵住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, hashPasswordSync } from '../pwd.js';

const PWD = 'Admin@123456';

test('哈希格式：盐:密钥，长度与旧版一致', async () => {
  const stored = await hashPassword(PWD);
  const parts = stored.split(':');
  assert.equal(parts.length, 2, '必须是「盐:密钥」两段');
  assert.equal(parts[0].length, 32, '盐是 16 字节 → 32 个 hex 字符');
  assert.equal(parts[1].length, 128, '密钥是 64 字节 → 128 个 hex 字符');
  assert.match(stored, /^[0-9a-f]{32}:[0-9a-f]{128}$/, '只允许 hex 字符');
});

test('校验：正确密码通过，错误密码失败', async () => {
  const stored = await hashPassword(PWD);
  assert.equal(await verifyPassword(PWD, stored), true);
  assert.equal(await verifyPassword('Admin@1234567', stored), false, '差一个字符也必须失败');
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword(PWD.toUpperCase(), stored), false, '大小写敏感');
});

test('校验：脏数据一律判失败，且不抛异常', async () => {
  // 这几类输入都可能来自历史库或手工改库，必须是「返回 false」而不是「抛错 500」
  for (const bad of [null, undefined, '', 'no-colon-here', ':', 'abc:', ':abc', 'salt:zzzz', 'salt:']) {
    assert.equal(await verifyPassword(PWD, bad), false, `脏数据 ${JSON.stringify(bad)} 应判失败`);
  }
});

test('兼容性：旧版同步生成的哈希，异步校验必须通过（已有账号不用迁移）', async () => {
  // 模拟「改动前」库里存的哈希：用 scryptSync 生成，格式完全相同
  const salt = crypto.randomBytes(16).toString('hex');
  const legacy = `${salt}:${crypto.scryptSync(PWD, salt, 64).toString('hex')}`;
  assert.equal(await verifyPassword(PWD, legacy), true, '旧哈希必须仍然可用');
  assert.equal(await verifyPassword('wrong-pass', legacy), false);
});

test('兼容性：启动用的同步版与业务用的异步版互相认', async () => {
  // db.js 播种管理员用 hashPasswordSync，登录走异步 verifyPassword，
  // 两者必须能互通，否则默认管理员根本登不进去
  const seeded = hashPasswordSync(PWD);
  assert.equal(await verifyPassword(PWD, seeded), true);
  const asyncHash = await hashPassword(PWD);
  assert.equal(await verifyPassword(PWD, asyncHash), true);
});

test('同一个密码两次哈希结果不同（盐随机）', async () => {
  const a = await hashPassword(PWD);
  const b = await hashPassword(PWD);
  assert.notEqual(a, b, '盐必须每次随机，否则相同密码哈希相同，可被批量比对');
  assert.equal(await verifyPassword(PWD, a), true);
  assert.equal(await verifyPassword(PWD, b), true);
});

test('事件循环不被阻塞：并发哈希期间定时器照常触发（S-02 的核心断言）', async () => {
  // 做法：开一个 10ms 的定时器，同时并发算 6 个哈希。
  //  - 异步版：计算跑在线程池，主线程立刻空闲 → 定时器几乎准时触发；
  //  - 同步版：第一个哈希就把主线程占了 50~100ms → 定时器被整体推迟。
  // 判据用「定时器延迟 < 总耗时的一半」，避免不同机器性能差异导致的误判。
  const t0 = Date.now();
  let timerAt = null;
  const timer = new Promise((resolve) => {
    setTimeout(() => { timerAt = Date.now() - t0; resolve(); }, 10);
  });
  await Promise.all(Array.from({ length: 6 }, () => hashPassword(PWD)));
  const total = Date.now() - t0;
  await timer;

  assert.ok(timerAt !== null, '定时器必须触发');
  assert.ok(
    timerAt < total * 0.5,
    `定时器应远早于全部哈希完成：定时器 ${timerAt}ms / 总耗时 ${total}ms（比值应 < 0.5；若接近 1 说明仍在阻塞主线程）`
  );
});
