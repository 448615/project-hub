# 数据处理脚本（data-scripts）v2

项目枢纽的数据层：**所有账号数据都存放在本项目内**（本地 `hub_accounts.db`），
并以整条密文同步到云端数据库（`hub_accounts_enc` 表），云端冷启动也不会丢账号。

本目录既被枢纽进程直接加载（登录校验、账号面板），也能脱离枢纽当命令行工具独立运行。

---

## 1. 结构：四层分离

| 文件 | 层 | 职责 | 依赖 |
|---|---|---|---|
| `ds_config.py` | 配置 | 路径 / 日志 / 输出格式 / 权限来源，参数校验 | 标准库 |
| `ds_store/` | 数据访问 | SQLite 读写、密码哈希、AEAD 加密、旧库迁移（原 `data_store.py`，708 行拆成 9 个模块） | 标准库（**不依赖本目录其他模块**） |
| `ds_report.py` | 处理 | 规范化 → 过滤 → 排序 → 截断 → 统计（纯函数，不碰 IO） | 标准库 |
| `ds_output.py` | 输出 | 表格 / JSON / CSV 渲染，原子写盘 | 标准库 |
| `run_all.py` | 编排 | 解析参数 → 校验 → 调度 → 退出码 | 上面四个 |

为什么要这样切：

- **`ds_store/` 不能依赖本目录的其他模块**。枢纽把 `demo-scripts/` 加进 `sys.path`
  后 `import ds_store`，如果它反过来 `import ds_report`，命令行脚本和枢纽的心智就混在一起了。
  它只用标准库，其余模块只被 `run_all.py` 使用。
- **数据层内部按依赖方向单向排列**（改上层不会影响下层）：

  ```
  paths → text → crypto → schema → read → write → migrate / report / cli
  ```

  唯一的可变状态（库路径、密钥路径、主密钥缓存）集中在 `ds_store/paths.py`；
  其他模块一律写 `paths.DB_PATH`，**不要** `from .paths import DB_PATH`——
  那是导入时快照，`configure()` 换库后读到的是旧值。
- **处理层是纯函数**。想验证报表口径，不需要建库、不需要密钥，直接喂 `list[dict]` 即可。
- **输出层不碰数据库**。换格式（表格→JSON→CSV）不影响取数逻辑。

```
demo-scripts/
├── run_all.py        入口：CLI 编排
├── data_store.py     兼容入口（只转发，勿在此加逻辑）
├── ds_store/         数据访问层（枢纽共用，勿改签名）
│   ├── paths.py      路径、常量、configure、唯一可变状态
│   ├── text.py       输入规范化（邮箱/文本/角色）
│   ├── crypto.py     密钥派生 + AEAD + 密码哈希
│   ├── schema.py     连接、建表、加密迁移
│   ├── read.py       只读查询
│   ├── write.py      建号 / 改密 / 改角色 / 删除
│   ├── migrate.py    旧 users.db 迁移
│   ├── report.py     报表
│   └── cli.py        独立命令行
├── ds_config.py      配置与校验
├── ds_report.py      处理层（纯函数）
├── ds_output.py      输出层（渲染 + 落盘）
├── README.md         本文档
├── hub_accounts.db   账号库本体（本地数据，自动创建）
└── exports/          导出的报表（时间戳命名）
```

---

## 2. 快速开始

在枢纽桌面点「数据处理脚本 → ▶ 一键运行」，会执行 `run_all.py` 并弹出**账号数据**面板
（邮箱、用户名、角色、创建时间，可改密 / 改角色 / 删除 / 同步云端）。

命令行等价操作：

```bash
# 账号报表（管理员）+ 自动导出一份 JSON 快照
python demo-scripts/run_all.py

# 只看统计（任何人可跑，不含敏感字段）
python demo-scripts/run_all.py --stats

# 导出
python demo-scripts/run_all.py --export                    # JSON
python demo-scripts/run_all.py --export --format csv       # CSV

# 维护
python demo-scripts/run_all.py --reset-password <邮箱> <新密码>
python demo-scripts/run_all.py --set-role <邮箱> admin|user
python demo-scripts/run_all.py --delete <邮箱>
python demo-scripts/run_all.py --init                      # 建表 + 迁移旧 users.db
```

> 权限：**账号明细只有管理员能看**。前端按钮隐藏只是体验层，服务端
> `/api/admin/accounts*` 与「一键运行」接口（`POST /api/projects/*/start`）
> 都强制校验 `role=admin`，普通用户一律 403。
>
> 命令行身份来自环境变量 `HUB_OPERATOR_ROLE` / `HUB_OPERATOR_EMAIL`
> （枢纽一键运行时会自动注入当前登录者）。本地手动跑：

