# 桓梦工作台（workbench）补丁登记

> **这个文件是给「下一次升级前」的自己看的。**
> 工作台只有构建产物、没有源码（AGPLv3 发行包），我们改过的东西全部直接落在压缩后的
> bundle 里。一旦覆盖 `workbench/www/`，这些补丁会**静默消失**，而回归症状和首次故障
> 一模一样——很难想到根因是"升级把补丁冲掉了"。
>
> 升级前必读第 4 节；升级后必跑第 5 节的自检。

---

## 1. 现状与前提

| 项 | 值 |
|---|---|
| 部署目录 | `workbench/www/` |
| 入口 | `workbench/www/index.html` |
| 主 bundle | `workbench/www/assets/index-k3Vt9Qmd.js`（约 108 KB，11 行压缩代码） |
| 样式 | `workbench/www/assets/index-BxNXup4h.css` |
| 源码 | **无**（发行包只有产物） |
| 维护方式 | 直接对产物打补丁；每个补丁必须在此登记 |

bundle 是压缩的：**最长单行约 56,000 字符**。用编辑器直接打开会非常卡，建议用
`grep -o` / Python 按锚点定位后局部替换，不要全文格式化重排（会破坏 sourcemap 与
压缩语义，也可能撑爆编辑器）。

---

## 2. 补丁清单

### P-1　播放失败分流（3 处）

- **解决什么**：`<audio>` 播放失败时，原代码只弹一句"播放失败：xxx"。但这个提示无法
  区分两种完全不同的故障——用户没点过页面（`NotAllowedError`，点一下 ▶ 就好）和音频
  文件本身损坏（`NotSupportedError`，需要清库重载）。后者如果只提示"播放失败"，用户
  会反复点、反复失败，永远好不了。
- **怎么改**：`catch` 分支改为先调用 `window.__hmMusicFail(a)`，由 `heal-music.js`
  按错误类型分流；`__hmMusicFail` 不存在时（脚本没加载）退回原提示，保证不更坏。
- **锚点**：`__hmMusicFail` 在 bundle 中出现 **4 次**（1 次定义在 `heal-music.js`，
  3 次调用在 bundle 内）。bundle 内的三处分别对应：
  1. `oe` 里首次播放：`.play().then(()=>{...}).catch(a=>{...})`
  2. 同函数的另一分支：同上（两条 `catch(a=>` 结构）
  3. 暂停/续播切换：`.catch(t=>{...})`（变量名是 `t` 不是 `a`）
- **改后形态**（三处一致）：
  ```js
  .catch(a=>{console.error("[Music] play failed:",a),
    window.__hmMusicFail?window.__hmMusicFail(a):m("播放失败："+(a.message||a),"error")})
  ```

### P-2　播放列表损坏条目过滤（1 处）

- **解决什么**：工作台把播放列表连同音频 `File` 一起持久化在 IndexedDB `MusicDB`
  （objectStore `tracks`，key `"list"`）。如果某条目存进去的"音频"其实是网关返回的
  HTML（曾因分享链接未带 sharecode，`.mp3` 被 403 页面顶替），这条坏数据会**永久**
  卡在库里——每次启动都读到非空列表，于是不再拉默认音乐，一路播到坏条目就失败。
- **怎么改**：读库后按 `file.type` 是否 `audio/*` 过滤；过滤后为空则视为"用户清空"，
  重置标志并重新拉默认列表。
- **锚点**：`丢弃损坏条目`
- **改后形态**：
  ```js
  js().then(n=>{if(n&&n.list&&n.list.length){
    var _ok=n.list.filter(function(x){return x&&x.file&&/^audio\//i.test(x.file.type||"")});
    if(_ok.length!==n.list.length&&console.warn("[Music] 丢弃损坏条目",n.list.length-_ok.length),
    n.list=_ok,_ok.length===0){E("musicUserCleared",!1),St();return}}
    n&&n.list&&n.list.length?(c.musicList=n.list,...
  ```

### P-3　启动兜底与音乐自愈的外链脚本（`index.html`，非 bundle 内补丁）

- **新增文件**：
  - `workbench/www/boot-guard.js` —— 脚本加载失败 / `file://` 直接打开时显示红色告警条。
  - `workbench/www/heal-music.js` —— 实现 `window.__hmMusicFail`，按错误类型分流；
    损坏条目走"清 `MusicDB` + reload"，并用 `sessionStorage.hm_musicHealCount`
    限制最多自愈 2 次，防无限刷新循环。
