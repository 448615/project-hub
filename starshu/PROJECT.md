# 星枢（starshu）· 项目文档

> 通用内容管理后台 · 原生 JS SPA + Express + SQLite
>
> 登录认证 / 内容管理 / RBAC 权限 / 工作流 / 定时发布 / 数据统计 / 媒体库

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 技术栈](#2-技术栈)
- [3. 目录结构](#3-目录结构)
- [4. 核心功能](#4-核心功能)
- [5. 权限模型](#5-权限模型)
- [6. 数据模型](#6-数据模型)
- [7. 接口设计](#7-接口设计)
- [8. 部署陷阱与运维](#8-部署陷阱与运维)
- [9. 测试](#9-测试)
- [10. 后续规划](#10-后续规划)
- [10.5 许可证](#105-许可证)
- [11. 常见问题](#11-常见问题)

---

## 1. 项目概述

为「通用内容管理」搭建一套可独立运行、可上线的后台管理系统。

**业务范围**

- 内容（文章 / 资讯 / 公告）的增删改查与审核流
- 分类、标签、媒体资源的统一管理
- 运营指标看板与数据导出
- 多角色（管理员 / 编辑 / 作者 / 访客）权限隔离

**非目标（1.x 本期不做）**

- 面向 C 端的内容展示门户（仅后台）
- 多租户 / SaaS 化（2.x 起由 pro 版官方支持）
- 复杂工作流引擎、插件市场

**设计约定**

- `posts.type` 预留扩展字段，后续可平滑接入其他内容类型
- 所有删除走软删除（`is_deleted = 1`），列表默认过滤
- 状态机：`draft → pending → published → offline`，驳回走 `rejected → draft`

---

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 后端 | Node.js + Express 4 | 单进程 HTTP 服务 |
| 数据库 | better-sqlite3（SQLite, WAL） | 单文件，随服务部署 |
| 认证 | 无状态 JWT（`X-Auth-Token` 透传） | 兼容多实例 |
| 前端 | 原生 JS ES Module SPA | 无框架，`public/` 直出 |
| 图表 | ECharts 5.5.1（懒加载） | 仅看板 / 统计页使用 |
| 富文本 | 自研轻量编辑器 | 基于 `contenteditable` |
| 测试 | `node:test` + Playwright | 无 Jest / supertest 依赖 |

---

## 3. 目录结构

```
starshu/
├── server.js                 # 服务入口
├── db.js                     # 数据库初始化 + 种子 + 自愈
├── auth.js                   # JWT 签发 / 校验 + 权限中间件
├── pwd.js                    # scrypt 密码哈希
├── package.json
├── start.bat / start.sh      # 一键启动入口
├── README.md                 # 项目入口（快速开始 / 配置 / 接口 / 部署 / 生态）
├── PROJECT.md                # 技术细节（数据模型 / 权限 / 接口 / 部署陷阱 / FAQ）
│
├── scripts/
│   ├── start.js              # 跨平台启动脚本
│   └── check-syntax.js       # 全量语法门禁
├── src/
│   ├── routes/               # API 路由（auth/posts/...）
│   ├── lib/                  # 限流/日志/净化/备份/迁移/调度
│   └── shared/               # 前后端共享常量
│
├── public/                   # 星枢前端 SPA
│   ├── index.html
│   ├── js/
│   ├── styles.css
│   └── vendor-echarts.js
│
├── workbench/                # 桓梦工作台（独立静态前端，与 CMS 并列挂载）
│   └── www/                  # 构建产物（须置于 CMS 兜底路由之前）
│
├── migrations/               # 编号 SQL 迁移
├── tests/                    # node:test 用例
├── e2e/                      # Playwright 关键路径
│
├── data/                     # 运行时生成（SQLite + 备份）
│   ├── starshu.db
│   └── backups/
└── uploads/                  # 用户上传
```

---

## 4. 核心功能

| 模块 | 功能 |
|---|---|
| 认证 | 登录 / 注册 / 会话 / 登录限流 / 无状态 JWT |
| 内容 | 增删改查 / 软删除 / 批量操作 / CSV 导出 / 富文本 / 自动保存草稿 |
| 工作流 | 草稿 → 待审 → 已发布 / 已驳回 / 已下线；状态机受权限约束 |
| 定时发布 | `scheduled_at` 到点自动发布（调度器每 30s 扫描） |
| 分类 / 标签 | CRUD，多级分类 |
| 媒体库 | 上传（图片 / PDF / DOCX，≤5MB）/ 预览 / 删除 |
| 用户管理 | 列表 / 角色分配 / 禁用 / 防自降权 / 防删超管 |
| 角色权限 | RBAC，4 内置角色 + 自定义角色 + 权限矩阵 |
| 数据看板 | KPI / 趋势图 / 状态分布 / 分类占比 |
| 数据统计 | PV/UV 埋点（`/api/track`）/ 来源归一化 / 演示数据一键清除 |
| 站内通知 | 驳回 / 发布 / 定时发布通知 |

**内容状态机**

```
draft ──submit──▶ pending ──approve──▶ published ──offline──▶ offline
  ▲                  │                                           │
  │                  └──reject──▶ rejected ──submit──▶ pending   │
  └──────────────────────────────restore─────────────────────────┘
```

> 补充：`rejected → draft`（`reopen`，作者撤回修改后重新起草）与
> `offline → draft`（`restore`，管理员恢复为草稿）是两个回到 `draft` 的入口。
> `posts.js` 的 `TRANSITIONS` 均已实现；前端目前仅暴露 `restore`。

---

## 5. 权限模型

采用 **RBAC**：用户 → 角色 → 权限。角色定义在 `src/lib/permissions.js`。

**内置角色**

| 角色 key | 名称 | 权限概览 |
|---|---|---|
| `admin` | 超级管理员 | 全部权限，不可删除 / 降权 |
| `editor` | 内容编辑 | 全量内容 + 媒体 + 发布，不能管理用户 / 角色 / 分类 / 标签结构 |
| `author` | 作者 | 仅自己的内容 + 查看类，不能发布 |
| `viewer` | 只读访客 | 只读 |

**权限分组**

`post` / `media` / `category` / `tag` / `user` / `role` / `dashboard` / `stats`，共 19 项权限。

**数据作用域**

- 拥有 `post:manage` 或超管：可见 / 可操作**全部**内容
- 其他角色：仅能见 / 改**自己创建的**内容（`postScope`）

---

## 6. 数据模型

核心表：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | id / email / password_hash / role / status | 账号与角色 |
| `roles` | key / name / permissions / is_system / is_super | 角色定义 |
| `categories` | id / name / slug / parent_id / sort_order | 多级分类 |
| `tags` | id / name / slug | 标签 |
| `posts` | id / title / slug / content / category_id / author_id / status / is_deleted / scheduled_at / reject_reason | 核心内容 |
| `media` | id / filename / url / mime_type / size / uploaded_by | 媒体资源 |
| `notifications` | id / user_id / type / title / body / ref_type / ref_id / is_read | 站内通知 |
| `page_views` | id / post_id / visitor_id / source / is_demo | 阅读埋点 |
| `_meta` | key / value | 一次性标记（如 `demo_views_cleared`） |
| `_migrations` | name / applied_at | 迁移记录 |

状态枚举：

- `posts.status`: `draft` / `pending` / `published` / `offline` / `scheduled` / `rejected`
- `users.status`: `active` / `disabled`

---

## 7. 接口设计

REST 风格，统一前缀 `/api`。

| 类别 | 接口 | 说明 |
|---|---|---|
| 认证 | `POST /auth/login` · `POST /auth/register` · `GET /auth/me` · `POST /auth/logout` | 登录 / 注册 / 会话 |
| 内容 | `GET/POST /posts` · `GET/PUT/DELETE /posts/:id` | CRUD |
| 内容 | `POST /posts/:id/transition` | 工作流流转 |
| 内容 | `PATCH /posts/batch` | 批量操作 |
| 内容 | `GET /posts/export` | CSV 导出 |
| 分类 / 标签 | `GET/POST/PUT/DELETE /categories` · `/tags` | CRUD |
| 媒体 | `GET/POST /media` · `GET /media/:id/file` · `DELETE /media/:id` | 上传托管 |
| 用户 | `GET /users` · `PATCH /users/:id` · `DELETE /users/:id` | 用户管理 |
| 角色 | `GET/POST /roles` · `PATCH/DELETE /roles/:id` | 角色管理 |
| 通知 | `GET /notifications` · `POST /notifications/mark` | 站内通知 |
| 看板 | `GET /dashboard?range=` | 指标聚合 |
| 统计 | `GET /stats/overview?days=` · `POST /stats/demo/clear` | 阅读统计 |
| 埋点 | `POST /track` | 公开信标 |
| RSS 代理 | `GET /rss?url=` | 同源代理白名单源（工作台实时资讯，绕过浏览器 CORS） |
| 健康 | `GET /health` | 就绪探测 |

鉴权头：`X-Auth-Token: <jwt>`（优先）或 `Authorization: Bearer <jwt>`。

错误响应统一：`{ "error": "..." }`，常见状态码 400 / 401 / 403 / 404 / 409 / 429 / 500。

> ⚠️ **路由注册顺序**：`/posts/export`、`/posts/batch` 等固定路径必须在 `/posts/:id` **之前**注册，否则会被 `:id` 通配符吞掉（`/posts/export` 被当作 `id = "export"`）。`server.js` 中已按此顺序挂载。

---

## 8. 部署陷阱与运维

### 8.1 部署陷阱

**陷阱 1：`data/` 随发布上传并成为线上库**

发布器上传整个项目目录，`data/starshu.db` 是线上服务的实际数据库。**发布前必须确认本地库是要上线的状态**（清测试账号、测试文章）。

**根治方案（推荐）**：

1. 使用 `.deployignore` 或在发布器后台排除 `data/` / `uploads/` / `test-results/` / `*.log` / `.env`；
2. 或用环境变量指向仓库外目录：`DB_FILE=/var/lib/app/data/starshu.db npm start`；
3. 或在发布器中配置 `data/` 为持久化卷，与代码发布解耦。

**陷阱 2：WAL 边车文件需先 checkpoint**

```bash
node -e "const db=require('better-sqlite3')('data/starshu.db');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
```

**陷阱 3：客户端 IP 逐连接轮换，不能作为限流键**

网关透传的 `X-Forwarded-For` 首跳随连接轮换。本项目限流键改用稳定业务标识：

- 登录 / 注册：**按邮箱**
- 埋点：**按 visitor_id**

IP 仅保留为粗粒度兜底。

### 8.2 发布前自查清单

| # | 检查项 | 方法 |
|---|---|---|
| 1 | 测试全绿 | `npm test` + `npm run check` |
| 2 | 本地库为上线状态 | 无 `@test.local` 账号、无测试文章 |
| 3 | WAL 已 checkpoint | 陷阱 2 命令 |
| 4 | 本地冒烟通过 | 起服务验证 health / 登录 / 限流 |
| 5 | 发布后线上复验 | health 版本、数据状态 |

### 8.3 日常运维

- **每日自动备份**：服务启动后异步触发，生成 `data/backups/starshu-YYYY-MM-DD.db`，`backup.js` 自动保留最近 **7 份**（每天 1 份），超出部分自动删除，无需手动干预。
- **损坏文件清理**：主库自愈时隔离的 `data/starshu.db.corrupt-*` 由 `db.js` 在启动时自动清理 **30 天前**的文件；确认无需恢复时也可手动删除。
- **健康检查**：`GET /api/health` 返回 `db` / `uptime` / `scheduler`。
- **无用内容清理**：不提供专用脚本。如需清理，手动删除 `*.log`、`test-results/`、`uploads/` 中未被 `media` 表引用的文件。**切勿直接删除 `data/starshu.db` 及其 `-wal`/`-shm`**；备份目录由 `backup.js` 自动轮转，无需手动清理。

---

## 9. 测试

```bash
npm test           # 单元 / 集成测试（node:test，零外部依赖）
npm run check      # 语法门禁（全量 node --check）
npm run test:e2e   # 端到端（Playwright，需系统 Edge 或 CI chromium）
```

**覆盖范围**

| 文件 | 覆盖 |
|---|---|
| `tests/smoke.test.mjs` | 健康检查 / 登录 / 看板 / 内容 CRUD / 上传 |
| `tests/rbac.test.mjs` | 权限矩阵 / 越权拦截 / 数据 scope / 防自降权 / 系统角色保护 |
| `tests/workflow.test.mjs` | 状态机合法 / 非法流转 / 驳回理由 / 通知触达 / 定时发布 |
| `tests/stats.test.mjs` | track 去重 / 限流 / 统计口径 / 演示数据清除 |
| `tests/sanitize.test.mjs` | XSS 攻击向量 / 前后端净化一致性 |
| `tests/migrate.test.mjs` | 迁移幂等 / 旧库接管 / fail-fast |
| `tests/requestLog.test.mjs` | 日志降噪策略 / 路由改写回归 |
| `e2e/critical-path.spec.js` | 登录 → 发布 → 上传 → 退出 |

---

## 10. 后续规划

### 已完成（P0 / P1 / P2）

- ✅ 登录 / 埋点限流（`src/lib/rateLimit.js`）
- ✅ 默认管理员恢复策略改为「仅无活跃超管时」
- ✅ HTML 白名单净化（前后端镜像）
- ✅ RBAC / 工作流 / 统计回归测试
- ✅ 演示数据清除后重启不复种（`_meta.demo_views_cleared`）
- ✅ 每日自动备份（`src/lib/backup.js`）
- ✅ Schema 迁移机制（`migrations/` + `_migrations` 表）
- ✅ 请求日志（降噪）+ 健康检查扩展

### 待办（P3 及后续）

- ⬜ 进一步压缩启动（就绪门控路由挂载）
- ⬜ 接入 CI（GitHub Actions 等）
- ⬜ 代码清理（`postScope` 冗余 push / `asyncHandler.wrap` 死代码）
- ⬜ 功能增强：富文本优化、内容版本历史、模板库、内容专题、媒体文件夹、图片压缩、SEO 元信息、自定义 slug、RSS / sitemap、明暗主题、全局搜索、外部 API / Webhook、PWA 等

---

## 10.5 许可证

本项目采用 **双许可证** 模式：

| 版本 | 许可证 | 适用场景 |
|---|---|---|
| **社区版** | [AGPLv3](agpl-3.0.txt) | 个人使用、非商业项目、开源集成 |
| **商业版** | [商业订阅](LICENSE.COMMERCIAL.txt) | 企业内部多实例、SaaS、闭源集成、官方技术支持 |

详见 [`LICENSE.txt`](LICENSE.txt)。

> **AGPLv3 用户**可自行部署任意数量实例、对外提供 SaaS、闭源集成——只需遵守 AGPLv3 开源义务。商业订阅的价值是官方技术支持 SLA、闭源集成合规审查、品牌移除服务、商业责任担保，而非代码功能阉割。

---

## 11. 常见问题

### 初始账号在哪里？

首次启动时 `db.js` 会播种默认管理员：

| 邮箱 | 密码 | 角色 |
|---|---|---|
| `admin@cms.local` | `Admin@123456` | 超级管理员 |

> ⚠️ **仅限本地开发**。公网部署前必须：
> 1. 登录后立即修改密码（目前无改密页面，用下方「忘记密码」脚本改）。
> 2. 设置 `JWT_SECRET` 环境变量（多实例须一致）。
> 3. 确认 `data/starshu.db` 未包含任何 `@test.local` 测试账号。

### better-sqlite3 安装失败

**现象**：`npm install` 报 `prebuild-install` 失败 / `node-gyp rebuild` 失败 / `Could not find any Visual Studio installation`。

**解决方案**：按 Node 版本对号入座。

| Node 版本 | 解决方案 |
|---|---|
| 20 / 22 | `better-sqlite3@^11.3.0` 有现成预编译包，直接 `npm install` 即可 |
| 24 | 必须用 `better-sqlite3@^12.10.0`，先 `npm approve-scripts better-sqlite3` 再 `npm rebuild better-sqlite3` |

### 端口被占用

```bash
# Windows 查占用进程
netstat -ano | findstr :3000
taskkill /PID <pid> /F

# 或换端口
PORT=3100 npm start
```

### 忘记密码

系统没有内置改密页面。用 Node 脚本直接改：

```bash
node -e "const db=require('better-sqlite3')('data/starshu.db');const {hashPassword}=require('./pwd');db.prepare(\"UPDATE users SET password_hash=? WHERE email='admin@cms.local'\").run(hashPassword('你的新密码'));console.log('已修改');db.close()"
```

### 数据库损坏

`db.js` 启动时会自动检测（`quick_check`）并自愈：清 WAL 重开 → 隔离损坏文件（同目录改名为 `data/starshu.db.corrupt-<毫秒时间戳>`）→ 按种子重建。**损坏文件保留 30 天**，由下次启动自动清理，便于后续救援；确认无需恢复也可手动删除 `data/starshu.db.corrupt-*` 文件。

### 怎么清空数据重新开始

```bash
# 停服务后
del data\starshu.db
del data\starshu.db-wal
del data\starshu.db-shm
# 启动会重新 seed（默认管理员 + 演示埋点）
npm start
```

---

**文档版本**：v1.0.0  
**最后更新**：2026-10-21