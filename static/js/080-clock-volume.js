// 080-clock-volume.js — 时钟与音量
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 时钟 =====
// 制式 / 是否带秒 / 是否带日期 都由设置中心决定，改完立刻调用 syncClockTick() 重画
function clockText() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  let hm;
  if (SETTINGS.clock24) {
    hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    const h = d.getHours(), ampm = h < 12 ? 'AM' : 'PM';
    hm = `${pad(h % 12 || 12)}:${pad(d.getMinutes())} ${ampm}`;
  }
  if (SETTINGS.clockSecs) hm += ':' + pad(d.getSeconds());
  const date = SETTINGS.clockDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : '';
  return date + hm;
}
function syncClockTick() {
  if (!clockEl) return;
  try { clockEl.textContent = clockText(); } catch (e) { /* 忽略 */ }
}
function startClock() {
  syncClockTick();
  setInterval(syncClockTick, 1000);
}

// ===== 音量控制（状态栏时间旁边的声音大小图标） =====
function initVolume() {
  // 先把页面上那几个小零件一个一个抓出来，后面都用它们
  const volEl  = document.getElementById('volume');   // 包住按钮和弹窗的外层
  const btn    = document.getElementById('volBtn');   // 喇叭按钮
  const popup  = document.getElementById('volPopup'); // 音量滑块弹窗
  const slider = document.getElementById('volSlider'); // 滑块本身
  const valEl  = document.getElementById('volVal');   // 显示百分比的小字

  // 两个变量：volume 是当前音量（0~1 的小数），muted 表示是否静音
  let volume = 0.8;
  let muted  = false;

  // 根据音量和静音状态，把对应的喇叭矢量图标填进 #volGlyph（单色 SVG，和关机标同款）。
  // 三种状态：静音/0 -> 喇叭加斜叉；小于一半 -> 喇叭加一条波；一半以上 -> 喇叭加两条波。
  // 注意：这里只换 SVG 内部路径，不动外层按钮样式，所以图标始终跟 ⏻ 一样清晰、同色。
  function updateIcon() {
    const g = document.getElementById('volGlyph');     // 容器里只放图形，不碰按钮
    const spk = '<path d="M11 5 6 9H2v6h4l5 4V5z"/>';  // 喇叭本体（三种状态共用）
    if (muted || volume === 0) {
      // 静音：喇叭 + 右上到左下的叉
      g.innerHTML = spk + '<line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>';
    } else if (volume < 0.5) {
      // 小声：喇叭 + 一条近处声波
      g.innerHTML = spk + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    } else {
      // 大声：喇叭 + 两条声波
      g.innerHTML = spk + '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
    }
  }

  // 把音量真正作用到页面里所有音频/视频（现在没媒体也能跑，以后接了媒体直接生效）
  function apply() {
    const v = muted ? 0 : volume;                     // 静音时一律 0
    document.querySelectorAll('audio, video').forEach(el => {
      try { el.volume = v; } catch (e) {}             // 个别元素可能不让改，跳过
    });
  }

  // 刷新弹窗里显示的百分比数字
  function showVal() {
    valEl.textContent = Math.round((muted ? 0 : volume) * 100) + '%';
  }

  // 鼠标移入音量区域 -> 弹出滑块；移出 -> 收起（popup 是 volEl 的子元素，移上去不算移出）
  volEl.addEventListener('mouseenter', () => { popup.hidden = false; });
  volEl.addEventListener('mouseleave', () => { popup.hidden = true;  });

  // 点一下图标：快速静音 / 取消静音（再点回来恢复之前音量）
  btn.addEventListener('click', () => {
    muted = !muted;                                   // 把静音状态翻过来
    if (!muted && volume === 0) volume = 0.5;         // 若原来就是 0，取消静音给个默认值
    updateIcon(); showVal(); apply();
  });

  // 拖滑块：实时改音量、自动取消静音、更新图标
  slider.addEventListener('input', () => {
    volume = Number(slider.value) / 100;              // 滑块是整数 0~100，除以 100 变 0~1
    if (volume > 0) muted = false;                   // 一旦有音量就取消静音
    updateIcon(); showVal(); apply();
  });

  updateIcon(); showVal(); apply();                   // 启动时先按默认值(80%)画好界面
}

// 启动闸门：先过账号体系（未登录显示登录遮罩），登录成功才 load() 进桌面。
// 原来是脚本末尾直接 load()；现在所有 /api 请求都需要登录令牌。
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）

// ===== 任务栏自动隐藏：鼠标靠近底部滑出，移开滑入（开机键/时钟在栏内） =====
// ↑ 原 30 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
