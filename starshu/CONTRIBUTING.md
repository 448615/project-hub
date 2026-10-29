# 星枢（starshu）- 贡献指南

感谢您对 **蓝域星河有限公司集团** 旗下开源项目 **星枢（starshu）** 的关注！我们欢迎所有形式的贡献，包括但不限于代码、文档、Bug 报告、安全加固建议、测试用例等。

## 📌 适用范围

本贡献指南适用于 **星枢（starshu）** 项目，隶属于 **星海量子通用操作系统（StarseaOS）**。

## 📋 行为准则

请阅读并遵守本节，共同营造友好、尊重、专业的社区氛围：

- **尊重他人**：尊重所有贡献者和用户的意见、经验和背景。
- **专业交流**：保持建设性和专业性的沟通，避免人身攻击和不当言论。
- **安全优先**：涉及认证、权限、净化、限流的修改，必须附带安全影响说明。
- **数据负责**：不得引入后门、遥测上传、未经用户同意的外部请求。
- **合规使用**：不得将本项目用于侵犯他人著作权、隐私权或其他合法权利的用途。

**不可接受的行为**：性化语言或图像、挑衅/侮辱/人身攻击、公开或私下骚扰、未经许可发布他人私人信息。

**执行**：如遇滥用、骚扰或其他不可接受的行为，可通过 `lzc737507@outlook.com` 联系项目团队。所有投诉都将被及时、公平地审查和调查。安全漏洞请**勿**公开提交 Issue，请通过邮件私下报告，我们会在 72 小时内响应。

