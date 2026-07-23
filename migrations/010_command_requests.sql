CREATE TABLE command_requests (
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, actor_id, request_id)
) STRICT;

INSERT INTO command_requests
  (session_id, actor_id, request_id, command_type, payload_fingerprint, created_at_ms)
SELECT session_id, actor_id, request_id, command_type, payload_fingerprint, created_at_ms
FROM command_outcomes
WHERE NOT (
  command_type = 'rate_limited'
  AND json_extract(outcome_json, '$.ok') = 0
  AND json_extract(outcome_json, '$.code') = 'RATE_LIMITED'
);

DROP TRIGGER command_outcomes_no_delete;

DELETE FROM command_outcomes
WHERE json_extract(outcome_json, '$.ok') = 0
  AND json_extract(outcome_json, '$.code') IN
    ('WRONG_PHASE', 'STALE_ATTEMPT', 'TOO_LATE', 'RATE_LIMITED');

CREATE TRIGGER command_outcomes_no_delete
BEFORE DELETE ON command_outcomes
BEGIN
  SELECT RAISE(ABORT, 'command outcomes are immutable');
END;

DROP INDEX idx_events_request_dedupe;

CREATE UNIQUE INDEX idx_events_request_dedupe
  ON game_events(session_id, actor_kind, actor_id, request_id)
  WHERE request_id IS NOT NULL AND actor_id IS NOT NULL AND event_type != 'command_rejected';

CREATE TRIGGER command_requests_no_update
BEFORE UPDATE ON command_requests
BEGIN
  SELECT RAISE(ABORT, 'command requests are immutable');
END;

CREATE TRIGGER command_requests_no_delete
BEFORE DELETE ON command_requests
BEGIN
  SELECT RAISE(ABORT, 'command requests are immutable');
END;
