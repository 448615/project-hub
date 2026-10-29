// 124-settings-system.js — 设置中心 · 系统页（自动刷新 / 备份 / 重置 / 存储占用 / 清缓存）
// 由 120-theme-settings.js 的 openSettings 拆出；本文件只放声明，加载时不产生副作用。

// 本机存储占用：把 localStorage 里所有键值按 UTF-16 双字节估算
function settingsCalcStorage(win) {
  const storageVal = win.querySelector('#setStorageVal');
  let bytes = 0, keys = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      const v = localStorage.getItem(k) || '';
      bytes += (k.length + v.length) * 2;   // localStorage 按 UTF-16 存，1 字符 = 2 字节
      keys++;
    }
  } catch (e) { /* 隐私模式可能抛错 */ }
  const kb = bytes / 1024;
  const txt = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
  if (storageVal) storageVal.innerHTML = `<b>${txt}</b> · ${keys} 项`;
  return { bytes, keys };
}

function bindSettingsSystem(win) {
  // 状态自动刷新间隔
  settingsBindSeg(win, '#setRefreshSecs', 'refreshSecs');

  // 回收站自动清理：保留 3 / 7 / 30 天，0 = 关闭
  settingsBindSeg(win, '#setTrashDays', 'trashDays');
  const trashSeg = win.querySelector('#setTrashDays');
  if (trashSeg) {
    // settingsBindSeg 用 onclick 先写入 SETTINGS，这里追加一个监听：改完立刻按新规则清一次，
    // 不用等下次打开回收站（真正生效点仍是 openTrash / 这次立即执行）
    trashSeg.querySelectorAll('.seg-btn').forEach(b => {
      b.addEventListener('click', () => {
        const n = trashAutoPurge(true);
        refreshTrashWin();
        if (n) toast('已清理 ' + n + ' 项超过 ' + (Number(SETTINGS.trashDays) || 0) + ' 天的条目');
      });
    });
  }

  // 数据备份：导出 / 导入
  const exportBtn = win.querySelector('#setExport');
  if (exportBtn) exportBtn.onclick = () => exportDataBackup();
  const importBtn = win.querySelector('#setImport');
  if (importBtn) importBtn.onclick = () => importDataBackup();

  // 恢复默认设置：只重置 SETTINGS，便签 / 记事本 / 文件数据不动
  const resetBtn = win.querySelector('#setReset');
  if (resetBtn) resetBtn.onclick = async () => {
    const ok = await hubConfirm('恢复默认设置？便签 / 记事本 / 文件数据不受影响。', { title: '恢复默认设置', okText: '恢复' });
    if (!ok) return;
    SETTINGS = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings(); applySettings();
    settingsRefillToggles(win);
    // 所有分段选择器统一按各自的 data-key 重新回填（新增项自动覆盖，无需再列一遍）
    win.querySelectorAll('.set-seg[data-key]').forEach(c => settingsSyncSeg(c, c.dataset.key));
    // 百分比滑杆同理
    win.querySelectorAll('.set-range[data-key]').forEach(c => settingsSyncRange(c, c.dataset.key));
    settingsSyncAccent(win);
    syncClockTick();
    toast('已恢复默认设置');
  };

  // 清空桌面数据（不可恢复）
  const wipeBtn = win.querySelector('#setWipe');
  if (wipeBtn) wipeBtn.onclick = async () => {
    const ok = await hubConfirm('确定清空全部桌面数据？便签 / 记事本 / 窗口布局 / 图标位置都会被删除，且不可恢复！', {
      title: '清空桌面数据', okText: '全部清空', danger: true,
    });
    if (!ok) return;
    ['hub-stickies', 'hub-notes', 'ph.winlayout', 'hub-icons-pos'].forEach(k => localStorage.removeItem(k));
    toast('已清空桌面数据，正在刷新…');
    setTimeout(() => location.reload(), 700);
  };

  // 本机存储占用：进页面先算一次，另有「刷新」按钮
  settingsCalcStorage(win);
  const storageRefresh = win.querySelector('#setStorageRefresh');
  if (storageRefresh) storageRefresh.onclick = () => { settingsCalcStorage(win); toast('已刷新存储占用'); };

  // 清理缓存并重载：删掉所有 Cache Storage 条目 + 注销 Service Worker 后重载
  const clearCache = win.querySelector('#setClearCache');
  if (clearCache) clearCache.onclick = async () => {
    const ok = await hubConfirm('清理离线缓存并重新加载页面？便签 / 记事本 / 设置等本地数据不受影响。', { title: '清理缓存', okText: '清理并重载' });
    if (!ok) return;
    let n = 0;
    try {
      if (window.caches && caches.keys) {
        const ks = await caches.keys();
        for (const k of ks) { await caches.delete(k); n++; }
      }
    } catch (e) { /* 忽略 */ }
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const rs = await navigator.serviceWorker.getRegistrations();
        for (const r of rs) { await r.unregister(); }
      }
    } catch (e) { /* 忽略 */ }
    toast(n ? `已清理 ${n} 个缓存，正在重载…` : '缓存已是干净的，正在重载…');
    setTimeout(() => location.reload(), 600);
  };
}