本行为准则改编自 [Contributor Covenant](https://www.contributor-covenant.org) 2.1 版。

## 🔄 贡献流程

### 1. 报告 Bug 或功能建议

- 请在 GitHub Issues 中搜索是否已存在类似问题。
- 如不存在，请创建新的 Issue，填写详细描述：
  - **Bug 报告**：问题现象、复现步骤、预期行为、实际行为、环境信息（操作系统、Node 版本、数据库是否为新库）。
  - **功能建议**：期望的功能、使用场景和可能的价值。
  - **安全漏洞**：请**不要**公开提交 Issue，通过邮件 `lzc737507@outlook.com` 私下报告，我们会在 72 小时内响应。

### 2. 提交代码（Pull Request）

1. **Fork 仓库** 到您的 GitHub 账号。
2. **克隆到本地**：`git clone https://github.com/your-username/starshu.git`
3. **创建分支**：`git checkout -b feature/your-feature-name` 或 `fix/issue-123`
4. **编写代码**：
   - 遵循现有代码风格
   - 添加必要的注释
   - **补充或更新测试**（见下方测试要求）
   - 确保不影响现有功能
5. **本地验证**：
   ```bash
   npm test
   npm run check
   npm run test:e2e   # 如改动涉及前端关键路径
   ```
6. **提交代码**：`git commit -m "feat(posts): 简洁描述"`
7. **推送并提交 PR**：清晰描述修改内容、动机、测试情况、安全影响。

### 3. 代码审查

- 维护者将审查 PR，可能提出修改意见。
- 请及时响应反馈。
- 涉及安全基线的修改（认证 / 权限 / 净化 / 限流 / 备份）至少需要一名维护者明确批准。

## ⚠️ 贡献者许可协议（CLA）

本项目采用 **双许可证（AGPLv3 / 商业订阅）** 模式。为保护项目长期发展与商业可持续性，**所有贡献者必须同意 [贡献者许可协议（CLA）](./CONTRIBUTOR_LICENSE_AGREEMENT.md)**。

**提交 Pull Request，即视为您已阅读、理解并同意该协议。**

## 🛠️ 开发环境搭建

### 基础环境

- Node.js ≥ 18（推荐 20 LTS）
- npm ≥ 9

```bash
git clone https://github.com/your-username/starshu.git
cd starshu
npm install
# 可选：按需创建 .env 自定义 PORT / JWT_SECRET（无此文件也能启动）
npm start
```

### 使用临时数据库（推荐）

避免污染开发库 `data/starshu.db`：

```bash
# Windows PowerShell
$env:DB_FILE = "$env:TEMP/cms-test/test.db"
npm start

# macOS / Linux
DB_FILE=/tmp/cms-test/test.db npm start
```

`npm test` 已自动使用临时库，无需额外设置。

## 📁 项目结构

```
starshu/
├── server.js                 # 入口：路由挂载、health、静态资源、错误处理
├── db.js                     # 建表基线 + 种子 + 自愈 + 迁移调用
├── auth.js                   # JWT + 权限中间件
├── pwd.js                    # scrypt 哈希
├── src/
│   ├── routes/               # auth / posts / categories / tags / media / users / roles / notifications / stats / track / dashboard
│   ├── lib/                  # rateLimit / requestLog / sanitize / backup / migrate / scheduler / upload / notifications / permissions / helpers / errorHandler
│   └── shared/maps.js        # 状态 / 角色文案与徽章类名
├── public/                   # 星枢前端 SPA（原生 ES Module）
├── migrations/               # NNN_*.sql
├── tests/                    # node:test
├── e2e/                      # Playwright
```

## 📐 代码风格

### JavaScript（服务端）

- 遵循项目现有风格：CommonJS（`require` / `module.exports`），2 空格缩进
- 函数名 `camelCase`，类名 `PascalCase`，常量 `UPPER_SNAKE_CASE`
- **SQL 一律参数化**；仅可信来源（如 token 中的整数 `uid`）可拼接到 SQL 片段，且须在注释中说明可信性
- 新增路由必须挂载 `authMiddleware` + `requirePermission(...)`
- 错误统一 `throw` 或 `res.status(...).json({ error })`，由全局 `errorHandler` 兜底

### JavaScript（前端）

- 原生 ES Module，2 空格缩进
- 视图渲染使用 `setView()` + `viewEpoch` 防过期写入
- 网络请求统一走 `api.js`，不直接 `fetch`
- 用户输入渲染必须经 `esc()`；富文本经 `sanitize.js`

### CSS

- 2 空格缩进，类名 `kebab-case`
- 优先使用 `:root` 中已定义的 CSS 变量
- 新增组件样式放在 `styles.css` 对应区块，并加注释分隔

### SQL / 迁移

- 表名 / 列名 `snake_case`
- 索引命名 `idx_{表名}_{列名}`
- **不要修改 `db.js` 中的建表基线来加列**；列级演进一律新增 `migrations/NNN_xxx.sql`
- 迁移文件必须幂等或在 `migrate.js` 的「已应用」规则内可安全跳过

## 📝 提交规范

```
<type>(<scope>): <subject>

<body>
```

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 格式调整（不影响功能） |
| `refactor` | 重构 |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建 / 工具变动 |
| `security` | 安全加固 |

**Scope 建议**：`auth` / `posts` / `users` / `roles` / `media` / `stats` / `track` / `db` / `migrate` / `backup` / `sanitize` / `rateLimit` / `ui` / `docs`

**示例**：

```
feat(posts): 批量操作支持追加标签

PATCH /posts/batch 新增 action=tags，事务内合并去重，
保持原有 action 行为不变。补充 rbac 用例覆盖越权场景。
```

```
security(sanitize): 拦截协议内嵌零宽字符绕过

URL 白名单校验前剔除 U+200B~U+200D 等零宽字符，
新增攻击向量回归用例，前后端镜像同步修改。
```

## 🧪 测试

提交 PR 前请确保：

### 1. 语法门禁通过

```bash
npm run check
```

### 2. 单元 / 集成测试通过

```bash
npm test
```

新增功能必须附带 `node:test` 用例；修复 Bug 尽量附带回归用例。

### 3. 端到端（如涉及前端关键路径）

```bash
npm run test:e2e
```

### 4. 重点回归项

- 工作流状态机：非法流转 409、越权 403、scope 外 404
- 批量操作：空 `ids` 400、越权不生效、`count` 正确
- 净化器：新增攻击向量前后端输出一致
- 迁移：新库按序应用、旧库 `duplicate column` 接管、失败不记录
- 限流：IP 轮换下按业务键仍能触发

### 5. 数据安全

⚠️ **测试清理 / 批量删除 / 迁移时，务必使用临时 `DB_FILE`**，禁止在开发库 `data/starshu.db` 上做破坏性测试。

## 🚫 禁止提交

- ❌ 真实的用户数据、生产数据库文件、`data/starshu.db`
- ❌ 包含真实密钥 / token / 密码的代码或配置
- ❌ 硬编码的本地绝对路径
- ❌ 会向第三方服务器发送用户数据的代码
- ❌ 削弱安全基线的改动（除非附带充分论证与替代方案）
- ❌ 未附测试的权限 / 认证 / 净化相关改动

## 🎯 贡献方向建议

### 高优先级

- 🐛 修复已知 Bug
- 🔐 安全加固（净化绕过、限流绕过、越权）
- 📖 完善部署陷阱与运维文档
- 🧪 补充回归测试

### 中优先级

- ⚡ 启动优化（就绪门控路由挂载）
- 🎨 前端交互优化
- 🌐 国际化
- 🔌 内容版本历史、自定义 slug、RSS / sitemap

## 📄 许可证

向本项目提交贡献，即表示您同意您的贡献将在 **双许可证（AGPLv3 / 商业订阅）** 下发布。

详见 [`LICENSE.txt`](./LICENSE.txt)。

## 📞 联系方式

**蓝域星河有限公司集团**
- 系统网站：https://aitanser.github.io/starsea-os/
- 电子邮箱：lzc737507@outlook.com
- GitHub Issues：提交 Issue 或 Pull Request

---

**感谢您的贡献！**
