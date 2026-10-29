// 标签路由：/api/tags
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const { isUniqueViolation } = require('../lib/helpers');

router.get('/', authMiddleware, requirePermission('tag:view'), (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM tags ORDER BY id').all() });
});

router.post('/', authMiddleware, requirePermission('tag:manage'), (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '名称与 slug 必填' });
  try {
    const info = db.prepare('INSERT INTO tags (name,slug) VALUES (?,?)').run(name, slug);
    res.json({ row: db.prepare('SELECT * FROM tags WHERE id=?').get(info.lastInsertRowid) });
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: '该名称或 slug 已存在' });
    throw e;
  }
});

router.put('/:id', authMiddleware, requirePermission('tag:manage'), (req, res) => {
  const { name, slug } = req.body || {};
  db.prepare('UPDATE tags SET name=?,slug=? WHERE id=?').run(name, slug, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', authMiddleware, requirePermission('tag:manage'), (req, res) => {
  db.prepare('DELETE FROM tags WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
