CREATE TABLE auth_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'teacher')),
  actor_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER auth_events_no_update
BEFORE UPDATE ON auth_events
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;

CREATE TRIGGER auth_events_no_delete
BEFORE DELETE ON auth_events
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;
