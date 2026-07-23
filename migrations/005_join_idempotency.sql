ALTER TABLE session_players ADD COLUMN client_instance_id TEXT;
ALTER TABLE session_players ADD COLUMN token_value TEXT;

CREATE UNIQUE INDEX idx_players_join_identity
  ON session_players(session_id, nickname_norm, client_instance_id)
  WHERE client_instance_id IS NOT NULL;
