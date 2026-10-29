# 星枢（starshu）· 内容运营中枢

> **本目录是「项目枢纽」的子项目之一**，从 `starshu-bundle` 发行包拆分而来。
> 下文「发行包原始说明」保留原厂内容，整合相关的改动见本节。

## 一、在枢纽中的位置

| 项 | 说明 |
|---|---|
| 桌面入口 | 枢纽桌面图标 **🌌 星枢**，双击直接打开应用窗口 |
| 挂载点 | `/apps/starshu/`（枢纽同源反向代理 → `127.0.0.1:3000`） |
| 进程 | 首次访问时由枢纽懒启动 `node server.js`；枢纽退出时一并结束（只杀自己拉起的实例） |
| 数据库 | `data/starshu.db`（SQLite + WAL，已 checkpoint，主库自包含） |
| 签名密钥 | `data/jwt.secret`（首次启动随机生成，权限 0600，不随代码分发） |
| 默认账号 | `admin@cms.local` / `Admin@123456`（登录后顶栏常驻改密提醒） |

## 二、相对发行包做的改动

1. **JWT 密钥不再写死**（P0）：旧版 `process.env.JWT_SECRET || 'starshu-shared-secret-v1-…'`
   意味着拿到源码的人可以自己签 `role=admin` 的 token 直接通过鉴权（已实测可读用户列表）。
   现改为三级解析：环境变量 → `data/jwt.secret` → 进程内随机（并告警）。
2. **新增改密能力**：`POST /api/auth/password` + 顶栏「修改密码」+ 弱口令常驻提醒条。
   此前系统没有任何改密入口，只能用 `node -e` 直接改库。
3. **multer 1.x → 2.x**（1.x 已被官方标记存在漏洞）。
4. **前端绝对路径改相对**：`/styles.css`、`/js/main.js`、`/api`、`/vendor-echarts.js`、
   `window.open('/api/posts/export')`、`<img src="/api/media/…">` 共 6 处。
   因为挂载在 `/apps/starshu/` 下，绝对路径会指到枢纽根；星枢用 hash 路由，
   改相对后深链接不受影响，单独跑 `npm start`（根路径）也照常工作。
5. **WAL checkpoint**：发行包里的主库只有 4 KB、2 MB 数据全在 `-wal` 里，
   只拷 `.db` 就是一个空库；已 `wal_checkpoint(TRUNCATE)` 收敛进主库。

## 三、单独运行（不经枢纽）

```bash
npm install
npm start            # 或 node server.js，默认 3000 端口
```

生产环境请显式设置 `JWT_SECRET`（多实例必须一致），并把默认管理员密码改掉。

## 四、许可证

AGPLv3 / 商业订阅双许可，详见 `LICENSE.txt`、`agpl-3.0.txt`、`LICENSE.COMMERCIAL.txt`。

---

# 附：发行包原始说明（starshu-bundle）
# 星枢合并版（starshu-bundle）

