import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type Row = { label: string; value: string };
type StateModel = {
  sessionRows: (session: unknown) => Row[];
  roundRows: (round: unknown, serverTimeMs: unknown) => Row[];
  storedEventFrame: (event: unknown) => Record<string, unknown>;
};

let model: StateModel;

beforeAll(async () => {
  const source = await readFile(new URL("../static/dev-state-model.js", import.meta.url), "utf8");
  model = await import(`data:text/javascript,${encodeURIComponent(source)}`) as StateModel;
});

describe("sessionRows", () => {
  it("formats status and timestamps, tolerating missing values", () => {
    const rows = model.sessionRows({ status: "active", started_at_ms: 1750000000000, ended_at_ms: null });
    expect(rows[0]).toEqual({ label: "Status", value: "active" });
    expect(rows[1]?.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);
    expect(rows[2]).toEqual({ label: "Ended", value: "—" });
    expect(model.sessionRows(null)).toEqual([{ label: "Session", value: "Unavailable" }]);
  });
});

describe("roundRows", () => {
  const active = {
    question: { prompt: "What is 1/2 + 1/4?" },
    eligiblePlayerIds: ["a", "b", "c"],
    deadlineWallMs: 10_000,
  };

  it("degrades to NO ROUND without a snapshot", () => {
    expect(model.roundRows(null, 0)).toEqual([{ label: "Phase", value: "NO ROUND" }]);
  });

  it("shows phase, prompt, lock counts, and remaining time while open", () => {
    const rows = model.roundRows({ phase: "QUESTION_OPEN", active, answers: [{}, {}] }, 4_000);
    expect(rows).toEqual([
      { label: "Phase", value: "QUESTION_OPEN" },
      { label: "Question", value: "What is 1/2 + 1/4?" },
      { label: "Locked", value: "2 of 3" },
      { label: "Remaining", value: "6.0s" },
    ]);
  });

  it("clamps expired deadlines to zero and reports pause remaining", () => {
    const open = model.roundRows({ phase: "QUESTION_OPEN", active, answers: [] }, 99_999);
    expect(open.at(-1)).toEqual({ label: "Remaining", value: "0.0s" });
    const paused = model.roundRows({ phase: "PAUSED", active, answers: [], pauseRemainingMs: 2_500 }, 0);
    expect(paused.at(-1)).toEqual({ label: "Paused with", value: "2.5s left" });
  });
});

describe("storedEventFrame", () => {
  it("maps stored camelCase events onto the log-format frame shape", () => {
    const frame = model.storedEventFrame({
      serverSeq: 7,
      eventType: "reveal",
      payload: { correct_choice: 2 },
      createdAtMs: 123,
      actorKind: "system",
    });
    expect(frame).toEqual({
      source: "events",
      server_seq: 7,
      event_type: "reveal",
      payload: { correct_choice: 2 },
      created_at_ms: 123,
    });
    expect(model.storedEventFrame(null)).toEqual({
      source: "events",
      server_seq: undefined,
      event_type: undefined,
      payload: undefined,
      created_at_ms: undefined,
    });
  });
});
