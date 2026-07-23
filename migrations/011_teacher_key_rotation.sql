ALTER TABLE teachers ADD COLUMN key_rotated_at_ms INTEGER;

CREATE INDEX idx_auth_events_teacher_login
  ON auth_events(actor_kind, actor_id, event_type, created_at_ms);
