// 用户管理路由：/api/users
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const { getRole } = require('../../src/lib/permissions');

// 用户列表等只读操作需要 user:view
router.get('/', authMiddleware, requirePermission('user:view'), (req, res) => {
  res.json({ rows: db.prepare('SELECT id,email,display_name,role,status,created_at,last_login_at FROM users ORDER BY id').all() });
});

router.patch('/:id', authMiddleware, requirePermission('user:manage'), (req, res) => {
  const { role, status, display_name } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  // 校验目标角色存在
  if (role != null && !getRole(role)) return res.status(400).json({ error: '目标角色不存在' });
  // 防止把自己（或任何超级管理员）降权，避免锁死系统
  const targetRole = getRole(target.role);
  const newRole = role != null ? getRole(role) : targetRole;
  if (req.user.uid === target.id && targetRole && targetRole.isSuper && (!newRole || !newRole.isSuper)) {
    return res.status(400).json({ error: '不能取消自己的超级管理员权限' });
  }
  if (targetRole && targetRole.isSuper && (!newRole || !newRole.isSuper) && req.user.uid !== target.id) {
    // 跨用户降权：仅允许同样具备超级权限者操作
    if (!req.user.isSuper) return res.status(403).json({ error: '权限不足：降权超级管理员需超级权限' });
  }
  db.prepare('UPDATE users SET role=COALESCE(?,role), status=COALESCE(?,status), display_name=COALESCE(?,display_name) WHERE id=?')
    .run(role || null, status || null, display_name || null, req.params.id);
  // 若被修改者是当前登录用户，权限可能已变化，前端会在返回后刷新会话
  const changedSelf = req.user.uid === target.id;
  res.json({ ok: true, changedSelf });
});

router.delete('/:id', authMiddleware, requirePermission('user:manage'), (req, res) => {
  if (req.user.uid === parseInt(req.params.id)) return res.status(400).json({ error: '不能删除自己' });
  const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const targetRole = getRole(target.role);
  if (targetRole && targetRole.isSuper) return res.status(400).json({ error: '不能删除超级管理员账号' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
