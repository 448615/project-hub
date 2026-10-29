// 内容（posts）路由：/api/posts
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const { parseTags, slugify, canManageAllPosts, postScope } = require('../lib/helpers');
const { STATUS_LABEL } = require('../shared/maps');
const { sanitizeHtml } = require('../lib/sanitize');
const { notify } = require('../lib/notifications');

// 列表（排除 content 字段以降低带宽）
router.get('/', authMiddleware, requirePermission('post:view'), (req, res) => {
  const { q, status, category_id, tag, sort = 'created_at', order = 'desc', page = 1, pageSize = 10 } = req.query;
  const where = ['p.is_deleted = 0'];
  const params = [];
  if (!canManageAllPosts(req.user)) { where.push('p.author_id = ?'); params.push(req.user.uid); }
  if (q) { where.push('(p.title LIKE ? OR p.summary LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
  if (tag) { where.push("p.tag_ids LIKE ?"); params.push(`%"${tag}"%`); }

  const whereSql = 'WHERE ' + where.join(' AND ');
  const allowedSort = ['created_at', 'updated_at', 'views', 'title'];
  const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) c FROM posts p ${whereSql}`).get(...params).c;
  const ps = Math.max(1, Math.min(parseInt(pageSize) || 10, 100)); // 硬上限，防滥用/大体积返回
  const offset = (Math.max(1, parseInt(page)) - 1) * ps;
  const rows = db.prepare(
    `SELECT p.id,p.type,p.title,p.slug,p.summary,p.cover_image,p.category_id,p.author_id,p.tag_ids,p.status,p.views,p.created_at,p.updated_at,p.published_at,p.scheduled_at,p.reject_reason,
            c.name AS category_name, u.display_name AS author_name
     FROM posts p LEFT JOIN categories c ON p.category_id=c.id
     LEFT JOIN users u ON p.author_id=u.id
     ${whereSql} ORDER BY p.${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ).all(...params, ps, offset);
  rows.forEach((r) => { r.tag_ids = parseTags(r.tag_ids); });
  res.json({ rows, total, page: parseInt(page), pageSize: ps });
});

// 导出 CSV（必须位于 /:id 之前，避免被 :id 捕获）
router.get('/export', authMiddleware, requirePermission('post:view'), (req, res) => {
  const { q, status, category_id } = req.query;
  const where = ['p.is_deleted = 0'];
  const params = [];
  if (!canManageAllPosts(req.user)) { where.push('p.author_id = ?'); params.push(req.user.uid); }
  if (q) { where.push('p.title LIKE ?'); params.push(`%${q}%`); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  if (category_id) { where.push('p.category_id = ?'); params.push(category_id); }
  const rows = db.prepare(
    `SELECT p.id,p.title,p.status,p.views,p.created_at,p.scheduled_at,c.name AS category FROM posts p
     LEFT JOIN categories c ON p.category_id=c.id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC`
  ).all(...params);
  const header = ['ID', '标题', '状态', '浏览量', '分类', '创建时间', '计划发布时间'];
  const escape = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(escape).join(',')];
  rows.forEach((r) => lines.push([r.id, r.title, STATUS_LABEL[r.status] || r.status, r.views, r.category, r.created_at, r.scheduled_at].map(escape).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="posts-export.csv"');
  res.send('﻿' + lines.join('\n'));
});

// 详情
router.get('/:id', authMiddleware, requirePermission('post:view'), (req, res) => {
  const scope = postScope(req.user);
  const row = db.prepare(
    `SELECT p.*, c.name AS category_name FROM posts p LEFT JOIN categories c ON p.category_id=c.id
     WHERE p.id = ? AND p.is_deleted=0 ${scope}`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: '内容不存在或无权限' });
  row.tag_ids = parseTags(row.tag_ids);
  res.json({ row });
});

// 创建
router.post('/', authMiddleware, requirePermission('post:create'), (req, res) => {
  const { title, type, summary, content, category_id, tag_ids, status, cover_image, scheduled_at } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: '标题与正文为必填项' });
  if (!category_id) return res.status(400).json({ error: '请选择分类' });
  let finalStatus = status || 'draft';
  let finalScheduled = null;
  if (finalStatus === 'scheduled') {
    // 定时发布需要明确的计划时间；无发布权限者不可自行排期，降级为「待审核」
    if (!req.user.permissions.includes('post:publish')) finalStatus = 'pending';
    else {
      if (!scheduled_at) return res.status(400).json({ error: '请设置计划发布时间' });
      finalScheduled = scheduled_at;
    }
  }
  if (finalStatus === 'published') {
    // 无发布权限者提交发布将转为「待审核」
    if (!req.user.permissions.includes('post:publish')) finalStatus = 'pending';
  }
  const publishedAtSql = finalStatus === 'published' ? `datetime('now')` : 'NULL';
  const safeContent = sanitizeHtml(content);
  const info = db.prepare(
    `INSERT INTO posts (type,title,slug,summary,content,cover_image,category_id,author_id,tag_ids,status,published_at,scheduled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,${publishedAtSql},?)`
  ).run(
    type || 'article', title, slugify(title), summary || '', safeContent, cover_image || null,
    category_id, req.user.uid, JSON.stringify(parseTags(tag_ids)), finalStatus, finalScheduled
  );
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  row.tag_ids = parseTags(row.tag_ids);
  res.json({ row });
});

