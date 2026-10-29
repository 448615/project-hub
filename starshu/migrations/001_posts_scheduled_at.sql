-- 001：定时发布——posts 增加计划发布时间 scheduled_at
-- （原 db.js 内联 ALTER，迁移机制上线后改由此处演进）
ALTER TABLE posts ADD COLUMN scheduled_at TEXT;