- **`index.html` 引用顺序（顺序有意义，不要调换）**：
  ```html
  <!-- 必须排在最前：注册脚本加载失败的兜底监听，晚于主 bundle 就等于没注册 -->
  <script src="./boot-guard.js"></script>
  <script src="./heal-music.js"></script>
  <!-- 本地存储守卫：版本标记 + 启动扫描 + 一键修复（见 P-4） -->
  <script src="./storage-guard.js"></script>
  <script type="module" crossorigin src="./assets/index-k3Vt9Qmd.js"></script>
  ```
- **为什么 `boot-guard.js` 必须在前**：它用捕获阶段监听 `error` 事件来发现 `<script>`
  加载失败。**监听器注册本身要早于出问题的脚本**。早期版本把这段内联写在 `<body>`
  末尾，而模块脚本在 `<head>` 里——主 bundle 一旦 404，错误早已触发完毕，监听器才刚
  注册，告警条永远不会出现（兜底机制本身失效）。
- **为什么是外链而不是内联**：枢纽的 CSP 是 `script-src 'self'`，内联脚本要依赖
  `'unsafe-inline'`。虽然子应用当前没被套用枢纽 CSP（见 `subapps._subapp_sec_headers`
  的注释），但一旦将来收紧，内联块会静默失效且没有任何报错。外链同源文件天然合规。

### P-4　本地存储守卫（新增 `storage-guard.js`，非 bundle 内补丁）

- **新增文件**：`workbench/www/storage-guard.js`（约 400 行，含注释）
- **它解决的问题**：应用的数据全在浏览器本地，而应用自身的读取逻辑是「读到非空就当
  正常」。历史上音乐永久卡死就是这么来的（IndexedDB 里存着损坏条目，每次都优先恢复）。
  守卫补三件事：
  1. **版本标记**：在 `hm_settingsMeta`（**不是** `hm_settings`，理由见文件头决策 A/B）
     里写 `schemaVersion`，让「数据是哪个版本写的」可判定，并提供 `MIGRATIONS` 钩子。
  2. **通用健康检查**：按类型表扫描 `hm_*` 键 + `MusicDB` 播放列表记录。类型表由 bundle
     里 `b("<key>", <默认值>)` 的默认值反推，**未登记的键一律放过**（避免应用升级后误报）。
  3. **一键修复**：删除前把原文写进 `sessionStorage.hm_guard_backup_<键名>`，且必须用户
     点击确认——守卫不会在启动时静默删任何数据。
- **`index.html` 附带一处文案**：设置 → 数据管理 里补了一段说明，讲清「JSON 备份不含
  音乐文件（音乐在 IndexedDB，换浏览器需重新导入）」。原文案容易让人以为备份是完整的。
- **版本号为什么必须叫 `hm_settingsMeta`**：应用「导入数据备份」的键名白名单判定是
  `g === y || g.startsWith(y.substring(0, y.length - 1))`——注意最后一位被截掉，所以只有
  以 `setting` 开头的键才会被接受。用 `hm_schemaVersion` 的话，导入备份时会被当成无效
  数据丢弃，恢复出来的数据永远没有版本号。`tests/test_workbench_guard.py` 里有断言锁死
  这个耦合（它同时校验 bundle 里那段判定代码还在）。
- **为什么不把版本塞进 `hm_settings`**：应用的设置读取是「存的是对象就直接用」，不做默认
  值合并。若在 `hm_settings` 尚不存在时先写 `{schemaVersion:2}`，应用会读到缺字段的设置
  （主题、透明度等全部 undefined）。
- **对外 API**：`window.__hmStorageGuard`（`diagnose()` / `heal()` / 纯函数若干），
  排查线上问题时可在控制台直接调用。
- **测试**：`workbench/tests/storage-guard.test.mjs`（22 项，`node --test`），
  `tests/test_workbench_guard.py`（静态契约 + 调用上面的 node 套件）。

---

## 3. 与枢纽的分工（别在错误的地方修）

| 问题 | 该在哪修 |
|---|---|
| 音频文件被网关 403 → HTML 冒名顶替 | 枢纽/网关层（分享码 Cookie），不是工作台 |
| 已损坏的 IndexedDB 条目 | 工作台（P-2 + `heal-music.js`），因为数据在浏览器里 |
| 静态资源缓存不刷新 | 枢纽 `subapps.serve_static`（统一 `no-cache` + ETag） |
| 子应用缺 X-Frame-Options / Referrer-Policy | 枢纽 `subapps._subapp_sec_headers`（子应用自己也发不出来，见该函数注释） |
| 页面打不开、白屏 | 先看 `boot-guard.js` 有没有显示告警条；没有就看是不是外链文件本身没发出去 |

