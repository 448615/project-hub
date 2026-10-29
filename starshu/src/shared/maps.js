// 集中维护状态/角色的中文文案与徽章样式类名。
// STATUS_LABEL / BADGE_CLASS 供后端 CSV 导出使用；ROLE_LABEL 与前端
// public/js/constants.js 保持逐项一致（含 author / viewer），避免两端文案漂移。
const STATUS_LABEL = { draft: '草稿', pending: '待审核', published: '已发布', offline: '已下线', scheduled: '计划中', rejected: '已驳回' };
const ROLE_LABEL = { admin: '超级管理员', editor: '内容编辑', author: '作者', viewer: '只读访客', disabled: '已禁用' };
const BADGE_CLASS = { draft: 'b-draft', pending: 'b-pending', published: 'b-published', offline: 'b-offline', scheduled: 'b-scheduled', rejected: 'b-rejected' };

module.exports = { STATUS_LABEL, ROLE_LABEL, BADGE_CLASS };
