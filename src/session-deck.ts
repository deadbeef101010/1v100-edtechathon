import { CommandCoordinator, type CommandError } from "./command-coordinator.js";
import type { AppDatabase } from "./db.js";
import { createSilentLogger, type ServerLogger } from "./log.js";

export type DeckQuestion = Readonly<{
  id: string;
  position: number;
  prompt: string;
  choices: readonly string[];
  correctChoice: number;
  explanation: string | null;
}>;

export type ReservedDeck = Readonly<{
  ok: true;
  requestId: string;
  serverSeq: number;
  questionSetId: string;
  startPosition: number;
  questions: readonly DeckQuestion[];
}>;

export type EndedSessionDeck = Readonly<{
  ok: true;
  requestId: string;
  serverSeq: number;
  ended: true;
  reason: "question_budget_short";
}>;

type SessionDeckOutcome = ReservedDeck | EndedSessionDeck | CommandError;
type SessionDeckState =
  | Readonly<{ kind: "ended" }>
  | Readonly<{
      kind: "deck";
      questions: readonly DeckQuestion[];
      nextStartPosition: number;
    }>;

export type SessionDeckEvent = Readonly<{
  type: "question_set_attached" | "deck_reserved" | "session_end" | "teacher_notice";
  audience: "all" | "teacher";
  serverSeq: number;
  payload: Readonly<Record<string, unknown>>;
}>;

type SessionRow = {
  teacher_id: string;
  question_set_id: string;
  deck_start_position: number;
  status: "lobby" | "live" | "ended";
  settings_json: string;
};

function sessionRow(database: AppDatabase, sessionId: string): SessionRow | undefined {
  return database.prepare(
    `SELECT teacher_id, question_set_id, deck_start_position, status, settings_json
     FROM sessions WHERE session_id = ?`,
  ).get(sessionId) as SessionRow | undefined;
}

function loadQuestions(
  database: AppDatabase,
  questionSetId: string,
  startPosition: number,
  size: number,
): DeckQuestion[] {
  const rows = database.prepare(
    `SELECT question_id, position, prompt, choices_json, correct_choice, explanation
     FROM questions
     WHERE question_set_id = ? AND position >= ?
     ORDER BY position
     LIMIT ?`,
  ).all(questionSetId, startPosition, size) as Array<{
    question_id: string;
    position: number;
    prompt: string;
    choices_json: string;
    correct_choice: number;
    explanation: string | null;
  }>;
  const questions: DeckQuestion[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.position !== startPosition + index) {
      break;
    }
    const choices = JSON.parse(row.choices_json) as unknown;
    if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === "string")) {
      throw new Error(`Question ${row.question_id} has invalid choices`);
    }
    questions.push(Object.freeze({
      id: row.question_id,
      position: row.position,
      prompt: row.prompt,
      choices: Object.freeze(choices),
      correctChoice: row.correct_choice,
      explanation: row.explanation,
    }));
  }
  return questions;
}

export function attachQuestionSetToSession(
  database: AppDatabase,
  command: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
    questionSetId: string;
    now?: number;
  }>,
  emit: (event: SessionDeckEvent) => void = () => undefined,
  logger: ServerLogger = createSilentLogger(),
): Readonly<{ ok: true; requestId: string; serverSeq: number }> | CommandError {
  const coordinator = new CommandCoordinator(database, undefined, logger);
  return coordinator.execute({
    sessionId: command.sessionId,
    commandType: "attach_question_set",
    actorKind: "teacher",
    actorId: command.teacherId,
    requestId: command.requestId,
    payload: { question_set_id: command.questionSetId },
    createdAtMs: command.now ?? Date.now(),
    propose: () => {
      const session = sessionRow(database, command.sessionId);
      const ownedSet = database.prepare(
        "SELECT question_set_id FROM question_sets WHERE question_set_id = ? AND teacher_id = ?",
      ).get(command.questionSetId, command.teacherId);
      if (session === undefined || session.teacher_id !== command.teacherId) {
        return { code: "FORBIDDEN", disposition: "terminal" };
      }
      if (session.status !== "lobby") {
        return { code: "SESSION_STARTED", message: "Choose questions before the show starts", disposition: "terminal" };
      }
      if (ownedSet === undefined) {
        return { code: "QUESTION_SET_NOT_FOUND", disposition: "terminal" };
      }
      return {
        state: command.questionSetId,
        eventType: "question_set_attached",
        eventPayload: { question_set_id: command.questionSetId, deck_start_position: 1 },
        persist: () => {
          database.prepare(
            "UPDATE sessions SET question_set_id = ?, deck_start_position = 1 WHERE session_id = ?",
          ).run(command.questionSetId, command.sessionId);
        },
        outcome: (event) => Object.freeze({
          ok: true as const,
          requestId: command.requestId,
          serverSeq: event.serverSeq,
        }),
        apply: (questionSetId, event) => emit(Object.freeze({
          type: "question_set_attached",
          audience: "teacher",
          serverSeq: event.serverSeq,
          payload: Object.freeze({ question_set_id: questionSetId, deck_start_position: 1 }),
        })),
      };
    },
  });
}

