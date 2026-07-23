ALTER TABLE sessions ADD COLUMN archived_at_ms INTEGER;

CREATE INDEX idx_sessions_teacher_archive
  ON sessions(teacher_id, archived_at_ms, created_at_ms DESC);
