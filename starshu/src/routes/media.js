// 媒体库路由：/api/media
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
// upload（含 multer）按需延迟加载：仅在媒体库接口被调用时才 require，
// 避免启动阶段为极少用到的上传能力加载 multer（约 30ms）。

router.get('/', authMiddleware, requirePermission('media:view'), (req, res) => {
  const all = req.user.isSuper || (req.user.permissions || []).includes('media:manage');
  const rows = db.prepare(
    `SELECT * FROM media ${all ? '' : 'WHERE uploaded_by = ?'} ORDER BY id DESC`
  ).all(...(all ? [] : [req.user.uid]));
  res.json({ rows });
});

router.post('/', authMiddleware, requirePermission('media:manage'), (req, res, next) => {
  const { upload } = require('../lib/upload');
  upload.single('file')(req, res, next);
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: '上传失败：文件类型不支持或超出 5MB' });
  const info = db.prepare(
    'INSERT INTO media (filename,original_name,url,path,mime_type,size,uploaded_by) VALUES (?,?,?,?,?,?,?)'
  ).run(
    req.file.filename, req.file.originalname, '', req.file.path,
    req.file.mimetype, req.file.size, req.user.uid
  );
  const id = info.lastInsertRowid;
  const url = `/api/media/${id}/file`;
  db.prepare('UPDATE media SET url=? WHERE id=?').run(url, id);
  const row = db.prepare('SELECT * FROM media WHERE id=?').get(id);
  row.url = url;
  res.json({ row });
});

router.get('/:id/file', authMiddleware, (req, res) => {
  const { uploadDir } = require('../lib/upload');
  const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).send('not found');
  const fp = path.join(uploadDir, m.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('not found');
  res.setHeader('Content-Type', m.mime_type || 'application/octet-stream');
  res.sendFile(fp);
});

router.delete('/:id', authMiddleware, requirePermission('media:manage'), (req, res) => {
  const { uploadDir } = require('../lib/upload');
  const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: '不存在' });
  const all = req.user.isSuper || (req.user.permissions || []).includes('media:manage');
  if (!all && m.uploaded_by !== req.user.uid) return res.status(403).json({ error: '权限不足' });
  db.prepare('DELETE FROM media WHERE id=?').run(req.params.id);
  const fp = path.join(uploadDir, m.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

module.exports = router;
