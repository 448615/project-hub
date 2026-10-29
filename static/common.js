// 公共工具：转义函数（前后端/测试共用，便于单测覆盖）
// 把文字里的特殊符号变成 HTML 实体，防止 XSS 与页面显示错乱
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Node 环境下导出，供测试 import；浏览器环境忽略（esc 已是全局函数）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { esc };
}
