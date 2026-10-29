// 迁移机制单测（P2-1）：编号执行、幂等重放、旧库无缝接管、失败 fail-fast。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/migrate.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cms-migrate-'));
}

// 最小 posts 表（模拟 db.js 建表基线之后的形态）
function freshDb(dir) {
  const db = new Database(path.join(dir, 't.db'));
  db.exec('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)');
  return db;
}

function cols(db) {
  return db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
}

test('迁移：全新库按序应用并记录，字段到位', () => {
  const dir = tmpdir();
  const mig = path.join(dir, 'migrations');
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '001_a.sql'), 'ALTER TABLE posts ADD COLUMN a TEXT;');
  fs.writeFileSync(path.join(mig, '002_b.sql'), 'ALTER TABLE posts ADD COLUMN b TEXT;');
  const db = freshDb(dir);
  const r = runMigrations(db, mig);
  assert.deepEqual(r.applied, ['001_a.sql', '002_b.sql']);
  assert.ok(cols(db).includes('a') && cols(db).includes('b'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _migrations').get().c, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：重复执行不重放（幂等）', () => {
  const dir = tmpdir();
  const mig = path.join(dir, 'migrations');
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '001_a.sql'), 'ALTER TABLE posts ADD COLUMN a TEXT;');
  const db = freshDb(dir);
  runMigrations(db, mig);
  const r2 = runMigrations(db, mig); // 第二次：全部跳过
  assert.deepEqual(r2.applied, []);
  assert.equal(r2.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _migrations').get().c, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：旧库字段已存在（无 _migrations 记录）按已应用无缝接管', () => {
  // 模拟迁移机制上线前的线上库：字段已通过内联 ALTER 拿到，但从未记录迁移
  const dir = tmpdir();
  const db = freshDb(dir);
  db.prepare('ALTER TABLE posts ADD COLUMN a TEXT').run(); // 旧路径拿字段
  const mig = path.join(dir, 'migrations');
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '001_a.sql'), 'ALTER TABLE posts ADD COLUMN a TEXT;');
  const r = runMigrations(db, mig); // 不得抛错
  assert.deepEqual(r.applied, []);
  assert.equal(r.skipped, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _migrations').get().c, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：真实 SQL 错误向上抛（fail fast），且不记录', () => {
  const dir = tmpdir();
  const mig = path.join(dir, 'migrations');
  fs.mkdirSync(mig);
  fs.writeFileSync(path.join(mig, '001_bad.sql'), 'ALTER TABLE not_exist_table ADD COLUMN x TEXT;');
  const db = freshDb(dir);
  assert.throws(() => runMigrations(db, mig), /no such table/i);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM _migrations').get().c, 0, '失败迁移不得记录');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('迁移：仓库 migrations/ 目录包含既定两笔且可对基线库执行', () => {
  // 用 db.js 的建表基线形态（完整 posts 表）验证仓库内迁移文件可执行
  const dir = tmpdir();
  const db = new Database(path.join(dir, 't.db'));
  db.exec(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
  )`);
  const r = runMigrations(db); // 默认目录 = 仓库 migrations/
  assert.deepEqual(r.applied, ['001_posts_scheduled_at.sql', '002_posts_reject_reason.sql']);
  assert.ok(cols(db).includes('scheduled_at') && cols(db).includes('reject_reason'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
