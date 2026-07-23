import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  generatedQuestionsCsv,
  generationPrompt,
  parseGeneratedQuestions,
} from "../src/question-generation.js";
import { runImportQuestionsCli } from "./import-questions.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4.1-mini";

function argumentValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1]?.trim();
}

export type GenerateQuestionsResult = Readonly<{
  outputPath: string;
  count: number;
  imported: boolean;
}>;

export async function runGenerateQuestionsCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<GenerateQuestionsResult> {
  const subject = argumentValue(arguments_, "--subject");
  const grade = argumentValue(arguments_, "--grade");
  const count = Number(argumentValue(arguments_, "--count"));
  const model = argumentValue(arguments_, "--model") ?? DEFAULT_MODEL;
  const outputPath = resolve(argumentValue(arguments_, "--out") ?? `questions-${Date.now()}.csv`);
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (
    subject === undefined ||
    subject.length === 0 ||
    grade === undefined ||
    grade.length === 0 ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 100
  ) {
    throw new Error("Usage: gen-questions --subject <subject> --grade <grade> --count <1-100> [--model <model>] [--out <file.csv>] [--import]");
  }
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Missing required environment variable: OPENAI_API_KEY");
  }
  const baseUrl = (environment.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetcher(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You write accurate, inclusive classroom assessment questions and return strict JSON.",
        },
        { role: "user", content: generationPrompt(subject, grade, count) },
      ],
      response_format: { type: "json_object" },
    }),
  });
  const rawResponse = await response.text();
  if (!response.ok) {
    writeFileSync(`${outputPath}.rejected`, rawResponse, "utf8");
    throw new Error(`Model request failed with HTTP ${response.status}; raw response saved to ${outputPath}.rejected`);
  }
  let questions;
  try {
    questions = parseGeneratedQuestions(rawResponse, count);
  } catch (error) {
    writeFileSync(`${outputPath}.rejected`, rawResponse, "utf8");
    throw new Error(`${error instanceof Error ? error.message : String(error)}; raw response saved to ${outputPath}.rejected`);
  }

  writeFileSync(outputPath, generatedQuestionsCsv(questions, subject, grade), "utf8");
  const shouldImport = arguments_.includes("--import");
  if (shouldImport) {
    const teacherId = argumentValue(arguments_, "--teacher-id");
    runImportQuestionsCli([
      "--file",
      outputPath,
      ...(teacherId === undefined ? [] : ["--teacher-id", teacherId]),
    ], environment);
  }
  return Object.freeze({ outputPath, count: questions.length, imported: shouldImport });
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runGenerateQuestionsCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${result.count} draft questions written to ${result.outputPath}${result.imported ? " and imported" : ""}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
