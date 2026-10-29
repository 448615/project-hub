// 000-core.js — 元素引用与持久化键
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 元素引用 =====
// 拿到页面上几个固定位置的元素，后面往里面填内容
const iconsEl = document.getElementById('icons');          // 桌面图标容器
const windowsEl = document.getElementById('windows');      // 窗口容器
const taskItemsEl = document.getElementById('taskItems');  // 任务栏按钮区
const toastEl = document.getElementById('toast');
const clockEl = document.getElementById('clock');
const desktopEl = document.getElementById('desktop');      // 桌面层（文件夹图标）

let DATA = null;          // 用来存后端返回的项目列表
let zCounter = 30;        // 窗口层级计数器：每点/每激活一次就升高，保证点到的最上层
const openWins = {};      // 记录已打开的窗口：key=项目name -> {el, taskBtn, minimized}

// ---- 记事本 / 文件夹 / 回收站 持久化 ----
const NOTES_KEY = 'hub-notes';       // localStorage：打开的记事本 {__note_N: {seq,title,content,left,top}}
const FOLDERS_KEY = 'hub-folders';   // localStorage：文件夹 {fN: {id,name,left,top}}
const TRASH_KEY = 'hub-trash';       // localStorage：回收站（被删除的文件夹）
const ICON_POS_KEY = 'hub-icons-pos';   // localStorage：桌面图标自由位置 {name: {x,y}}
const TRASH_POS_KEY = 'hub-trash-pos';  // localStorage：回收站位置 {x,y}
const noteRecords = {};              // 内存态：key -> 记录
const folderRecords = {};            // 内存态：id -> 记录
let noteSeq = 0, folderSeq = 0;
let trashRecords = [];               // 内存态：回收站列表
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 回收站唯一的写入口：落盘 + 同步桌面徽标 + 回收站窗口开着就重画列表。
// refreshTrashWin 只读 trashRecords（不回头写），所以不会递归。
function saveTrash() {
  try { localStorage.setItem(TRASH_KEY, JSON.stringify(trashRecords)); } catch (e) { /* 隐私模式写不了，内存态仍可用 */ }
  if (typeof refreshTrashWin === 'function') refreshTrashWin();
  else if (typeof updateTrashBadge === 'function') updateTrashBadge();
}
function loadJSON(k, def) { try { return JSON.parse(localStorage.getItem(k)) || def; } catch (e) { return def; } }
