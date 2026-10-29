-- 002：工作流驳回——posts 增加驳回理由 reject_reason
-- （原 db.js 内联 ALTER，迁移机制上线后改由此处演进）
ALTER TABLE posts ADD COLUMN reject_reason TEXT;
