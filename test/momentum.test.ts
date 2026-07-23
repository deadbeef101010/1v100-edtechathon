import { describe, expect, it } from "vitest";

import { computeMomentumFastWindow } from "../src/engine/momentum.js";

describe("momentum fast window", () => {
  const compute = (
    answers: Parameters<typeof computeMomentumFastWindow>[0]["answers"],
    overrides: Partial<Parameters<typeof computeMomentumFastWindow>[0]> = {},
  ) => computeMomentumFastWindow({
    answers,
    correctChoice: 2,
    fastK: 1.25,
    windowMinMs: 8_000,
    windowMaxMs: 20_000,
    ...overrides,
  });

  it("uses the fastest ceil(correct Mob count / 2)", () => {
    const result = compute([
      { choice: 2, receiveDurationMs: 12_000, role: "mob" },
      { choice: 2, receiveDurationMs: 4_000, role: "mob" },
      { choice: 2, receiveDurationMs: 8_000, role: "mob" },
      { choice: 2, receiveDurationMs: 6_000, role: "mob" },
      { choice: 2, receiveDurationMs: 10_000, role: "mob" },
    ]);

    expect(result.correctMobDurationsMs).toEqual([4_000, 6_000, 8_000, 10_000, 12_000]);
    expect(result.selectedDurationsMs).toEqual([4_000, 6_000, 8_000]);
    expect(result.selectedCount).toBe(3);
    expect(result.fastWindowMs).toBe(8_000);
  });

  it("filters wrong answers and correct Crowd answers", () => {
    const result = compute([
      { choice: 1, receiveDurationMs: 100, role: "mob" },
      { choice: 2, receiveDurationMs: 200, role: "crowd" },
      { choice: 2, receiveDurationMs: 10_000, role: "mob" },
    ]);

    expect(result.correctMobDurationsMs).toEqual([10_000]);
    expect(result.fastWindowMs).toBe(12_500);
  });

  it("clamps both window bounds", () => {
    expect(compute([{ choice: 2, receiveDurationMs: 1_000, role: "mob" }]).fastWindowMs).toBe(8_000);
    expect(compute([{ choice: 2, receiveDurationMs: 30_000, role: "mob" }]).fastWindowMs).toBe(20_000);
  });

  it("uses and marks the maximum-window fallback when no Mob answer is correct", () => {
    const result = compute([
      { choice: 1, receiveDurationMs: 5_000, role: "mob" },
      { choice: 2, receiveDurationMs: 5_000, role: "crowd" },
    ]);

    expect(result).toMatchObject({
      fastWindowMs: 20_000,
      correctMobDurationsMs: [],
      selectedDurationsMs: [],
      selectedCount: 0,
      meanMs: null,
      fallback: true,
    });
  });

  it("keeps the 20-second fallback even when the configured window maximum is lower", () => {
    const result = computeMomentumFastWindow({
      answers: [{ choice: 1, receiveDurationMs: 5_000, role: "mob" }],
      correctChoice: 0,
      fastK: 1.25,
      windowMinMs: 8_000,
      windowMaxMs: 15_000,
    });

    expect(result).toMatchObject({ fastWindowMs: 20_000, fallback: true });
  });
});
