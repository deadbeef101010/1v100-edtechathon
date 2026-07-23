import { describe, expect, it } from "vitest";

import {
  generatedQuestionsCsv,
  parseGeneratedQuestions,
} from "../src/question-generation.js";

function response(content: unknown): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

const goodQuestions = [
  {
    question: "Which fraction equals one half?",
    choices: ["1/2", "1/3", "1/4"],
    correct: 0,
    explanation: "One of two equal parts is one half.",
  },
  {
    question: "What is one fourth of 20?",
    choices: ["4", "5", "8"],
    correct: 1,
    explanation: "Twenty divided into four equal groups gives five.",
  },
];

describe("AI question response validation", () => {
  it("validates a complete response and emits importer-compatible CSV", () => {
    const questions = parseGeneratedQuestions(response(JSON.stringify({ questions: goodQuestions })), 2);
    const csv = generatedQuestionsCsv(questions, "fractions", "5");

    expect(questions).toHaveLength(2);
    expect(csv).toContain("set title,subject,grade,question,choices,correct,explanation");
    expect(csv).toContain('"Grade 5 Fractions - AI draft","Fractions","5"');
    expect(csv).toContain('"[""1/2"",""1/3"",""1/4""]"');
  });

  it("rejects malformed model content", () => {
    expect(() => parseGeneratedQuestions(response("definitely not JSON"), 2))
      .toThrow("Model message content is not valid JSON");
  });

  it("rejects the wrong number of questions", () => {
    expect(() => parseGeneratedQuestions(response(JSON.stringify([goodQuestions[0]])), 2))
      .toThrow("Model returned 1 questions; expected 2");
  });

  it("rejects duplicate options", () => {
    const duplicate = [{
      ...goodQuestions[0],
      choices: ["1/2", "1/2", "1/4"],
    }];
    expect(() => parseGeneratedQuestions(response(JSON.stringify(duplicate)), 1))
      .toThrow("Question 1 choices must be distinct");
  });

  it("rejects incomplete and out-of-range answer data", () => {
    const incomplete = [{
      question: "Question?",
      choices: ["A", "B", "C"],
      correct: 3,
    }];
    expect(() => parseGeneratedQuestions(response(JSON.stringify(incomplete)), 1))
      .toThrow("must have a short explanation");
  });
});