---

## 4. 升级流程（覆盖 `www/` 之前）

1. **先备份当前产物**（不要只备份 `index.html`，补丁在 bundle 里）：
   ```bash
   cp -r workbench/www /tmp/workbench-www-backup-$(date +%Y%m%d)
   ```
2. **记录现有补丁指纹**，升级后用来对比：
   ```bash
   # 注意：bundle 是压缩的，多处在同一行 —— 必须用 grep -o | wc -l 数"次数"。
   # grep -c 数的是"行数"，这里会得到 1，会让人误判补丁丢了。
   grep -o "__hmMusicFail" workbench/www/assets/*.js | wc -l     # 期望 4
   grep -o "丢弃损坏条目"   workbench/www/assets/*.js | wc -l     # 期望 1
   ```
3. 覆盖新版本产物，**保留** `boot-guard.js`、`heal-music.js`、`storage-guard.js`
   三个文件（它们在 `www/` 根目录，通常是新增文件、不会被覆盖；但若整目录替换就会丢）。
4. 按第 5 节自检。**补丁数量对不上就是被冲掉了**，按第 2 节锚点重打。
5. 重打后必须真机验证（第 5 节的第 3、4 项），不能只看 grep 命中。

> 注意：bundle 文件名带内容哈希（如 `index-k3Vt9Qmd.js`），升级后名字会变。
> **不需要再手工改名破缓存**——枢纽已改为 `no-cache` + ETag 协商（见
> `subapps.serve_static`），改了内容浏览器会自动重拉。

---

## 5. 自检清单（升级后必跑）

```bash
cd <项目根>

# 1) 补丁是否还在（grep -o | wc -l 数次数；grep -c 只能数行，压缩产物会误报）
grep -o "__hmMusicFail" workbench/www/assets/*.js | wc -l   # 期望 4
grep -o "丢弃损坏条目"   workbench/www/assets/*.js | wc -l   # 期望 1

# 2) 外链脚本是否还在、引用顺序是否正确
ls workbench/www/boot-guard.js workbench/www/heal-music.js workbench/www/storage-guard.js
grep -n "<script" workbench/www/index.html
#   期望顺序：boot-guard.js → heal-music.js → storage-guard.js → assets/index-*.js
#   且页面内不得出现内联 <script>（无 src 的那种）

# 3) 页面能否正常打开（无告警条）
#   浏览器开 /apps/workbench/，#fatalBanner 应为 display:none

# 4) 兜底是否真的有效（关键，别省）
#   临时把主 bundle 改名，刷新页面，应看到红色"核心脚本加载失败"告警条；
#   改回名字后告警消失。

# 5) 音乐是否可播
#   首次进入自动加载默认音乐；点播放能出声；控制台无 [Music] play failed

# 6) 存储守卫是否生效（语义级，不能只看文件在不在）
cd workbench && node --test                  # 期望 22 项全过
#   坑：node --test tests/ 会把目录当单个测试文件跑，直接 FAIL(1)，必须不带路径参数
python -m unittest tests.test_workbench_guard -q
#   控制台：__hmStorageGuard.diagnose() 应返回 {version:2, issues:[], music:{status:'ok',issues:[]}}
#   数据健康时不应出现 #hmGuardBanner 提示条
#   把 hm_todos 手动改坏再刷新，应出现提示条且带「修复并重载」按钮，点后数据被清、原文留在
#   sessionStorage.hm_guard_backup_hm_todos
```

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-28 | 音乐自愈：新增 `heal-music.js`；bundle 内打 P-1（3 处）与 P-2（1 处） |
| 2026-10-29 | 本地存储守卫：新增 `storage-guard.js`（P-4，版本标记 + 通用体检 + 一键修复）；`index.html` 补「备份不含音乐」文案；自检清单加第 6 项 |
| 2026-10-29 | 兜底修复：内联告警脚本外链化为 `boot-guard.js` 并前移到 `<head>` 最前（修掉"监听器注册晚于 bundle"导致告警永不出现的问题）；`index.html` 内联 `<script>` 清零 |
