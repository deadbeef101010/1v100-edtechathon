import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type GraphModel = {
  answerChip: (round: unknown, playerId: string) => { visible: boolean; time: string; correct: boolean | null };
  groupPlayers: (players: Array<Record<string, unknown>>) => {
    one: Array<Record<string, unknown>>;
    mob: Array<Record<string, unknown>>;
    crowd: Array<Record<string, unknown>>;
  };
  roundSummary: (round: unknown) => { phase: string; answered: number; eligible: number };
};

let model: GraphModel;

beforeAll(async () => {
  const source = await readFile(new URL("../static/dev-graph-model.js", import.meta.url), "utf8");
  model = await import(`data:text/javascript,${encodeURIComponent(source)}`) as GraphModel;
});

describe("dev graph model", () => {
  it("groups active players by role and omits kicked players", () => {
    const groups = model.groupPlayers([
      { player_id: "one", role: "one", kicked_at_ms: null },
      { player_id: "mob", role: "mob", kicked_at_ms: null },
      { player_id: "crowd", role: "crowd", kicked_at_ms: null },
      { player_id: "gone", role: "mob", kicked_at_ms: 10 },
    ]);

    expect(groups.one.map((player) => player.player_id)).toEqual(["one"]);
    expect(groups.mob.map((player) => player.player_id)).toEqual(["mob"]);
    expect(groups.crowd.map((player) => player.player_id)).toEqual(["crowd"]);
  });

  it("withholds choice and correctness until reveal while preserving answer timing", () => {
    const snapshot = {
      phase: "QUESTION_OPEN",
      active: { startedWallMs: 1_000, question: { correctChoice: 2 }, eligiblePlayerIds: ["p1"] },
      answers: [{ playerId: "p1", choice: 2, receivedAtMs: 2_234 }],
    };

    expect(model.answerChip(snapshot, "p1")).toEqual({ visible: true, time: "1.2s", correct: null });
    expect(model.answerChip({ ...snapshot, phase: "LOCKED" }, "p1").correct).toBeNull();
    expect(model.answerChip({ ...snapshot, phase: "PAUSED" }, "p1").correct).toBeNull();
    expect(model.answerChip({ ...snapshot, phase: "REVEALED" }, "p1")).toEqual({
      visible: true,
      time: "1.2s",
      correct: true,
    });
    expect(model.answerChip({
      ...snapshot,
      phase: "REVEALED",
      answers: [{ playerId: "p1", choice: 1, receivedAtMs: 2_234 }],
    }, "p1").correct).toBe(false);
  });

  it("degrades without a round, active question, or answer", () => {
    expect(model.answerChip(null, "p1")).toEqual({ visible: false, time: "", correct: null });
    expect(model.answerChip({ phase: "LOBBY", active: null, answers: [] }, "p1").visible).toBe(false);
    expect(model.answerChip({ phase: "QUESTION_OPEN", active: {}, answers: [] }, "p1").visible).toBe(false);
    expect(model.roundSummary(null)).toEqual({ phase: "NO ROUND", answered: 0, eligible: 0 });
    expect(model.roundSummary({})).toEqual({ phase: "UNKNOWN", answered: 0, eligible: 0 });
  });
});
