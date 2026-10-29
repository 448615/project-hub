// 前端权限判定：超级管理员直接放行，其余按权限列表判断。
import { state } from './session.js';

export function can(permission) {
  const u = state.user;
  if (!u) return false;
  if (u.isSuper) return true;
  return (u.permissions || []).includes(permission);
}
export function canAny(list) { return !!(list || []).some(can); }

// 将 UTC 时间字符串（YYYY-MM-DD HH:MM:SS）格式化为可读文本（按本地时区显示）
