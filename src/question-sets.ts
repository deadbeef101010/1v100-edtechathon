import type { AppDatabase } from "./db.js";

export type QuestionSetSummary = Readonly<{
  question_set_id: string;
  title: string;
  subject: string;
  grade: string;
  question_count: number;
}>;

export function listQuestionSets(
  database: AppDatabase,
  teacherId: string,
  filters: Readonly<{ subject?: string; grade?: string }> = {},
): QuestionSetSummary[] {
  const conditions = ["s.teacher_id = ?"];
  const parameters: string[] = [teacherId];
  if (filters.subject !== undefined && filters.subject.length > 0) {
    conditions.push("lower(s.subject) = lower(?)");
    parameters.push(filters.subject);
  }
  if (filters.grade !== undefined && filters.grade.length > 0) {
    conditions.push("lower(s.grade) = lower(?)");
    parameters.push(filters.grade);
  }
  return database.prepare(
    `SELECT s.question_set_id, s.title, s.subject, s.grade, COUNT(q.question_id) AS question_count
     FROM question_sets s
     LEFT JOIN questions q ON q.question_set_id = s.question_set_id
     WHERE ${conditions.join(" AND ")}
     GROUP BY s.question_set_id
     ORDER BY s.updated_at_ms DESC, s.title, s.question_set_id`,
  ).all(...parameters) as QuestionSetSummary[];
}
