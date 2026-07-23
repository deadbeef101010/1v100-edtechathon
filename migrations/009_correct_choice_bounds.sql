CREATE TABLE questions_bounded_choice (
  question_id TEXT PRIMARY KEY,
  question_set_id TEXT NOT NULL REFERENCES question_sets(question_set_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL CHECK (json_valid(choices_json)),
  correct_choice INTEGER NOT NULL CHECK (
    correct_choice >= 0 AND correct_choice < json_array_length(choices_json)
  ),
  explanation TEXT,
  phase_a_seconds INTEGER CHECK (phase_a_seconds BETWEEN 10 AND 60),
  UNIQUE (question_set_id, position)
) STRICT;

INSERT INTO questions_bounded_choice SELECT * FROM questions;
DROP TABLE questions;
ALTER TABLE questions_bounded_choice RENAME TO questions;
CREATE INDEX idx_questions_set_position ON questions(question_set_id, position);
