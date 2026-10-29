// 阅读埋点路由：/api/track（公开信标，供站点前端调用，无需登录）
// 设计要点：
//  - 60 秒内同一访客对同一页面只计一次 PV，防止刷新/重复上报放大数据；
//  - UV 口径为「按天 + visitor_id 去重」，由统计查询侧 COUNT(DISTINCT) 完成；
//  - post_id 可为空（站点级访问）；来源做归一化（去 www.、取主机名、空值归 direct）。
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { rateLimit, clientIp } = require('../lib/rateLimit');

// 公开写接口防护（P0 安全基线）：
//  - 细粒度按 visitor_id：每分钟 120 次（正常浏览远低于此，防单访客刷量）；
//    键取自请求体、与客户端 IP 无关——平台反代 IP 逐连接轮换（见 auth.js 注释），
//    visitor_id 键在线上实测可稳定累积并精确触发；
//    加 'track:' 前缀避免访客自定义 ID 与其他路由的限流键碰撞。
//  - 粗粒度按 IP：每分钟 600 次（防伪造 visitor_id 批量刷库的兜底；
//    阈值按共享出口 IP 校准，正常站点聚合流量不会触顶；平台 IP 轮换下为尽力而为）。
const trackFine = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyFn: (req) => 'track:' + (String((req.body || {}).visitor_id || '').trim().slice(0, 64) || clientIp(req)),
  message: '上报过于频繁，请稍后再试',
});
const trackCoarse = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  message: '该 IP 上报过于频繁，请稍后再试',
});

function normalizeSource(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'direct') return 'direct';
  try {
    if (!/^https?:\/\//.test(s)) s = 'http://' + s;
    s = new URL(s).hostname || 'direct';
  } catch {
    return 'direct';
  }
  s = s.replace(/^www\./, '');
  return s.slice(0, 64) || 'direct';
}

router.post('/', trackCoarse, trackFine, (req, res) => {
  const { post_id, visitor_id, source } = req.body || {};
  const vid = String(visitor_id || '').trim().slice(0, 64);
  if (!vid) return res.status(400).json({ error: '缺少访客标识 visitor_id' });
  let pid = null;
  if (post_id !== undefined && post_id !== null && post_id !== '') {
    pid = Number(post_id);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'post_id 不合法' });
  }

  // 去重窗口：同访客 + 同页面 + 60 秒内
  const recent = db.prepare(
    "SELECT id FROM page_views WHERE visitor_id = ? AND IFNULL(post_id, 0) = ? AND created_at >= datetime('now', '-60 seconds') LIMIT 1"
  ).get(vid, pid === null ? 0 : pid);
  if (recent) return res.json({ ok: true, deduped: true });

  const src = normalizeSource(source || req.headers.referer);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO page_views (post_id, visitor_id, source) VALUES (?,?,?)').run(pid, vid, src);
    if (pid !== null) {
      db.prepare('UPDATE posts SET views = views + 1 WHERE id = ? AND is_deleted = 0').run(pid);
    }
  });
  tx();
  res.json({ ok: true, deduped: false });
});

module.exports = router;
