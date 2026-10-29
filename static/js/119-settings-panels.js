// 119-settings-panels.js — 设置中心：面板 HTML 模板（左侧 5 个分类 + 右侧 5 个 section）
// 由 120-theme-settings.js 的 openSettings 内联模板原样抽出，字符串内容逐字节不变。
// 本文件只放声明，加载时不产生副作用。

function settingsPanelsHtml() {
  return `
    <div class="set-body">
      <aside class="set-nav">
        <button class="set-nav-item sel" data-panel="appearance">🎨 外观</button>
        <button class="set-nav-item" data-panel="personal">👤 个性化</button>
        <button class="set-nav-item" data-panel="window">🪟 窗口</button>
        <button class="set-nav-item" data-panel="account">🔐 账号</button>
        <button class="set-nav-item" data-panel="system">⚙ 系统</button>
      </aside>
      <div class="set-main">
        <section class="set-panel" data-panel="appearance">
          <h3>外观</h3>
          <div class="set-row">
            <div class="set-info"><div class="set-name">主题配色</div><div class="set-desc">一键切换整套界面配色</div></div>
            <div class="set-themes">
              <button class="set-theme-swat" data-t=""><span class="sw-chip sw-blue"></span>角色蓝</button>
              <button class="set-theme-swat" data-t="dark"><span class="sw-chip sw-dark"></span>暗黑</button>
              <button class="set-theme-swat" data-t="pink"><span class="sw-chip sw-pink"></span>樱花粉</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">强调色</div><div class="set-desc">按钮、选中态、聚焦边框的主色；「主题」= 跟随上面选的配色</div></div>
            <div class="set-accents" id="setAccent">
              <button class="ac-swat sel" data-a="" title="跟随主题"></button>
              <button class="ac-swat" data-a="violet" title="星河紫"></button>
              <button class="ac-swat" data-a="teal" title="薄荷青"></button>
              <button class="ac-swat" data-a="green" title="森野绿"></button>
              <button class="ac-swat" data-a="amber" title="暖阳橙"></button>
              <button class="ac-swat" data-a="rose" title="玫瑰粉"></button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">任务栏自动隐藏</div><div class="set-desc">开启：鼠标移到屏幕边缘才显示；关闭：任务栏常显</div></div>
            <label class="sw"><input type="checkbox" id="setAutoHide"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">桌面图标大小</div><div class="set-desc">调整桌面图标与文字的显示尺寸</div></div>
            <div class="set-seg" id="setIconSize" data-key="iconSize">
              <button class="seg-btn" data-v="sm">小</button>
              <button class="seg-btn sel" data-v="md">中</button>
              <button class="seg-btn" data-v="lg">大</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">桌面图标密度</div><div class="set-desc">紧凑=一格多放图标，宽松=间距更大</div></div>
            <div class="set-seg" id="setDensity" data-key="density">
              <button class="seg-btn" data-v="sm">紧凑</button>
              <button class="seg-btn sel" data-v="md">适中</button>
              <button class="seg-btn" data-v="lg">宽松</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">桌面图标文字</div><div class="set-desc">只显示图标不显示名字，桌面更干净（悬停仍能看到提示）</div></div>
            <div class="set-seg" id="setIconLabel" data-key="iconLabel">
              <button class="seg-btn sel" data-v="true">显示</button>
              <button class="seg-btn" data-v="false">只显示图标</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">壁纸模糊</div><div class="set-desc">桌面壁纸的磨砂程度，1% = 清晰原图</div></div>
            <div class="set-range" id="setWallBlur" data-key="wallBlur">
              <input type="range" class="range-in" min="1" max="100" step="1" aria-label="壁纸模糊">
              <span class="range-out">1%</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">窗口透明度</div><div class="set-desc">窗口与任务栏的透光程度，百分比越高越透；100% 时几乎只剩磨砂</div></div>
            <div class="set-range" id="setGlassA" data-key="glassA">
              <input type="range" class="range-in" min="1" max="100" step="1" aria-label="窗口透明度">
              <span class="range-out">81%</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">玻璃模糊</div><div class="set-desc">玻璃背后画面的磨砂强度，百分比越高越糊；调低会看穿画面</div></div>
            <div class="set-range" id="setGlassBlur" data-key="glassBlur">
              <input type="range" class="range-in" min="1" max="100" step="1" aria-label="玻璃模糊">
              <span class="range-out">65%</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">玻璃提亮</div><div class="set-desc">把玻璃后的画面提亮，深色壁纸下文字更清楚（不改文字颜色）</div></div>
            <div class="set-range" id="setGlassLift" data-key="glassLift">
              <input type="range" class="range-in" min="1" max="100" step="1" aria-label="玻璃提亮">
              <span class="range-out">1%</span>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">桌面背景明暗</div><div class="set-desc">压暗背景让桌面图标和字更清楚；「跟随主题」用当前配色的默认值</div></div>
            <div class="set-seg" id="setShade" data-key="shade">
              <button class="seg-btn sel" data-v="auto">跟随主题</button>
              <button class="seg-btn" data-v="none">原图</button>
              <button class="seg-btn" data-v="mid">压暗</button>
              <button class="seg-btn" data-v="strong">更暗</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">界面字号</div><div class="set-desc">菜单、图标名、按钮、笔记的整体大小</div></div>
            <div class="set-seg" id="setFontSize" data-key="fontSize">
              <button class="seg-btn" data-v="sm">小</button>
              <button class="seg-btn sel" data-v="md">中</button>
              <button class="seg-btn" data-v="lg">大</button>
            </div>
          </div>
        </section>
        <section class="set-panel" data-panel="personal" hidden>
          <h3>个性化</h3>
          <div class="set-row">
            <div class="set-info"><div class="set-name">交互音效</div><div class="set-desc">窗口开关、点击的提示音</div></div>
            <label class="sw"><input type="checkbox" id="setSfx"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">通知浮层</div><div class="set-desc">操作提示弹出的小气泡（关闭后仍记入通知中心）</div></div>
            <label class="sw"><input type="checkbox" id="setNotif"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">提示停留时长</div><div class="set-desc">小气泡在屏幕上停留多久自动消失</div></div>
            <div class="set-seg" id="setToastMs" data-key="toastMs">
              <button class="seg-btn" data-v="1500">短</button>
              <button class="seg-btn sel" data-v="2600">标准</button>
              <button class="seg-btn" data-v="4500">长</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">音效音量</div><div class="set-desc">提示音大小</div></div>
            <div class="set-seg" id="setSfxVol" data-key="sfxVol">
              <button class="seg-btn" data-v="0.4">低</button>
              <button class="seg-btn sel" data-v="1">中</button>
              <button class="seg-btn" data-v="1.5">高</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">时钟制式</div><div class="set-desc">状态栏时间显示格式</div></div>
            <div class="set-seg" id="setClock24" data-key="clock24">
              <button class="seg-btn sel" data-v="true">24小时</button>
              <button class="seg-btn" data-v="false">12小时</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">时钟显示秒</div><div class="set-desc">关掉后只显示到分钟，任务栏更清爽</div></div>
            <div class="set-seg" id="setClockSecs" data-key="clockSecs">
              <button class="seg-btn sel" data-v="true">显示</button>
              <button class="seg-btn" data-v="false">隐藏</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">时钟显示日期</div><div class="set-desc">在时间前面加上「年-月-日」</div></div>
            <div class="set-seg" id="setClockDate" data-key="clockDate">
              <button class="seg-btn sel" data-v="true">显示</button>
              <button class="seg-btn" data-v="false">隐藏</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">启动锁屏</div><div class="set-desc">刷新/打开页面时先见锁屏，点击进入桌面</div></div>
            <label class="sw"><input type="checkbox" id="setLock"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">壁纸</div><div class="set-desc">换壁纸、拖图导入、换主题</div></div>
            <button class="btn ghost" id="setWallpaper">打开个性化</button>
          </div>
        </section>
        <section class="set-panel" data-panel="window" hidden>
          <h3>窗口</h3>
          <div class="set-row">
            <div class="set-info"><div class="set-name">打开/关闭动画</div><div class="set-desc">窗口淡入缩放的过渡效果</div></div>
            <label class="sw"><input type="checkbox" id="setAnim"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">动画速度</div><div class="set-desc">窗口弹出/收起的快慢，低配机器建议「快」</div></div>
            <div class="set-seg" id="setAnimSpeed" data-key="animSpeed">
              <button class="seg-btn" data-v="fast">快</button>
              <button class="seg-btn sel" data-v="normal">标准</button>
              <button class="seg-btn" data-v="slow">柔</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">边缘吸附分屏</div><div class="set-desc">窗口拖到屏幕左/右边缘自动半屏，顶部最大化</div></div>
            <label class="sw"><input type="checkbox" id="setSnap"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">窗口玻璃效果</div><div class="set-desc">半透明毛玻璃 / 实心不透明背景</div></div>
            <div class="set-seg" id="setWinSolid" data-key="winSolid">
              <button class="seg-btn sel" data-v="false">半透明</button>
              <button class="seg-btn" data-v="true">实心</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">窗口投影</div><div class="set-desc">窗口下方的柔和阴影；关掉更扁平、渲染更省</div></div>
            <label class="sw"><input type="checkbox" id="setWinShadow"><span></span></label>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">双击标题栏最大化</div><div class="set-desc">关闭后双击标题栏不再切换最大化，避免误触</div></div>
            <label class="sw"><input type="checkbox" id="setDblMax"><span></span></label>
          </div>
        </section>
        <section class="set-panel" data-panel="system" hidden>
          <h3>系统</h3>
          <div class="set-row">
            <div class="set-info"><div class="set-name">状态自动刷新</div><div class="set-desc">定时检查子项目「运行中/离线」，你不用手动刷新（关掉可减少请求）</div></div>
            <div class="set-seg" id="setRefreshSecs" data-key="refreshSecs">
              <button class="seg-btn" data-v="10">10 秒</button>
              <button class="seg-btn sel" data-v="20">20 秒</button>
              <button class="seg-btn" data-v="60">60 秒</button>
              <button class="seg-btn" data-v="0">关闭</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">回收站自动清理</div><div class="set-desc">打开回收站时，删除时间超过保留期的条目自动永久删除（回收站的「清空」不受影响）</div></div>
            <div class="set-seg" id="setTrashDays" data-key="trashDays">
              <button class="seg-btn sel" data-v="0">关闭</button>
              <button class="seg-btn" data-v="3">保留 3 天</button>
              <button class="seg-btn" data-v="7">保留 7 天</button>
              <button class="seg-btn" data-v="30">保留 30 天</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">数据备份</div><div class="set-desc">导出/导入便签、记事本、布局等全部本地数据</div></div>
            <div class="set-btnrow">
              <button class="btn ghost" id="setExport">导出</button>
              <button class="btn ghost" id="setImport">导入</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">恢复默认设置</div><div class="set-desc">仅重置本页开关，便签/记事本/文件数据不受影响</div></div>
            <button class="btn ghost" id="setReset">重置</button>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">本机存储占用</div><div class="set-desc">便签、记事本、图标位置等本地数据的大小（不含项目文件）</div></div>
            <div class="set-btnrow">
              <span class="set-val" id="setStorageVal">统计中…</span>
              <button class="btn ghost" id="setStorageRefresh" type="button">刷新</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">清理缓存并重载</div><div class="set-desc">清掉离线缓存、彻底加载最新代码（本地数据不受影响）</div></div>
            <button class="btn ghost" id="setClearCache">清理</button>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">清空桌面数据</div><div class="set-desc">删除便签、记事本、窗口布局与图标位置（不可恢复）</div></div>
            <button class="btn ghost danger" id="setWipe">清空</button>
          </div>
          <p class="about-line">项目枢纽 · 仿真桌面 v1.1（设置中心 2.0）<br>窗口 / 便签 / 记事本 / 文件管理 / 终端 / 浏览器 / 虚拟桌面 / 设置中心<br>本版新增：强调色 · 背景明暗 · 图标文字 · 动画速度 · 窗口投影 · 时钟秒/日期 · 提示时长 · 自动刷新间隔 · 存储占用 · 清缓存 · 空闲锁屏 · 退出登录</p>
        </section>
        <section class="set-panel" data-panel="account" hidden>
          <h3>账号</h3>
          <div class="set-row">
            <div class="set-info"><div class="set-name">当前账号</div><div class="set-desc">登录后用于访问本枢纽的邮箱</div></div>
            <div id="acctEmail" class="acct-val">—</div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">角色</div><div class="set-desc">管理员拥有完整功能，普通用户只读</div></div>
            <div id="acctRole" class="acct-val">—</div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">记住账号密码</div><div class="set-desc">仅保存在本设备浏览器，下次自动填充（不上传、不替代云端登录）</div></div>
            <label class="sw"><input type="checkbox" id="setRemember"><span></span></label>
          </div>
          <div class="set-row" id="acctPwdRow">
            <div class="set-info"><div class="set-name">已保存密码</div><div class="set-desc">本设备保存的登录密码（明文仅存于本地浏览器）</div></div>
            <div class="set-btnrow">
              <span id="acctPwd" class="acct-pwd">（无）</span>
              <button class="btn ghost" id="acctReveal" type="button">显示</button>
              <button class="btn ghost danger" id="acctClear" type="button">清除</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">空闲自动锁屏</div><div class="set-desc">一段时间没操作就自动回到锁屏页（需先开启上面的「启动锁屏」）</div></div>
            <div class="set-seg" id="setIdleLock" data-key="idleLock">
              <button class="seg-btn sel" data-v="0">关闭</button>
              <button class="seg-btn" data-v="5">5 分钟</button>
              <button class="seg-btn" data-v="15">15 分钟</button>
              <button class="seg-btn" data-v="30">30 分钟</button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">退出登录</div><div class="set-desc">退出当前账号，回到登录页（本机保存的账号可选保留）</div></div>
            <button class="btn ghost danger" id="setLogout" type="button">退出登录</button>
          </div>
        </section>
      </div>
    </div>`;
}
