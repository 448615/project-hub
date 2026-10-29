// 统计报表视图。
import { ICONS } from '../core/constants.js';
import { api, ensureECharts } from '../core/api.js';
import { esc, toast, statusBadge, emptyState, confirmDialog } from '../ui/dom.js';
import { drawTrafficLine } from '../ui/charts.js';
import { can } from '../core/permissions.js';
import { setView } from './shell.js';
import { renderError } from './error.js';
import { viewState } from '../core/runtime.js';

export async function renderStats() {
  if (!can('stats:view')) return renderError(403, '权限不足', '你没有查看阅读与访客统计的权限。');
  const canManage = can('stats:manage');
  setView(`<div class="toolbar">
    <h2 style="margin:0">阅读与访客统计</h2>
    <div class="grow"></div>
    <div class="chips" id="stats-range">
      <span class="chip" data-r="7">近 7 天</span>
      <span class="chip on" data-r="30">近 30 天</span>
      <span class="chip" data-r="90">近 90 天</span>
    </div>
  </div>
  <div id="demo-banner"></div>
  <div class="section-hint">PV = 页面浏览量；UV = 独立访客数（按天去重）。环比对照前一个等长周期。</div>
  <div class="grid-stats" id="kpis"></div>
  <div class="row">
    <div class="panel" style="flex:1"><h3><span class="h-ic">${ICONS.chart}</span>阅读趋势<span class="h-sub" id="trend-sub"></span></h3><div id="trafficChart" class="chart-box"></div></div>
  </div>
  <div class="row">
    <div class="panel" style="flex:2"><h3><span class="h-ic">${ICONS.eye}</span>内容阅读排行<span class="h-sub">Top 10 · 当前周期</span></h3><div id="topPosts"></div></div>
    <div class="panel" style="flex:1"><h3><span class="h-ic">${ICONS.activity}</span>来源分布<span class="h-sub">PV / UV</span></h3><div id="sources" class="chart-box"></div></div>
  </div>`);

  let range = 30;
  document.getElementById('stats-range').querySelectorAll('.chip').forEach((c) =>
    (c.onclick = () => {
      document.querySelectorAll('#stats-range .chip').forEach((x) => x.classList.remove('on'));
      c.classList.add('on'); range = +c.dataset.r; load();
    }));

  const delta = (cur, prev) => {
    if (prev > 0) return Math.round(((cur - prev) / prev) * 100);
    if (cur > 0) return 100;
    return null;
  };
  const trendTag = (v) => {
    if (v == null) return '';
    const cls = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
    const sign = v > 0 ? '+' : '';
    return `<span class="kpi-trend ${cls}">环比 ${sign}${v}%</span>`;
  };
  const barList = (rows) => {
    const max = Math.max(1, ...rows.map((r) => r.pv));
    return rows.map((r) => `
      <div class="src-row">
        <div class="src-name" title="${esc(r.source)}">${esc(r.source)}</div>
        <div class="src-bar"><div style="width:${(r.pv / max) * 100}%"></div></div>
        <div class="src-val">${r.pv} / ${r.uv}</div>
      </div>`).join('');
  };

  async function load() {
    const epoch = viewState.epoch;
    const d = await api('/stats/overview?days=' + range);
    if (epoch !== viewState.epoch) return; // 已切换到其他页面，终止过期渲染
    const s = d.summary || {};
    // 演示数据横幅：统计管理员可见清除入口，其他角色仅作提示
    const bn = document.getElementById('demo-banner');
    if (bn) {
      bn.innerHTML = s.hasDemo
        ? `<div class="demo-banner${canManage ? '' : ' ro'}"><span>${ICONS.info}当前包含 <b>演示数据</b>（播种的合成埋点），仅用于展示统计效果${canManage ? '，可一键清除' : ''}。</span>${canManage ? '<button class="btn sm danger" id="demo-clear">清除演示数据</button>' : ''}</div>`
        : '';
      const cl = document.getElementById('demo-clear');
      if (cl) cl.onclick = async () => {
        if (!(await confirmDialog('确认清除全部演示埋点数据？该操作不可恢复。'))) return;
        try { const r = await api('/stats/demo/clear', { method: 'POST', body: '{}' }); toast('已清除 ' + r.removed + ' 条演示数据', 'success'); load(); }
        catch (e) { toast(e.message, 'error'); }
      };
    }
    const kpis = [
      { ic: 'eye', color: 'blue', label: '浏览量 PV', value: (s.pv || 0).toLocaleString(), unit: '次', sub: '近 ' + range + ' 天', d: delta(s.pv || 0, s.pvPrev || 0) },
      { ic: 'users', color: 'purple', label: '独立访客 UV', value: (s.uv || 0).toLocaleString(), unit: '人', sub: '按天去重', d: delta(s.uv || 0, s.uvPrev || 0) },
      { ic: 'activity', color: 'green', label: '今日访问', value: (s.todayPv || 0).toLocaleString(), unit: 'PV', sub: '今日访客 ' + (s.todayUv || 0) + ' UV' },
      { ic: 'chart', color: 'amber', label: '篇均阅读', value: s.avgRead || 0, unit: '次/篇', sub: s.postCount + ' 篇内容有访问' },
    ];
    document.getElementById('kpis').innerHTML = kpis.map((k) => `
      <div class="kpi ${k.color}">
        <div class="kpi-top"><div class="kpi-ic">${ICONS[k.ic]}</div><div class="kpi-top-r">${trendTag(k.d)}</div></div>
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}${k.unit ? `<span class="kpi-unit">${k.unit}</span>` : ''}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`).join('');
    await ensureECharts();
    if (epoch !== viewState.epoch) return; // 懒加载期间可能已切换页面
    drawTrafficLine(d.trend || []);
    document.getElementById('trend-sub').textContent = '近 ' + range + ' 天';
    const tp = document.getElementById('topPosts');
    if (!(d.topPosts || []).length) {
      tp.innerHTML = emptyState({ icon: 'doc', title: '暂无阅读数据', desc: '站点内容接入埋点后将在此展示排行' });
    } else {
      tp.innerHTML = `<table class="tbl"><thead><tr><th style="width:36px">#</th><th>内容</th><th>状态</th><th>PV</th><th>UV</th></tr></thead>
        <tbody>${d.topPosts.map((p, i) => `
          <tr><td class="muted">${i + 1}</td>
          <td><a class="t-link" href="#/posts/${p.id}">${esc(p.title)}</a></td>
          <td>${statusBadge(p.status)}</td><td>${p.pv}</td><td>${p.uv}</td></tr>`).join('')}</tbody></table>`;
    }
    const sc = document.getElementById('sources');
    sc.innerHTML = (d.sources || []).length ? barList(d.sources) : emptyState({ icon: 'activity', title: '暂无来源数据', desc: '接入埋点并携带来源后展示' });
  }
  load();
}

// ---------- 错误页 ----------
