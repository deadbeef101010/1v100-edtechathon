import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { openDatabase } from "../src/db.js";
import {
  importQuestionsCsv,
  QuestionImportValidationError,
  type QuestionImportResult,
} from "../src/question-import.js";

function argumentValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1]?.trim();
}

export function runImportQuestionsCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): QuestionImportResult {
  const filePath = argumentValue(arguments_, "--file") ?? arguments_.find((value) => !value.startsWith("--"));
  const databasePath = environment.DATABASE_PATH?.trim() || environment.DB_PATH?.trim();
  if (filePath === undefined || filePath.length === 0 || databasePath === undefined || databasePath.length === 0) {
    throw new Error("Usage: import-questions --file <questions.csv> [--teacher-id <id>] [--partial] (DATABASE_PATH required)");
  }

  const database = openDatabase(databasePath);
  try {
    const requestedTeacherId = argumentValue(arguments_, "--teacher-id");
    const teachers = database.prepare(
      "SELECT teacher_id FROM teachers WHERE status = 'active' ORDER BY created_at_ms",
    ).all() as Array<{ teacher_id: string }>;
    const teacherId = requestedTeacherId ?? (teachers.length === 1 ? teachers[0]?.teacher_id : undefined);
    if (teacherId === undefined) {
      throw new Error("Specify --teacher-id when the database does not contain exactly one active teacher");
    }
    if (!teachers.some((teacher) => teacher.teacher_id === teacherId)) {
      throw new Error("The selected teacher does not exist or is not active");
    }
    return importQuestionsCsv(database, readFileSync(filePath, "utf8"), {
      teacherId,
      partial: arguments_.includes("--partial"),
      sourceName: filePath,
    });
  } finally {
    database.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    const result = runImportQuestionsCli(process.argv.slice(2));
    for (const error of result.skipped) {
      process.stderr.write(`Row ${error.row}: ${error.reason}\n`);
    }
    process.stdout.write(`${result.questionsImported} questions imported into ${result.setsCreated} set(s)\n`);
  } catch (error) {
    if (error instanceof QuestionImportValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
