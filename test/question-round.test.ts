import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import {
  QuestionRound,
  type LeaderboardBroadcast,
  type RevealBroadcast,
  type RoundBroadcast,
} from "../src/question-round.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = `question-round-${"test-only-".repeat(3)}`;
let directory: string;
let database: AppDatabase;
let sessionId: string;
let now: number;
let broadcasts: Array<RoundBroadcast | RevealBroadcast | LeaderboardBroadcast>;
let round: QuestionRound;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-question-round-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Round Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, SECRET).sessionId;
  now = 100;
  broadcasts = [];
  round = new QuestionRound({
    sessionId,
    store: new GameEventStore(database),
    database,
    monotonicNow: () => now,
    wallNow: () => 10_000 + now,
    emit: (event) => broadcasts.push(event),
  });
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const open = (eligiblePlayerIds = ["player-1", "player-2"]) =>
  round.openQuestion({
    actorId: "teacher-1",
    requestId: "open-1",
    attemptId: "attempt-1",
    question: {
      id: "question-1",
      prompt: "Which option?",
      choices: ["A", "B", "C"],
      correctChoice: 1,
    },
    durationMs: 1_000,
    eligiblePlayerIds,
  });

const answer = (overrides: Record<string, unknown> = {}) =>
  round.answer({
    actorId: "player-1",
    requestId: "answer-1",
    attemptId: "attempt-1",
    questionId: "question-1",
    choice: 1,
    ...overrides,
  });

describe("question open and answer intake", () => {
  it("broadcasts the question with a monotonic deadline projection", () => {
    expect(open()).toEqual({ ok: true, requestId: "open-1", serverSeq: 1 });

    expect(broadcasts).toEqual([
      {
        type: "question_open",
        serverSeq: 1,
        payload: {
          attempt_id: "attempt-1",
          question_id: "question-1",
          prompt: "Which option?",
            choices: ["A", "B", "C"],
            started_at_ms: 10_100,
            deadline_ms: 11_100,
            server_time_ms: 10_100,
        },
      },
    ]);
  });

  it("rejects an answer received one millisecond after the deadline before timer lock", () => {
    open();
    now = 1_101;

    expect(answer()).toEqual({ ok: false, requestId: "answer-1", code: "TOO_LATE" });
    expect(round.phase).toBe("QUESTION_OPEN");
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "answer_accepted"),
    ).toHaveLength(0);
  });

  it("returns the same ack for a request retry but rejects a second request", () => {
    open();
    const first = answer();

    expect(answer()).toEqual(first);
    expect(answer({ requestId: "answer-2", choice: 2 })).toEqual({
      ok: false,
      requestId: "answer-2",
      code: "ALREADY_ANSWERED",
    });
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "answer_accepted"),
    ).toHaveLength(1);
  });

  it("locks early when every eligible player has answered", () => {
    open();
    answer();

    expect(answer({ actorId: "player-2", requestId: "answer-2", choice: 0 })).toMatchObject({
      ok: true,
    });
    expect(round.phase).toBe("LOCKED");
    expect(broadcasts.at(-1)).toMatchObject({
      type: "phase_a_locked",
      payload: { reason: "all_answered", locked_count: 2, eligible_count: 2 },
    });
  });

  it("rolls back the final answer when its automatic lock cannot persist", () => {
    open();
    answer();
    database.exec(`
      CREATE TRIGGER reject_automatic_lock BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'phase_a_locked'
      BEGIN SELECT RAISE(ABORT, 'injected automatic lock failure'); END;
    `);

    expect(() => answer({ actorId: "player-2", requestId: "answer-2", choice: 0 }))
      .toThrow(/injected automatic lock failure/);

    expect(round.phase).toBe("QUESTION_OPEN");
    expect(round.liveSnapshot("player-2").own_answer).toBeNull();
    expect(new GameEventStore(database).readSession(sessionId).filter((event) =>
      event.eventType === "answer_accepted" || event.eventType === "phase_a_locked"
    )).toHaveLength(1);
  });

  it("accepts choice D when the active question has four choices", () => {
    round.openQuestion({
      actorId: "teacher-1",
      requestId: "open-four",
      attemptId: "attempt-four",
      question: { id: "question-four", prompt: "Choose D", choices: ["A", "B", "C", "D"], correctChoice: 3 },
      durationMs: 1_000,
      eligiblePlayerIds: ["player-1"],
    });

    expect(round.answer({
      actorId: "player-1",
      requestId: "answer-four",
      attemptId: "attempt-four",
      questionId: "question-four",
      choice: 3,
    })).toMatchObject({ ok: true });
  });

  it("records every unanswered eligible player as no_answer at deadline lock", () => {
    open(["player-1", "player-2", "player-3"]);
    answer();
    now = 1_101;

    expect(round.lockExpired()).toMatchObject({ ok: true });
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "no_answer")
        .map((event) => event.actorId),
    ).toEqual(["player-2", "player-3"]);
  });

  it.each([
    ["wrong phase", () => answer(), "WRONG_PHASE"],
    ["stale attempt", () => (open(), answer({ attemptId: "stale" })), "STALE_ATTEMPT"],
    ["wrong question", () => (open(), answer({ questionId: "other" })), "STALE_ATTEMPT"],
    ["ineligible player", () => (open(), answer({ actorId: "late-player" })), "FORBIDDEN"],
    ["choice below range", () => (open(), answer({ choice: -1 })), "INVALID_CHOICE"],
    ["choice above range", () => (open(), answer({ choice: 3 })), "INVALID_CHOICE"],
  ] as const)("rejects %s without persisting an answer", (_name, act, code) => {
    expect(act()).toMatchObject({ ok: false, code });
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "answer_accepted"),
    ).toHaveLength(0);
  });

  it("makes timer and all-answered locking idempotent", () => {
    open(["player-1"]);
    answer();
    now = 1_101;

    expect(round.lockExpired()).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "phase_a_locked"),
    ).toHaveLength(1);
  });
});
