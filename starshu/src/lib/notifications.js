// 站内通知：轻量实现，复用主库连接（better-sqlite3 同步 API）。
// 用途：审核驳回通知、定时发布到点通知等。每条通知针对单个目标用户。

// 创建一条通知并通知目标用户
function notify(db, userId, { type = 'system', title, body = '', refType = null, refId = null }) {
  if (!userId) return null;
  const info = db.prepare(
    `INSERT INTO notifications (user_id, type, title, body, ref_type, ref_id)
     VALUES (?,?,?,?,?,?)`
  ).run(userId, type, title, body, refType, refId);
  return info.lastInsertRowid;
}

// 列出某用户的通知（按时间倒序）。unreadOnly=true 仅取未读。
function listNotifications(db, userId, { unreadOnly = false, limit = 50 } = {}) {
  const where = unreadOnly ? 'AND is_read = 0' : '';
  const rows = db.prepare(
    `SELECT id, type, title, body, ref_type, ref_id, is_read, created_at
     FROM notifications WHERE user_id = ? ${where} ORDER BY id DESC LIMIT ?`
  ).all(userId, limit);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
  return { rows, unread };
}

// 标记已读：传入 ids 数组标记指定项；传入 all=true 标记该用户全部。
function markRead(db, userId, { ids = null, all = false } = {}) {
  if (all) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
    return;
  }
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids);
  }
}

module.exports = { notify, listNotifications, markRead };
