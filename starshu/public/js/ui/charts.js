// ECharts 图表封装（带 SVG 降级）
// 自行维护图表实例注册表，供视图切换时统一销毁/重置尺寸，避免内存泄漏。
import { esc, emptyState } from './dom.js';
import { STATUS_COLOR } from '../core/constants.js';

const _charts = [];

function disposeCharts() {
  _charts.forEach((c) => { try { c.dispose(); } catch (e) {} });
  _charts.length = 0;
}
function resizeCharts() {
  _charts.forEach((c) => { try { c.resize(); } catch (e) {} });
}

// 内容创建趋势
function drawTrend(data) {
  const el = document.getElementById('trend');
  if (!el) return;
  if (!data.length) { el.innerHTML = emptyState({ icon: 'activity', title: '暂无趋势数据', desc: '该时间范围内没有新内容' }); return; }
  if (!window.echarts) { el.innerHTML = fallbackArea(data.map((x) => ({ label: x.d.slice(5), value: x.c }))); return; }
  const chart = window.echarts.init(el); _charts.push(chart);
  chart.setOption({
    grid: { left: 6, right: 14, top: 18, bottom: 6, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,41,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 }, padding: [8, 12] },
    xAxis: { type: 'category', data: data.map((x) => x.d.slice(5)), boundaryGap: false, axisLine: { lineStyle: { color: '#e9ecf2' } }, axisTick: { show: false }, axisLabel: { color: '#9aa3af', fontSize: 11 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f6f8fc' } }, axisLabel: { color: '#9aa3af', fontSize: 11 } },
    series: [{
      name: '新增内容', type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x.c),
      lineStyle: { width: 3, color: '#3b6cff' }, itemStyle: { color: '#3b6cff' },
      areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(59,108,255,.28)' }, { offset: 1, color: 'rgba(59,108,255,.02)' }]) },
    }],
  });
}

// 阅读趋势（PV / UV 双线面积图）
function drawTrafficLine(data) {
  const el = document.getElementById('trafficChart');
  if (!el) return;
  if (!data.length) { el.innerHTML = emptyState({ icon: 'chart', title: '暂无访问数据', desc: '站点接入埋点后在此展示趋势' }); return; }
  if (!window.echarts) { el.innerHTML = fallbackArea(data.map((x) => ({ label: x.d.slice(5), value: x.pv }))); return; }
  const chart = window.echarts.init(el); _charts.push(chart);
  const axis = {
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(15,23,41,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 }, padding: [8, 12] },
    grid: { left: 6, right: 14, top: 18, bottom: 6, containLabel: true },
    xAxis: { type: 'category', data: data.map((x) => x.d.slice(5)), boundaryGap: false, axisLine: { lineStyle: { color: '#e9ecf2' } }, axisTick: { show: false }, axisLabel: { color: '#9aa3af', fontSize: 11 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f6f8fc' } }, axisLabel: { color: '#9aa3af', fontSize: 11 } },
  };
  const line = (name, key, color, rgb) => ({
    name, type: 'line', smooth: true, showSymbol: false, data: data.map((x) => x[key]),
    lineStyle: { width: 3, color }, itemStyle: { color },
    areaStyle: { color: new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: `rgba(${rgb},.26)` }, { offset: 1, color: `rgba(${rgb},.02)` }]) },
  });
  chart.setOption({
    ...axis,
    legend: { top: 0, right: 0, icon: 'circle', textStyle: { color: '#6b7280', fontSize: 12 }, itemWidth: 8, itemHeight: 8 },
    series: [line('浏览量 PV', 'pv', '#3b6cff', '59,108,255'), line('访客 UV', 'uv', '#0ca678', '12,167,135')],
  });
}

