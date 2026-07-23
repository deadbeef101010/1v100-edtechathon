import { basename } from "node:path";

import type { AppDatabase } from "./db.js";
import { uuidV7 } from "./ids.js";

const REQUIRED_HEADERS = [
  "set title",
  "subject",
  "grade",
  "question",
  "choices",
  "correct",
  "explanation",
] as const;

export type QuestionImportError = Readonly<{
  row: number;
  reason: string;
}>;

export type QuestionImportResult = Readonly<{
  setsCreated: number;
  questionsImported: number;
  skipped: readonly QuestionImportError[];
}>;

export class QuestionImportValidationError extends Error {
  readonly errors: readonly QuestionImportError[];

  constructor(errors: readonly QuestionImportError[]) {
    super(errors.map((error) => `Row ${error.row}: ${error.reason}`).join("\n"));
    this.name = "QuestionImportValidationError";
    this.errors = Object.freeze([...errors]);
  }
}

export class QuestionImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionImportFormatError";
  }
}

type ParsedRow = Readonly<{
  row: number;
  setTitle: string;
  subject: string;
  grade: string;
  prompt: string;
  choices: readonly [string, string, string];
  correctChoice: number;
  explanation: string | null;
  explicitPosition: number | null;
}>;

type ImportableRow = ParsedRow & Readonly<{ position: number }>;

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) {
    throw new QuestionImportFormatError("CSV contains an unterminated quoted field");
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((value) => value.trim().length > 0));
}

function parseChoices(value: string): readonly [string, string, string] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "choices must be a JSON array";
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((choice) => typeof choice === "string")) {
    return "choices must contain exactly 3 text options";
  }
  const choices = parsed.map((choice) => choice.trim()) as [string, string, string];
  if (choices.some((choice) => choice.length === 0)) {
    return "choices must not contain an empty option";
  }
  if (new Set(choices.map((choice) => choice.toLocaleLowerCase())).size !== choices.length) {
    return "choices must be distinct";
  }
  return Object.freeze(choices);
}

function parseRows(csv: string): Readonly<{ rows: ParsedRow[]; errors: QuestionImportError[] }> {
  const records = parseCsv(csv);
  const header = records[0];
  if (header === undefined) {
    throw new QuestionImportFormatError("CSV is empty");
  }
  const headers = header.map((value) => value.trim().toLocaleLowerCase());
  const missing = REQUIRED_HEADERS.filter((required) => !headers.includes(required));
  if (missing.length > 0) {
    throw new QuestionImportFormatError(`CSV is missing required columns: ${missing.join(", ")}`);
  }
  const column = (name: string): number => headers.indexOf(name);
  const parsedRows: ParsedRow[] = [];
  const errors: QuestionImportError[] = [];

  for (const [recordIndex, record] of records.slice(1).entries()) {
    const rowNumber = recordIndex + 2;
    const value = (name: string): string => record[column(name)]?.trim() ?? "";
    const rowErrors: string[] = [];
    for (const required of ["set title", "subject", "grade", "question"] as const) {
      if (value(required).length === 0) {
        rowErrors.push(`${required} must not be empty`);
      }
    }
    const choices = parseChoices(value("choices"));
    if (typeof choices === "string") {
      rowErrors.push(choices);
    }
    const correctChoice = Number(value("correct"));
    if (!Number.isInteger(correctChoice) || correctChoice < 0 || correctChoice > 2) {
      rowErrors.push("correct must be an integer from 0 to 2");
    }
    const positionValue = column("position") < 0 ? "" : value("position");
    const explicitPosition = positionValue.length === 0 ? null : Number(positionValue);
    if (explicitPosition !== null && (!Number.isInteger(explicitPosition) || explicitPosition < 1)) {
      rowErrors.push("position must be a positive integer");
    }
    if (rowErrors.length > 0 || typeof choices === "string") {
      errors.push(...rowErrors.map((reason) => Object.freeze({ row: rowNumber, reason })));
      continue;
    }
    parsedRows.push(Object.freeze({
      row: rowNumber,
      setTitle: value("set title"),
      subject: value("subject"),
      grade: value("grade"),
      prompt: value("question"),
      choices,
      correctChoice,
      explanation: value("explanation") || null,
      explicitPosition,
    }));
  }
  return Object.freeze({ rows: parsedRows, errors });
}

function setKey(row: ParsedRow): string {
  return JSON.stringify([row.setTitle, row.subject, row.grade]);
}

export function importQuestionsCsv(
  database: AppDatabase,
  csv: string,
  options: Readonly<{
    teacherId: string;
    partial?: boolean;
    sourceName?: string;
    now?: number;
  }>,
): QuestionImportResult {
  const parsed = parseRows(csv);
  const errors = [...parsed.errors];
  const positions = new Map<string, number>();
  const usedPositions = new Map<string, Set<number>>();
  const importable: ImportableRow[] = [];

  for (const row of parsed.rows) {
    const key = setKey(row);
    const nextPosition = (positions.get(key) ?? 0) + 1;
    positions.set(key, nextPosition);
    const position = row.explicitPosition ?? nextPosition;
    const used = usedPositions.get(key) ?? new Set<number>();
    usedPositions.set(key, used);
    if (used.has(position)) {
      errors.push(Object.freeze({ row: row.row, reason: `position ${position} is duplicated in this set` }));
      continue;
    }
    used.add(position);
    importable.push(Object.freeze({ ...row, position }));
  }

  if (errors.length > 0 && options.partial !== true) {
    throw new QuestionImportValidationError(errors);
  }
  const invalidRows = new Set(errors.map((error) => error.row));
  const accepted = importable.filter((row) => !invalidRows.has(row.row));
  const now = options.now ?? Date.now();
  let setsCreated = 0;

  const importAll = database.transaction(() => {
    const setIds = new Map<string, string>();
    for (const row of accepted) {
      const key = setKey(row);
      let questionSetId = setIds.get(key);
      if (questionSetId === undefined) {
        questionSetId = uuidV7(now + setsCreated);
        database.prepare(
          `INSERT INTO question_sets
            (question_set_id, teacher_id, title, source_name, created_at_ms, updated_at_ms,
             subject, grade)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          questionSetId,
          options.teacherId,
          row.setTitle,
          options.sourceName === undefined ? null : basename(options.sourceName),
          now,
          now,
          row.subject,
          row.grade,
        );
        setIds.set(key, questionSetId);
        setsCreated += 1;
      }
      database.prepare(
        `INSERT INTO questions
          (question_id, question_set_id, position, prompt, choices_json, correct_choice, explanation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuidV7(now + setsCreated + row.row),
        questionSetId,
        row.position,
        row.prompt,
        JSON.stringify(row.choices),
        row.correctChoice,
        row.explanation,
      );
    }
  });
  importAll();

  return Object.freeze({
    setsCreated,
    questionsImported: accepted.length,
    skipped: Object.freeze(errors),
  });
}
