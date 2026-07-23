CREATE TABLE teachers (
  teacher_id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash BLOB NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER
) STRICT;

CREATE TABLE question_sets (
  question_set_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
  title TEXT NOT NULL,
  source_name TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE questions (
  question_id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(question_set_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL CHECK (json_valid(choices_json)),
  correct_choice INTEGER NOT NULL CHECK (correct_choice BETWEEN 0 AND 2),
  explanation TEXT,
  phase_a_seconds INTEGER CHECK (phase_a_seconds BETWEEN 10 AND 60),
  UNIQUE (question_set_id, position)
) STRICT;

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES teachers(teacher_id),
  question_set_id TEXT NOT NULL REFERENCES question_sets(question_set_id),
  code_hash BLOB NOT NULL UNIQUE,
  projector_token_hash BLOB,
  projector_expires_at_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'live', 'ended')),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  settings_revision INTEGER NOT NULL DEFAULT 1,
  last_server_seq INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  ended_at_ms INTEGER
) STRICT;

CREATE TABLE session_players (
  player_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  nickname_norm TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  token_expires_at_ms INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('one', 'mob', 'crowd')),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  has_been_one INTEGER NOT NULL DEFAULT 0 CHECK (has_been_one IN (0, 1)),
  joined_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  kicked_at_ms INTEGER,
  UNIQUE (session_id, nickname_norm)
) STRICT;

CREATE TABLE games (
  game_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  one_player_id TEXT NOT NULL REFERENCES session_players(player_id),
  status TEXT NOT NULL CHECK (status IN ('live', 'ended')),
  end_reason TEXT CHECK (end_reason IN ('flameout', 'deck_survived', 'mob_emptied')),
  deck_start_position INTEGER NOT NULL,
  deck_size INTEGER NOT NULL CHECK (deck_size BETWEEN 1 AND 12),
  question_offset INTEGER NOT NULL DEFAULT 0,
  strikes_remaining INTEGER NOT NULL,
  bank_points INTEGER NOT NULL DEFAULT 0,
  momentum_progress INTEGER NOT NULL DEFAULT 0,
  momentum_awarded INTEGER NOT NULL DEFAULT 0 CHECK (momentum_awarded IN (0, 1)),
  help_poll_used INTEGER NOT NULL DEFAULT 0 CHECK (help_poll_used IN (0, 1)),
  help_ask_used INTEGER NOT NULL DEFAULT 0 CHECK (help_ask_used IN (0, 1)),
  help_trust_used INTEGER NOT NULL DEFAULT 0 CHECK (help_trust_used IN (0, 1)),
  snapshot_seq INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  UNIQUE (session_id, ordinal)
) STRICT;

CREATE TABLE game_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  game_id TEXT REFERENCES games(game_id) ON DELETE CASCADE,
  server_seq INTEGER NOT NULL,
  attempt_id TEXT,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'teacher', 'player')),
  actor_id TEXT,
  request_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, server_seq)
) STRICT;

CREATE INDEX idx_sessions_teacher_status ON sessions(teacher_id, status);
CREATE INDEX idx_players_session_role ON session_players(session_id, role);
CREATE INDEX idx_players_session_points ON session_players(session_id, points DESC);
CREATE INDEX idx_questions_set_position ON questions(question_set_id, position);
CREATE INDEX idx_games_session_ordinal ON games(session_id, ordinal DESC);
CREATE INDEX idx_events_game_seq ON game_events(game_id, server_seq);
CREATE INDEX idx_events_session_type ON game_events(session_id, event_type, created_at_ms);
CREATE UNIQUE INDEX idx_events_request_dedupe
  ON game_events(session_id, actor_kind, actor_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TRIGGER game_events_no_update
BEFORE UPDATE ON game_events
BEGIN
  SELECT RAISE(ABORT, 'game_events is append-only');
END;

CREATE TRIGGER game_events_no_delete
BEFORE DELETE ON game_events
BEGIN
  SELECT RAISE(ABORT, 'game_events is append-only');
END;