// 更新
router.put('/:id', authMiddleware, requirePermission('post:edit'), (req, res) => {
  const scope = postScope(req.user);
  const existing = db.prepare(`SELECT * FROM posts WHERE id = ? AND is_deleted=0 ${scope}`)
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: '内容不存在或无权限' });
  const { title, type, summary, content, category_id, tag_ids, status, cover_image, scheduled_at } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: '标题与正文为必填项' });
  if (!category_id) return res.status(400).json({ error: '请选择分类' });
  let finalStatus = status || existing.status;
  let finalScheduled = finalStatus === 'scheduled' ? (scheduled_at || existing.scheduled_at) : null;
  if (finalStatus === 'scheduled') {
    if (!req.user.permissions.includes('post:publish')) finalStatus = 'pending';
    else if (!finalScheduled) return res.status(400).json({ error: '请设置计划发布时间' });
  }
  if (finalStatus === 'published' && !req.user.permissions.includes('post:publish')) finalStatus = 'pending';
  const newPublished = finalStatus === 'published' && existing.status !== 'published';
  const publishedAtSql = newPublished ? `datetime('now')` : 'published_at';
  const safeContent = sanitizeHtml(content);
  db.prepare(
    `UPDATE posts SET type=?,title=?,summary=?,content=?,cover_image=?,category_id=?,tag_ids=?,status=?,scheduled_at=?,published_at=COALESCE(${publishedAtSql}, published_at),updated_at=datetime('now') WHERE id=?`
  ).run(
    type || 'article', title, summary || '', safeContent, cover_image ?? existing.cover_image,
    category_id, JSON.stringify(parseTags(tag_ids)), finalStatus, finalScheduled, req.params.id
  );
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  row.tag_ids = parseTags(row.tag_ids);
  res.json({ row });
});

