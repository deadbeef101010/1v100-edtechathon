import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import {
  importQuestionsCsv,
  QuestionImportValidationError,
} from "../src/question-import.js";
import { mintTeacherKey } from "../src/teachers.js";

let database: AppDatabase;
let teacherId: string;

beforeEach(() => {
  database = openDatabase(":memory:");
  teacherId = mintTeacherKey(database, "Question importer").teacherId;
});

afterEach(() => database.close());

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
}

describe("question CSV import", () => {
  it("imports a valid set with positions 1 through 10", async () => {
    const result = importQuestionsCsv(database, await fixture("good.csv"), { teacherId });
    const set = database.prepare(
      `SELECT title, subject, grade,
              (SELECT COUNT(*) FROM questions q WHERE q.question_set_id = s.question_set_id) AS question_count
       FROM question_sets s`,
    ).get() as { title: string; subject: string; grade: string; question_count: number };
    const positions = database.prepare("SELECT position FROM questions ORDER BY position").all();

    expect(result).toMatchObject({ setsCreated: 1, questionsImported: 10, skipped: [] });
    expect(set).toEqual({
      title: "Fraction Foundations",
      subject: "Fractions",
      grade: "5",
      question_count: 10,
    });
    expect(positions).toEqual(Array.from({ length: 10 }, (_, index) => ({ position: index + 1 })));
  });

  it("reports every invalid row and leaves the database unchanged by default", async () => {
    let failure: unknown;
    try {
      importQuestionsCsv(database, await fixture("bad.csv"), { teacherId });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(QuestionImportValidationError);
    expect((failure as Error).message).toContain("Row 3: position 1 is duplicated");
    expect((failure as Error).message).toContain("Row 4: correct must be an integer from 0 to 2");
    expect((failure as Error).message).toContain("Row 5: choices must not contain an empty option");
    expect(database.prepare("SELECT COUNT(*) AS count FROM question_sets").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM questions").get()).toEqual({ count: 0 });
  });

  it("imports only valid rows in partial mode and reports skipped rows", async () => {
    const result = importQuestionsCsv(database, await fixture("bad.csv"), {
      teacherId,
      partial: true,
    });

    expect(result.questionsImported).toBe(1);
    expect(result.skipped.map((error) => error.row)).toEqual([4, 5, 3]);
    expect(database.prepare("SELECT position, prompt FROM questions").all()).toEqual([
      { position: 1, prompt: "Which is one half?" },
    ]);
  });

  it("enforces JSON choices and answer bounds in strict tables", () => {
    database.prepare(
      `INSERT INTO question_sets
        (question_set_id, teacher_id, title, created_at_ms, updated_at_ms, subject, grade)
       VALUES ('set', ?, 'Set', 1, 1, 'Math', '5')`,
    ).run(teacherId);

    expect(() => database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice)
       VALUES ('bad-json', 'set', 1, 'Prompt', 'not-json', 0)`,
    ).run()).toThrow(/CHECK constraint failed/);
    expect(() => database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice)
       VALUES ('bad-index', 'set', 1, 'Prompt', '["a","b","c"]', 3)`,
    ).run()).toThrow(/CHECK constraint failed/);
  });
});
