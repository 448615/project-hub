// 仪表盘视图：概览卡片 + 趋势/流量/状态/分类图表 + 最近内容。
import { ICONS } from '../core/constants.js';
import { api, getDashboard, ensureECharts } from '../core/api.js';
import { esc, toast, statusBadge } from '../ui/dom.js';
import { drawTrend, drawStatusDonut, drawCatBar } from '../ui/charts.js';
import { makeSortable } from '../ui/dnd.js';
import { can } from '../core/permissions.js';
import { viewState } from '../core/runtime.js';
import { paintMessages, setView } from './shell.js';
import { openPostDrawer } from './post-editor.js';

export async function renderDashboard() {
  setView(`<div class="toolbar"><div class="grow"></div>
    <div class="chips" id="range-chips">
      <span class="chip" data-r="7">近 7 天</span>
      <span class="chip on" data-r="30">近 30 天</span>
      <span class="chip" data-r="90">近 90 天</span>
    </div></div>
    <div class="section-hint">拖动卡片可调整快捷入口顺序 <span class="muted">· 拖出区域将自动回弹归位</span></div>
    <div class="quick" id="quick"></div>
    <div class="grid-stats" id="stats"></div>
    <div class="row">
      <div class="panel" style="flex:2"><h3><span class="h-ic">${ICONS.activity}</span>内容创建趋势<span class="h-sub" id="trend-sub"></span></h3><div id="trend" class="chart-box"></div></div>
      <div class="panel" style="flex:1"><h3><span class="h-ic">${ICONS.layers}</span>状态分布</h3><div id="statusChart" class="chart-box"></div></div>
    </div>
    <div class="row">
      <div class="panel" style="flex:1"><h3><span class="h-ic">${ICONS.folder}</span>分类占比</h3><div id="catChart" class="chart-box"></div></div>
      <div class="panel" style="flex:1"><h3><span class="h-ic">${ICONS.doc}</span>最近更新<span class="h-sub"><a class="link" href="#/posts">查看全部</a></span></h3><div id="recent" class="recents"></div></div>
    </div>`);

  // 快捷操作入口（同组卡片：可拖拽排序，松手完成；拖出区域自动回弹归位）
  const quickDef = [
    { ic: 'plus', color: 'brand', t: '新建内容', s: '撰写文章 / 公告', href: '#/posts/new', perm: 'post:create' },
    { ic: 'upload', color: 'purple', t: '上传媒体', s: '图片 / 文件素材', href: '#/media', perm: 'media:manage' },
    { ic: 'folderPlus', color: 'ok', t: '新建分类', s: '组织内容结构', href: '#/categories', perm: 'category:manage' },
    { ic: 'alert', color: 'warn', t: '待审核', s: '处理提交内容', href: '#/posts' },
  ];
  const orderKey = 'starshu_quick_order';
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(orderKey) || '[]'); } catch (e) { saved = []; }
  const quick = [...quickDef].sort((a, b) => {
    const ia = saved.indexOf(a.href), ib = saved.indexOf(b.href);
    if (ia === -1 && ib === -1) return 0;
    if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib;
  }).filter((q) => !q.perm || can(q.perm));
  document.getElementById('quick').innerHTML = quick.map((q) => `
    <a class="qa" href="${q.href}" data-href="${q.href}" title="拖拽可调整顺序">
      <div class="qa-ic" style="background:var(--${q.color}-soft,var(--brand-soft));color:var(--${q.color},var(--brand))">${ICONS[q.ic]}</div>
      <div><div class="qa-t">${q.t}</div><div class="qa-s">${q.s}</div></div>
    </a>`).join('');
  makeSortable(document.getElementById('quick'), {
    onCommit: (order) => { try { localStorage.setItem(orderKey, JSON.stringify(order)); } catch (e) {} },
  });

  let range = 30;
  document.getElementById('range-chips').querySelectorAll('.chip').forEach((c) =>
    (c.onclick = () => {
      document.querySelectorAll('#range-chips .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on'); range = +c.dataset.r; load();
    }));
  async function load() {
    const epoch = viewState.epoch;
    try {
      const d = await getDashboard(range);
      if (epoch !== viewState.epoch) return; // 已切换到其他页面，终止过期渲染
      // 同步刷新顶部消息中心（复用同一份看板数据，避免重复请求）
      paintMessages(d);
      // 顶部 4 个 KPI 卡片（内容总数附"较前 7 天"迷你趋势，数据源自看板 trend）
      const published = (d.byStatus.find((x) => x.status === 'published') || {}).c || 0;
      const pending = (d.byStatus.find((x) => x.status === 'pending') || {}).c || 0;
      const t = d.trend || [];
      const sum = (arr) => arr.reduce((s, x) => s + (x.c || 0), 0);
      let wow = null;
      if (t.length >= 14) {
        const last7 = sum(t.slice(-7));
        const prev7 = sum(t.slice(-14, -7));
        if (prev7 > 0) wow = Math.round(((last7 - prev7) / prev7) * 100);
        else if (last7 > 0) wow = 100;
      }
      const trendTag = (k) => {
        if (k.wow == null) return '';
        const cls = k.wow > 0 ? 'up' : k.wow < 0 ? 'down' : 'flat';
        const sign = k.wow > 0 ? '+' : '';
        return `<span class="kpi-trend ${cls}">较前 7 天 ${sign}${k.wow}%</span>`;
      };
      const kpi = [
        { ic: 'doc', color: 'blue', label: '内容总数', value: d.total, unit: '篇', sub: '全部内容', wow },
        { ic: 'eye', color: 'purple', label: '总浏览量', value: d.views, unit: '次', sub: '累计访问' },
        { ic: 'check', color: 'green', label: '已发布', value: published, unit: '篇', sub: '对外可见' },
        { ic: 'alert', color: 'amber', label: '待审核', value: pending, unit: '篇', sub: pending > 0 ? '需尽快处理' : '暂无待处理', urgent: pending > 0 },
      ];
      document.getElementById('stats').innerHTML = kpi.map((k) => `
        <div class="kpi ${k.color}${k.urgent ? ' urgent' : ''}">
          <div class="kpi-top"><div class="kpi-ic">${ICONS[k.ic]}</div><div class="kpi-top-r">${trendTag(k)}${k.urgent ? '<span class="kpi-flag">待处理</span>' : ''}</div></div>
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value">${k.value}${k.unit ? `<span class="kpi-unit">${k.unit}</span>` : ''}</div>
          <div class="kpi-sub">${k.sub}</div>
        </div>`).join('');
      // 图表（按需懒加载 ECharts，失败则 SVG 降级）
      await ensureECharts();
      if (epoch !== viewState.epoch) return; // 懒加载期间可能已切换页面
      drawTrend(d.trend || []);
      document.getElementById('trend-sub').textContent = '近 ' + range + ' 天';
      drawStatusDonut(d.byStatus || []);
      drawCatBar(d.byCat || []);
      // 最近更新（由看板接口一并返回，无需额外请求）
      const rc = document.getElementById('recent');
      if (!rc) return; // 视图已切换（防御性兜底）
      const recent = d.recent || [];
      if (!recent.length) {
        const samples = [
          { title: '欢迎使用星枢', time: '示例' },
          { title: '如何创建你的第一篇内容', time: '示例' },
          { title: '管理分类与标签的最佳实践', time: '示例' },
        ];
        rc.innerHTML =
          samples.map((s) => `<div class="recent-item" style="opacity:.72">
            <span class="r-title" style="color:var(--sub)">${esc(s.title)}</span>
            <span class="r-meta">${esc(s.time)}</span>
          </div>`).join('') +
          `<div style="margin-top:12px;font-size:12px;color:var(--sub)">以上为示例占位，发布内容后将在此展示最近更新。</div>`;
      } else {
        rc.innerHTML = recent.map((r) => `
          <div class="recent-item" data-post="${r.id}" style="cursor:pointer">
            <span class="r-title" style="color:var(--ink)">${esc(r.title)}</span>
            ${statusBadge(r.status)}
            <span class="r-meta">${esc((r.updated_at || '').slice(0, 10))}</span>
          </div>`).join('');
        rc.querySelectorAll('[data-post]').forEach((it) => (it.onclick = () => openPostDrawer(+it.dataset.post)));
      }
    } catch (e) { toast(e.message, 'error'); }
  }
  load();
}

// ---------- 内容列表 ----------