// 工作流状态流转：提交审核 / 通过 / 驳回 / 退回修改 / 下线 / 恢复草稿
// 状态机：draft → pending →(approve)→ published →(offline)→ offline →(restore)→ draft
//                        ↘(reject)→ rejected →(reopen)→ draft
const TRANSITIONS = {
  submit:  { from: ['draft', 'rejected'], to: 'pending',  need: 'post:edit' },
  approve: { from: ['pending'],           to: 'published', need: 'post:publish' },
  reject:  { from: ['pending'],           to: 'rejected',  need: 'post:publish', reason: true },
  reopen:  { from: ['rejected'],          to: 'draft',     need: 'post:edit' },
  offline: { from: ['published'],         to: 'offline',   need: 'post:manage' },
  restore: { from: ['offline'],           to: 'draft',     need: 'post:manage' },
};
const LITERAL = (s) => typeof s === 'string' && /^(NULL|datetime\('now'\))$/i.test(s);
router.post('/:id/transition', authMiddleware, (req, res) => {
  const action = (req.body && req.body.action) || '';
  const t = TRANSITIONS[action];
  if (!t) return res.status(400).json({ error: '未知的操作' });
  const permOk = req.user.isSuper || (req.user.permissions || []).includes(t.need);
  if (!permOk) return res.status(403).json({ error: '权限不足：' + (STATUS_LABEL[t.to] ? '无法执行该状态流转' : '缺少所需权限') });
  const scope = postScope(req.user);
  const post = db.prepare(`SELECT * FROM posts WHERE id = ? AND is_deleted=0 ${scope}`)
    .get(req.params.id);
  if (!post) return res.status(404).json({ error: '内容不存在或无权限' });
  if (!t.from.includes(post.status)) {
    return res.status(409).json({ error: `当前状态（${STATUS_LABEL[post.status] || post.status}）不允许「${action}」操作` });
  }
  let reason = null;
  if (t.reason) {
    reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: '请填写驳回理由' });
  }
  const setStatus = (newStatus, extra = {}) => {
    const sets = ['status = ?', "updated_at = datetime('now')"];
    const params = [newStatus];
    for (const [k, v] of Object.entries(extra)) {
      if (LITERAL(v)) sets.push(`${k} = ${v}`);
      else { sets.push(`${k} = ?`); params.push(v); }
    }
    db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...params, post.id);
  };
  if (action === 'approve') {
    setStatus('published', { published_at: "datetime('now')", reject_reason: 'NULL' });
    notify(db, post.author_id, { type: 'review', title: '内容已通过审核', body: `《${post.title}》已通过审核并发布。`, refType: 'post', refId: post.id });
  } else if (action === 'reject') {
    setStatus('rejected', { published_at: 'NULL', reject_reason: reason });
    notify(db, post.author_id, { type: 'review', title: '内容被驳回', body: `《${post.title}》未通过审核：${reason}`, refType: 'post', refId: post.id });
  } else if (action === 'offline') {
    setStatus('offline');
  } else {
    // submit / reopen / restore
    const extra = (action === 'submit' || action === 'reopen') ? { reject_reason: 'NULL' } : {};
    setStatus(t.to, extra);
  }
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id);
  row.tag_ids = parseTags(row.tag_ids);
  res.json({ row });
});

// 软删除
router.delete('/:id', authMiddleware, requirePermission('post:delete'), (req, res) => {
  const scope = postScope(req.user);
  const existing = db.prepare(`SELECT id FROM posts WHERE id = ? AND is_deleted=0 ${scope}`)
    .get(req.params.id);
  if (!existing) return res.status(404).json({ error: '内容不存在或无权限' });
  db.prepare("UPDATE posts SET is_deleted=1, updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// 批量操作
router.patch('/batch', authMiddleware, requirePermission('post:manage'), (req, res) => {
  const { ids, action, status, category_id, tag_ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择内容' });
  const scope = postScope(req.user);
  const placeholders = ids.map(() => '?').join(',');
  if (action === 'delete') {
    const sql = `UPDATE posts SET is_deleted=1, updated_at=datetime('now') WHERE id IN (${placeholders}) AND is_deleted=0 ${scope}`;
    const r = db.prepare(sql).run(...ids);
    return res.json({ ok: true, count: r.changes });
  }
  if (action === 'status') {
    let finalStatus = status;
    if (!req.user.permissions.includes('post:publish') && finalStatus === 'published') finalStatus = 'pending';
    const sql = `UPDATE posts SET status=?, updated_at=datetime('now') WHERE id IN (${placeholders}) AND is_deleted=0 ${scope}`;
    const r = db.prepare(sql).run(finalStatus, ...ids);
    return res.json({ ok: true, count: r.changes });
  }
  if (action === 'category') {
    if (!category_id) return res.status(400).json({ error: '请选择分类' });
    const sql = `UPDATE posts SET category_id=?, updated_at=datetime('now') WHERE id IN (${placeholders}) AND is_deleted=0 ${scope}`;
    const r = db.prepare(sql).run(category_id, ...ids);
    return res.json({ ok: true, count: r.changes });
  }
  if (action === 'tags') {
    const add = Array.isArray(tag_ids) ? tag_ids.map((x) => +x).filter(Boolean) : [];
    if (!add.length) return res.status(400).json({ error: '请选择标签' });
    const tx = db.transaction(() => {
      let n = 0;
      for (const id of ids) {
        const row = db.prepare(`SELECT id, tag_ids FROM posts WHERE id = ? AND is_deleted = 0 ${scope}`).get(id);
        if (!row) continue;
        const cur = parseTags(row.tag_ids).map((x) => +x);
        const merged = [...new Set([...cur, ...add])];
        db.prepare('UPDATE posts SET tag_ids = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(merged), id);
        n++;
      }
      return n;
    });
    const count = tx();
    return res.json({ ok: true, count });
  }
  return res.status(400).json({ error: '未知操作' });
});

module.exports = router;
