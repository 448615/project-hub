// 角色管理路由：/api/roles
// 提供角色列表（含成员计数）、创建、更新权限、删除能力。
// 角色列表对「查看用户」或「查看角色」权限者开放；增删改需 role:manage。
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');
const perm = require('../../src/lib/permissions');

// 角色列表（含每个角色的成员数）
router.get('/', authMiddleware, requirePermission('user:view', 'role:view'), (req, res) => {
  const roles = perm.listRoles().map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description,
    is_system: r.isSystem ? 1 : 0, is_super: r.isSuper ? 1 : 0, permissions: r.permissions,
  }));
  const counts = db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all();
  const map = {};
  counts.forEach((c) => { map[c.role] = c.c; });
  roles.forEach((r) => { r.memberCount = map[r.key] || 0; });
  res.json({ rows: roles });
});

// 创建自定义角色
router.post('/', authMiddleware, requirePermission('role:manage'), (req, res) => {
  const { key, name, description, permissions } = req.body || {};
  if (!key || !name) return res.status(400).json({ error: '角色标识与名称为必填' });
  if (!/^[a-z0-9_]{2,32}$/i.test(key)) return res.status(400).json({ error: '角色标识仅允许字母、数字与下划线（2–32 位）' });
  if (perm.getRole(key)) return res.status(409).json({ error: '该角色标识已存在' });
  const perms = Array.isArray(permissions) ? permissions.filter((p) => perm.isKnownPermission(p)) : [];
  try {
    const info = db.prepare('INSERT INTO roles (key,name,description,is_system,is_super,permissions) VALUES (?,?,?,0,0,?)')
      .run(key, name, description || '', JSON.stringify(perms));
    perm.invalidateRoleCache(db);
    res.json({ row: db.prepare('SELECT * FROM roles WHERE id=?').get(info.lastInsertRowid) });
  } catch (e) {
    if (/constraint/i.test(e.message)) return res.status(409).json({ error: '该角色标识已存在' });
    throw e;
  }
});

// 更新角色（名称 / 描述 / 权限）；系统内置角色可改权限，但不可改标识与超管标记
router.patch('/:id', authMiddleware, requirePermission('role:manage'), (req, res) => {
  const { name, description, permissions } = req.body || {};
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  const updName = name != null ? name : role.name;
  const updDesc = description != null ? description : role.description;
  let updPerms = role.permissions;
  if (Array.isArray(permissions)) {
    if (role.is_super) return res.status(400).json({ error: '超级管理员权限不可修改' });
    if (role.is_system && !req.user.isSuper) {
      return res.status(403).json({ error: '权限不足：仅超级管理员可修改系统内置角色' });
    }
    updPerms = JSON.stringify(permissions.filter((p) => perm.isKnownPermission(p)));
  }
  db.prepare('UPDATE roles SET name=?, description=?, permissions=? WHERE id=?').run(updName, updDesc, updPerms, req.params.id);
  perm.invalidateRoleCache(db);
  res.json({ ok: true });
});

// 删除自定义角色（系统内置角色、仍有成员的角色不可删除）
router.delete('/:id', authMiddleware, requirePermission('role:manage'), (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  if (role.is_system) return res.status(400).json({ error: '系统内置角色不可删除' });
  const cnt = db.prepare('SELECT COUNT(*) c FROM users WHERE role=?').get(role.key).c;
  if (cnt > 0) return res.status(409).json({ error: `仍有 ${cnt} 名用户属于该角色，请先为其重新分配角色` });
  db.prepare('DELETE FROM roles WHERE id=?').run(req.params.id);
  perm.invalidateRoleCache(db);
  res.json({ ok: true });
});

module.exports = router;