```bash
# Windows Git Bash / macOS / Linux
HUB_OPERATOR_ROLE=admin python demo-scripts/run_all.py

# Windows PowerShell
$env:HUB_OPERATOR_ROLE="admin"; python demo-scripts/run_all.py
```

---

## 3. 参数一览

### 3.1 动作（互斥，一次只能选一个）

| 参数 | 说明 | 需要管理员 |
|---|---|---|
| （不带参数） | 打印账号报表，并自动导出 JSON 快照 | 是 |
| `--stats` | 只输出统计摘要 | 否 |
| `--export` | 只导出文件，不打印表格 | 是 |
| `--init` | 建表 + 迁移旧 `users.db`（幂等） | 否 |
| `--reset-password EMAIL PASSWORD` | 重置密码（密码 ≥ 6 位） | 是 |
| `--set-role EMAIL ROLE` | 改角色：`admin` / `user` | 是 |
| `--delete EMAIL` | 删除账号 | 是 |

### 3.2 输出

| 参数 | 默认 | 说明 |
|---|---|---|
| `--format {table,json,csv}` | `table` | 输出格式；`--export` 时默认 `json` |
| `--export-dir DIR` | `demo-scripts/exports` | 导出目录 |
| `--no-export` | 关 | 报表模式下不自动导出快照 |

### 3.3 数据与筛选

| 参数 | 默认 | 说明 |
|---|---|---|
| `--db PATH` | `demo-scripts/hub_accounts.db` | 账号库路径 |
| `--filter-email KW` | 空 | 邮箱包含该子串（大小写不敏感） |
| `--role {admin,user}` | 空 | 只看某个角色 |
| `--keyword KW` | 空 | 邮箱或用户名包含该关键词 |
| `--sort {id,email,username,role,created_at,updated_at}` | `id` | 排序字段 |
| `--desc` | 关 | 倒序 |
| `--limit N` | `0`（不限） | 最多显示 / 导出 N 条 |

### 3.4 运行

| 参数 | 默认 | 说明 |
|---|---|---|
| `--log-level {DEBUG,INFO,WARNING,ERROR,CRITICAL}` | `INFO` | 日志级别（输出到 stderr） |
| `--log-file PATH` | 空 | 日志追加写入文件 |
| `--dry-run` | 关 | 只显示将做什么：**不修改账号数据、不写导出文件** |
| `--quiet` | 关 | 只输出结果，不输出过程日志 |
| `--version` / `-h` | — | 版本 / 帮助 |

### 3.5 环境变量

| 变量 | 作用 |
|---|---|
| `DATA_SCRIPTS_DB` | 账号库路径（等价 `--db`） |
| `DATA_SCRIPTS_EXPORT_DIR` | 导出目录（等价 `--export-dir`） |
| `DATA_SCRIPTS_LOG_LEVEL` | 日志级别（非法值自动降级为 INFO 并告警） |
| `DATA_SCRIPTS_LOG_FILE` | 日志文件路径 |
| `HUB_OPERATOR_EMAIL` | 操作者邮箱（枢纽注入） |
| `HUB_OPERATOR_ROLE` | 操作者角色；`admin` 才能看明细 |

优先级：**命令行参数 > 环境变量 > 内置默认值**。环境变量写错只降级并告警，
命令行写错直接报错退出（当场可改）。

---

## 4. 退出码

| 码 | 含义 | 典型场景 |
|---|---|---|
| `0` | 成功 | 报表打印/导出完成 |
| `1` | 业务失败 | 账号不存在、库不可写、删除失败 |
| `2` | 参数或配置错误 | 非法邮箱、密码太短、未知参数、互斥参数同用 |
| `3` | 权限不足 | 非管理员要看明细 / 改数据 |

脚本不会以 traceback 形式崩给用户：所有异常都会转成 `[错误] ...` + 非零退出码。

---

## 5. 输入校验与错误处理

| 输入 | 校验规则 | 违规表现 |
|---|---|---|
| 邮箱 | 非空、含 `@`、域名含点且不以点开头/结尾、无空白、≤ 1024 字符 | 退出码 2 |
| 密码 | 非空、≥ 6 位、≤ 1024 字符 | 退出码 2 |
| 角色 | 只能是 `admin` / `user` | 退出码 2 |
| 格式 / 排序字段 | argparse 限定取值 | 退出码 2 |
| 条数上限 | 非负整数 | 退出码 2 |
| 库文件 | 不可写时降级为只读并告警，不中断 | 退出码 0 + warning |

