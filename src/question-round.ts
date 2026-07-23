import {
  CommandCoordinator,
  type CommandError,
  type CommandSuccess,
  type RejectedCommand,
} from "./command-coordinator.js";
import { GameEventStore, type StoredGameEvent } from "./game-event-store.js";
import type { AppDatabase } from "./db.js";
import { buildLeaderboard, type Leaderboard } from "./leaderboard.js";
import { createSilentLogger, type ServerLogger } from "./log.js";

export type Question = Readonly<{
  id: string;
  prompt: string;
  choices: readonly string[];
  correctChoice: number;
}>;

type SuccessAck = CommandSuccess;
type ErrorCode =
  | "WRONG_PHASE"
  | "TOO_LATE"
  | "ALREADY_ANSWERED"
  | "STALE_ATTEMPT"
  | "FORBIDDEN"
  | "INVALID_CHOICE"
  | "ALREADY_REVEALED"
  | "SESSION_ENDED";
type ErrorAck = CommandError & Readonly<{ code: ErrorCode | "REQUEST_MISMATCH" }>;
export type RoundAck = SuccessAck | ErrorAck;

export type RoundBroadcast = Readonly<{
  type: "question_open" | "lock_counts" | "phase_a_locked" | "phase_state";
  serverSeq: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RevealBroadcast = Readonly<{
  type: "reveal";
  serverSeq: number;
  payload: Readonly<Record<string, unknown>>;
}>;

export type LeaderboardBroadcast = Readonly<{
  type: "leaderboard";
  serverSeq: number;
  payload: Leaderboard & Readonly<{ server_time_ms: number; deadline_ms: number | null }>;
}>;

export type QuestionRoundBroadcast = RoundBroadcast | RevealBroadcast | LeaderboardBroadcast;

export type LiveRoundSnapshot = Readonly<{
  phase: "LOBBY" | "QUESTION_OPEN" | "LOCKED" | "REVEALED" | "PAUSED";
  attempt_id: string | null;
  question: Readonly<{
    question_id: string;
    prompt: string;
    choices: readonly string[];
  }> | null;
  own_answer: number | null;
  locked_count: number;
  eligible_count: number;
  server_time_ms: number;
  deadline_ms: number | null;
}>;

export type ScoringInput = Readonly<{
  correct: boolean;
  answered: boolean;
  priorStreak: number;
  nextStreak: number;
}>;

export type ScoringFunction = (input: ScoringInput) => number;

export const flatScoring: ScoringFunction = ({ correct }) => (correct ? 10 : 0);

type OpenQuestionCommand = Readonly<{
  actorId: string;
  requestId: string;
  attemptId: string;
  question: Question;
  durationMs: number;
  eligiblePlayerIds: readonly string[];
  advanceDeckCursor?: boolean;
  expectedDeckStartPosition?: number;
  idempotencyPayload?: Readonly<Record<string, unknown>>;
  prepare?: () => void;
}>;

type AnswerCommand = Readonly<{
  actorId: string;
  requestId: string;
  attemptId: string;
  questionId: string;
  choice: number;
  idempotencyPayload?: Readonly<Record<string, unknown>>;
}>;

export type ActiveQuestion = Readonly<{
  attemptId: string;
  question: Question;
  startedMonotonicMs: number;
  deadlineMonotonicMs: number;
  startedWallMs: number;
  deadlineWallMs: number;
  eligiblePlayerIds: readonly string[];
}>;

export type QuestionRoundOptions = Readonly<{
  sessionId: string;
  store: GameEventStore;
  database: AppDatabase;
  scoring?: ScoringFunction;
  monotonicNow: () => number;
  wallNow: () => number;
  emit: (event: QuestionRoundBroadcast) => void;
  connectedPlayerIds?: () => ReadonlySet<string>;
  restore?: QuestionRoundSnapshot;
  logger?: ServerLogger;
}>;

export type QuestionRoundSnapshot = Readonly<{
  phase: "LOBBY" | "QUESTION_OPEN" | "LOCKED" | "REVEALED" | "PAUSED";
  active: ActiveQuestion | null;
  answers: readonly Readonly<{
    playerId: string;
    choice: number;
    receivedAtMs: number;
  }>[];
  revealAck: SuccessAck | null;
  pauseRemainingMs: number | null;
}>;

export class QuestionRound {
  readonly #sessionId: string;
  readonly #database: AppDatabase;
  readonly #coordinator: CommandCoordinator;
  readonly #scoring: ScoringFunction;
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => number;
  readonly #listeners = new Set<(event: QuestionRoundBroadcast) => void>();
  readonly #connectedPlayerIds: () => ReadonlySet<string>;
  readonly #answers = new Map<string, { choice: number; receivedAtMs: number }>();
  #active: ActiveQuestion | null = null;
  #phase: "LOBBY" | "QUESTION_OPEN" | "LOCKED" | "REVEALED" | "PAUSED" = "LOBBY";
  #revealAck: SuccessAck | null = null;
  #pauseRemainingMs: number | null = null;

  constructor(options: QuestionRoundOptions) {
    this.#sessionId = options.sessionId;
    this.#database = options.database;
    this.#coordinator = new CommandCoordinator(options.database, options.store, options.logger ?? createSilentLogger());
    this.#scoring = options.scoring ?? flatScoring;
    this.#monotonicNow = options.monotonicNow;
    this.#wallNow = options.wallNow;
    this.#listeners.add(options.emit);
    this.#connectedPlayerIds = options.connectedPlayerIds ?? (() => new Set());
    if (options.restore !== undefined) {
      this.restore(options.restore);
    }
  }

  get phase(): "LOBBY" | "QUESTION_OPEN" | "LOCKED" | "REVEALED" | "PAUSED" {
    return this.#phase;
  }

  subscribe(listener: (event: QuestionRoundBroadcast) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  liveSnapshot(playerId?: string): LiveRoundSnapshot {
    const active = this.#active;
    return Object.freeze({
      phase: this.#phase,
      attempt_id: active?.attemptId ?? null,
      question: active === null
        ? null
        : Object.freeze({
            question_id: active.question.id,
            prompt: active.question.prompt,
            choices: active.question.choices,
          }),
      own_answer: playerId === undefined ? null : this.#answers.get(playerId)?.choice ?? null,
      locked_count: this.#answers.size,
      eligible_count: active?.eligiblePlayerIds.length ?? 0,
      server_time_ms: this.#wallNow(),
      deadline_ms: active === null || this.#phase !== "QUESTION_OPEN" ? null : active.deadlineWallMs,
    });
  }

  openQuestion(command: OpenQuestionCommand): RoundAck {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "open_question",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command.idempotencyPayload ?? command,
      createdAtMs: this.#wallNow(),
      ...(command.prepare === undefined ? {} : { prepare: command.prepare }),
      propose: () => {
        if (this.#sessionEnded()) {
          return this.#rejected("SESSION_ENDED");
        }
        if (this.#phase !== "LOBBY" && this.#phase !== "LOCKED" && this.#phase !== "REVEALED") {
          return this.#rejected("WRONG_PHASE");
        }
        const startedMonotonicMs = this.#monotonicNow();
        const startedWallMs = this.#wallNow();
        const active = Object.freeze({
          attemptId: command.attemptId,
          question: command.question,
          startedMonotonicMs,
          deadlineMonotonicMs: startedMonotonicMs + command.durationMs,
          startedWallMs,
          deadlineWallMs: startedWallMs + command.durationMs,
          eligiblePlayerIds: Object.freeze([...command.eligiblePlayerIds]),
        });
        return {
          state: active,
          eventType: "question_open",
          eventPayload: {
            question_id: command.question.id,
            prompt: command.question.prompt,
            choices: command.question.choices,
            correct_choice: command.question.correctChoice,
            started_at_ms: active.startedWallMs,
            deadline_ms: active.deadlineWallMs,
            eligible_player_ids: active.eligiblePlayerIds,
          },
          persist: () => {
            const guardedCursor = command.advanceDeckCursor === true
              ? " AND deck_start_position = ?"
              : "";
            const updated = this.#database
              .prepare(
                `UPDATE sessions SET status = 'live', started_at_ms = COALESCE(started_at_ms, ?),
                   deck_start_position = deck_start_position + ?
                 WHERE session_id = ? AND status != 'ended'${guardedCursor}`,
              )
              .run(
                startedWallMs,
                command.advanceDeckCursor === true ? 1 : 0,
                this.#sessionId,
                ...(command.advanceDeckCursor === true ? [command.expectedDeckStartPosition] : []),
              );
            if (updated.changes !== 1) {
              const error = new Error(`Deck cursor changed while opening a question: ${this.#sessionId}`);
              error.name = "DeckCursorConflict";
              throw error;
            }
          },
          outcome: (event) => this.#success(command.requestId, event.serverSeq),
          apply: (next, event) => {
            this.#active = next;
            this.#phase = "QUESTION_OPEN";
            this.#answers.clear();
            this.#revealAck = null;
            this.#broadcast({
              type: "question_open",
              serverSeq: event.serverSeq,
              payload: Object.freeze({
                attempt_id: next.attemptId,
                question_id: next.question.id,
                prompt: next.question.prompt,
                choices: next.question.choices,
                started_at_ms: next.startedWallMs,
                deadline_ms: next.deadlineWallMs,
                server_time_ms: this.#wallNow(),
              }),
            });
          },
        };
      },
    });
  }

  answer(command: AnswerCommand): RoundAck {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "answer",
      attemptId: command.attemptId,
      actorKind: "player",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command.idempotencyPayload ?? command,
      createdAtMs: this.#wallNow(),
      propose: () => {
        const active = this.#active;
        if (this.#phase !== "QUESTION_OPEN" || active === null) {
          return this.#rejected("WRONG_PHASE");
        }
        if (command.attemptId !== active.attemptId || command.questionId !== active.question.id) {
          return this.#rejected("STALE_ATTEMPT");
        }
        if (!active.eligiblePlayerIds.includes(command.actorId)) {
          return this.#rejected("FORBIDDEN");
        }
        if (!Number.isInteger(command.choice) || command.choice < 0 || command.choice >= active.question.choices.length) {
          return this.#rejected("INVALID_CHOICE");
        }
        const receivedAtMs = this.#monotonicNow();
        if (receivedAtMs > active.deadlineMonotonicMs) {
          return this.#rejected("TOO_LATE");
        }
        if (this.#answers.has(command.actorId)) {
          return this.#rejected("ALREADY_ANSWERED");
        }
        const answer = Object.freeze({ choice: command.choice, receivedAtMs });
        const completesRound = this.#answers.size + 1 === active.eligiblePlayerIds.length;
        const answerEventPayload = {
          question_id: active.question.id,
          choice: command.choice,
          receive_duration_ms: receivedAtMs - active.startedMonotonicMs,
        };
        return {
          state: answer,
          ...(completesRound
            ? {
                priorEvents: [{
                  eventType: "answer_accepted",
                  eventPayload: answerEventPayload,
                  actorKind: "player" as const,
                  actorId: command.actorId,
                }],
              }
            : {}),
          eventType: completesRound ? "phase_a_locked" : "answer_accepted",
          eventPayload: completesRound
            ? {
                reason: "all_answered",
                locked_count: active.eligiblePlayerIds.length,
                eligible_count: active.eligiblePlayerIds.length,
              }
            : answerEventPayload,
          outcome: (event) => this.#success(command.requestId, event.serverSeq),
          apply: (next, event, _ack, events) => {
            this.#answers.set(command.actorId, next);
            const answerEvent = completesRound ? events[0] : event;
            this.#broadcast({
              type: "lock_counts",
              serverSeq: answerEvent?.serverSeq ?? event.serverSeq,
              payload: Object.freeze({
                locked_count: this.#answers.size,
                eligible_count: active.eligiblePlayerIds.length,
                deadline_ms: active.deadlineWallMs,
                server_time_ms: this.#wallNow(),
              }),
            });
            if (completesRound) {
              this.#broadcastLock(active, "all_answered", event);
            }
          },
        };
      },
    });
  }

  lockExpired(): RoundAck {
    const active = this.#active;
    if (
      this.#phase !== "QUESTION_OPEN" ||
      active === null ||
      this.#monotonicNow() < active.deadlineMonotonicMs
    ) {
      return this.#error("deadline", "WRONG_PHASE");
    }
    return this.#lock("deadline", `deadline:${active.attemptId}`);
  }

  snapshot(): QuestionRoundSnapshot {
    return Object.freeze({
      phase: this.#phase,
      active: this.#active,
      answers: Object.freeze(
        [...this.#answers].map(([playerId, answer]) =>
          Object.freeze({ playerId, choice: answer.choice, receivedAtMs: answer.receivedAtMs }),
        ),
      ),
      revealAck: this.#revealAck,
      pauseRemainingMs: this.#pauseRemainingMs,
    });
  }

  restore(snapshot: QuestionRoundSnapshot): void {
    this.#phase = snapshot.phase;
    this.#active = snapshot.active;
    this.#answers.clear();
    for (const answer of snapshot.answers) {
      this.#answers.set(answer.playerId, {
        choice: answer.choice,
        receivedAtMs: answer.receivedAtMs,
      });
    }
    this.#revealAck = snapshot.revealAck;
    this.#pauseRemainingMs = snapshot.pauseRemainingMs;
  }

  pause(command: Readonly<{ actorId: string; requestId: string; attemptId: string }> & { reason?: string }):
    | RoundAck
    | Readonly<{ ok: true; requestId: string; serverSeq: number; remainingMs: number }> {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "pause",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
      createdAtMs: this.#wallNow(),
      propose: () => {
        const active = this.#active;
        if (this.#phase !== "QUESTION_OPEN" || active === null) {
          return this.#rejected("WRONG_PHASE");
        }
        if (command.attemptId !== active.attemptId) {
          return this.#rejected("STALE_ATTEMPT");
        }
        const remainingMs = Math.max(0, active.deadlineMonotonicMs - this.#monotonicNow());
        return {
          state: remainingMs,
          eventType: "pause",
          eventPayload: { reason: command.reason ?? null, remaining_ms: remainingMs },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            remainingMs,
          }),
          apply: (next, event) => {
            this.#pauseRemainingMs = next;
            this.#phase = "PAUSED";
            this.#broadcast({
              type: "phase_state",
              serverSeq: event.serverSeq,
              payload: Object.freeze({
                phase: "PAUSED",
                remaining_ms: next,
                server_time_ms: this.#wallNow(),
                deadline_ms: null,
              }),
            });
          },
        };
      },
    });
  }

  resume(command: Readonly<{ actorId: string; requestId: string; attemptId: string }> ):
    | RoundAck
    | Readonly<{ ok: true; requestId: string; serverSeq: number; deadlineMs: number }> {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "resume",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
      createdAtMs: this.#wallNow(),
      propose: () => {
        const active = this.#active;
        const remainingMs = this.#pauseRemainingMs;
        if (this.#phase !== "PAUSED" || active === null || remainingMs === null) {
          return this.#rejected("WRONG_PHASE");
        }
        if (command.attemptId !== active.attemptId) {
          return this.#rejected("STALE_ATTEMPT");
        }
        const monotonicNow = this.#monotonicNow();
        const wallNow = this.#wallNow();
        const deadlineMs = wallNow + remainingMs;
        const resumed = Object.freeze({
          ...active,
          startedMonotonicMs: monotonicNow - (active.deadlineMonotonicMs - active.startedMonotonicMs - remainingMs),
          deadlineMonotonicMs: monotonicNow + remainingMs,
          deadlineWallMs: deadlineMs,
        });
        return {
          state: resumed,
          eventType: "resume",
          eventPayload: { deadline_ms: deadlineMs },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            deadlineMs,
          }),
          apply: (next, event) => {
            this.#active = next;
            this.#pauseRemainingMs = null;
            this.#phase = "QUESTION_OPEN";
            this.#broadcast({
              type: "phase_state",
              serverSeq: event.serverSeq,
              payload: Object.freeze({
                phase: "QUESTION_OPEN",
                server_time_ms: this.#wallNow(),
                deadline_ms: next.deadlineWallMs,
              }),
            });
          },
        };
      },
    });
  }

  forceReveal(command: Readonly<{ actorId: string; requestId: string; attemptId: string }>): RoundAck {
    const replay = this.#coordinator.replay<RoundAck>({
      sessionId: this.#sessionId,
      commandType: "reveal",
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
    });
    if (replay !== undefined) return replay;
    if (this.#revealAck !== null && this.#active?.attemptId === command.attemptId) {
      return this.#replayReveal(command);
    }
    const active = this.#active;
    if ((this.#phase !== "QUESTION_OPEN" && this.#phase !== "LOCKED") || active === null) {
      return this.#rejectCommand("reveal", command, "WRONG_PHASE");
    }
    if (command.attemptId !== active.attemptId) {
      return this.#rejectCommand("reveal", command, "STALE_ATTEMPT");
    }
    return this.#reveal(command, this.#phase === "QUESTION_OPEN");
  }

  advance(command: Readonly<{ actorId: string; requestId: string; attemptId: string }>): RoundAck {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "advance",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: { attempt_id: command.attemptId },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const active = this.#active;
        if (this.#phase !== "REVEALED" || active === null) {
          return this.#rejected("WRONG_PHASE");
        }
        if (command.attemptId !== active.attemptId) {
          return this.#rejected("STALE_ATTEMPT");
        }
        return {
          state: null,
          eventType: "teacher_advance",
          eventPayload: {},
          outcome: (event) => this.#success(command.requestId, event.serverSeq),
          apply: (_next, event) => {
            this.#phase = "LOBBY";
            this.#active = null;
            this.#answers.clear();
            this.#revealAck = null;
            this.#broadcast({
              type: "phase_state",
              serverSeq: event.serverSeq,
              payload: Object.freeze({
                phase: "LOBBY",
                server_time_ms: this.#wallNow(),
                deadline_ms: null,
              }),
            });
          },
        };
      },
    });
  }

  reveal(command: Readonly<{ actorId: string; requestId: string; attemptId: string }>): RoundAck {
    const replay = this.#coordinator.replay<RoundAck>({
      sessionId: this.#sessionId,
      commandType: "reveal",
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
    });
    if (replay !== undefined) return replay;
    if (this.#revealAck !== null && this.#active?.attemptId === command.attemptId) {
      return this.#replayReveal(command);
    }
    const active = this.#active;
    if (this.#phase !== "LOCKED" || active === null) {
      return this.#rejectCommand("reveal", command, "WRONG_PHASE");
    }
    if (active.attemptId !== command.attemptId) {
      return this.#rejectCommand("reveal", command, "STALE_ATTEMPT");
    }
    return this.#reveal(command, false);
  }

  #replayReveal(command: Readonly<{ actorId: string; requestId: string; attemptId: string }>): RoundAck {
    const revealed = this.#revealAck;
    if (revealed === null) {
      return this.#error(command.requestId, "WRONG_PHASE");
    }
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "reveal",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
      createdAtMs: this.#wallNow(),
      propose: () => ({
        state: null,
        eventType: "reveal_replayed",
        eventPayload: { reveal_server_seq: revealed.serverSeq },
        outcome: () => this.#success(command.requestId, revealed.serverSeq),
        apply: () => undefined,
      }),
    });
  }

  #reveal(
    command: Readonly<{ actorId: string; requestId: string; attemptId: string }>,
    lockFirst: boolean,
  ): RoundAck {
    const active = this.#active;
    if (active === null) {
      return this.#error(command.requestId, "WRONG_PHASE");
    }
    const players = this.#database
      .prepare(
        `SELECT player_id, points, streak FROM session_players
         WHERE session_id = ? ORDER BY joined_at_ms, player_id`,
      )
      .all(this.#sessionId) as Array<{ player_id: string; points: number; streak: number }>;
    const eligible = new Set(active.eligiblePlayerIds);
    const outcomes = players
      .filter((player) => eligible.has(player.player_id))
      .map((player) => {
        const answer = this.#answers.get(player.player_id);
        const correct = answer?.choice === active.question.correctChoice;
        const nextStreak = correct ? player.streak + 1 : 0;
        const delta = this.#scoring({
          correct,
          answered: answer !== undefined,
          priorStreak: player.streak,
          nextStreak,
        });
        if (!Number.isInteger(delta) || delta < 0) {
          throw new Error("Scoring function must return a non-negative integer");
        }
        return Object.freeze({
          player_id: player.player_id,
          choice: answer?.choice ?? null,
          correct,
          delta,
          streak: nextStreak,
        });
      });
    const counts = active.question.choices.map((_, choice) =>
      [...this.#answers.values()].filter((answer) => answer.choice === choice).length,
    );
    const payload = Object.freeze({
      attempt_id: active.attemptId,
      question_id: active.question.id,
      correct_choice: active.question.correctChoice,
      counts: Object.freeze(counts),
      outcomes: Object.freeze(outcomes),
      server_time_ms: this.#wallNow(),
      deadline_ms: null,
    });
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "reveal",
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
      createdAtMs: this.#wallNow(),
      propose: () => ({
        state: payload,
        ...(lockFirst
          ? { priorEvents: [
              ...this.#noAnswerEvents(active),
              {
                eventType: "phase_a_locked",
                eventPayload: this.#lockPayload(active, "force_reveal"),
                actorKind: "system" as const,
                actorId: "system",
              },
            ] }
          : {}),
        eventType: "reveal",
        eventPayload: payload,
        persist: () => {
          for (const outcome of outcomes) {
            this.#database
              .prepare(
                `UPDATE session_players SET points = points + ?, streak = ?
                 WHERE session_id = ? AND player_id = ?`,
              )
              .run(outcome.delta, outcome.streak, this.#sessionId, outcome.player_id);
          }
        },
        outcome: (event) => this.#success(command.requestId, event.serverSeq),
        apply: (next, event, ack, events) => {
          if (lockFirst) {
            const lockEvent = events.find((candidate) => candidate.eventType === "phase_a_locked");
            if (lockEvent !== undefined) {
              this.#broadcastLock(active, "force_reveal", lockEvent);
            }
          }
          this.#phase = "REVEALED";
          this.#revealAck = ack.ok ? ack : null;
          this.#broadcast({ type: "reveal", serverSeq: event.serverSeq, payload: next });
          this.#broadcast({
            type: "leaderboard",
            serverSeq: event.serverSeq,
            payload: Object.freeze({
              ...buildLeaderboard(this.#database, this.#sessionId, this.#connectedPlayerIds()),
              server_time_ms: this.#wallNow(),
              deadline_ms: null,
            }),
          });
        },
      }),
    });
  }

  #lock(reason: "all_answered" | "deadline", requestId: string): RoundAck {
    const active = this.#active;
    if (active === null) {
      return this.#error(requestId, "WRONG_PHASE");
    }
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      attemptId: active.attemptId,
      commandType: "lock_question",
      actorKind: "system",
      actorId: "system",
      requestId,
      payload: { reason, attempt_id: active.attemptId },
      createdAtMs: this.#wallNow(),
      propose: () => {
        if (this.#phase !== "QUESTION_OPEN" || this.#active?.attemptId !== active.attemptId) {
          return this.#rejected("WRONG_PHASE");
        }
        if (this.#sessionEnded()) {
          return this.#rejected("SESSION_ENDED");
        }
        return {
          state: active,
          priorEvents: this.#noAnswerEvents(active),
          eventType: "phase_a_locked",
          eventPayload: this.#lockPayload(active, reason),
          outcome: (event) => this.#success(requestId, event.serverSeq),
          apply: (next, event) => this.#broadcastLock(next, reason, event),
        };
      },
    });
  }

  #noAnswerEvents(active: ActiveQuestion): readonly Readonly<{
    eventType: string;
    eventPayload: unknown;
    actorKind: "player";
    actorId: string;
  }>[] {
    return active.eligiblePlayerIds
      .filter((playerId) => !this.#answers.has(playerId))
      .map((playerId) => Object.freeze({
        eventType: "no_answer",
        eventPayload: { question_id: active.question.id },
        actorKind: "player" as const,
        actorId: playerId,
      }));
  }

  #lockPayload(
    active: ActiveQuestion,
    reason: "all_answered" | "deadline" | "force_reveal",
  ): Readonly<Record<string, unknown>> {
    return Object.freeze({
      reason,
      locked_count: this.#answers.size,
      eligible_count: active.eligiblePlayerIds.length,
    });
  }

  #broadcastLock(
    active: ActiveQuestion,
    reason: "all_answered" | "deadline" | "force_reveal",
    event: StoredGameEvent,
  ): void {
    this.#phase = "LOCKED";
    this.#broadcast({
      type: "phase_a_locked",
      serverSeq: event.serverSeq,
      payload: Object.freeze({
        reason,
        locked_count: this.#answers.size,
        eligible_count: active.eligiblePlayerIds.length,
        server_time_ms: this.#wallNow(),
        deadline_ms: active.deadlineWallMs,
      }),
    });
  }

  #sessionEnded(): boolean {
    const session = this.#database
      .prepare("SELECT status FROM sessions WHERE session_id = ?")
      .get(this.#sessionId) as { status: string } | undefined;
    return session?.status === "ended";
  }

  #success(requestId: string, serverSeq: number): SuccessAck {
    return Object.freeze({ ok: true, requestId, serverSeq });
  }

  #error(requestId: string, code: ErrorCode): ErrorAck {
    return Object.freeze({ ok: false, requestId, code });
  }

  #rejectCommand(
    commandType: string,
    command: Readonly<{ actorId: string; requestId: string; attemptId: string }>,
    code: ErrorCode,
  ): RoundAck {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType,
      attemptId: command.attemptId,
      actorKind: "teacher",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: command,
      createdAtMs: this.#wallNow(),
      propose: () => this.#rejected(code),
    });
  }

  #rejected(code: ErrorCode): RejectedCommand {
    return Object.freeze({
      code,
      disposition: ["WRONG_PHASE", "STALE_ATTEMPT", "TOO_LATE"].includes(code)
        ? "transient" as const
        : "terminal" as const,
    });
  }

  #broadcast(event: QuestionRoundBroadcast): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
