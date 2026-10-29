// 内置默认管理员标识：db.js（播种/恢复）与 routes/auth.js（弱口令提示）共用。
// 单独成文件是为了避免 db.js 与 auth.js 相互 require 形成循环依赖。
//
// 安全说明：
// 默认口令只用于「本地开箱」与「提示用户尽快改密」。公网/容器部署**必须**通过
// 环境变量 STARSHU_DEFAULT_ADMIN_PWD 显式设置一个强口令，否则回落到下面的源码
// 默认值（任何拿到源码的人都知道），等于公开凭据。
const DEFAULT_ADMIN_EMAIL = 'admin@cms.local';
const DEFAULT_ADMIN_PWD = process.env.STARSHU_DEFAULT_ADMIN_PWD || 'Admin@123456';

module.exports = { DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PWD };
