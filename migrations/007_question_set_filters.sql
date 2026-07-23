ALTER TABLE question_sets ADD COLUMN subject TEXT NOT NULL DEFAULT '';
ALTER TABLE question_sets ADD COLUMN grade TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_question_sets_teacher_subject_grade
  ON question_sets(teacher_id, subject, grade, updated_at_ms DESC);