export function reserveNextSessionDeck(
  database: AppDatabase,
  command: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
    now?: number;
  }>,
  emit: (event: SessionDeckEvent) => void = () => undefined,
  logger: ServerLogger = createSilentLogger(),
): ReservedDeck | EndedSessionDeck | CommandError {
  const coordinator = new CommandCoordinator(database, undefined, logger);
  const now = command.now ?? Date.now();
  return coordinator.execute<SessionDeckState, SessionDeckOutcome>({
    sessionId: command.sessionId,
    commandType: "reserve_next_deck",
    actorKind: "teacher",
    actorId: command.teacherId,
    requestId: command.requestId,
    payload: {},
    createdAtMs: now,
    propose: () => {
      const session = sessionRow(database, command.sessionId);
      if (session === undefined || session.teacher_id !== command.teacherId) {
        return { code: "FORBIDDEN", disposition: "terminal" };
      }
      if (session.status === "ended") {
        return { code: "SESSION_ENDED", disposition: "terminal" };
      }
      const settings = JSON.parse(session.settings_json) as {
        questions_per_game?: unknown;
        session_question_budget?: unknown;
      };
      const deckSize = settings.questions_per_game;
      const budget = settings.session_question_budget;
      if (!Number.isInteger(deckSize) || !Number.isInteger(budget)) {
        throw new Error("Session question settings are invalid");
      }
      const consumed = session.deck_start_position - 1;
      const remainingBudget = (budget as number) - consumed;
      if (remainingBudget <= 0) {
        return { code: "QUESTION_BUDGET_REACHED", disposition: "terminal" };
      }
      const questions = loadQuestions(
        database,
        session.question_set_id,
        session.deck_start_position,
        Math.min(deckSize as number, remainingBudget),
      );
      if (questions.length === 0) {
        const reason = "question_budget_short";
        return {
          state: Object.freeze({ kind: "ended" as const }),
          eventType: "session_end",
          eventPayload: { reason, questions_used: consumed, question_budget: budget },
          persist: () => {
            database.prepare(
              "UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?",
            ).run(now, command.sessionId);
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            ended: true as const,
            reason,
          }),
          apply: (_state, event) => {
            emit(Object.freeze({
              type: "session_end",
              audience: "all",
              serverSeq: event.serverSeq,
              payload: Object.freeze({ reason, questions_used: consumed, question_budget: budget }),
            }));
            emit(Object.freeze({
              type: "teacher_notice",
              audience: "teacher",
              serverSeq: event.serverSeq,
              payload: Object.freeze({
                code: "QUESTION_BUDGET_SHORT",
                message: `The question set ended after ${consumed} questions, before the ${String(budget)}-question session budget.`,
              }),
            }));
          },
        };
      }
      const nextStartPosition = session.deck_start_position + questions.length;
      const safeQuestions = questions.map((question) => ({
        question_id: question.id,
        position: question.position,
      }));
      return {
        state: Object.freeze({
          kind: "deck" as const,
          questions: Object.freeze(questions),
          nextStartPosition,
        }),
        eventType: "deck_reserved",
        eventPayload: {
          question_set_id: session.question_set_id,
          deck_start_position: session.deck_start_position,
          questions: safeQuestions,
        },
        persist: () => {
          database.prepare(
            "UPDATE sessions SET deck_start_position = ?, status = 'live', started_at_ms = COALESCE(started_at_ms, ?) WHERE session_id = ?",
          ).run(nextStartPosition, now, command.sessionId);
        },
        outcome: (event): ReservedDeck => Object.freeze({
          ok: true,
          requestId: command.requestId,
          serverSeq: event.serverSeq,
          questionSetId: session.question_set_id,
          startPosition: session.deck_start_position,
          questions: Object.freeze(questions),
        }),
        apply: (state, event) => emit(Object.freeze({
          type: "deck_reserved",
          audience: "teacher",
          serverSeq: event.serverSeq,
          payload: Object.freeze({
            question_set_id: session.question_set_id,
            deck_start_position: session.deck_start_position,
            deck_size: state.kind === "deck" ? state.questions.length : 0,
          }),
        })),
      };
    },
  });
}