> **蓝域星河有限公司集团 · 星海量子通用操作系统（StarseaOS） · 内容运营中枢**
>
> 通用内容管理后台模板：登录认证 / RBAC 权限 / 内容工作流 / 定时发布 / 数据统计 / 媒体库。
>
> **Express 4 + better-sqlite3 + 原生 JS SPA**，单进程、单文件库、零前端框架依赖。

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![License: Commercial](https://img.shields.io/badge/License-Commercial-green.svg)](./LICENSE.COMMERCIAL.txt)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/Version-1.0.0-orange.svg)](#)

---

> **本发行包包含两个独立组件**：
>
> - **星枢（starshu）**：内容运营中枢。源码与构建产物均在本发行包根目录，
>   许可见 [`LICENSE.txt`](./LICENSE.txt)。
> - **桓梦工作台（huandream-workbench）**：纯前端个人效率工作台。
>   本发行包仅包含其构建产物，位于 `workbench/www/`，
>   许可见 [`workbench/www/LICENSE.txt`](./workbench/www/LICENSE.txt)，
>   源码获取方式（离线书面要约）见 [`workbench/www/WRITTEN_OFFER.md`](./workbench/www/WRITTEN_OFFER.md)。
>
> 两个组件数据完全隔离、可独立运行，也可通过星枢的 `/workbench/` 子路径统一入口。
> 聚合许可说明见 [`LICENSES.md`](./LICENSES.md)。

---

## 📖 简介

一套可直接运行、可二次开发的内容运营中枢。面向中小型内容站点与内部运营后台，提供「内容生产 → 审核 → 发布 → 统计」的完整闭环。

**它解决的问题**：

- 从零搭后台成本高：认证、权限、审核流、媒体、统计每个都要重写
- 多角色协作缺乏隔离：编辑、作者、访客的权限边界容易写漏
- SQLite 部署在单机上，但需要 WAL 一致性、备份、迁移、自愈等运维能力
- 前端不想引入框架，但仍要有 SPA 路由、富文本、图表、拖拽等交互

## ✨ 核心特性

### 认证与权限

- **无状态 JWT**：`X-Auth-Token` 透传，天然兼容多实例
- **RBAC**：4 个内置角色（超管 / 编辑 / 作者 / 只读）+ 自定义角色 + 19 项权限矩阵
- **数据作用域**：`post:manage` 或超管可见全量；其他角色仅见自己创建的内容
- **登录 / 注册 / 埋点限流**：键取稳定业务标识（邮箱 / visitor_id），规避反代 IP 轮换导致限流失效

### 内容与工作流

- 增删改查、软删除、批量操作、CSV 导出
- 富文本编辑器（`contenteditable`）+ 前端自动保存草稿
- 状态机：`draft → pending → published → offline`，驳回走 `rejected → draft`
- **定时发布**：`scheduled_at` 到点自动发布（调度器 30s 扫描）
- 站内通知：驳回、发布、定时发布到点

### 数据与媒体

- 分类（多级）/ 标签 CRUD
- 媒体库：图片 / PDF / DOCX，≤ 5MB，磁盘存储
- 看板：KPI、创建趋势、状态分布、分类占比
- 阅读统计：PV/UV 埋点、来源归一化、演示数据一键清除且重启不复种

### 安全基线

- **HTML 白名单净化**：标签 / 属性 / URL 协议三重白名单，前后端镜像实现（同一测试向量校验，防策略漂移）
- **密码哈希**：scrypt + 随机盐 + `timingSafeEqual` 比较
- **统一错误处理**：不泄露堆栈，5xx 只回安全 JSON
- **请求日志降噪**：只记 `/api/*` 与失败请求，高频信标仅记失败

### 运维能力

- **Schema 迁移**：`migrations/NNN_*.sql` + `_migrations` 表，单事务幂等，旧库 `duplicate column` 视为已应用
- **每日在线备份**：`db.backup` 一致性快照，保留最近 7 天（每天 1 份）
- **启动自愈**：`quick_check` 不通过时清 WAL 重开 → `integrity_check` → 隔离损坏文件（`.corrupt-*`）按种子重建
- **健康检查**：`/api/health` 返回 DB 连通、uptime、调度器状态

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 18**（推荐 20 LTS；Node 24 需 `better-sqlite3@^12.10.0` 并 `npm approve-scripts`）

### 安装与启动

```bash
npm install
# 可选：按需创建 .env 自定义 PORT / JWT_SECRET（无此文件也能启动）
npm start
```

访问 <http://localhost:3000>，默认账号：

| 邮箱 | 密码 | 角色 |
|---|---|---|
| `admin@cms.local` | `Admin@123456` | 超级管理员 |

> ⚠️ **公网部署前必须修改默认密码，并设置 `JWT_SECRET`（多实例须一致）。**

## ⚙️ 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` 仅本机） |
| `DB_FILE` | `data/starshu.db` | 数据库路径（相对或绝对） |
| `JWT_SECRET` | 内置常量 | 生产环境**务必替换**；多实例须一致 |
| `SEED_DEMO` | `1` | 是否播种演示埋点（`0` 跳过） |
| `NPM_REGISTRY` | — | 启动脚本安装依赖时的镜像地址 |

## 🧰 常用命令

| 命令 | 说明 |
|---|---|
| `npm start` | 启动服务（经 `scripts/start.js`，含体检与兜底） |
| `npm test` | 单元 / 集成测试（`node:test`，零外部依赖） |
| `npm run check` | 全量语法门禁（`node --check`） |
| `npm run test:e2e` | 端到端（Playwright） |

## 🔌 接口一览

统一前缀 `/api`，鉴权头 `X-Auth-Token: <jwt>`（优先）或 `Authorization: Bearer <jwt>`。

| 类别 | 接口 |
|---|---|
| 认证 | `POST /auth/login` · `POST /auth/register` · `GET /auth/me` · `POST /auth/logout` |
| 内容 | `GET/POST /posts` · `GET/PUT/DELETE /posts/:id` · `POST /posts/:id/transition` · `PATCH /posts/batch` · `GET /posts/export` |
| 分类 / 标签 | `GET/POST/PUT/DELETE /categories` · `/tags` |
| 媒体 | `GET/POST /media` · `GET /media/:id/file` · `DELETE /media/:id` |
| 用户 | `GET /users` · `PATCH /users/:id` · `DELETE /users/:id` |
| 角色 | `GET/POST /roles` · `PATCH/DELETE /roles/:id` |
| 通知 | `GET /notifications` · `POST /notifications/mark` |
| 看板 | `GET /dashboard?range=` |
| 统计 | `GET /stats/overview?days=` · `POST /stats/demo/clear` |
| 埋点 | `POST /track`（公开信标） |
| RSS | `GET /rss?url=`（同源代理，白名单 4 源，工作台实时资讯用） |
| 健康 | `GET /health` |

错误响应统一 `{ "error": "..." }`；常见状态码 400 / 401 / 403 / 404 / 409 / 429 / 500。

## 🛠️ 部署与运维

### 发布前自查

1. `npm test` + `npm run check` 全绿
2. 本地库为上线状态（无 `@test.local` 账号、无测试文章）
3. WAL 已 checkpoint：
   ```bash
   node -e "const db=require('better-sqlite3')('data/starshu.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
   ```
4. 公网部署已修改默认密码并设置 `JWT_SECRET`

### 日常运维

- **每日备份**：启动后异步生成 `data/backups/starshu-YYYY-MM-DD.db`，保留最近 7 天（每天 1 份）
- **健康检查**：`GET /api/health` 返回 `db` / `uptime` / `scheduler`
- **数据库损坏**：`db.js` 启动时自动检测并自愈，损坏文件隔离保留 30 天后由下次启动自动清理

> 详细数据模型与接口说明见 [`PROJECT.md`](./PROJECT.md)。

## 📁 目录结构

```
starshu/
├── server.js  db.js  auth.js  pwd.js
├── src/routes/          # API 路由
├── src/lib/             # 限流/日志/净化/备份/迁移/调度/上传
├── src/shared/maps.js
├── public/              # 星枢前端 SPA（原生 ES Module）
├── workbench/           # 桓梦工作台（独立静态前端，www/ 为构建产物）
├── migrations/          # 编号 SQL 迁移
├── tests/               # node:test 用例
├── e2e/                 # Playwright 关键路径
└── data/  uploads/      # 运行时生成
```

## 🧩 二次开发

- **新增权限**：`src/lib/permissions.js` 的 `PERMISSION_GROUPS`，前端 `public/js/constants.js` 同步
- **新增表/字段**：`migrations/NNN_xxx.sql`，勿改基线 `db.js`
- **新增路由**：`src/routes/xxx.js` + `server.js` 挂载
- **新增页面**：`public/js/main.js` 的 `router()` + `renderXxx()`

## 🤝 贡献

欢迎所有形式的贡献——代码、文档、Bug 报告、安全加固建议。

- 阅读 [贡献指南](./CONTRIBUTING.md)
- 阅读 [贡献者许可协议（CLA）](./CONTRIBUTOR_LICENSE_AGREEMENT.md)
- 在 GitHub Issues 提交 Bug / 功能建议

**提交 PR 即视为您已同意 CLA。**

## 📜 许可证

本项目采用 **双许可证** 模式：

| 版本 | 许可证 | 适用场景 |
|---|---|---|
| **社区版** | [AGPLv3](./agpl-3.0.txt) | 个人使用、非商业项目、开源集成 |
| **商业版** | [商业订阅](./LICENSE.COMMERCIAL.txt) | 企业内部多实例、SaaS、闭源集成 |

详见 [`LICENSE.txt`](./LICENSE.txt)。

## 🌌 与 StarseaOS 的关系

本组件是 **星海量子通用操作系统（StarseaOS）** 生态的一部分，与以下服务平级：

| 服务 | 端口 | 定位 | 许可 |
|---|---|---|---|
| **星舟（starbarge）** | 8001 | 托管第三方 Web 应用 | AGPLv3 / 商业订阅 |
| **星文（starwen）** | 8002 | AI 同人创作 | AGPLv3 / 商业订阅 |
| **星镜（starmirror）** | 8003 | 媒体库管理 | AGPLv3 / 商业订阅 |
| **星铸（starforge）** | 8004 | 角色卡工具 | AGPLv3 / 商业订阅 |
| **星枢（starshu）** | 3000（1.x）/ 8005（2.x） | 内容运营中枢 | **AGPLv3 / 商业订阅** |
| **星钥（starkey）** | 9001 | 密钥管理与授权签发 | AGPLv3 / 商业订阅 |

> 注：星枢默认端口为 3000（Node.js 惯例），未纳入 8001–8005 应用层序列；星钥为基础设施层（9001），独立于应用层。API 网关按服务名路由，不受端口影响。

各组件完全独立，可单独使用，也可组合使用。

## 📞 联系方式

**蓝域星河有限公司集团**

- 系统网站：https://aitanser.github.io/starsea-os/
- 电子邮箱：lzc737507@outlook.com
- GitHub Issues：提交 Issue 或 Pull Request

---

**Developed by 蓝域星河有限公司集团 · 星海量子开发组**