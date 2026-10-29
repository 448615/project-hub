// 121-settings-appearance.js — 设置中心 · 外观页（主题 / 强调色 / 桌面图标 / 字号）
// 由 120-theme-settings.js 的 openSettings 拆出；本文件只放声明，加载时不产生副作用。

function bindSettingsAppearance(win) {
  // 主题色块：角色蓝 / 暗黑 / 樱花粉
  win.querySelectorAll('.set-theme-swat').forEach(el => {
    el.classList.toggle('sel', (el.dataset.t || '') === (document.body.dataset.theme || ''));
    el.onclick = () => {
      applyTheme(el.dataset.t || '');
      win.querySelectorAll('.set-theme-swat').forEach(x => x.classList.toggle('sel', x === el));
      toast('主题已切换');
    };
  });

  // 强调色圆点
  const accentBox = win.querySelector('#setAccent');
  if (accentBox) {
    settingsSyncAccent(win);
    accentBox.querySelectorAll('.ac-swat').forEach(el => {
      el.onclick = () => {
        SETTINGS.accent = el.dataset.a || '';
        saveSettings(); applySettings(); settingsSyncAccent(win);
        const pr = ACCENT_PRESET[SETTINGS.accent];
        toast(pr ? '强调色：' + pr.name : '强调色：跟随主题');
      };
    });
  }

  // 开关：任务栏自动隐藏
  settingsBindToggle(win, 'setAutoHide', 'autoHideTaskbar');

  // 分段选择器：图标尺寸 / 密度 / 文字 / 背景明暗 / 界面字号
  settingsBindSeg(win, '#setIconSize', 'iconSize');
  settingsBindSeg(win, '#setDensity', 'density');
  settingsBindSeg(win, '#setIconLabel', 'iconLabel');
  settingsBindSeg(win, '#setShade', 'shade');
  settingsBindSeg(win, '#setFontSize', 'fontSize');
  // 百分比滑杆：壁纸模糊 + 玻璃质感（窗口 / 任务栏 的透明度 / 模糊 / 提亮）
  settingsBindRange(win, '#setWallBlur', 'wallBlur');
  settingsBindRange(win, '#setGlassA', 'glassA');
  settingsBindRange(win, '#setGlassBlur', 'glassBlur');
  settingsBindRange(win, '#setGlassLift', 'glassLift');
}