export function questionOpenPayload(question: DeckQuestion): Readonly<Record<string, unknown>> {
  return Object.freeze({
    question_id: question.id,
    prompt: question.prompt,
    choices: question.choices,
  });
}

export function openNextDeckQuestion(
  database: AppDatabase,
  round: Readonly<{
    openQuestion: (command: Readonly<{
      actorId: string;
      requestId: string;
      attemptId: string;
      question: Readonly<{
        id: string;
        prompt: string;
        choices: readonly string[];
        correctChoice: number;
      }>;
      durationMs: number;
      eligiblePlayerIds: readonly string[];
      advanceDeckCursor?: boolean;
      expectedDeckStartPosition?: number;
      idempotencyPayload?: Readonly<Record<string, unknown>>;
      prepare?: () => void;
    }>) => unknown;
  }>,
  command: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
    attemptId: string;
    durationMs: number;
    eligiblePlayerIds: readonly string[];
  }>,
  logger: ServerLogger = createSilentLogger(),
): unknown {
  const idempotencyPayload = {
    source: "session_deck",
    attempt_id: command.attemptId,
    duration_ms: command.durationMs,
    eligible_player_ids: command.eligiblePlayerIds,
  };
  const replay = new CommandCoordinator(database, undefined, logger).replay({
    sessionId: command.sessionId,
    commandType: "open_question",
    actorKind: "teacher",
    actorId: command.teacherId,
    requestId: command.requestId,
    payload: idempotencyPayload,
  });
  if (replay !== undefined) return replay;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let selectedQuestion: DeckQuestion | undefined;
    let selectedPosition: number | undefined;
    try {
      return round.openQuestion({
        actorId: command.teacherId,
        requestId: command.requestId,
        attemptId: command.attemptId,
        get question() {
          const question = selectedQuestion;
          if (question === undefined) throw new Error("Deck question was not selected transactionally");
          return question;
        },
        durationMs: command.durationMs,
        eligiblePlayerIds: command.eligiblePlayerIds,
        advanceDeckCursor: true,
        get expectedDeckStartPosition() {
          const position = selectedPosition;
          if (position === undefined) throw new Error("Deck cursor was not selected transactionally");
          return position;
        },
        idempotencyPayload,
        prepare: () => {
          const session = database.prepare(
            "SELECT question_set_id, deck_start_position FROM sessions WHERE session_id = ?",
          ).get(command.sessionId) as
            | { question_set_id: string; deck_start_position: number }
            | undefined;
          if (session === undefined) throw new Error(`Unknown session: ${command.sessionId}`);
          const question = loadQuestions(database, session.question_set_id, session.deck_start_position, 1)[0];
          if (question === undefined) throw new Error("The selected question set has no next question");
          selectedQuestion = question;
          selectedPosition = session.deck_start_position;
        },
      });
    } catch (error) {
      if ((error as Error).name !== "DeckCursorConflict" || attempt === 1) throw error;
    }
  }
  throw new Error("Unable to reserve the next deck question");
}