数据库层面的脏数据也不会让报表崩：`ds_report.normalize_row()` 会把 `None`、
非法角色、坏时间戳、缺用户名统统归一（角色按 `user`、时间显示 `-`、用户名回退邮箱前缀），
非字典行直接跳过。

---

## 6. 日志

- **结果**走 `stdout`（表格 / JSON / CSV），**过程**走 `stderr`，管道里互不污染；
- 默认格式：`2026-10-27 16:15:29 INFO    hub.datascripts: 已导出：...`；
- `--log-file` 额外写文件，文件不可写时只告警、不阻断业务；
- `--quiet` 等价于把级别提到 `WARNING`；
- 日志**从不打印密码或密文**，最多打印邮箱和被影响的账号数。

排障建议：

```bash
python demo-scripts/run_all.py --stats --log-level DEBUG
python demo-scripts/run_all.py --export --log-file logs/ds.log
```

---

## 7. 测试

```bash
python tests/test_data_scripts.py -v      # 33 项：配置/处理/输出/数据层/CLI
```

测试全部使用临时目录与临时库，不会读写真实账号库；用完即删。

---

## 8. 数据模型

`hub_accounts.db` → 表 `accounts`

| 列 | 说明 |
|---|---|
| `id` | 自增主键 |
| `username` | 用户名 |
| `email` | 唯一，登录名（入库前统一小写去空白） |
| `pwd_hash` | 本机密钥加密的 `salt$pbkdf2_sha256`，登录校验用 |
| `pwd_enc` | 历史遗留列，**自 v2 起恒为空**（不再保存可逆明文副本） |
| `role` | `admin` / `user`（角色只认显式传入，不再"首个注册即管理员"） |
| `created_at` / `updated_at` | Unix 时间戳 |

云端表 `hub_accounts_enc` 只存 `email_idx`（HMAC 索引）+ `blob`（AEAD 密文）+ `sig`（签名）；
服务端直接读 `cloud.public.json` 的 `endpoint + publishableKey`（`accounts._cloud_cfg()`），
调 `/.cloud/database/rest/hub_accounts_enc` 读写，读出后逐条解密。

### 加密要点

- 主密钥 `.data/secret.key`（64 字节，权限 600），用 HKDF-SHA256 按用途派生独立子密钥
  （本地账号 / 云端副本 / 会话签名 / 邮箱索引互不牵连）；
- 密文格式 `v2:` + base64url(nonce 12 | 密文 | tag 32)，Encrypt-then-MAC；
- `aad` 绑定邮箱，**把 A 行的密文搬到 B 行会直接验签失败**；
- 解密一律"先验 MAC 再解密"，任何异常返回空串，绝不"降级放行"。

---

## 9. 安全边界

- 账号报表**永远不返回明文密码**（`pwd_enc` 已停用）。登录校验只用不可逆的
  `pwd_hash`；可逆明文只会放大「密钥泄露 → 全库密码可读」的爆炸半径。
- 报表 / 导出 / 改密 / 改角色 / 删除均要求管理员；普通用户只能看 `--stats`。
- 导出的 JSON / CSV 写盘权限 `600`，且采用「临时文件 + 原子替换」，
  中断不会留下半截文件。
- 拷走 `.db` 而不带 `secret.key`，`pwd_hash` 无法解密，无法离线爆破。
- 用 `--db` 指向自定义库时**不会**自动迁移项目根的 `users.db`，避免误导入。

---

## 10. 与枢纽的契约（改动前必读）

`hub/store.py` 把 `demo-scripts/` 加进 `sys.path` 后 `import ds_store`，并直接调用下列符号，
**签名与返回语义不可变**：

```
subkey  aead_encrypt  aead_decrypt  hash_pwd  check_pwd
create  get_by_email  get_by_id  count  set_password
set_role  delete  list_accounts  raw_hash  init_db
migrate_legacy  build_report  configure
```

**这份清单是有测试守着的**：`tests/test_datastore_contract.py` 会逐项校验符号是否存在、
关键函数的参数名与顺序是否被改动、以及 `ds.DB_PATH` 是否仍随 `configure()` 实时变化。
改名或调参顺序而不改测试，CI 立刻报红——不用等线上登录失败才发现。

- `create()` → `(ok: bool, err: str)`
- `build_report()` → `{generated_at, db_path, total, admins, accounts}`（账号面板直接消费）
- 其余写操作 → `bool`

改动这些函数后，至少跑一遍 `python tests/test_data_scripts.py`。
