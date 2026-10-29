# 桓梦工作台（huandream-workbench）

> **本目录是「项目枢纽」的子项目之一**，来自 `starshu-bundle` 发行包中的 `workbench/` 部分。
> 它原本是星枢旁边并列挂载的独立静态前端，现已拆分为独立子项目。

## 一、在枢纽中的位置

| 项 | 说明 |
|---|---|
| 桌面入口 | 枢纽桌面图标 **🧭 桓梦工作台**，双击直接打开应用窗口 |
| 挂载点 | `/apps/workbench/`（枢纽直接按文件托管，**不需要任何后端进程**） |
| 内容 | `www/` 是完整构建产物（`index.html` + `assets/` + `images/` + `music/` + `data/`） |
| 数据 | 全部存在**浏览器本地存储**（localStorage / IndexedDB），换浏览器或清缓存会丢 |
| 与星枢的关系 | 数据完全隔离；`starshu/workbench` 是指向本目录的**目录联接**，避免 14 MB 产物存两份 |

## 二、整合时做的适配

1. **静态托管而非独立服务**：`serve_static` 带目录穿越防护，SPA 路由回落 `index.html`。
2. **`/api/rss` 由枢纽提供**：工作台「实时资讯」原本打星枢 Node 的 `/api/rss`，
   拆开后它不再依赖星枢，改由枢纽侧实现同名接口（白名单仍是 4 个源，避免变成任意地址抓取）。
3. **相对路径天然可用**：构建产物用 `./assets/…` 引用资源，挂到子路径下无需改写
   （这也是它比星枢省事的原因 —— 星枢用的是绝对路径，得逐个改）。
4. **枢纽的 Service Worker 不接管 `/apps/*`**：否则会出现「工作台发了新版、
   枢纽 SW 还回旧 JS」的跨项目缓存幽灵。

## 三、单独运行

任意静态服务器即可，例如：

```bash
cd www && python -m http.server 8080
```

注意单独跑时没有 `/api/rss`（实时资讯会取不到数据），其余功能不受影响。

## 四、许可证与源码

本发行包**仅含构建产物**，不含源码。按 GNU AGPLv3 第 6(b) 条，
对应源码通过书面要约提供，见 `www/WRITTEN_OFFER.md`（联系人：lzc737507@outlook.com）。

许可正文见 `www/LICENSE.txt`、`www/agpl-3.0.txt`、`www/LICENSE.COMMERCIAL.txt`。
