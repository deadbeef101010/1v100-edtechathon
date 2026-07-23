import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import {
  flatScoring,
  QuestionRound,
  type LeaderboardBroadcast,
  type RevealBroadcast,
  type RoundBroadcast,
  type ScoringFunction,
} from "../src/question-round.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "reveal-scoring-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let sessionId: string;
let now: number;
let broadcasts: Array<RoundBroadcast | RevealBroadcast | LeaderboardBroadcast>;
let round: QuestionRound;

function addPlayer(playerId: string, points: number, streak: number, joinedAtMs: number): void {
  database
    .prepare(
      `INSERT INTO session_players
        (player_id, session_id, nickname, nickname_norm, token_hash,
         token_expires_at_ms, role, points, streak, joined_at_ms, last_seen_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'mob', ?, ?, ?, ?)`,
    )
    .run(
      playerId,
      sessionId,
      playerId,
      playerId,
      Buffer.from(`token-${playerId}`),
      99_999,
      points,
      streak,
      joinedAtMs,
      joinedAtMs,
    );
}

function makeRound(scoring: ScoringFunction = flatScoring): QuestionRound {
  return new QuestionRound({
    sessionId,
    store: new GameEventStore(database),
    database,
    scoring,
    monotonicNow: () => now,
    wallNow: () => 10_000 + now,
    emit: (event) => broadcasts.push(event),
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-reveal-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Reveal Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, SECRET).sessionId;
  addPlayer("player-1", 0, 2, 1);
  addPlayer("player-2", 20, 3, 2);
  addPlayer("player-3", 5, 4, 3);
  now = 100;
  broadcasts = [];
  round = makeRound();
  round.openQuestion({
    actorId: "teacher-1",
    requestId: "open-1",
    attemptId: "attempt-1",
    question: {
      id: "question-1",
      prompt: "Pick B",
      choices: ["A", "B", "C"],
      correctChoice: 1,
    },
    durationMs: 1_000,
    eligiblePlayerIds: ["player-1", "player-2", "player-3"],
  });
  round.answer({
    actorId: "player-1",
    requestId: "answer-1",
    attemptId: "attempt-1",
    questionId: "question-1",
    choice: 1,
  });
  round.answer({
    actorId: "player-2",
    requestId: "answer-2",
    attemptId: "attempt-1",
    questionId: "question-1",
    choice: 0,
  });
  now = 1_101;
  round.lockExpired();
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const reveal = (requestId = "reveal-1") =>
  round.reveal({ actorId: "teacher-1", requestId, attemptId: "attempt-1" });

describe("generic reveal scoring", () => {
  it("commits correctness, flat deltas, player totals, and counts before broadcast", () => {
    let persistedAtEmit = false;
    broadcasts = [];
    round = new QuestionRound({
      sessionId,
      store: new GameEventStore(database),
      database,
      scoring: flatScoring,
      monotonicNow: () => now,
      wallNow: () => 10_000 + now,
      emit: (event) => {
        if (event.type === "reveal") {
          persistedAtEmit = new GameEventStore(database)
            .readSession(sessionId)
            .some((stored) => stored.eventType === "reveal");
        }
        broadcasts.push(event);
      },
      restore: round.snapshot(),
    });

    expect(reveal()).toMatchObject({ ok: true });
    const players = database
      .prepare(
        "SELECT player_id, points, streak FROM session_players WHERE session_id = ? ORDER BY joined_at_ms",
      )
      .all(sessionId);
    const revealEvent = new GameEventStore(database)
      .readSession(sessionId)
      .find((event) => event.eventType === "reveal");

    expect(persistedAtEmit).toBe(true);
    expect(players).toEqual([
      { player_id: "player-1", points: 10, streak: 3 },
      { player_id: "player-2", points: 20, streak: 0 },
      { player_id: "player-3", points: 5, streak: 0 },
    ]);
    expect(revealEvent?.payload).toMatchObject({
      correct_choice: 1,
      counts: [1, 1, 0],
      outcomes: [
        { player_id: "player-1", choice: 1, correct: true, delta: 10, streak: 3 },
        { player_id: "player-2", choice: 0, correct: false, delta: 0, streak: 0 },
        { player_id: "player-3", choice: null, correct: false, delta: 0, streak: 0 },
      ],
    });
  });

  it("keeps ledger sums equal to replayed reveal deltas", () => {
    reveal();
    const replayDelta = new GameEventStore(database)
      .readSession(sessionId)
      .filter((event) => event.eventType === "reveal")
      .flatMap((event) => (event.payload as { outcomes: Array<{ delta: number }> }).outcomes)
      .reduce((sum, outcome) => sum + outcome.delta, 0);
    const persistedTotal = (
      database.prepare("SELECT SUM(points) AS total FROM session_players").get() as {
        total: number;
      }
    ).total;

    expect(replayDelta).toBe(10);
    expect(persistedTotal).toBe(35);
    expect(persistedTotal - 25).toBe(replayDelta);
  });

  it("persists a request-correlated replay acknowledgement without double scoring", () => {
    const first = reveal();
    const retried = reveal("reveal-2");

    expect(retried).toEqual({ ...first, requestId: "reveal-2" });
    expect(reveal("reveal-2")).toEqual(retried);
    expect(
      new GameEventStore(database)
        .readSession(sessionId)
        .filter((event) => event.eventType === "reveal"),
    ).toHaveLength(1);
    expect(
      (database
        .prepare("SELECT points FROM session_players WHERE player_id = 'player-1'")
        .get() as { points: number }).points,
    ).toBe(10);
    expect(database.prepare(
      "SELECT command_type, outcome_json FROM command_outcomes WHERE session_id = ? AND actor_id = ? AND request_id = ?",
    ).get(sessionId, "teacher-1", "reveal-2")).toEqual({
      command_type: "reveal",
      outcome_json: JSON.stringify(retried),
    });
  });

  it("uses an injected streak-aware scoring function", () => {
    const restored = round.snapshot();
    const streakScoring: ScoringFunction = ({ correct, nextStreak }) =>
      correct ? nextStreak * 2 : 0;
    round = makeRound(streakScoring);
    round.restore(restored);

    reveal();

    expect(
      (database
        .prepare("SELECT points FROM session_players WHERE player_id = 'player-1'")
        .get() as { points: number }).points,
    ).toBe(6);
  });

  it("leaves state, scores, events, and broadcasts unchanged after transaction failure", () => {
    database.exec(`
      CREATE TRIGGER reject_reveal BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'reveal'
      BEGIN SELECT RAISE(ABORT, 'injected reveal failure'); END;
    `);
    const beforeEvents = new GameEventStore(database).readSession(sessionId);
    const beforeSnapshot = round.snapshot();
    broadcasts = [];

    expect(() => reveal()).toThrow(/injected reveal failure/);

    expect(round.snapshot()).toEqual(beforeSnapshot);
    expect(new GameEventStore(database).readSession(sessionId)).toEqual(beforeEvents);
    expect(broadcasts).toEqual([]);
    expect(
      database
        .prepare("SELECT player_id, points, streak FROM session_players ORDER BY joined_at_ms")
        .all(),
    ).toEqual([
      { player_id: "player-1", points: 0, streak: 2 },
      { player_id: "player-2", points: 20, streak: 3 },
      { player_id: "player-3", points: 5, streak: 4 },
    ]);
  });

  it("rejects reveal outside the locked phase and for stale attempts", () => {
    const lobby = makeRound();

    expect(lobby.reveal({ actorId: "teacher-1", requestId: "r", attemptId: "a" })).toMatchObject(
      { ok: false, code: "WRONG_PHASE" },
    );
    expect(
      round.reveal({ actorId: "teacher-1", requestId: "stale-reveal", attemptId: "stale" }),
    ).toMatchObject({ ok: false, code: "STALE_ATTEMPT" });
  });
});
