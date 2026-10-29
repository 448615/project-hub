# 第三方资产声明

**项目**：星枢（starshu）
**最后更新日期**：2026-10-21

本项目包含或依赖以下第三方组件。各组件与 AGPLv3 的关系如下：

- 运行时依赖（MIT）：可作为 AGPLv3 项目的组成部分分发，须保留原 MIT 许可证声明。
- 前端内嵌资产（Apache-2.0 ECharts）：以独立文件形式加载（聚合体），不触发 AGPLv3 传染性，保留原 Apache-2.0 许可证头。

---

## 运行时依赖（服务端）

| 组件 | 版本 | 许可证 | 用途 | 仓库 |
|------|------|--------|------|------|
| [Express](https://expressjs.com) | ^4.19.2 | MIT | HTTP 服务与路由 | https://github.com/expressjs/express |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | ^12.10.0 | MIT | SQLite 同步驱动 | https://github.com/WiseLibs/better-sqlite3 |
| [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | ^9.0.2 | MIT | JWT 签发 / 校验 | https://github.com/auth0/node-jsonwebtoken |
| [multer](https://github.com/expressjs/multer) | ^1.4.5-lts.1 | MIT | 文件上传 | https://github.com/expressjs/multer |

## 运行时资产（前端，内嵌）

| 组件 | 版本 | 许可证 | 用途 | 仓库 |
|------|------|--------|------|------|
| [ECharts](https://echarts.apache.org) | 5.5.1 | Apache-2.0 | 看板 / 统计图表（`public/vendor-echarts.js` 内嵌） | https://github.com/apache/echarts |

字体使用系统默认字体栈（`-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`），不引入第三方字体文件。

图标为项目内联 SVG，未使用第三方图标库。

## 开发依赖

| 组件 | 版本 | 许可证 | 用途 |
|------|------|--------|------|
| [@playwright/test](https://playwright.dev) | ^1.64.0 | Apache-2.0 | 端到端测试 |

## 测试运行时

`node:test`、`node:assert`、`node:crypto`、`node:child_process` 等均为 Node.js 标准库，随 Node.js 分发（MIT 许可），不单独列为本项目第三方依赖。

---

## 注意事项

1. **ECharts 内嵌文件**：`public/vendor-echarts.js` 为 Apache-2.0 许可的 ECharts 构建产物，保留了原始许可证头注释。如升级 ECharts 版本，请同步更新该文件并保留许可证头。
2. **multer 1.x（EOL）**：1.x 已于 2025 年停止维护，不再接收安全补丁。当前 `1.4.5-lts.1` 为临时过渡，**生产环境必须升级到 2.x**（API 基本兼容，需核对配置）；升级前建议在 Nginx 层限制上传请求频率以缓解 DoS 风险。
3. **better-sqlite3 原生模块**：需要与 Node ABI 匹配的预编译包或本地编译工具链。部署环境无编译工具时，请使用有预编译包的 Node 版本（20 / 22）。
4. **系统字体**：不引入第三方字体文件，避免字体许可与分发问题。

---

**Developed by 蓝域星河有限公司集团**
