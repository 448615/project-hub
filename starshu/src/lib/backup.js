// 每日自动数据库备份（P1 数据安全基线）。
//  - 使用 better-sqlite3 的在线备份 API（db.backup），WAL 模式下也能得到一致性快照；
//  - 备份文件落在主库同级的 backups/ 目录（随 DB_FILE 走，测试/运维环境自动隔离）；
//  - 每天仅一份（按日期命名，已存在则跳过），仅保留最近 KEEP 份，防止磁盘无限增长；
//  - 全过程异步、不阻塞启动；任何失败仅告警，绝不影响服务可用性。
const path = require('path');
const fs = require('fs');

const KEEP = 7;
const NAME_RE = /^starshu-\d{4}-\d{2}-\d{2}\.db$/;

function runBackup(db) {
  try {
    const dbPath = db && db.name; // better-sqlite3 暴露的主库文件路径
    if (!dbPath || dbPath === ':memory:') return Promise.resolve();
    const dir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `starshu-${new Date().toISOString().slice(0, 10)}.db`);
    if (fs.existsSync(dest)) return Promise.resolve(); // 今日已备份
    return db.backup(dest).then(() => {
      // 备份完成后主文件已自洽（数据全部落盘），清理 WAL 附属文件残留，
      // 保证「只拷贝 .db 单文件即可完整恢复」
      for (const suffix of ['-wal', '-shm']) {
        try { if (fs.existsSync(dest + suffix)) fs.unlinkSync(dest + suffix); } catch (e) { /* 忽略 */ }
      }
      // 只保留最近 KEEP 份
      const files = fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ }
      }
      console.log(`[backup] 已生成每日备份 ${path.basename(dest)}（保留最近 ${KEEP} 份）`);
    }).catch((e) => {
      console.error('[backup] 备份失败（不影响服务）:', e.message);
    });
  } catch (e) {
    console.error('[backup] 备份初始化失败（不影响服务）:', e.message);
    return Promise.resolve();
  }
}

module.exports = { runBackup };
