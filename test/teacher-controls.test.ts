import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { QuestionRound } from "../src/question-round.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "teacher-controls-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let sessionId: string;
let now: number;
let round: QuestionRound;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-controls-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Control Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, SECRET).sessionId;
  for (const [index, id] of ["p-1", "p-2"].entries()) {
    database
      .prepare(
        `INSERT INTO session_players
          (player_id, session_id, nickname, nickname_norm, token_hash,
           token_expires_at_ms, role, joined_at_ms, last_seen_at_ms)
         VALUES (?, ?, ?, ?, ?, 99999, 'mob', ?, ?)`,
      )
      .run(id, sessionId, id, id, Buffer.from(id), index, index);
  }
  now = 100;
  round = new QuestionRound({
    sessionId,
    store: new GameEventStore(database),
    database,
    monotonicNow: () => now,
    wallNow: () => 10_000 + now,
    emit: () => undefined,
  });
  round.openQuestion({
    actorId: "teacher",
    requestId: "open",
    attemptId: "attempt-1",
    question: { id: "q-1", prompt: "Q", choices: ["A", "B", "C"], correctChoice: 0 },
    durationMs: 1_000,
    eligiblePlayerIds: ["p-1", "p-2"],
  });
  round.answer({
    actorId: "p-1",
    requestId: "answer",
    attemptId: "attempt-1",
    questionId: "q-1",
    choice: 0,
  });
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe("teacher pacing controls", () => {
  it("force reveals and treats every unanswered player as no_answer", () => {
    expect(
      round.forceReveal({ actorId: "teacher", requestId: "force", attemptId: "attempt-1" }),
    ).toMatchObject({ ok: true });

    expect(round.phase).toBe("REVEALED");
    const events = new GameEventStore(database).readSession(sessionId);
    expect(events.filter((event) => event.eventType === "no_answer").map((event) => event.actorId)).toEqual([
      "p-2",
    ]);
    expect(
      (events.find((event) => event.eventType === "reveal")?.payload as {
        outcomes: Array<{ player_id: string; delta: number }>;
      }).outcomes,
    ).toContainEqual(expect.objectContaining({ player_id: "p-2", delta: 0 }));
  });

  it("reveals after all eligible players auto-lock the round", () => {
    expect(round.answer({
      actorId: "p-2",
      requestId: "answer-2",
      attemptId: "attempt-1",
      questionId: "q-1",
      choice: 1,
    })).toMatchObject({ ok: true });
    expect(round.phase).toBe("LOCKED");

    const revealed = round.forceReveal({
      actorId: "teacher",
      requestId: "reveal-locked",
      attemptId: "attempt-1",
    });
    expect(revealed).toMatchObject({ ok: true });
    expect(round.phase).toBe("REVEALED");
    expect(round.forceReveal({
      actorId: "teacher",
      requestId: "reveal-locked",
      attemptId: "attempt-1",
    })).toEqual(revealed);
    expect(new GameEventStore(database).readSession(sessionId).filter((event) =>
      event.eventType === "reveal"
    )).toHaveLength(1);
  });

  it("does not partially lock when atomic force reveal persistence fails", () => {
    database.exec(`
      CREATE TRIGGER reject_force_reveal BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'reveal'
      BEGIN SELECT RAISE(ABORT, 'injected force reveal failure'); END;
    `);
    const before = round.snapshot();

    expect(() => round.forceReveal({
      actorId: "teacher",
      requestId: "failed-force",
      attemptId: "attempt-1",
    })).toThrow(/injected force reveal failure/);

    expect(round.snapshot()).toEqual(before);
    expect(new GameEventStore(database).readSession(sessionId).filter((event) =>
      ["phase_a_locked", "no_answer", "reveal"].includes(event.eventType)
    )).toEqual([]);
  });

  it("rejects answers while paused and resumes with deadline extended by pause duration", () => {
    now = 400;
    expect(
      round.pause({ actorId: "teacher", requestId: "pause", attemptId: "attempt-1" }),
    ).toMatchObject({ ok: true, remainingMs: 700 });
    now = 900;

    expect(
      round.answer({
        actorId: "p-2",
        requestId: "paused-answer",
        attemptId: "attempt-1",
        questionId: "q-1",
        choice: 0,
      }),
    ).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    expect(
      round.resume({ actorId: "teacher", requestId: "resume", attemptId: "attempt-1" }),
    ).toMatchObject({ ok: true, deadlineMs: 11_600 });
    now = 1_599;
    expect(
      round.answer({
        actorId: "p-2",
        requestId: "resumed-answer",
        attemptId: "attempt-1",
        questionId: "q-1",
        choice: 0,
      }),
    ).toMatchObject({ ok: true });
  });

  it("advances from revealed standings only on a teacher command", () => {
    round.forceReveal({ actorId: "teacher", requestId: "force", attemptId: "attempt-1" });
    expect(round.phase).toBe("REVEALED");

    expect(
      round.advance({ actorId: "teacher", requestId: "advance", attemptId: "attempt-1" }),
    ).toMatchObject({ ok: true });
    expect(round.phase).toBe("LOBBY");
  });

  it("re-evaluates the same advance request after a real phase transition", () => {
    const command = { actorId: "teacher", requestId: "advance-after-reveal", attemptId: "attempt-1" };

    expect(round.advance(command)).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    expect(round.forceReveal({
      actorId: "teacher",
      requestId: "reveal-for-retry",
      attemptId: "attempt-1",
    })).toMatchObject({ ok: true });
    expect(round.advance(command)).toMatchObject({ ok: true });
    expect(round.phase).toBe("LOBBY");
    expect(new GameEventStore(database).readSession(sessionId).filter((event) =>
      event.eventType === "teacher_advance"
    )).toHaveLength(1);
  });

  it("rejects stale and wrong-phase controls without mutation", () => {
    const before = round.snapshot();

    expect(
      round.pause({ actorId: "teacher", requestId: "pause", attemptId: "stale" }),
    ).toMatchObject({ ok: false, code: "STALE_ATTEMPT" });
    expect(
      round.resume({ actorId: "teacher", requestId: "resume", attemptId: "attempt-1" }),
    ).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    expect(round.snapshot()).toEqual(before);
  });
});
