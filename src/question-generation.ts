export type GeneratedQuestion = Readonly<{
  question: string;
  choices: readonly [string, string, string];
  correct: number;
  explanation: string;
}>;

type ChatCompletion = Readonly<{
  choices?: readonly Readonly<{
    message?: Readonly<{ content?: unknown }>;
  }>[];
}>;

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((word) => `${word.slice(0, 1).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function parseGeneratedQuestions(rawResponse: string, expectedCount: number): GeneratedQuestion[] {
  let completion: ChatCompletion;
  try {
    completion = JSON.parse(rawResponse) as ChatCompletion;
  } catch {
    throw new Error("Gateway response is not valid JSON");
  }
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Gateway response does not contain message content");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Model message content is not valid JSON");
  }
  const candidates =
    typeof payload === "object" && payload !== null && "questions" in payload
      ? (payload as { questions: unknown }).questions
      : payload;
  if (!Array.isArray(candidates)) {
    throw new Error("Model output must be an array of questions");
  }
  if (candidates.length !== expectedCount) {
    throw new Error(`Model returned ${candidates.length} questions; expected ${expectedCount}`);
  }

  return candidates.map((candidate, index) => {
    const position = index + 1;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error(`Question ${position} must be an object`);
    }
    const record = candidate as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const explanation = typeof record.explanation === "string" ? record.explanation.trim() : "";
    if (question.length === 0) {
      throw new Error(`Question ${position} has an empty prompt`);
    }
    if (explanation.length === 0 || explanation.length > 240) {
      throw new Error(`Question ${position} must have a short explanation (1-240 characters)`);
    }
    if (
      !Array.isArray(record.choices) ||
      record.choices.length !== 3 ||
      !record.choices.every((choice) => typeof choice === "string")
    ) {
      throw new Error(`Question ${position} must have exactly 3 text choices`);
    }
    const choices = record.choices.map((choice) => choice.trim()) as [string, string, string];
    if (choices.some((choice) => choice.length === 0)) {
      throw new Error(`Question ${position} has an empty choice`);
    }
    if (new Set(choices.map((choice) => choice.toLocaleLowerCase())).size !== 3) {
      throw new Error(`Question ${position} choices must be distinct`);
    }
    if (!Number.isInteger(record.correct) || (record.correct as number) < 0 || (record.correct as number) > 2) {
      throw new Error(`Question ${position} correct index must be an integer from 0 to 2`);
    }
    return Object.freeze({
      question,
      choices: Object.freeze(choices),
      correct: record.correct as number,
      explanation,
    });
  });
}

export function generatedQuestionsCsv(
  questions: readonly GeneratedQuestion[],
  subject: string,
  grade: string,
): string {
  const title = `Grade ${grade.trim()} ${titleCase(subject)} - AI draft`;
  const rows = questions.map((question) => [
    title,
    titleCase(subject),
    grade.trim(),
    question.question,
    JSON.stringify(question.choices),
    String(question.correct),
    question.explanation,
  ].map(csvCell).join(","));
  return [
    "set title,subject,grade,question,choices,correct,explanation",
    ...rows,
    "",
  ].join("\n");
}

export function generationPrompt(subject: string, grade: string, count: number): string {
  return [
    `Create exactly ${count} classroom-safe multiple-choice questions about ${subject} for grade ${grade}.`,
    "Return JSON only, with no markdown, as an object with a questions array.",
    "Each question object must have: question (string), choices (exactly 3 distinct non-empty strings), correct (zero-based integer 0-2), and explanation (clear and no more than 240 characters).",
    "Use age-appropriate language, vary the correct option position, and verify every answer.",
  ].join(" ");
}
