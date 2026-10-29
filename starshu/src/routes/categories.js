// 分类路由：/api/categories
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const { isUniqueViolation } = require('../lib/helpers');

router.get('/', authMiddleware, requirePermission('category:view'), (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all() });
});

router.post('/', authMiddleware, requirePermission('category:manage'), (req, res) => {
  const { name, slug, description, parent_id, sort_order } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '名称与 slug 必填' });
  try {
    const info = db.prepare('INSERT INTO categories (name,slug,description,parent_id,sort_order) VALUES (?,?,?,?,?)')
      .run(name, slug, description || '', parent_id || null, sort_order || 0);
    res.json({ row: db.prepare('SELECT * FROM categories WHERE id=?').get(info.lastInsertRowid) });
  } catch (e) {
    if (isUniqueViolation(e)) return res.status(409).json({ error: '该名称或 slug 已存在' });
    throw e;
  }
});

router.put('/:id', authMiddleware, requirePermission('category:manage'), (req, res) => {
  const { name, slug, description, parent_id, sort_order } = req.body || {};
  db.prepare('UPDATE categories SET name=?,slug=?,description=?,parent_id=?,sort_order=? WHERE id=?')
    .run(name, slug, description || '', parent_id || null, sort_order || 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', authMiddleware, requirePermission('category:manage'), (req, res) => {
  db.prepare('UPDATE posts SET category_id=NULL WHERE category_id=?', req.params.id);
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
