// 阅读与访客统计路由：/api/stats
// 汇总口径：
//  - PV = 埋点明细行数；UV = 按天 COUNT(DISTINCT visitor_id)（跨天重复访问分别计入各天）；
//  - 环比 = 当前周期 vs 前一个等长周期；
//  - 演示数据（is_demo=1）计入真实统计展示，但可由 stats:manage 权限一键清除并回滚 views。
const express = require('express');
const router = express.Router();
const db = require('../../db');
const { authMiddleware, requirePermission } = require('../../auth');

router.get('/overview', authMiddleware, requirePermission('stats:view'), (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const prevSince = new Date(Date.now() - 2 * days * 86400000).toISOString().slice(0, 10);

  const cur = db.prepare(
    'SELECT COUNT(*) pv, COUNT(DISTINCT visitor_id) uv FROM page_views WHERE date(created_at) >= ?'
  ).get(since);
  const prev = db.prepare(
    'SELECT COUNT(*) pv, COUNT(DISTINCT visitor_id) uv FROM page_views WHERE date(created_at) >= ? AND date(created_at) < ?'
  ).get(prevSince, since);

  const trend = db.prepare(
    `SELECT date(created_at) d, COUNT(*) pv, COUNT(DISTINCT visitor_id) uv
     FROM page_views WHERE date(created_at) >= ? GROUP BY d ORDER BY d`
  ).all(since);

  const topPosts = db.prepare(
    `SELECT v.post_id AS id, COUNT(*) pv, COUNT(DISTINCT v.visitor_id) uv, p.title, p.status
     FROM page_views v JOIN posts p ON v.post_id = p.id
     WHERE p.is_deleted = 0 AND date(v.created_at) >= ?
     GROUP BY v.post_id ORDER BY pv DESC, uv DESC LIMIT 10`
  ).all(since);

  const sources = db.prepare(
    `SELECT source, COUNT(*) pv, COUNT(DISTINCT visitor_id) uv
     FROM page_views WHERE date(created_at) >= ?
     GROUP BY source ORDER BY pv DESC, uv DESC LIMIT 8`
  ).all(since);

  const today = db.prepare(
    "SELECT COUNT(*) pv, COUNT(DISTINCT visitor_id) uv FROM page_views WHERE date(created_at) = date('now')"
  ).get();

  // 篇均阅读：仅统计有埋点的内容（站点级访问不计入分母）
  const postPv = db.prepare(
    "SELECT COUNT(*) c FROM page_views WHERE post_id IS NOT NULL AND date(created_at) >= ?"
  ).get(since).c;
  const postCount = db.prepare(
    "SELECT COUNT(DISTINCT post_id) c FROM page_views WHERE post_id IS NOT NULL AND date(created_at) >= ?"
  ).get(since).c;

  const hasDemo = db.prepare('SELECT COUNT(*) c FROM page_views WHERE is_demo = 1').get().c > 0;

  res.json({
    days,
    summary: {
      pv: cur.pv, uv: cur.uv,
      pvPrev: prev.pv, uvPrev: prev.uv,
      todayPv: today.pv, todayUv: today.uv,
      postPv, postCount,
      avgRead: postCount > 0 ? Math.round((postPv / postCount) * 10) / 10 : 0,
      hasDemo,
    },
    trend, topPosts, sources,
  });
});

// 清除演示数据：仅删除 is_demo=1 的埋点，并回滚其中累加到 posts.views 的部分
router.post('/demo/clear', authMiddleware, requirePermission('stats:manage'), (req, res) => {
  const perPost = db.prepare(
    'SELECT post_id, COUNT(*) c FROM page_views WHERE is_demo = 1 AND post_id IS NOT NULL GROUP BY post_id'
  ).all();
  const tx = db.transaction(() => {
    const dec = db.prepare('UPDATE posts SET views = MAX(views - ?, 0) WHERE id = ?');
    perPost.forEach((r) => dec.run(r.c, r.post_id));
    // 写入「已清除」标记：防止重启后 seedDemoViews 再次复种
    db.setMeta('demo_views_cleared', '1');
    return db.prepare('DELETE FROM page_views WHERE is_demo = 1').run().changes;
  });
  const removed = tx();
  res.json({ ok: true, removed });
});

module.exports = router;
