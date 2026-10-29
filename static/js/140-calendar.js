// 140-calendar.js — 小日历与农历
// 由原 static/app.js 拆分；本文件只放声明，加载时不产生副作用。

// ===== 右下角时间 → 小日历（白色玻璃 + 农历/节日/节气标注） =====
const calEl = document.getElementById('cal');
let calYear = 0, calMonth = 0;   // calMonth 0 基
const CAL_MIN_YEAR = 1900, CAL_MAX_YEAR = 2100;   // 农历/节气查表法的可靠覆盖范围（LUNAR_INFO / TERM_INFO）

// ---- 农历转换（1900-2100 查表法） ----
const LUNAR_INFO = [
  0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,
  0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,
  0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,
  0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,
  0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,
  0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,
  0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,
  0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b5a0,0x195a6,
  0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,
  0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,
  0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,
  0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,
  0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,
  0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,
  0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,
  0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,
  0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,
  0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,
  0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,
  0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,
  0x0d520
];
const LUNAR_MONTHS = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const LUNAR_DAYS = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'];
function leapMonthOf(y) { return LUNAR_INFO[y - 1900] & 0xf; }
function leapDays(y) { return leapMonthOf(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
function monthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
function lunarYearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
  return sum + leapDays(y);
}
function lunarFromSolar(y, m, d) {           // m 0基；超出查表范围（1900-01-31 之前或 2100 之后）返回 null
  let offset = Math.floor((Date.UTC(y, m, d) - Date.UTC(1900, 0, 31)) / 86400000);
  if (y < 1900 || y > 2100 || offset < 0) return null;
  let i = 1900;
  while (i < 2101 && offset >= lunarYearDays(i)) { offset -= lunarYearDays(i); i++; }
  const lunarYear = i;
  const leap = leapMonthOf(lunarYear);
  let isLeap = false, month = 1, day = 1;
  for (i = 1; i <= 12 && offset >= 0; i++) {
    let mDays;
    if (leap > 0 && i === leap + 1 && !isLeap) {
      // 进入闰月：本月长取闰月天数；isLeap 留到下一次迭代（i=leap+1）再复位，
      // 那时 else 分支会改取正式月长——两步都不可省，否则闰月后的日期会错标
      // "闰X月"且月长误用闰月天数，整年日期漂移（2025 中秋曾被算成八月十六）。
      --i; isLeap = true;
      mDays = leapDays(lunarYear);
    } else {
      if (isLeap && i === leap + 1) isLeap = false;   // 闰月已过完：先复位再取正式月长
      mDays = monthDays(lunarYear, i);
    }
    if (offset < mDays) { day = offset + 1; break; }
    offset -= mDays;
  }
  month = i;
  return { year: lunarYear, month, day, isLeap };
}
function lunarText(y, m, d) {
  const L = lunarFromSolar(y, m, d);
  if (!L) return '（超出农历可查范围）';
  const md = L.isLeap ? '闰' : '';
  return `${md}${LUNAR_MONTHS[L.month - 1]}月${LUNAR_DAYS[L.day - 1]}`;
}

// ---- 二十四节气（1900-2100 近似算法） ----
const TERM_INFO = [0,21208,42467,63836,85337,107014,128867,150921,173149,195551,218072,240693,263343,285989,308563,331033,353350,375494,397447,419210,440795,462224,483532,504758];
const TERM_NAMES = ['小寒','大寒','立春','雨水','惊蛰','春分','清明','谷雨','立夏','小满','芒种','夏至','小暑','大暑','立秋','处暑','白露','秋分','寒露','霜降','立冬','小雪','大雪','冬至'];
function termOf(y, m, d) {                     // m 0基；返回节气名或 null
  const base = Date.UTC(1900, 0, 6, 2, 5);     // 1900-01-06 02:05 小寒（近似基准）
  for (let i = 0; i < 24; i++) {
    const t = new Date(base + (TERM_INFO[i] + 31556925974.7 * (y - 1900) / 60000) * 60000);
    // 用 UTC 字段比较：该近似模型算出的“UTC 日期”与权威节气日期一致（已用日本国立天文台
    // 2025/2026 数据核对，对中国用户 24/24 命中）。改用本地日期比较反而会因模型时刻偏几小时、
    // 在东八区 +8h 跨日而错位，故保持 UTC 比较。
    if (t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d) return TERM_NAMES[i];
  }
  return null;
}

// ---- 节日表 ----
const SOLAR_FEST = { '1-1':'元旦','2-14':'情人节','3-8':'妇女节','3-12':'植树节','4-1':'愚人节','5-1':'劳动节','5-4':'青年节','6-1':'儿童节','7-1':'建党节','8-1':'建军节','9-10':'教师节','10-1':'国庆节','12-24':'平安夜','12-25':'圣诞节' };
const LUNAR_FEST = { '1-1':'春节','1-15':'元宵节','2-2':'龙抬头','5-5':'端午节','7-7':'七夕节','7-15':'中元节','8-15':'中秋节','9-9':'重阳节','12-8':'腊八节','12-23':'小年' };

function dayFests(y, m, d) {                    // 返回节日数组（含节气）
  const fests = [];
  const sf = SOLAR_FEST[`${m + 1}-${d}`];
  if (sf) fests.push({ name: sf, red: true });
  const L = lunarFromSolar(y, m, d);
  if (L) {
    const lf = LUNAR_FEST[`${L.month}-${L.day}`];
    if (lf) fests.push({ name: lf, red: true });
    // 除夕：腊月最后一天
    if (L.month === 12) {
      const total = (leapMonthOf(L.year) && leapMonthOf(L.year) === 12 ? leapDays(L.year) : monthDays(L.year, 12));
      if (L.day === total) fests.push({ name: '除夕', red: true });
    }
  }
  const term = termOf(y, m, d);
  if (term) fests.push({ name: term, red: false });
  return fests;
}

// ---- 渲染 ----
function buildCalendar(y, m) {
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const wds = ['日', '一', '二', '三', '四', '五', '六'];
  // N3：翻到农历查表边界时禁用对应按钮，避免展示错误的农历/节气
  const canPrev = !(y === CAL_MIN_YEAR && m === 0);
  const canNext = !(y === CAL_MAX_YEAR && m === 11);
  let html = `
    <div class="cal-head">
      <button class="cal-nav" id="calPrev"${canPrev ? '' : ' disabled'} title="${canPrev ? '上一月' : '已到最早可查的 1900 年 1 月'}">‹</button>
      <div class="cal-title">${y} 年 ${m + 1} 月</div>
      <button class="cal-nav" id="calNext"${canNext ? '' : ' disabled'} title="${canNext ? '下一月' : '已到最晚可查的 2100 年 12 月'}">›</button>
    </div>
    <div class="cal-grid">${wds.map(d => `<div class="cal-dow">${d}</div>`).join('')}`;
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${m}-${d}`;
    const isToday = key === todayKey;
    const hasFest = dayFests(y, m, d).length > 0;
    html += `<div class="cal-cell ${isToday ? 'today' : ''} ${hasFest ? 'fest' : ''}" data-d="${d}">${d}</div>`;
  }
  // 补齐 42 格（固定 6 行，让面板高度稳定）
  const cells = startDow + daysInMonth;
  for (let i = cells; i < 42; i++) html += '<div class="cal-cell blank"></div>';
  html += '</div><div class="cal-info"></div>';
  calEl.innerHTML = html;
  calEl.querySelector('#calPrev').onclick = (e) => { e.stopPropagation(); moveCal(-1); };
  calEl.querySelector('#calNext').onclick = (e) => { e.stopPropagation(); moveCal(1); };
  calEl.querySelectorAll('.cal-cell:not(.blank)').forEach(el => {
    el.onclick = () => showDayInfo(y, m, +el.dataset.d);
  });
}

// ---- 点击某一天：下方显示 公历 + 农历 + 节日/节气 ----
function showDayInfo(y, m, d) {
  const wds = ['日', '一', '二', '三', '四', '五', '六'];
  const wd = new Date(y, m, d).getDay();
  const fests = dayFests(y, m, d);
  const festHtml = fests.length
    ? `<div class="ci-fests">${fests.map(f => `<span class="ci-fest ${f.red ? 'fest-red' : ''}">${f.name}</span>`).join('')}</div>`
    : '';
  const info = calEl.querySelector('.cal-info');
  info.innerHTML = `
    <div class="ci-date">${m + 1} 月 ${d} 日 · 星期${wds[wd]}</div>
    <div class="ci-lunar">农历 ${lunarText(y, m, d)}</div>
    ${festHtml}`;
}

function moveCal(delta) {
  let m = calMonth + delta, y = calYear;
  if (m < 0) { m = 11; y--; }
  else if (m > 11) { m = 0; y++; }
  if (y < CAL_MIN_YEAR) { y = CAL_MIN_YEAR; m = 0; }        // N3：钳制在查表范围内，不再翻出
  else if (y > CAL_MAX_YEAR) { y = CAL_MAX_YEAR; m = 11; }
  calYear = y; calMonth = m;
  buildCalendar(y, m);
  showDayInfo(y, m, 1);   // 翻月后默认展示当月 1 号
}

function toggleCal() {
  if (!calEl.hidden) { hideCal(); return; }
  const now = new Date();
  calYear = now.getFullYear(); calMonth = now.getMonth();
  buildCalendar(calYear, calMonth);
  showDayInfo(calYear, calMonth, now.getDate());   // 默认显示今天
  calEl.hidden = false;
  const r = clockEl.getBoundingClientRect();
  const w = calEl.offsetWidth, h = calEl.offsetHeight;
  calEl.style.left = Math.max(4, r.left + r.width - w) + 'px';
  calEl.style.top = Math.max(4, r.top - h - 10) + 'px';
}
function hideCal() { calEl.hidden = true; }

// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// 关闭：点日历/时钟外、Esc
// ↑ 原 3 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
// ↑ 原 1 行顶层初始化语句已移至 999-boot.js（在所有函数定义后执行）
