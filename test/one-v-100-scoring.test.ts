import { describe, expect, it } from "vitest";

import { scoreOneV100Reveal, type ScoringPlayer } from "../src/engine/one-v-100-scoring.js";
import { ONE_V_100_DEFAULT_SETTINGS } from "../src/engine/ruleset-settings.js";

const one = (points = 0): ScoringPlayer => ({ id: "one", role: "one", points, streak: 0 });
const mob = (id: string, points = 0, streak = 0): ScoringPlayer => ({ id, role: "mob", points, streak });
const crowd = (id: string, points = 0, streak = 0): ScoringPlayer => ({ id, role: "crowd", points, streak });

describe("1v100 reveal scoring", () => {
  it("awards streak scoring, demotes three wrong Mob players, and grows the bank", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("right"), mob("wrong-1"), mob("wrong-2"), mob("silent")],
      eligiblePlayerIds: ["right", "wrong-1", "wrong-2", "silent"],
      answers: [
        { playerId: "right", choice: 1 },
        { playerId: "wrong-1", choice: 0 },
        { playerId: "wrong-2", choice: 2 },
        { playerId: "silent", choice: null },
      ],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 20,
      questionNumber: 1,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result).toMatchObject({
      demoted: ["wrong-1", "wrong-2", "silent"],
      bankDelta: 60,
      bank: 80,
      strikesRemaining: 2,
      endReason: null,
    });
    expect(result.scoreDeltas).toEqual(expect.arrayContaining([
      { player_id: "right", points: 12, reason: "correct_answer" },
      { player_id: "one", points: 10, reason: "survival_drip" },
    ]));
  });

  it("splits a flameout bank with floor rounding and drops the remainder", () => {
    const result = scoreOneV100Reveal({
      players: [one(10), mob("a"), mob("b"), mob("c")],
      eligiblePlayerIds: ["a", "b", "c"],
      answers: [],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: false,
      strikesRemaining: 1,
      bank: 65,
      questionNumber: 4,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result.endReason).toBe("flameout");
    expect(result.bankedByOne).toBe(0);
    expect(result.payouts).toEqual([
      { player_id: "a", points: 21 },
      { player_id: "b", points: 21 },
      { player_id: "c", points: 21 },
    ]);
    expect(result.players.find((player) => player.id === "one")?.points).toBe(10);
  });

  it("pays the jackpot after a correct answer empties the Mob", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("a"), mob("b")],
      eligiblePlayerIds: ["a", "b"],
      answers: [{ playerId: "a", choice: 0 }, { playerId: "b", choice: null }],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 20,
      questionNumber: 12,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result).toMatchObject({ endReason: "mob_emptied", bank: 60, bankedByOne: 90 });
    expect(result.players.find((player) => player.id === "one")?.points).toBe(100);
    expect(result.payouts).toEqual([{ player_id: "one", points: 90 }]);
  });

  it("omits payouts when the durable player row is absent", () => {
    const result = scoreOneV100Reveal({
      players: [mob("mob")],
      eligiblePlayerIds: ["mob"],
      answers: [{ playerId: "mob", choice: 0 }],
      correctChoice: 1,
      onePlayerId: "deleted-one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 30,
      questionNumber: 1,
      deckSize: 2,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result.endReason).toBe("mob_emptied");
    expect(result.payouts).toEqual([]);
    expect(result.scoreDeltas.some((delta) => delta.player_id === "deleted-one")).toBe(false);
  });

  it("accumulates a Crowd player's streak when they answer correctly", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("survivor"), crowd("crowd", 20, 2)],
      eligiblePlayerIds: ["survivor", "crowd"],
      answers: [{ playerId: "survivor", choice: 1 }, { playerId: "crowd", choice: 1 }],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 0,
      questionNumber: 1,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result.players.find((player) => player.id === "crowd")).toMatchObject({
      points: 31,
      streak: 3,
    });
    expect(result.scoreDeltas).toContainEqual({
      player_id: "crowd",
      points: 11,
      reason: "correct_answer",
    });
  });

  it("resets a nonzero streak when a player answers incorrectly", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("wrong", 20, 4), mob("survivor")],
      eligiblePlayerIds: ["wrong", "survivor"],
      answers: [{ playerId: "wrong", choice: 0 }, { playerId: "survivor", choice: 1 }],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 0,
      questionNumber: 1,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result.players.find((player) => player.id === "wrong")).toMatchObject({
      points: 20,
      streak: 0,
    });
  });

  it("banks for the One and bonuses surviving Mob players after the deck is survived", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("a"), mob("b")],
      eligiblePlayerIds: ["a", "b"],
      answers: [{ playerId: "a", choice: 1 }, { playerId: "b", choice: 1 }],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: false,
      strikesRemaining: 2,
      bank: 65,
      questionNumber: 12,
      deckSize: 12,
      settings: ONE_V_100_DEFAULT_SETTINGS,
    });

    expect(result).toMatchObject({ endReason: "deck_survived", strikesRemaining: 1, bankedByOne: 65 });
    expect(result.payouts).toEqual([
      { player_id: "one", points: 65 },
      { player_id: "a", points: 15 },
      { player_id: "b", points: 15 },
    ]);
    expect(result.players.find((player) => player.id === "one")?.points).toBe(75);
    expect(result.players.find((player) => player.id === "a")?.points).toBe(27);
    expect(result.players.find((player) => player.id === "b")?.points).toBe(27);
  });

  it("uses a non-default bank_per_elimination setting", () => {
    const result = scoreOneV100Reveal({
      players: [one(), mob("wrong-1"), mob("wrong-2"), mob("silent"), mob("survivor")],
      eligiblePlayerIds: ["wrong-1", "wrong-2", "silent", "survivor"],
      answers: [
        { playerId: "wrong-1", choice: 0 },
        { playerId: "wrong-2", choice: 2 },
        { playerId: "silent", choice: null },
        { playerId: "survivor", choice: 1 },
      ],
      correctChoice: 1,
      onePlayerId: "one",
      oneCorrect: true,
      strikesRemaining: 2,
      bank: 20,
      questionNumber: 1,
      deckSize: 12,
      settings: { ...ONE_V_100_DEFAULT_SETTINGS, bank_per_elimination: 30 },
    });

    expect(result).toMatchObject({
      demoted: ["wrong-1", "wrong-2", "silent"],
      bankDelta: 90,
      bank: 110,
    });
  });
});
