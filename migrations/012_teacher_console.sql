ALTER TABLE sessions ADD COLUMN display_code_ciphertext TEXT;

CREATE TABLE teacher_command_state (
  teacher_id TEXT PRIMARY KEY REFERENCES teachers(teacher_id),
  last_server_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE teacher_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
  server_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'teacher'),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (teacher_id, server_seq),
  UNIQUE (teacher_id, actor_id, request_id)
) STRICT;

CREATE TABLE teacher_command_outcomes (
  teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  event_id INTEGER NOT NULL REFERENCES teacher_events(event_id),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (teacher_id, actor_id, request_id)
) STRICT;

CREATE TRIGGER teacher_events_no_update
BEFORE UPDATE ON teacher_events
BEGIN
  SELECT RAISE(ABORT, 'teacher events are append-only');
END;

CREATE TRIGGER teacher_events_no_delete
BEFORE DELETE ON teacher_events
BEGIN
  SELECT RAISE(ABORT, 'teacher events are append-only');
END;

CREATE TRIGGER teacher_command_outcomes_no_update
BEFORE UPDATE ON teacher_command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'teacher command outcomes are immutable');
END;

CREATE TRIGGER teacher_command_outcomes_no_delete
BEFORE DELETE ON teacher_command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'teacher command outcomes are immutable');
END;
