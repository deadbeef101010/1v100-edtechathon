import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import {
  attachQuestionSetToSession,
  openNextDeckQuestion,
  questionOpenPayload,
  reserveNextSessionDeck,
  type SessionDeckEvent,
} from "../src/session-deck.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";
import { GameEventStore } from "../src/game-event-store.js";
import { QuestionRound } from "../src/question-round.js";
import { ServerLogger } from "../src/log.js";

const SECRET = "deck-test-secret-at-least-32-characters";
let database: AppDatabase;
let teacherId: string;
let sessionId: string;
let setId: string;

beforeEach(() => {
  database = openDatabase(":memory:");
  teacherId = mintTeacherKey(database, "Deck teacher").teacherId;
  setId = "thirty-questions";
  database.prepare(
    `INSERT INTO question_sets
      (question_set_id, teacher_id, title, created_at_ms, updated_at_ms, subject, grade)
     VALUES (?, ?, 'Thirty questions', 1, 1, 'Math', '5')`,
  ).run(setId, teacherId);
  const insert = database.prepare(
    `INSERT INTO questions
      (question_id, question_set_id, position, prompt, choices_json, correct_choice, explanation)
     VALUES (?, ?, ?, ?, '["A","B","C"]', ?, 'Because')`,
  );
  for (let position = 1; position <= 30; position += 1) {
    insert.run(`q-${position}`, setId, position, `Question ${position}`, position % 3);
  }
  sessionId = createClassroomSession(database, teacherId, SECRET, { questionSetId: setId }).sessionId;
});

afterEach(() => database.close());

describe("session question deck", () => {
  it("attaches a teacher-owned set through the command coordinator", () => {
    const otherSet = "other-set";
    database.prepare(
      `INSERT INTO question_sets
        (question_set_id, teacher_id, title, created_at_ms, updated_at_ms, subject, grade)
       VALUES (?, ?, 'Other', 1, 1, 'Science', '5')`,
    ).run(otherSet, teacherId);

    expect(attachQuestionSetToSession(database, {
      sessionId,
      teacherId,
      requestId: "attach-set",
      questionSetId: otherSet,
    })).toMatchObject({ ok: true });
    expect(database.prepare(
      "SELECT question_set_id, deck_start_position FROM sessions WHERE session_id = ?",
    ).get(sessionId)).toEqual({ question_set_id: otherSet, deck_start_position: 1 });
    expect(database.prepare(
      "SELECT event_type FROM game_events WHERE session_id = ? ORDER BY server_seq DESC LIMIT 1",
    ).get(sessionId)).toEqual({ event_type: "question_set_attached" });
  });

  it("uses the injected logger for deck request mismatches", () => {
    const logger = new ServerLogger({ write: () => undefined });
    const command = {
      sessionId,
      teacherId,
      requestId: "logged-attach",
      questionSetId: setId,
    };
    expect(attachQuestionSetToSession(database, command, undefined, logger)).toMatchObject({ ok: true });
    expect(attachQuestionSetToSession(database, {
      ...command,
      questionSetId: "changed-set",
    }, undefined, logger)).toMatchObject({ ok: false, code: "REQUEST_MISMATCH" });
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "command_request_mismatch",
      session_id: sessionId,
    }));
  });

  it("reserves consecutive non-wrapping game decks without overlap or gaps", () => {
    const positions: number[] = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const result = reserveNextSessionDeck(database, {
        sessionId,
        teacherId,
        requestId: `reserve-${ordinal}`,
      });
      expect(result.ok).toBe(true);
      if (result.ok && "questions" in result) {
        positions.push(...result.questions.map((question) => question.position));
        expect(result.questions.length).toBe(ordinal < 3 ? 12 : 6);
      }
    }

    expect(positions).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(new Set(positions).size).toBe(30);
    expect(database.prepare("SELECT deck_start_position FROM sessions WHERE session_id = ?").get(sessionId))
      .toEqual({ deck_start_position: 31 });
  });

  it("ends a 36-question-budget session after all 30 available questions with a teacher notice", () => {
    const events: SessionDeckEvent[] = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      reserveNextSessionDeck(database, {
        sessionId,
        teacherId,
        requestId: `game-${ordinal}`,
      });
    }
    const ended = reserveNextSessionDeck(database, {
      sessionId,
      teacherId,
      requestId: "game-4",
    }, (event) => events.push(event));

    expect(ended).toMatchObject({ ok: true, ended: true, reason: "question_budget_short" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session_end", payload: expect.objectContaining({ reason: "question_budget_short", questions_used: 30 }) }),
      expect.objectContaining({ type: "teacher_notice", audience: "teacher" }),
    ]));
    expect(database.prepare("SELECT status FROM sessions WHERE session_id = ?").get(sessionId))
      .toEqual({ status: "ended" });
  });

  it("builds question-open payloads from the reserved deck without leaking answers", () => {
    const result = reserveNextSessionDeck(database, {
      sessionId,
      teacherId,
      requestId: "first-game",
    });
    if (!result.ok || !("questions" in result)) {
      throw new Error("Expected a reserved deck");
    }
    const first = result.questions[0];
    if (first === undefined) {
      throw new Error("Expected a question");
    }

    expect(questionOpenPayload(first)).toEqual({
      question_id: "q-1",
      prompt: "Question 1",
      choices: ["A", "B", "C"],
    });
    expect(questionOpenPayload(first)).not.toHaveProperty("correctChoice");
    expect(questionOpenPayload(first)).not.toHaveProperty("correct_choice");
  });

  it("opens the next persisted deck question and advances the session cursor atomically", () => {
    const packets: unknown[] = [];
    const round = new QuestionRound({
      sessionId,
      database,
      store: new GameEventStore(database),
      monotonicNow: () => 10,
      wallNow: () => 20,
      emit: (event) => packets.push(event),
    });

    expect(openNextDeckQuestion(database, round, {
      sessionId,
      teacherId,
      requestId: "open-from-deck",
      attemptId: "attempt-from-deck",
      durationMs: 20_000,
      eligiblePlayerIds: [],
    })).toMatchObject({ ok: true });
    expect(packets[0]).toMatchObject({
      type: "question_open",
      payload: { question_id: "q-1", prompt: "Question 1", choices: ["A", "B", "C"] },
    });
    expect(JSON.stringify(packets[0])).not.toContain("correctChoice");
    expect(database.prepare("SELECT deck_start_position FROM sessions WHERE session_id = ?").get(sessionId))
      .toEqual({ deck_start_position: 2 });
    expect(openNextDeckQuestion(database, round, {
      sessionId,
      teacherId,
      requestId: "open-from-deck",
      attemptId: "attempt-from-deck",
      durationMs: 20_000,
      eligiblePlayerIds: [],
    })).toMatchObject({ ok: true });
    expect(database.prepare("SELECT deck_start_position FROM sessions WHERE session_id = ?").get(sessionId))
      .toEqual({ deck_start_position: 2 });
  });
});
