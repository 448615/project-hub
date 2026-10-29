// 数据库连接参数回归测试（对应 S-03：未设 busy_timeout）
//
// 为什么必须锁住：busy_timeout 是「偶发 500」的根因修复。一旦有人改 db.js 时
// 顺手删掉这行 pragma，症状是「偶尔保存失败、日志里 database is locked」，
// 极难复现、极难定位。所以用测试把「打开数据库后这两个 pragma 必须生效」钉死。
//
// 隔离方式：DB_FILE 指向临时目录，绝不碰开发库 data/starshu.db。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('打开数据库后 WAL 与 busy_timeout 均已生效', async (t) => {
  // 必须先设环境变量，再加载 db.js —— db.js 在 require 的那一刻就打开库了
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starshu-dbcfg-'));
  process.env.DB_FILE = path.join(dir, 'test.db');

  const { default: db } = await import('../db.js');
  t.after(() => {
    try { db.close(); } catch (e) { /* 已关闭 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  });

  // WAL：允许「一写多读」并发，是 busy_timeout 起作用的前提
  const journal = db.pragma('journal_mode', { simple: true });
  assert.equal(String(journal).toLowerCase(), 'wal');

  // busy_timeout：遇锁等待 5000ms 而不是立即 SQLITE_BUSY
  const timeout = db.pragma('busy_timeout', { simple: true });
  assert.equal(Number(timeout), 5000, 'busy_timeout 应为 5000ms');

  // 外键约束不能被顺带改掉（既有行为，一并锁住）
  const fk = db.pragma('foreign_keys', { simple: true });
  assert.equal(Number(fk), 1, 'foreign_keys 应为 ON');
});
