ALTER TABLE sessions ADD COLUMN deck_start_position INTEGER NOT NULL DEFAULT 1
  CHECK (deck_start_position >= 1);
