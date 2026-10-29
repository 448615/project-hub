// 轻量 Schema 迁移机制（P2-1）：把「结构演进」从初始化代码里剥离，幂等且可追溯。
//
// 机制：
//  - migrations/ 目录存放编号 SQL 文件（001_xxx.sql、002_xxx.sql…），
//    文件名排序即执行顺序，每个文件一个逻辑变更；
//  - _migrations(name, applied_at) 表记录已应用的迁移，重启不重放；
//  - 每个迁移在单事务内执行（db.transaction，原子：SQL 失败则整体回滚不记录）；
//  - 旧库兼容：迁移机制上线前，部分字段已通过 db.js 内联 ALTER 拿到。
//    此时执行对应迁移会报 "duplicate column name"——按「已应用」记录并放行，
//    保证新旧库都能无缝过渡；其他错误向上抛（fail fast，暴露真实问题）。
//
// 与现有基线的关系：db.js 里的 CREATE TABLE IF NOT EXISTS 保留为「建表基线」
// （幂等，且自愈重建空库时依赖它），列级演进统一走本机制。
const path = require('path');
const fs = require('fs');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

// 执行所有未应用的迁移。返回 { applied: string[], skipped: number }。
function runMigrations(db, dir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  if (!fs.existsSync(dir)) return { applied: [], skipped: 0 };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  let skipped = 0;
  for (const f of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(f)) { skipped++; continue; }
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    });
    try {
      apply();
      applied.push(f);
      console.log(`[migrate] 已应用 ${f}`);
    } catch (e) {
      if (/duplicate column name/i.test(e.message)) {
        // 旧库已通过内联 ALTER 获得该字段：记录为已应用，不阻断启动
        db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(f);
        skipped++;
        console.log(`[migrate] ${f} 目标字段已存在，按已应用处理`);
      } else {
        throw e;
      }
    }
  }
  return { applied, skipped };
}

module.exports = { runMigrations, MIGRATIONS_DIR };
