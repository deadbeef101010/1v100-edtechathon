import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGenerateQuestionsCli } from "../tools/gen-questions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("question generation CLI", () => {
  it("writes a valid CSV before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen-questions-"));
    directories.push(directory);
    const output = join(directory, "questions.csv");
    const raw = JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify([{ question: "Q?", choices: ["A", "B", "C"], correct: 0, explanation: "A is correct." }]),
        },
      }],
    });
    const fetcher = async (): Promise<Response> => new Response(raw, { status: 200 });

    const result = await runGenerateQuestionsCli(
      ["--subject", "fractions", "--grade", "5", "--count", "1", "--out", output],
      { OPENAI_API_KEY: "test-key" },
      fetcher,
    );

    expect(result).toMatchObject({ count: 1, imported: false, outputPath: output });
    expect(await readFile(output, "utf8")).toContain('"Q?","[""A"",""B"",""C""]","0"');
  });

  it("saves the raw response and does not write CSV for malformed output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gen-questions-"));
    directories.push(directory);
    const output = join(directory, "questions.csv");
    const raw = JSON.stringify({ choices: [{ message: { content: "bad model output" } }] });

    await expect(runGenerateQuestionsCli(
      ["--subject", "fractions", "--grade", "5", "--count", "1", "--out", output],
      { OPENAI_API_KEY: "test-key" },
      async () => new Response(raw, { status: 200 }),
    )).rejects.toThrow(`${output}.rejected`);
    expect(await readFile(`${output}.rejected`, "utf8")).toBe(raw);
    await expect(readFile(output, "utf8")).rejects.toThrow();
  });
});
