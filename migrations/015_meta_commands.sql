CREATE TABLE meta_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_server_seq INTEGER NOT NULL DEFAULT 0
) STRICT;

INSERT INTO meta_state (singleton) VALUES (1);

CREATE TABLE meta_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_seq INTEGER NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'organizer'),
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (actor_id, request_id)
) STRICT;

CREATE TRIGGER meta_events_type_required
BEFORE INSERT ON meta_events
WHEN length(NEW.event_type) = 0
BEGIN
  SELECT RAISE(ABORT, 'event_type must not be empty');
END;

CREATE TABLE meta_command_outcomes (
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  event_id INTEGER NOT NULL REFERENCES meta_events(event_id),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (actor_id, request_id)
) STRICT;

CREATE TRIGGER meta_events_no_update
BEFORE UPDATE ON meta_events
BEGIN
  SELECT RAISE(ABORT, 'meta_events is append-only');
END;

CREATE TRIGGER meta_events_no_delete
BEFORE DELETE ON meta_events
BEGIN
  SELECT RAISE(ABORT, 'meta_events is append-only');
END;

CREATE TRIGGER meta_command_outcomes_no_update
BEFORE UPDATE ON meta_command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'meta command outcomes are immutable');
END;

CREATE TRIGGER meta_command_outcomes_no_delete
BEFORE DELETE ON meta_command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'meta command outcomes are immutable');
END;
