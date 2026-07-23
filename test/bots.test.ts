import { describe, expect, it, vi } from "vitest";

import {
  chooseRandomAnswer,
  createLlmPolicy,
  createRandomPolicy,
  createSeededRandom,
  parseBotArguments,
  parseLlmChoice,
  sampleHumanLatencyMs,
  type BotQuestion,
} from "../tools/bots.js";

const question: BotQuestion = Object.freeze({
  attempt_id: "attempt-1",
  question_id: "question-1",
  prompt: "Which option is correct?",
  choices: ["Alpha", "Beta", "Gamma"],
  server_time_ms: 1_000,
  deadline_ms: 21_000,
});

describe("bot answer policies", () => {
  it("selects the oracle answer at full accuracy and only wrong choices at zero accuracy", () => {
    expect(chooseRandomAnswer(3, 1, 1, createSeededRandom(42))).toBe(1);
    const random = createSeededRandom(42);
    const choices = Array.from({ length: 20 }, () => chooseRandomAnswer(3, 0, 1, random));
    expect(choices).not.toContain(1);
  });

  it("tracks intermediate accuracy over seeded trials", () => {
    const random = createSeededRandom(2026);
    const choices = Array.from({ length: 200 }, () => chooseRandomAnswer(4, 0.7, 2, random));
    const correct = choices.filter((choice) => choice === 2).length;
    expect(correct / choices.length).toBeGreaterThan(0.62);
    expect(correct / choices.length).toBeLessThan(0.78);
  });

  it("selects uniformly across every wrong choice", () => {
    const random = createSeededRandom(7);
    const counts = [0, 0, 0, 0];
    for (let index = 0; index < 6_000; index += 1) {
      const choice = chooseRandomAnswer(4, 0, 1, random);
      counts[choice] = (counts[choice] ?? 0) + 1;
    }
    expect(counts[1]).toBe(0);
    for (const choice of [0, 2, 3]) expect(counts[choice]).toBeGreaterThan(1_850);
    for (const choice of [0, 2, 3]) expect(counts[choice]).toBeLessThan(2_150);
  });

  it("falls back to uniform random when no oracle answer is available", async () => {
    const fallback = vi.fn();
    const policy = createRandomPolicy({ accuracy: 1, onFallback: fallback });
    const choice = await policy.choose({
      question,
      sessionId: "session-1",
      random: () => 0.99,
      signal: new AbortController().signal,
    });
    expect(choice).toBe(2);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("parses a constrained LLM response without making a network call", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "2" } }] })),
    );
    const policy = createLlmPolicy({
      model: "test-model",
      baseUrl: "http://gateway.test/v1",
      apiKey: "test-key",
      fetchImpl,
    });
    await expect(policy.choose({
      question,
      sessionId: "session-1",
      random: () => 0,
      signal: new AbortController().signal,
    })).resolves.toBe(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://gateway.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(parseLlmChoice("Answer: B", 3)).toBe(1);
  });
});

describe("human latency sampler", () => {
  it("is deterministic, bounded to eight seconds, and clipped to the deadline", () => {
    const first = createSeededRandom(123);
    const second = createSeededRandom(123);
    const samples = Array.from({ length: 100 }, () => sampleHumanLatencyMs(first));
    expect(samples).toEqual(Array.from({ length: 100 }, () => sampleHumanLatencyMs(second)));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(2_000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(8_000);
    const clipped = sampleHumanLatencyMs(createSeededRandom(1), 250);
    expect(clipped).toBeGreaterThan(0);
    expect(clipped).toBeLessThanOrEqual(250);
  });
});

describe("bot CLI arguments", () => {
  it("parses defaults and explicit options", () => {
    expect(parseBotArguments(["--url", "https://game.test", "--code", "ABC234"])).toMatchObject({
      url: "https://game.test",
      code: "ABC234",
      count: 30,
      accuracy: 0.7,
      policy: "random",
      gatewayBaseUrl: "https://api.openai.com/v1",
      dropTest: false,
    });
    expect(parseBotArguments([
      "--url", "https://game.test", "--code", "ABC234", "--count", "5", "--accuracy", "0.9",
      "--policy", "llm", "--model", "model-a", "--seed", "12", "--drop-test",
    ])).toMatchObject({ count: 5, accuracy: 0.9, policy: "llm", model: "model-a", seed: 12, dropTest: true });
    expect(() => parseBotArguments([
      "--url", "https://game.test", "--code", "ABC234", "--unknown", "value",
    ])).toThrow(/Usage/);
  });
});
