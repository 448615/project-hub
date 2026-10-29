// 时间格式化：UTC 存储串 <-> 本地显示 <-> datetime-local 输入值。
// 纯函数，无外部依赖，可被任意视图复用。

export function fmtUtc(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 将本地 datetime-local 输入值转为 UTC 存储串（YYYY-MM-DD HH:MM:SS）
export function toUtcSql(localValue) {
  if (!localValue) return null;
  const d = new Date(localValue);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
// 将 UTC 存储串反填为 datetime-local 的本地输入值
export function toLocalInput(s) {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 内容工作流状态流转（提交/通过/驳回/退回/下线/恢复）
