// 123-settings-window.js — 设置中心 · 窗口页（动画 / 吸附 / 玻璃 / 投影）
// 由 120-theme-settings.js 的 openSettings 拆出；本文件只放声明，加载时不产生副作用。

function bindSettingsWindow(win) {
  // 开关：动画 / 边缘吸附 / 投影 / 双击标题栏最大化
  settingsBindToggle(win, 'setAnim', 'winAnim');
  settingsBindToggle(win, 'setSnap', 'snap');
  settingsBindToggle(win, 'setWinShadow', 'winShadow');
  settingsBindToggle(win, 'setDblMax', 'dblMax');

  // 分段选择器：动画速度 / 窗口玻璃效果
  settingsBindSeg(win, '#setAnimSpeed', 'animSpeed');
  settingsBindSeg(win, '#setWinSolid', 'winSolid');
}
