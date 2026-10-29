// 122-settings-personal.js — 设置中心 · 个性化页（音效 / 通知 / 时钟 / 锁屏）
// 由 120-theme-settings.js 的 openSettings 拆出；本文件只放声明，加载时不产生副作用。

function bindSettingsPersonal(win) {
  // 开关：交互音效 / 通知浮层 / 启动锁屏
  settingsBindToggle(win, 'setSfx', 'sfx');
  settingsBindToggle(win, 'setNotif', 'notif');
  settingsBindToggle(win, 'setLock', 'lockScreen');

  // 分段选择器：提示时长 / 音效音量 / 时钟制式 / 秒 / 日期
  settingsBindSeg(win, '#setToastMs', 'toastMs');
  settingsBindSeg(win, '#setSfxVol', 'sfxVol');
  settingsBindSeg(win, '#setClock24', 'clock24');
  settingsBindSeg(win, '#setClockSecs', 'clockSecs');
  settingsBindSeg(win, '#setClockDate', 'clockDate');

  // 壁纸：跳到「个性化」窗口（换壁纸 / 拖图导入 / 内置壁纸库）
  const wallBtn = win.querySelector('#setWallpaper');
  if (wallBtn) wallBtn.onclick = () => openPersonalize();
}
