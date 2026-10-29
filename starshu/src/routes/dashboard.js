// 看板数据路由：/api/dashboard
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const { postScope } = require('../lib/helpers');

router.get('/', authMiddleware, requirePermission('dashboard:view'), (req, res) => {
  const range = parseInt(req.query.range) || 30; // 天
  const scope = postScope(req.user);

  const total = db.prepare(`SELECT COUNT(*) c FROM posts WHERE is_deleted=0 ${scope}`).get().c;
  const byStatus = db.prepare(
    `SELECT status, COUNT(*) c FROM posts WHERE is_deleted=0 ${scope} GROUP BY status`
  ).all();
  const views = db.prepare(`SELECT COALESCE(SUM(views),0) v FROM posts WHERE is_deleted=0 ${scope}`).get().v;

  // 时间范围趋势（按天）
  const since = new Date(Date.now() - range * 86400000).toISOString().slice(0, 10);
  const trend = db.prepare(
    `SELECT date(created_at) d, COUNT(*) c FROM posts WHERE created_at >= ? ${scope} GROUP BY d ORDER BY d`
  ).all(since);

  // 分类占比
  const byCat = db.prepare(
    `SELECT c.name, COUNT(*) c FROM posts p LEFT JOIN categories c ON p.category_id=c.id
     WHERE p.is_deleted=0 ${scope} GROUP BY p.category_id ORDER BY c DESC LIMIT 8`
  ).all();

  // 最近更新（看板直接返回，免去前端额外请求 /posts）
  const recent = db.prepare(
    `SELECT p.id, p.title, p.status, p.updated_at FROM posts p WHERE p.is_deleted=0 ${scope} ORDER BY p.updated_at DESC LIMIT 5`
  ).all();

  res.json({ total, views, byStatus, trend, byCat, recent, role: req.user.role });
});

module.exports = router;