// 状态分布饼图
function drawStatusDonut(data) {
  const el = document.getElementById('statusChart');
  if (!el) return;
  const rows = data.filter((x) => x.c > 0);
  if (!rows.length) { el.innerHTML = emptyState({ icon: 'layers', title: '暂无状态数据', desc: '还没有内容记录' }); return; }
  if (!window.echarts) { el.innerHTML = fallbackBar(rows.map((x) => ({ label: x.status, value: x.c }))); return; }
  const colorMap = { draft: STATUS_COLOR.draft, pending: STATUS_COLOR.pending, published: STATUS_COLOR.published, offline: STATUS_COLOR.offline, scheduled: STATUS_COLOR.scheduled, rejected: STATUS_COLOR.rejected };
  const nameMap = { draft: '草稿', pending: '待审核', published: '已发布', offline: '已下线', scheduled: '计划中', rejected: '已驳回' };
  const chart = window.echarts.init(el); _charts.push(chart);
  chart.setOption({
    tooltip: { trigger: 'item', backgroundColor: 'rgba(15,23,41,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 }, formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#6b7280', fontSize: 12 }, itemWidth: 8, itemHeight: 8 },
    series: [{
      name: '状态分布', type: 'pie', radius: ['52%', '74%'], center: ['50%', '44%'], avoidLabelOverlap: true,
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 6 },
      label: { show: false }, labelLine: { show: false },
      data: rows.map((x) => ({ name: nameMap[x.status] || x.status, value: x.c, itemStyle: { color: colorMap[x.status] || '#3b6cff' } })),
    }],
  });
}

// 分类占比条形图
function drawCatBar(data) {
  const el = document.getElementById('catChart');
  if (!el) return;
  const rows = data.map((x) => ({ label: x.name || '未分类', value: x.c }));
  if (!rows.length) { el.innerHTML = emptyState({ icon: 'folder', title: '暂无分类数据', desc: '创建分类后将在此展示占比' }); return; }
  if (!window.echarts) { el.innerHTML = fallbackBar(rows); return; }
  const sorted = [...rows].sort((a, b) => a.value - b.value);
  const chart = window.echarts.init(el); _charts.push(chart);
  chart.setOption({
    grid: { left: 4, right: 28, top: 10, bottom: 6, containLabel: true },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(15,23,41,.92)', borderWidth: 0, textStyle: { color: '#fff', fontSize: 12 } },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#f6f8fc' } }, axisLabel: { color: '#9aa3af', fontSize: 11 } },
    yAxis: { type: 'category', data: sorted.map((r) => r.label), axisLine: { lineStyle: { color: '#e9ecf2' } }, axisTick: { show: false }, axisLabel: { color: '#475569', fontSize: 12 } },
    series: [{
      name: '内容数', type: 'bar', data: sorted.map((r) => r.value), barWidth: '55%',
      itemStyle: { borderRadius: [0, 6, 6, 0], color: new window.echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: '#7c5cff' }, { offset: 1, color: '#3b6cff' }]) },
      label: { show: true, position: 'right', color: '#6b7280', fontSize: 11 },
    }],
  });
}

// SVG 降级：面积图
function fallbackArea(data) {
  if (!data.length) return emptyState({ title: '暂无数据' });
  const W = 600, H = 200, pad = 28;
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = (W - pad * 2) / Math.max(1, data.length - 1);
  const pts = data.map((d, i) => [pad + i * step, H - pad - (d.value / max) * (H - pad * 2)]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `${pad},${H - pad} ` + line + ` ${pad + (data.length - 1) * step},${H - pad}`;
  const stride = Math.ceil(data.length / 6);
  const labels = data.map((d, i) => ({ d, i })).filter(({ i }) => i % stride === 0)
    .map(({ d, i }) => `<text x="${pad + i * step}" y="${H - 8}" font-size="9" fill="#9aa3af" text-anchor="middle">${esc(d.label)}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon points="${area}" fill="rgba(59,108,255,.12)"/><polyline points="${line}" fill="none" stroke="#3b6cff" stroke-width="2"/>${labels}</svg>`;
}

// SVG 降级：条形图
function fallbackBar(data) {
  if (!data.length) return emptyState({ title: '暂无数据' });
  const max = Math.max(1, ...data.map((d) => d.value));
  return `<div style="display:flex;flex-direction:column;gap:8px">` + data.map((d) => `
    <div style="display:flex;align-items:center;gap:10px;font-size:13px">
      <div style="width:72px;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.label)}</div>
      <div style="flex:1;background:#f1f3f5;border-radius:6px;height:18px;overflow:hidden"><div style="width:${(d.value / max) * 100}%;background:#3b6cff;height:100%"></div></div>
      <div style="width:32px;text-align:right;color:#6b7280">${d.value}</div>
    </div>`).join('') + `</div>`;
}

export { drawTrend, drawTrafficLine, drawStatusDonut, drawCatBar, disposeCharts, resizeCharts };
