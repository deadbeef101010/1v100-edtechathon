CREATE TABLE questions_four_choice (
  question_id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(question_set_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL CHECK (json_valid(choices_json)),
  correct_choice INTEGER NOT NULL CHECK (correct_choice BETWEEN 0 AND 3),
  explanation TEXT,
  phase_a_seconds INTEGER CHECK (phase_a_seconds BETWEEN 10 AND 60),
  UNIQUE (question_set_id, position)
) STRICT;

INSERT INTO questions_four_choice SELECT * FROM questions;
DROP TABLE questions;
ALTER TABLE questions_four_choice RENAME TO questions;
CREATE INDEX idx_questions_set_position ON questions(question_set_id, position);
