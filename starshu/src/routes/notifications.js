// 站内通知路由：/api/notifications
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware } = require('../../auth');
const { listNotifications, markRead } = require('../lib/notifications');

// 列出当前用户的通知（默认合并未读 + 最近，unreadOnly 仅取未读）
router.get('/', authMiddleware, (req, res) => {
  const unreadOnly = req.query.unread === '1';
  const data = listNotifications(db, req.user.uid, { unreadOnly, limit: 50 });
  res.json(data);
});

// 标记已读：{ ids: [...] } 指定项，或 { all: true } 全部
router.post('/mark', authMiddleware, (req, res) => {
  const { ids, all } = req.body || {};
  markRead(db, req.user.uid, { ids: Array.isArray(ids) ? ids : null, all: !!all });
  res.json({ ok: true });
});

module.exports = router;
