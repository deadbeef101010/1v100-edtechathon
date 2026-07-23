CREATE TABLE command_outcomes (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  event_id INTEGER NOT NULL REFERENCES game_events(event_id),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, actor_id, request_id)
) STRICT;

CREATE INDEX idx_command_outcomes_event ON command_outcomes(event_id);

CREATE TRIGGER command_outcomes_no_update
BEFORE UPDATE ON command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'command outcomes are immutable');
END;

CREATE TRIGGER command_outcomes_no_delete
BEFORE DELETE ON command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'command outcomes are immutable');
END;
