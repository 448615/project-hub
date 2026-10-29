# 枢纽（project-hub）

单进程 Web 服务：把多个子项目以桌面形式集中呈现、一键启动、运行与托管。
后端只用 **Python 标准库**（零第三方依赖），前端是手写的原生 JS/CSS，没有构建步骤。

- 版本：见 `hub/version.py`（必须与 `pyproject.toml` 的 `[project].version` 一致，CI 会拦）
- 详细设计：`功能文档.md`　安全模型：`SECURITY.md`　子项目改进建议：`子项目优化建议.md`

## 子项目一览

| 子项目 | 路径 | 端口 | 枢纽内挂载 | 说明 |
|---|---|---|---|---|
| 星枢 starshu | `starshu/` | 3000 | `/apps/starshu/`（Python 反向代理，懒启动） | 内容运营中枢 CMS：登录认证 / RBAC / 内容工作流 / 定时发布 / 媒体库（Express + SQLite） |
| 桓梦工作台 workbench | `workbench/` | — | `/apps/workbench/`（静态直供） | 纯前端效率工作台；仓库里只有构建产物 `workbench/www/`，数据存在浏览器本地 |
| 内置浏览器 browse | `browse/` | — | `/api/browse/*` | 站点反代内核（8 个模块），对外仍由根目录 `browse_proxy.py` 薄壳导出 |
| 数据脚本 demo-scripts | `demo-scripts/` | — | — | 账号数据层 + CLI。`ds_store/` **被枢纽直接 import**，删了登录就崩 |
| Web 前端 demo-web | `demo-web/` | 5173 | — | 演示桩（标准库静态页），用于演示「一键启动 + iframe 预览」 |
| API 服务 demo-api | `demo-api/` | 8081 | — | 演示桩（标准库状态页），用于演示接口类子项目 |

## 环境要求

- **Python ≥ 3.11**（`pyproject.toml` 的 `requires-python`），运行时零第三方依赖
- **Node.js**（仅星枢需要，Dockerfile 用 Node 22；`starshu/.npmrc` 已配 npmmirror）

## 本地启动

```bash
# 枢纽本体（默认 http://127.0.0.1:8000，本地模式禁止绑 0.0.0.0）
python main.py
python main.py --port 18080 --no-browser    # 换端口 / 不自动开浏览器

# Windows 双击：start-hub.bat（会自动探测可用的 Python）
# 交互式选端口：python start.py
```

星枢可以独立起（枢纽也会在首次访问 `/apps/starshu/` 时懒启动它）：

```bash
cd starshu
npm install
npm start          # 或 Windows 双击 start.bat / POSIX ./start.sh
curl -I http://127.0.0.1:3000/
```

> 云端模式：检测到 `PORT` 环境变量（或显式 `--cloud`）时绑定 `0.0.0.0`、读取 `$PORT`，
> 并启用登录与权限闸门（普通用户只读、管理员全功能）。

## 克隆后必须做的两件事

**1) 重建 `starshu/workbench` 目录联接**（它是指向根 `../workbench` 的 junction，不能进 git）

```bat
:: Windows（cmd，普通权限即可，junction 不需要管理员）
mklink /J starshu\workbench workbench
```
```bash
# POSIX
ln -s ../workbench starshu/workbench
```

缺了这一步，`starshu` 的 `/workbench/` 会静默落到星枢前台（`server.js:128` 的
`express.static` 挂到不存在的路径 → 走 `:133` 通配兜底），不报错，只是页面不对。

**2) 视需要配置云端服务**

```bash
copy cloud.example.json cloud.json     # 按需填写；不填也能跑
```

`cloud.json` 含真实共享密钥，已被 `.gitignore` 排除。不配置时：云端账号副本同步与
邮箱验证码自动停用（健康检查里 `cloud` 显示 disabled），其余功能不受影响——
可公开的 `endpoint` / `publishableKey` 已在 `cloud.public.json` 里（该文件入库）。

## 不入库的文件

| 排除项 | 原因 |
|---|---|
| `cloud.json` | 含真实 `hubSecret`，是仓库里唯一带真密钥的文件 |
| `.data/`（`secret.key`、`hub.log`） | 会话主密钥与诊断日志，换机器会自动重建 |
| `*.db` / `*.db-wal` / `*.db-shm` | 账号库与星枢数据库，含加密口令与业务数据 |
| `starshu/data/`（含 `backups/`、`jwt.secret`） | 星枢运行时数据与 JWT 密钥 |
| `starshu/node_modules/` | 依赖，`npm install` 重建（`package-lock.json` 入库） |
| `starshu/workbench` | 目录联接，存的是本机绝对路径，见上一节 |
| `.publish-hold/` | 发布工具的隔离事务痕迹，含本机绝对路径 |
| `__pycache__/`、`.pytest_cache/`、`*.log` | 生成物 |

发布到云端时另有一道闸门：`tools/prepublish.py`（**发布工具是整目录上传，不读 .gitignore**）。

## 测试

枢纽（`unittest`，逐文件可独立运行）：

```bash
python tests/test_auth_policy.py        # 任意一个
for f in tests/test_*.py; do python "$f" || echo "FAIL $f"; done
```

> 其中 `test_demo_crypto_kat.py`、`test_perf_layer.py`、`test_proxy_security.py`、
> `test_static_serving.py` 是自定义 runner，看**退出码**而不是 `Ran N tests` 行。

子项目：

```bash
cd starshu && npm test                  # node --test
cd starshu && npx playwright test       # e2e
node workbench/tests/storage-guard.test.mjs
```

## CI

`.github/workflows/ci.yml`：`ubuntu-latest` / `windows-latest` × Python 3.11 / 3.12，
跑语法编译、版本号一致性（**硬门禁**）、9 套测试（`continue-on-error`）、ruff（`continue-on-error`）。

## 已知项

- `starshu/e2e/critical-path.spec.js` 里硬编码了明文测试口令，计划改为读 `process.env`。
- `config.json` 含管理员邮箱（同时也是提交身份），若将来把仓库推到公开远端需重新评估。
- `starshu/.gitignore` 的 `data/` 没有前导斜杠锚定，会连带忽略 `starshu/` 下任意层级的
  `data/` 目录（例如 `workbench/www/data/articles.json` 若改由 starshu 提供就会漏提交）。
- `cloud.json` 目前**会被发布工具整目录上传**（`tools/prepublish.py` 的规则表里没有它），
  与 git 无关，属既有风险。

## 许可证

`starshu/LICENSE.txt`（AGPL-3.0）、`starshu/LICENSE.COMMERCIAL.txt`、
`workbench/www/LICENSE.txt`（保留原作者署名）。根目录其余代码随项目自有。
