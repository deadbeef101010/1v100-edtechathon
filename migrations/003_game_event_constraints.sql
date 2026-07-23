DROP INDEX idx_events_request_dedupe;

CREATE UNIQUE INDEX idx_events_request_dedupe
  ON game_events(session_id, actor_kind, actor_id, request_id)
  WHERE request_id IS NOT NULL AND actor_id IS NOT NULL;

CREATE TRIGGER game_events_request_actor_required
BEFORE INSERT ON game_events
WHEN NEW.request_id IS NOT NULL AND NEW.actor_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'request events require actor_id');
END;

CREATE TRIGGER game_events_type_required
BEFORE INSERT ON game_events
WHEN length(NEW.event_type) = 0
BEGIN
  SELECT RAISE(ABORT, 'event_type must not be empty');
END;
