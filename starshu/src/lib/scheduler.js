// 定时发布调度器：周期性扫描「计划中(scheduled)」且到点(scheduled_at <= now)的内容，自动翻转为「已发布」。
// 使用主库同步连接，直接操作 SQLite；翻转后向作者推送一条站内通知。
const { notify } = require('./notifications');

// 执行一次扫描并返回本次发布的篇数
function runScheduler(db) {
  const due = db.prepare(
    `SELECT id, title, author_id FROM posts
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')`
  ).all();
  if (!due.length) return 0;
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      db.prepare(
        "UPDATE posts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(p.id);
      notify(db, p.author_id, {
        type: 'publish',
        title: '内容已按计划发布',
        body: `《${p.title}》已于计划时间自动发布。`,
        refType: 'post',
        refId: p.id,
      });
    }
    return rows.length;
  });
  return tx(due);
}

// 启动调度器：立即执行一次，之后每 intervalMs 执行一次，返回定时器句柄。
// unref：定时器不阻止进程退出（优雅停机时不会被 setInterval 吊住）。
let timer = null;
function startScheduler(db, intervalMs = 30000) {
  runScheduler(db); // 启动即扫一次，避免重启后过期任务堆积
  timer = setInterval(() => {
    try { runScheduler(db); } catch (e) { /* 调度失败不应中断主进程 */ }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

// 调度器运行状态（供 /api/health 就绪探测）
function schedulerStatus() {
  return timer ? 'running' : 'stopped';
}

module.exports = { runScheduler, startScheduler, schedulerStatus };
