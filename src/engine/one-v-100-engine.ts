import { createHash, randomInt } from "node:crypto";

import type {
  CommandCoordinator,
  CommandError,
  CommandProposal,
  RejectedCommand,
  CommandSuccess,
} from "../command-coordinator.js";
import { uuidV7 } from "../ids.js";
import {
  isRuleset1v100,
  applyTeacherSettingsPatch,
  parseSettingsJson,
  SettingsValidationError,
  type Ruleset1v100Settings,
  type TeacherSettingsPatch,
} from "./ruleset-settings.js";
import { computeMomentumFastWindow } from "./momentum.js";
import { scoreOneV100Reveal, type ScoringPlayer } from "./one-v-100-scoring.js";

export type RulesetPhase =
  | "LOBBY"
  | "BETWEEN_QUESTIONS"
  | "PHASE_A"
  | "PHASE_A_LOCKED"
  | "PHASE_B"
  | "PAUSED"
  | "REVEAL"
  | "LEADERBOARD"
  | "SESSION_ENDED";

export type RulesetPlayer = Readonly<{
  id: string;
  nickname: string;
  role: "one" | "mob" | "crowd";
  points: number;
  streak: number;
  hasBeenOne: boolean;
  joinedAtMs: number;
}>;

export type RulesetSessionRecord = Readonly<{
  sessionId: string;
  teacherId: string;
  status: "lobby" | "live" | "ended";
  lastServerSeq: number;
  settingsJson: string;
  settingsRevision: number;
  deckStartPosition: number;
  questionCount: number;
}>;

export type RulesetGameSnapshot = Readonly<{
  phase: RulesetPhase;
  settings_revision: number;
  settings: Ruleset1v100Settings;
  pending_next_one_id: string | null;
  active: RulesetAttemptSnapshot | null;
  paused_reason: string | null;
  paused_from: "PHASE_A" | "PHASE_B" | null;
  pause_remaining_ms: number | null;
  pause_reasons: Readonly<{
    teacher: string | null;
    one_disconnected: boolean;
    one_kicked: boolean;
  }>;
  helps_used: Readonly<{ poll: boolean; ask: boolean; trust: boolean }>;
  momentum: Readonly<{ progress: number; awarded_once: boolean }>;
  last_result?: Readonly<{
    reason: "flameout" | "deck_survived" | "mob_emptied";
    payouts: readonly Readonly<{ player_id: string; points: number }>[];
    bank: number;
    banked_by_one: number;
  }>;
}>;

export type RulesetAttemptSnapshot = Readonly<{
  attempt_id: string;
  question_id: string;
  index: number;
  prompt: string;
  choices: readonly string[];
  correct_choice: number;
  started_at_ms: number;
  deadline_ms: number;
  eligible_player_ids: readonly string[];
  answers: readonly Readonly<{
    player_id: string;
    choice: number;
    receive_duration_ms: number;
  }>[];
  phase_b_started_at_ms: number | null;
  one_answer: number | null;
  one_duration_ms: number | null;
  help_used: "poll" | "ask" | "trust" | null;
  help_result: Readonly<Record<string, unknown>> | null;
  momentum_eligible: boolean;
}>;

export type RulesetQuestion = Readonly<{
  id: string;
  prompt: string;
  choices: readonly string[];
  correctChoice: number;
  phaseASeconds: number | null;
}>;

export type RulesetGameRecord = Readonly<{
  gameId: string;
  ordinal: number;
  onePlayerId: string;
  status: "live" | "ended";
  endReason: "flameout" | "deck_survived" | "mob_emptied" | null;
  deckStartPosition: number;
  deckSize: number;
  questionOffset: number;
  strikesRemaining: number;
  bank: number;
  helpsUsed: Readonly<{ poll: boolean; ask: boolean; trust: boolean }>;
  snapshot: RulesetGameSnapshot;
}>;

export type RulesetRepository = Readonly<{
  session: (sessionId: string) => RulesetSessionRecord | undefined;
  players: (sessionId: string) => readonly RulesetPlayer[];
  scoringPlayers: (sessionId: string, playerIds: readonly string[]) => readonly ScoringPlayer[];
  latestGame: (sessionId: string) => RulesetGameRecord | undefined;
  questionAt: (sessionId: string, position: number) => RulesetQuestion | undefined;
  startGame: (input: Readonly<{
    sessionId: string;
    gameId: string;
    ordinal: number;
    onePlayerId: string;
    deckStartPosition: number;
    deckSize: number;
    strikesRemaining: number;
    snapshot: RulesetGameSnapshot;
    startedAtMs: number;
  }>) => void;
  updateGameSnapshot: (gameId: string, snapshot: RulesetGameSnapshot) => void;
  applyHelp: (input: Readonly<{
    sessionId: string;
    gameId: string;
    snapshot: RulesetGameSnapshot;
    helpsUsed: Readonly<{ poll: boolean; ask: boolean; trust: boolean }>;
    pointAwards?: readonly Readonly<{ playerId: string; points: number }>[];
  }>) => void;
  updateGameProgress: (input: Readonly<{
    sessionId: string;
    gameId: string;
    questionOffset: number;
    strikesRemaining: number;
    bank: number;
    snapshot: RulesetGameSnapshot;
    nextDeckPosition?: number;
    phaseBExposedAtMs: number | null;
  }>) => void;
  applyReveal: (input: Readonly<{
    sessionId: string;
    gameId: string;
    players: readonly ScoringPlayer[];
    questionOffset: number;
    strikesRemaining: number;
    bank: number;
    helpsUsed: Readonly<{ poll: boolean; ask: boolean; trust: boolean }>;
    snapshot: RulesetGameSnapshot;
    endReason: "flameout" | "deck_survived" | "mob_emptied" | null;
    endedAtMs: number;
    sessionEndedAtMs?: number;
  }>) => void;
  endGame: (input: Readonly<{
    gameId: string;
    reason: "flameout" | "deck_survived" | "mob_emptied";
    snapshot: RulesetGameSnapshot;
    endedAtMs: number;
  }>) => void;
  endSession: (sessionId: string, endedAtMs: number) => void;
  updateSettings: (sessionId: string, settingsJson: string) => number;
}>;

export type RulesetLifecycleEvent = Readonly<{
  type:
    | "game_start"
    | "next_game"
    | "game_end"
    | "session_end"
    | "leaderboard"
    | "phase_a_start"
    | "phase_a_status"
    | "lock_counts"
    | "phase_a_locked"
    | "phase_b_start"
    | "help_poll_result"
    | "help_ask_result"
    | "help_trust_result"
    | "pause_state"
    | "strike"
    | "meter_progress"
    | "meter_filled"
    | "reveal";
  serverSeq: number;
  payload: Readonly<Record<string, unknown>>;
  roleChanges?: readonly Readonly<{ playerId: string; role: "one" | "mob" | "crowd" }>[];
}>;

type LifecycleSuccess = CommandSuccess & Readonly<{
  gameId?: string;
  question_id?: string;
  received_at_ms?: number;
}>;
export type LifecycleOutcome = LifecycleSuccess | CommandError;

type PhaseBTransition = Readonly<{
  game: RulesetGameRecord;
  eventType: "phase_b_start" | "pause_state" | null;
  eventPayload: Readonly<Record<string, unknown>> | null;
  exposedAtMs: number | null;
}>;

type MomentumReveal = Readonly<{
  fastWindowMs: number | null;
  windowLog: Readonly<Record<string, unknown>> | null;
  state: RulesetGameSnapshot["momentum"];
  strikesRemaining: number;
  progressPayload: Readonly<Record<string, unknown>> | null;
  filledPayload: Readonly<Record<string, unknown>> | null;
}>;

function leaderboard(players: readonly RulesetPlayer[]): readonly Readonly<Record<string, unknown>>[] {
  const sorted = [...players].sort((left, right) =>
    right.points - left.points || left.joinedAtMs - right.joinedAtMs || left.id.localeCompare(right.id),
  );
  let rank = 0;
  let previousPoints: number | undefined;
  return Object.freeze(sorted.map((player, index) => {
    if (player.points !== previousPoints) rank = index + 1;
    previousPoints = player.points;
    return Object.freeze({
      rank,
      player_id: player.id,
      nickname: player.nickname,
      points: player.points,
      has_been_one: player.hasBeenOne,
    });
  }));
}

const UNUSED_HELPS = Object.freeze({ poll: false, ask: false, trust: false });
const NO_PAUSE_REASONS = Object.freeze({ teacher: null, one_disconnected: false, one_kicked: false });

export function selectNextOne(players: readonly RulesetPlayer[], overrideId?: string | null): RulesetPlayer | undefined {
  if (overrideId !== undefined && overrideId !== null) {
    return players.find((player) => player.id === overrideId && !player.hasBeenOne);
  }
  return [...players]
    .filter((player) => !player.hasBeenOne)
    .sort((left, right) =>
      right.points - left.points || left.joinedAtMs - right.joinedAtMs || left.id.localeCompare(right.id),
    )[0];
}

export class OneV100Engine {
  readonly #sessionId: string;
  readonly #coordinator: CommandCoordinator;
  readonly #repository: RulesetRepository;
  readonly #wallNow: () => number;
  readonly #monotonicNow: () => number;
  readonly #connectedPlayerIds: () => ReadonlySet<string>;
  readonly #publish: (event: RulesetLifecycleEvent) => void;
  #phase: RulesetPhase;
  #game: RulesetGameRecord | null;
  #phaseAStartedMonotonicMs = 0;
  #phaseAPausedAtMonotonicMs: number | null = null;
  #phaseBStartedMonotonicMs = 0;
  #recoveryPending = false;

  constructor(options: Readonly<{
    sessionId: string;
    coordinator: CommandCoordinator;
    repository: RulesetRepository;
    wallNow: () => number;
    monotonicNow?: () => number;
    connectedPlayerIds?: () => ReadonlySet<string>;
    publish: (event: RulesetLifecycleEvent) => void;
  }>) {
    this.#sessionId = options.sessionId;
    this.#coordinator = options.coordinator;
    this.#repository = options.repository;
    this.#wallNow = options.wallNow;
    this.#monotonicNow = options.monotonicNow ?? options.wallNow;
    this.#connectedPlayerIds = options.connectedPlayerIds ?? (() => new Set(this.#repository.players(this.#sessionId).map((player) => player.id)));
    this.#publish = options.publish;
    this.#game = this.#repository.latestGame(this.#sessionId) ?? null;
    const session = this.#repository.session(this.#sessionId);
    this.#phase = session?.status === "ended"
      ? "SESSION_ENDED"
      : this.#game?.snapshot.phase ?? "LOBBY";
    const active = this.#game?.snapshot.active;
    if (active !== undefined && active !== null) {
      const elapsed = Math.max(0, this.#wallNow() - active.started_at_ms);
      this.#phaseAStartedMonotonicMs = this.#monotonicNow() - elapsed;
      if (active.phase_b_started_at_ms !== null) {
        this.#phaseBStartedMonotonicMs = this.#monotonicNow() -
          Math.max(0, this.#wallNow() - active.phase_b_started_at_ms);
      }
    }
    this.#recoveryPending = this.#phase === "PHASE_A_LOCKED" ||
      (this.#phase === "PHASE_B" && active?.one_answer !== null && active?.one_answer !== undefined);
  }

  get phase(): RulesetPhase {
    return this.#phase;
  }

  get game(): RulesetGameRecord | null {
    return this.#game;
  }

  liveSnapshot(playerId?: string): Readonly<Record<string, unknown>> {
    const session = this.#repository.session(this.#sessionId);
    const game = this.#game;
    const active = game?.snapshot.active ?? null;
    const players = this.#repository.players(this.#sessionId);
    const one = game === null ? undefined : players.find((player) => player.id === game.onePlayerId);
    const player = playerId === undefined ? undefined : players.find((candidate) => candidate.id === playerId);
    const ownAnswer = playerId === undefined || active === null
      ? undefined
      : active.answers.find((answer) => answer.player_id === playerId)?.choice ??
        (playerId === game?.onePlayerId ? active.one_answer : undefined);
    const isSpeaker = playerId !== undefined && active?.help_result?.type === "ask" &&
      Array.isArray(active.help_result.speakers) && active.help_result.speakers.some((speaker) =>
        typeof speaker === "object" && speaker !== null &&
        (speaker as Readonly<Record<string, unknown>>).player_id === playerId);
    const paused = game?.snapshot.phase === "PAUSED"
      ? Object.freeze({ active: true, ...(game.snapshot.paused_reason === null ? {} : { reason: this.#pauseReason(game.snapshot.pause_reasons) }) })
      : Object.freeze({ active: false });
    const questionPhase = game?.snapshot.paused_from ?? this.#phase;
    const gameSnapshot = game === null ? undefined : Object.freeze({
      game_id: game.gameId,
      ordinal: game.ordinal,
      one: Object.freeze({ player_id: game.onePlayerId, nickname: one?.nickname ?? "The One" }),
      mob_count: players.filter((candidate) => candidate.role === "mob").length,
      crowd_count: players.filter((candidate) => candidate.role === "crowd").length,
      phase: this.#phase,
      strikes_remaining: game.strikesRemaining,
      base_strikes: game.snapshot.settings.base_strikes,
      bank: game.bank,
      momentum_enabled: game.snapshot.settings.momentum_enabled,
      ...(game.snapshot.settings.momentum_enabled ? { momentum: Object.freeze({
        enabled: true,
        progress: game.snapshot.momentum.progress,
        threshold: game.snapshot.settings.momentum_threshold,
        awarded_once: game.snapshot.momentum.awarded_once,
      }) } : {}),
      helps_available: this.#helpsAvailable(game),
      paused,
      ...(active === null ? {} : {
        question: Object.freeze({
          index: active.index,
          question_id: active.question_id,
          prompt: active.prompt,
          choices: active.choices,
          ...(questionPhase === "PHASE_A" ? { deadline_ms: active.deadline_ms } : {}),
        }),
      }),
      ...(game.snapshot.last_result === undefined ? {} : { last_result: game.snapshot.last_result }),
    });
    return Object.freeze({
      question_phase: questionPhase,
      server_time_ms: this.#wallNow(),
      phase: this.#phase,
      ...(active === null ? {} : {
        attempt_id: active.attempt_id,
        question: Object.freeze({
          question_id: active.question_id,
          prompt: active.prompt,
          choices: active.choices,
        }),
        index: active.index,
        locked_count: active.answers.length,
        eligible_count: active.eligible_player_ids.length,
        deadline_ms: this.#phase === "PHASE_A" ? active.deadline_ms : null,
        question_exposed: active.phase_b_started_at_ms !== null,
      }),
      ...(ownAnswer === undefined ? {} : { own_answer: ownAnswer }),
      bank: game?.bank ?? 0,
      strikes: game?.strikesRemaining ?? 0,
      paused: game?.snapshot.paused_reason ?? null,
      helps_available: game === null ? UNUSED_HELPS : this.#helpsAvailable(game),
      helps_used: game?.snapshot.helps_used ?? game?.helpsUsed ?? UNUSED_HELPS,
      ...((game?.snapshot.settings.momentum_enabled ?? false) ? { momentum: Object.freeze({
        enabled: true,
        progress: game?.snapshot.momentum.progress ?? 0,
        threshold: game?.snapshot.settings.momentum_threshold ?? 4,
        awarded_once: game?.snapshot.momentum.awarded_once ?? false,
      }) } : {}),
      ...(active?.help_result === null || active?.help_result === undefined ? {} : { help_result: active.help_result }),
      server_seq: session?.lastServerSeq ?? 0,
      session: Object.freeze({
        session_id: this.#sessionId,
        status: session?.status ?? "lobby",
        mode: "one_v_100",
      }),
      ...(gameSnapshot === undefined ? {} : { game: gameSnapshot }),
      leaderboard: leaderboard(players),
      ...(player === undefined ? {} : {
        self: Object.freeze({
          player_id: player.id,
          role: player.role,
          points: player.points,
          streak: player.streak,
          answered: ownAnswer !== undefined && ownAnswer !== null,
          ...(ownAnswer === undefined || ownAnswer === null ? {} : { choice: ownAnswer }),
          is_speaker: isSpeaker,
        }),
      }),
    });
  }

  recover(): LifecycleOutcome | undefined {
    const game = this.#game;
    const active = game?.snapshot.active ?? null;
    if (game === null) return undefined;
    if (this.#phase === "PHASE_A_LOCKED") {
      // Stable state: the class is locked and the teacher has not yet revealed
      // the question to The One. Nothing to repair.
      this.#recoveryPending = false;
      return undefined;
    }
    if (this.#phase === "PHASE_B" && active?.one_answer !== null && active?.one_answer !== undefined) {
      const session = this.#repository.session(this.#sessionId);
      if (session === undefined) return undefined;
      const result = this.reveal({
        teacherId: session.teacherId,
        requestId: `recover-reveal:${active.attempt_id}`,
      });
      if (result.ok) this.#recoveryPending = false;
      return result;
    }
    if (this.#phase === "PHASE_B" && !this.#connectedPlayerIds().has(game.onePlayerId)) {
      return this.pauseOneDisconnected(game.onePlayerId);
    }
    if (this.#phase === "LEADERBOARD") {
      const session = this.#repository.session(this.#sessionId);
      if (
        session !== undefined && session.status !== "ended" &&
        session.deckStartPosition - 1 >= game.snapshot.settings.session_question_budget
      ) {
        return this.endSession({
          teacherId: session.teacherId,
          requestId: `recover-question-budget:${game.gameId}`,
          reason: "question_budget",
        });
      }
    }
    return undefined;
  }

  isEligible(playerId: string): boolean {
    return this.#game?.snapshot.active?.eligible_player_ids.includes(playerId) ?? false;
  }

  needsRecovery(): boolean {
    return this.#recoveryPending;
  }

  startSession(command: Readonly<{ teacherId: string; requestId: string; firstOnePlayerId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      commandType: "teacher_start_session",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: { first_one_player_id: command.firstOnePlayerId },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        if (session.status !== "lobby" || this.#phase !== "LOBBY") return this.#reject("WRONG_PHASE", "transient");
        const settings = this.#settings(session);
        if (settings instanceof SettingsValidationError) return this.#reject("INVALID_SETTINGS", "terminal", settings.message);
        if (settings === null) return this.#reject("GENERIC_SESSION", "terminal");
        const players = this.#repository.players(this.#sessionId);
        const one = players.find((player) => player.id === command.firstOnePlayerId);
        if (one === undefined) return this.#reject("PLAYER_NOT_FOUND", "terminal", "That player is not in this game");
        const deckSize = Math.min(
          settings.questions_per_game,
          settings.session_question_budget,
          Math.max(0, session.questionCount - session.deckStartPosition + 1),
        );
        if (deckSize < 1) return this.#reject("NO_QUESTION", "terminal", "No classroom question is ready");
        const gameId = uuidV7(this.#wallNow());
        const snapshot: RulesetGameSnapshot = Object.freeze({
          phase: "BETWEEN_QUESTIONS",
          settings_revision: session.settingsRevision,
          settings,
          pending_next_one_id: null,
          active: null,
          paused_reason: null,
          paused_from: null,
          pause_remaining_ms: null,
          pause_reasons: NO_PAUSE_REASONS,
          helps_used: UNUSED_HELPS,
          momentum: Object.freeze({ progress: 0, awarded_once: false }),
        });
        const nextGame: RulesetGameRecord = Object.freeze({
          gameId,
          ordinal: 1,
          onePlayerId: one.id,
          status: "live",
          endReason: null,
          deckStartPosition: session.deckStartPosition,
          deckSize,
          questionOffset: 0,
          strikesRemaining: settings.base_strikes,
          bank: 0,
          helpsUsed: UNUSED_HELPS,
          snapshot,
        });
        const proposal: CommandProposal<RulesetGameRecord, LifecycleOutcome> = {
          state: nextGame,
          eventType: "game_start",
          eventPayload: this.#gameStartPayload(nextGame, one, players, settings),
          gameId,
          persist: () => undefined,
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq, gameId }),
          apply: (game, event) => {
            this.#game = game;
            this.#phase = "BETWEEN_QUESTIONS";
            this.#publish(Object.freeze({
              type: "game_start",
              serverSeq: event.serverSeq,
              payload: this.#gameStartPayload(game, one, players, settings),
              roleChanges: this.#roles(players, one.id),
            }));
          },
        };
        this.#repository.startGame({
          sessionId: this.#sessionId,
          gameId,
          ordinal: 1,
          onePlayerId: one.id,
          deckStartPosition: session.deckStartPosition,
          deckSize,
          strikesRemaining: settings.base_strikes,
          snapshot,
          startedAtMs: this.#wallNow(),
        });
        return proposal;
      },
    });
  }

  selectNextOne(command: Readonly<{ teacherId: string; requestId: string; playerId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "teacher_select_next_one",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: { player_id: command.playerId },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        if (this.#phase !== "LEADERBOARD" || this.#game === null) return this.#reject("WRONG_PHASE", "transient");
        const player = this.#repository.players(this.#sessionId).find((candidate) => candidate.id === command.playerId);
        if (player === undefined) return this.#reject("PLAYER_NOT_FOUND", "terminal", "That player is not in this game");
        if (player.hasBeenOne) return this.#reject("ALREADY_HAD_CHAIR", "terminal", "Choose someone who has not been The One yet");
        const snapshot = Object.freeze({ ...this.#game.snapshot, pending_next_one_id: player.id });
        const proposal: CommandProposal<RulesetGameSnapshot, LifecycleOutcome> = {
          state: snapshot,
          eventType: "next_one_selected",
          eventPayload: { player_id: player.id },
          persist: () => this.#repository.updateGameSnapshot(this.#game!.gameId, snapshot),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (next) => {
            if (this.#game !== null) this.#game = Object.freeze({ ...this.#game, snapshot: next });
          },
        };
        return proposal;
      },
    });
  }

  updateSettings(command: Readonly<{
    teacherId: string;
    requestId: string;
    patch: TeacherSettingsPatch;
  }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "teacher_settings",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: command.patch,
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        const settings = this.#settings(session);
        if (settings instanceof SettingsValidationError) return this.#reject("INVALID_SETTINGS", "terminal", settings.message);
        if (settings === null) return this.#reject("GENERIC_SESSION", "terminal");
        let next: Ruleset1v100Settings;
        try {
          next = applyTeacherSettingsPatch(settings, command.patch) as Ruleset1v100Settings;
        } catch (error) {
          return this.#reject(
            "INVALID_SETTINGS",
            "terminal",
            error instanceof SettingsValidationError ? error.message : "Settings could not be updated",
          );
        }
        const revision = session.settingsRevision + 1;
        return {
          state: revision,
          eventType: "settings_updated",
          eventPayload: { settings_revision: revision, changed: Object.keys(command.patch) },
          persist: () => this.#repository.updateSettings(this.#sessionId, JSON.stringify(next)),
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            settings_revision: revision,
            phase_a_seconds: next.phase_a_seconds,
          }),
          apply: () => undefined,
        };
      },
    });
  }

  nextGame(command: Readonly<{ teacherId: string; requestId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "teacher_advance",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const priorGame = this.#game;
        if (this.#phase !== "LEADERBOARD" || priorGame === null) return this.#reject("WRONG_PHASE", "transient");
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        const settings = this.#settings(session);
        if (settings instanceof SettingsValidationError) return this.#reject("INVALID_SETTINGS", "terminal", settings.message);
        if (settings === null) return this.#reject("GENERIC_SESSION", "terminal");
        const players = this.#repository.players(this.#sessionId);
        const one = selectNextOne(players, priorGame.snapshot.pending_next_one_id);
        if (one === undefined) return this.#reject("NO_ELIGIBLE_ONE", "terminal", "Everyone has had the chair");
        const used = session.deckStartPosition - 1;
        const budgetRemaining = settings.session_question_budget - used;
        if (budgetRemaining <= 0) return this.#reject("QUESTION_BUDGET_REACHED", "terminal");
        const deckSize = Math.min(
          settings.questions_per_game,
          budgetRemaining,
          Math.max(0, session.questionCount - session.deckStartPosition + 1),
        );
        if (deckSize < 1) return this.#reject("NO_QUESTION", "terminal", "No classroom question is ready");
        const gameId = uuidV7(this.#wallNow());
        const snapshot: RulesetGameSnapshot = Object.freeze({
          phase: "BETWEEN_QUESTIONS",
          settings_revision: session.settingsRevision,
          settings,
          pending_next_one_id: null,
          active: null,
          paused_reason: null,
          paused_from: null,
          pause_remaining_ms: null,
          pause_reasons: NO_PAUSE_REASONS,
          helps_used: UNUSED_HELPS,
          momentum: Object.freeze({ progress: 0, awarded_once: false }),
        });
        const next: RulesetGameRecord = Object.freeze({
          gameId,
          ordinal: priorGame.ordinal + 1,
          onePlayerId: one.id,
          status: "live",
          endReason: null,
          deckStartPosition: session.deckStartPosition,
          deckSize,
          questionOffset: 0,
          strikesRemaining: settings.base_strikes,
          bank: 0,
          helpsUsed: UNUSED_HELPS,
          snapshot,
        });
        const proposal: CommandProposal<RulesetGameRecord, LifecycleOutcome> = {
          state: next,
          eventType: "next_game",
          eventPayload: { ordinal: next.ordinal, one: { id: one.id, nickname: one.nickname }, starts_at_ms: this.#wallNow() },
          gameId,
          followingEvents: [{
            eventType: "game_start",
            eventPayload: this.#gameStartPayload(next, one, players, settings),
            actorKind: "system" as const,
            actorId: "system",
            gameId,
          }],
          persist: () => undefined,
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq, gameId }),
          apply: (game, event, _outcome, events) => {
            this.#game = game;
            this.#phase = "BETWEEN_QUESTIONS";
            this.#publish(Object.freeze({
              type: "next_game",
              serverSeq: event.serverSeq,
              payload: Object.freeze({ ordinal: game.ordinal, one: { id: one.id, nickname: one.nickname }, starts_at_ms: this.#wallNow() }),
              roleChanges: this.#roles(players, one.id),
            }));
            const gameStart = events.find((candidate) => candidate.eventType === "game_start");
            this.#publish(Object.freeze({
              type: "game_start",
              serverSeq: gameStart?.serverSeq ?? event.serverSeq,
              payload: this.#gameStartPayload(game, one, players, settings),
            }));
          },
        };
        this.#repository.startGame({
          sessionId: this.#sessionId,
          gameId,
          ordinal: next.ordinal,
          onePlayerId: one.id,
          deckStartPosition: session.deckStartPosition,
          deckSize,
          strikesRemaining: settings.base_strikes,
          snapshot,
          startedAtMs: this.#wallNow(),
        });
        return proposal;
      },
    });
  }

  startPhaseA(command: Readonly<{ teacherId: string; requestId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "teacher_advance",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        if (this.#phase !== "BETWEEN_QUESTIONS" || game === null || game.status !== "live") {
          return this.#reject("WRONG_PHASE", "transient");
        }
        const question = this.#repository.questionAt(this.#sessionId, game.deckStartPosition + game.questionOffset);
        if (question === undefined) return this.#reject("NO_QUESTION", "terminal", "No classroom question is ready");
        const players = this.#repository.players(this.#sessionId);
        const connected = this.#connectedPlayerIds();
        const eligible = players
          .filter((player) => player.role !== "one" && connected.has(player.id))
          .map((player) => player.id);
        const startedAtMs = this.#wallNow();
        const currentSettings = this.#settings(session);
        if (currentSettings instanceof SettingsValidationError) return this.#reject("INVALID_SETTINGS", "terminal", currentSettings.message);
        if (currentSettings === null) return this.#reject("GENERIC_SESSION", "terminal");
        // Teacher timing changes apply at the question boundary and override
        // imported per-question timing for 1v100 sessions.
        const durationMs = currentSettings.phase_a_seconds * 1_000;
        const attemptSettings = Object.freeze({
          ...game.snapshot.settings,
          phase_a_seconds: currentSettings.phase_a_seconds,
          momentum_enabled: currentSettings.momentum_enabled,
        });
        const active: RulesetAttemptSnapshot = Object.freeze({
          attempt_id: uuidV7(startedAtMs),
          question_id: question.id,
          index: game.questionOffset + 1,
          prompt: question.prompt,
          choices: Object.freeze([...question.choices]),
          correct_choice: question.correctChoice,
          started_at_ms: startedAtMs,
          deadline_ms: startedAtMs + durationMs,
          eligible_player_ids: Object.freeze(eligible),
          answers: Object.freeze([]),
          phase_b_started_at_ms: null,
          one_answer: null,
          one_duration_ms: null,
          help_used: null,
          help_result: null,
          momentum_eligible: true,
        });
        const phaseASnapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          settings_revision: session.settingsRevision,
          settings: attemptSettings,
          phase: "PHASE_A",
          active,
          paused_reason: null,
          paused_from: null,
          pause_remaining_ms: null,
          pause_reasons: NO_PAUSE_REASONS,
        });
        const phaseAGame = Object.freeze({ ...game, snapshot: phaseASnapshot });
        const transition = eligible.length === 0
          ? this.#phaseBTransition(phaseAGame)
          : null;
        const next = transition?.game ?? phaseAGame;
        const payload = this.#phaseAQuestionPayload(active);
        const statusPayload = this.#phaseAStatusPayload(active, 0);
        const lockedPayload = Object.freeze({ reason: "all_answered", locked_count: 0, eligible_count: 0 });
        return {
          state: next,
          eventType: "phase_a_start",
          eventPayload: { ...payload, eligible_player_ids: eligible },
          followingEvents: [
            { eventType: "phase_a_status", eventPayload: statusPayload, actorKind: "system" as const, actorId: "system" },
            ...(transition === null ? [] : [
              { eventType: "phase_a_locked", eventPayload: lockedPayload, actorKind: "system" as const, actorId: "system" },
              ...(transition.eventType === null || transition.eventPayload === null ? [] : [
                { eventType: transition.eventType, eventPayload: transition.eventPayload, actorKind: "system" as const, actorId: "system" },
              ]),
            ]),
          ],
          persist: () => this.#repository.updateGameProgress({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            questionOffset: game.questionOffset,
            strikesRemaining: game.strikesRemaining,
            bank: game.bank,
            snapshot: next.snapshot,
            nextDeckPosition: game.deckStartPosition + game.questionOffset + 1,
            phaseBExposedAtMs: transition?.exposedAtMs ?? null,
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = state.snapshot.phase;
            this.#phaseAStartedMonotonicMs = this.#monotonicNow();
            this.#publish(Object.freeze({ type: "phase_a_start", serverSeq: event.serverSeq, payload }));
            const statusEvent = events.find((candidate) => candidate.eventType === "phase_a_status");
            this.#publish(Object.freeze({
              type: "phase_a_status",
              serverSeq: statusEvent?.serverSeq ?? event.serverSeq,
              payload: statusPayload,
            }));
            if (transition !== null) {
              const lockedEvent = events.find((candidate) => candidate.eventType === "phase_a_locked");
              const phaseBEvent = events.find((candidate) => candidate.eventType === transition.eventType);
              this.#publish(Object.freeze({
                type: "phase_a_locked",
                serverSeq: lockedEvent?.serverSeq ?? event.serverSeq,
                payload: lockedPayload,
              }));
              this.#publishPhaseBTransition(transition, phaseBEvent?.serverSeq ?? event.serverSeq);
            }
          },
        };
      },
    });
  }

  answerPhaseA(command: Readonly<{
    playerId: string;
    requestId: string;
    attemptId: string;
    questionId: string;
    choice: number;
  }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: command.attemptId,
      commandType: "student_answer",
      actorKind: "player",
      actorId: command.playerId,
      requestId: command.requestId,
      payload: { attempt_id: command.attemptId, question_id: command.questionId, choice: command.choice },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const active = game === null ? null : game.snapshot.active;
        if (game === null || active === null || this.#phase !== "PHASE_A") return this.#reject("WRONG_PHASE", "transient");
        if (active.attempt_id !== command.attemptId || active.question_id !== command.questionId) {
          return this.#reject("STALE_ATTEMPT", "transient");
        }
        if (!active.eligible_player_ids.includes(command.playerId)) return this.#reject("FORBIDDEN", "terminal");
        if (!Number.isInteger(command.choice) || command.choice < 0 || command.choice >= active.choices.length) {
          return this.#reject("INVALID_CHOICE", "terminal", "Choose one of the answers shown");
        }
        if (this.#wallNow() >= active.deadline_ms) return this.#reject("TOO_LATE", "transient");
        if (active.answers.some((answer) => answer.player_id === command.playerId)) {
          return this.#reject("ALREADY_ANSWERED", "terminal", "Your answer is already locked");
        }
        const answer = Object.freeze({
          player_id: command.playerId,
          choice: command.choice,
          receive_duration_ms: Math.max(0, this.#monotonicNow() - this.#phaseAStartedMonotonicMs),
        });
        const answers = Object.freeze([...active.answers, answer]);
        const complete = answers.length === active.eligible_player_ids.length;
        const updatedActive = Object.freeze({ ...active, answers });
        const phaseASnapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase: "PHASE_A",
          active: updatedActive,
        });
        const phaseAGame = Object.freeze({ ...game, snapshot: phaseASnapshot });
        const transition = complete
          ? this.#phaseBTransition(phaseAGame)
          : null;
        const next = transition?.game ?? phaseAGame;
        const countsPayload = Object.freeze({
          locked_count: answers.length,
          eligible_count: active.eligible_player_ids.length,
        });
        const lockedPayload = Object.freeze({ reason: "all_answered", ...countsPayload });
        return {
          state: next,
          eventType: "answer_accepted",
          eventPayload: answer,
          followingEvents: [
            { eventType: "lock_counts", eventPayload: countsPayload, actorKind: "system" as const, actorId: "system" },
            ...(transition === null ? [] : [
              { eventType: "phase_a_locked", eventPayload: lockedPayload, actorKind: "system" as const, actorId: "system" },
              ...(transition.eventType === null || transition.eventPayload === null ? [] : [
                { eventType: transition.eventType, eventPayload: transition.eventPayload, actorKind: "system" as const, actorId: "system" },
              ]),
            ]),
          ],
          persist: () => complete
            ? this.#repository.updateGameProgress({
                sessionId: this.#sessionId,
                gameId: game.gameId,
                questionOffset: game.questionOffset,
                strikesRemaining: game.strikesRemaining,
                bank: game.bank,
                snapshot: next.snapshot,
                phaseBExposedAtMs: transition?.exposedAtMs ?? null,
              })
            : this.#repository.updateGameSnapshot(game.gameId, phaseASnapshot),
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            question_id: active.question_id,
            received_at_ms: event.createdAtMs,
          }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = state.snapshot.phase;
            const countsEvent = events.find((candidate) => candidate.eventType === "lock_counts");
            this.#publish(Object.freeze({
              type: "lock_counts",
              serverSeq: countsEvent?.serverSeq ?? event.serverSeq,
              payload: countsPayload,
            }));
            if (transition !== null) {
              const lockedEvent = events.find((candidate) => candidate.eventType === "phase_a_locked");
              const phaseBEvent = events.find((candidate) => candidate.eventType === transition.eventType);
              this.#publish(Object.freeze({
                type: "phase_a_locked",
                serverSeq: lockedEvent?.serverSeq ?? event.serverSeq,
                payload: lockedPayload,
              }));
              this.#publishPhaseBTransition(transition, phaseBEvent?.serverSeq ?? event.serverSeq);
            }
          },
        };
      },
    });
  }

  lockPhaseA(reason: "all_answered" | "deadline" = "deadline"): LifecycleOutcome {
    const active = this.#game?.snapshot.active;
    const requestId = `phase-a-lock:${active?.attempt_id ?? "none"}`;
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: active?.attempt_id ?? null,
      commandType: "lock_phase_a",
      actorKind: "system",
      actorId: "system",
      requestId,
      payload: { reason },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const current = game === null ? null : game.snapshot.active;
        if (game === null || current === null || this.#phase !== "PHASE_A") return this.#reject("WRONG_PHASE", "transient");
        if (reason === "deadline" && this.#wallNow() < current.deadline_ms) return this.#reject("WRONG_PHASE", "transient");
        const transition = this.#phaseBTransition(game);
        const unanswered = current.eligible_player_ids.filter((playerId) =>
          !current.answers.some((answer) => answer.player_id === playerId),
        );
        const payload = Object.freeze({
          reason,
          locked_count: current.answers.length,
          eligible_count: current.eligible_player_ids.length,
        });
        return {
          state: transition.game,
          priorEvents: unanswered.map((playerId) => ({
            eventType: "no_answer",
            eventPayload: { question_id: current.question_id },
            actorKind: "player" as const,
            actorId: playerId,
          })),
          eventType: "phase_a_locked",
          eventPayload: payload,
          followingEvents: transition.eventType === null || transition.eventPayload === null ? [] : [{
            eventType: transition.eventType,
            eventPayload: transition.eventPayload,
            actorKind: "system" as const,
            actorId: "system",
          }],
          persist: () => this.#repository.updateGameProgress({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            questionOffset: game.questionOffset,
            strikesRemaining: game.strikesRemaining,
            bank: game.bank,
            snapshot: transition.game.snapshot,
            phaseBExposedAtMs: transition.exposedAtMs,
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId, serverSeq: event.serverSeq }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = state.snapshot.phase;
            this.#publish(Object.freeze({ type: "phase_a_locked", serverSeq: event.serverSeq, payload }));
            const phaseBEvent = events.find((candidate) => candidate.eventType === transition.eventType);
            this.#publishPhaseBTransition(transition, phaseBEvent?.serverSeq ?? event.serverSeq);
          },
        };
      },
    });
  }

  lockExpiredPhaseA(): LifecycleOutcome | undefined {
    const active = this.#game?.snapshot.active;
    if (this.#phase !== "PHASE_A" || active === undefined || active === null || this.#wallNow() < active.deadline_ms) {
      return undefined;
    }
    return this.lockPhaseA("deadline");
  }

  startPhaseB(): LifecycleOutcome {
    const attemptId = this.#game?.snapshot.active?.attempt_id ?? "none";
    const requestId = `phase-b-start:${attemptId}`;
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "start_phase_b",
      actorKind: "system",
      actorId: "system",
      requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const active = game === null ? null : game.snapshot.active;
        if (game === null || active === null || this.#phase !== "PHASE_A_LOCKED") return this.#reject("WRONG_PHASE", "transient");
        const oneConnected = this.#connectedPlayerIds().has(game.onePlayerId);
        const phase = oneConnected ? "PHASE_B" as const : "PAUSED" as const;
        const startedAtMs = Math.max(this.#wallNow(), (active.phase_b_started_at_ms ?? 0) + 1);
        const nextActive = Object.freeze({ ...active, phase_b_started_at_ms: oneConnected ? startedAtMs : null });
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase,
          active: nextActive,
          paused_reason: oneConnected ? null : "Waiting for The One to reconnect",
          paused_from: oneConnected ? null : "PHASE_B",
          pause_remaining_ms: null,
          pause_reasons: Object.freeze({
            ...game.snapshot.pause_reasons,
            one_disconnected: !oneConnected,
          }),
        });
        const next = Object.freeze({ ...game, snapshot });
        const payload = this.#phaseBPayload(nextActive, game);
        return {
          state: next,
          eventType: oneConnected ? "phase_b_start" : "pause_state",
          eventPayload: oneConnected
            ? payload
            : { paused: true, reason: "one_disconnected" },
          persist: () => this.#repository.updateGameProgress({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            questionOffset: game.questionOffset,
            strikesRemaining: game.strikesRemaining,
            bank: game.bank,
            snapshot,
            phaseBExposedAtMs: oneConnected ? startedAtMs : null,
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId, serverSeq: event.serverSeq }),
          apply: (state, event) => {
            this.#game = state;
            this.#phase = phase;
            if (oneConnected) {
              this.#phaseBStartedMonotonicMs = this.#monotonicNow();
              this.#publish(Object.freeze({ type: "phase_b_start", serverSeq: event.serverSeq, payload }));
            } else {
              this.#publish(Object.freeze({
                type: "pause_state",
                serverSeq: event.serverSeq,
                payload: Object.freeze({ paused: true, reason: "one_disconnected" }),
              }));
            }
          },
        };
      },
    });
  }

  resumeOne(playerId: string): LifecycleOutcome {
    const game = this.#game;
    const attemptId = game?.snapshot.active?.attempt_id ?? "none";
    const generation = game?.snapshot.active?.phase_b_started_at_ms ?? "unexposed";
    const requestId = `phase-b-resume:${attemptId}:player:${playerId}:generation:${generation}`;
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: game?.gameId ?? null,
      attemptId: game?.snapshot.active?.attempt_id ?? null,
      commandType: "resume_phase_b",
      actorKind: "system",
      actorId: "system",
      requestId,
      payload: { player_id: playerId },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const current = this.#game;
        const active = current?.snapshot.active ?? null;
        if (
          current === null || active === null || this.#phase !== "PAUSED" ||
          current.onePlayerId !== playerId || !this.#connectedPlayerIds().has(playerId) ||
          !current.snapshot.pause_reasons.one_disconnected
        ) {
          return this.#reject("WRONG_PHASE", "transient");
        }
        const startedAtMs = Math.max(this.#wallNow(), (active.phase_b_started_at_ms ?? 0) + 1);
        const pauseReasons = Object.freeze({ ...current.snapshot.pause_reasons, one_disconnected: false });
        const remainsPaused = pauseReasons.teacher !== null || pauseReasons.one_kicked;
        const nextActive = Object.freeze({ ...active, phase_b_started_at_ms: remainsPaused ? null : startedAtMs });
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...current.snapshot,
          phase: remainsPaused ? "PAUSED" : "PHASE_B",
          active: nextActive,
          paused_reason: remainsPaused ? this.#pauseReason(pauseReasons) : null,
          paused_from: remainsPaused ? "PHASE_B" : null,
          pause_remaining_ms: null,
          pause_reasons: pauseReasons,
        });
        const next = Object.freeze({ ...current, snapshot });
        const payload = this.#phaseBPayload(nextActive, current);
        return {
          state: next,
          eventType: "pause_state",
          eventPayload: { paused: remainsPaused, reason: remainsPaused ? this.#pauseReason(pauseReasons) : "one_reconnected" },
          followingEvents: remainsPaused ? [] : [{
            eventType: "phase_b_start",
            eventPayload: payload,
            actorKind: "system" as const,
            actorId: "system",
          }],
          persist: () => this.#repository.updateGameProgress({
            sessionId: this.#sessionId,
            gameId: current.gameId,
            questionOffset: current.questionOffset,
            strikesRemaining: current.strikesRemaining,
            bank: current.bank,
            snapshot,
            phaseBExposedAtMs: remainsPaused ? null : startedAtMs,
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId, serverSeq: event.serverSeq }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = state.snapshot.phase;
            if (!remainsPaused) this.#phaseBStartedMonotonicMs = this.#monotonicNow();
            this.#publish(Object.freeze({
              type: "pause_state",
              serverSeq: event.serverSeq,
              payload: Object.freeze({ paused: remainsPaused, reason: remainsPaused ? this.#pauseReason(pauseReasons) : "one_reconnected" }),
            }));
            if (!remainsPaused) {
              const phaseBEvent = events.find((candidate) => candidate.eventType === "phase_b_start");
              this.#publish(Object.freeze({ type: "phase_b_start", serverSeq: phaseBEvent?.serverSeq ?? event.serverSeq, payload }));
            }
          },
        };
      },
    });
  }

  pauseOneDisconnected(playerId: string): LifecycleOutcome {
    const game = this.#game;
    const attemptId = game?.snapshot.active?.attempt_id ?? "none";
    const generation = game?.snapshot.active?.phase_b_started_at_ms ?? "unexposed";
    const requestId = `phase-b-pause:${attemptId}:player:${playerId}:generation:${generation}`;
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: game?.gameId ?? null,
      attemptId: game?.snapshot.active?.attempt_id ?? null,
      commandType: "pause_phase_b",
      actorKind: "system",
      actorId: "system",
      requestId,
      payload: { player_id: playerId, reason: "one_disconnected" },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const current = this.#game;
        if (
          current === null || current.snapshot.active === null ||
          (this.#phase !== "PHASE_B" && this.#phase !== "PAUSED") ||
          current.onePlayerId !== playerId || this.#connectedPlayerIds().has(playerId) ||
          current.snapshot.pause_reasons.one_disconnected || current.snapshot.pause_reasons.one_kicked
        ) {
          return this.#reject("WRONG_PHASE", "transient");
        }
        const nextActive = this.#phase === "PHASE_B"
          ? Object.freeze({
              ...current.snapshot.active,
              one_duration_ms: this.#phaseBActiveDurationMs(current.snapshot.active),
            })
          : current.snapshot.active;
        const pauseReasons = Object.freeze({ ...current.snapshot.pause_reasons, one_disconnected: true });
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...current.snapshot,
          phase: "PAUSED",
          active: nextActive,
          paused_reason: "Waiting for The One to reconnect",
          paused_from: "PHASE_B",
          pause_remaining_ms: null,
          pause_reasons: pauseReasons,
        });
        const next = Object.freeze({ ...current, snapshot });
        const payload = Object.freeze({ paused: true, reason: "one_disconnected" });
        return {
          state: next,
          eventType: "pause_state",
          eventPayload: payload,
          persist: () => this.#repository.updateGameProgress({
            sessionId: this.#sessionId,
            gameId: current.gameId,
            questionOffset: current.questionOffset,
            strikesRemaining: current.strikesRemaining,
            bank: current.bank,
            snapshot,
            phaseBExposedAtMs: nextActive.phase_b_started_at_ms,
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId, serverSeq: event.serverSeq }),
          apply: (state, event) => {
            this.#game = state;
            this.#phase = "PAUSED";
            this.#publish(Object.freeze({ type: "pause_state", serverSeq: event.serverSeq, payload }));
          },
        };
      },
    });
  }

  teacherPause(command: Readonly<{ teacherId: string; requestId: string; reason?: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "teacher_pause",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: command.reason === undefined ? {} : { reason: command.reason },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        const game = this.#game;
        const active = game?.snapshot.active ?? null;
        if (game === null || active === null || (this.#phase !== "PHASE_A" && this.#phase !== "PHASE_B")) {
          return this.#reject("WRONG_PHASE", "transient");
        }
        const pausedFrom = this.#phase;
        const remainingMs = pausedFrom === "PHASE_A" ? Math.max(0, active.deadline_ms - this.#wallNow()) : null;
        const nextActive = pausedFrom === "PHASE_B"
          ? Object.freeze({ ...active, one_duration_ms: this.#phaseBActiveDurationMs(active) })
          : active;
        const reason = command.reason?.trim() || "teacher";
        const pauseReasons = Object.freeze({
          ...game.snapshot.pause_reasons,
          teacher: command.reason === "one_kicked" ? game.snapshot.pause_reasons.teacher : reason,
          one_kicked: command.reason === "one_kicked" || game.snapshot.pause_reasons.one_kicked,
        });
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase: "PAUSED",
          active: nextActive,
          paused_reason: reason,
          paused_from: pausedFrom,
          pause_remaining_ms: remainingMs,
          pause_reasons: pauseReasons,
        });
        const next = Object.freeze({ ...game, snapshot });
        const payload = Object.freeze({
          paused: true,
          reason: command.reason === "one_kicked" ? "one_kicked" : "teacher",
          ...(remainingMs === null ? {} : { remaining_ms: remainingMs }),
        });
        return {
          state: next,
          eventType: "pause_state",
          eventPayload: { ...payload, teacher_reason: reason, paused_from: pausedFrom },
          persist: () => this.#repository.updateGameSnapshot(game.gameId, snapshot),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (state, event) => {
            this.#game = state;
            this.#phase = "PAUSED";
            if (pausedFrom === "PHASE_A") this.#phaseAPausedAtMonotonicMs = this.#monotonicNow();
            this.#publish(Object.freeze({ type: "pause_state", serverSeq: event.serverSeq, payload }));
          },
        };
      },
    });
  }

  prepareKickPause(playerId: string): Readonly<{
    eventPayload: Readonly<Record<string, unknown>>;
    persist: () => void;
    apply: (serverSeq: number) => void;
  }> | undefined {
    const game = this.#game;
    const active = game?.snapshot.active ?? null;
    if (
      game === null || active === null || game.onePlayerId !== playerId ||
      (this.#phase !== "PHASE_A" && this.#phase !== "PHASE_B")
    ) {
      return undefined;
    }
    const pausedFrom = this.#phase;
    const remainingMs = pausedFrom === "PHASE_A" ? Math.max(0, active.deadline_ms - this.#wallNow()) : null;
    const nextActive = pausedFrom === "PHASE_B"
      ? Object.freeze({ ...active, one_duration_ms: this.#phaseBActiveDurationMs(active) })
      : active;
    const pauseReasons = Object.freeze({ ...game.snapshot.pause_reasons, one_kicked: true });
    const snapshot: RulesetGameSnapshot = Object.freeze({
      ...game.snapshot,
      phase: "PAUSED",
      active: nextActive,
      paused_reason: "one_kicked",
      paused_from: pausedFrom,
      pause_remaining_ms: remainingMs,
      pause_reasons: pauseReasons,
    });
    const next = Object.freeze({ ...game, snapshot });
    const eventPayload = Object.freeze({
      paused: true,
      reason: "one_kicked",
      ...(remainingMs === null ? {} : { remaining_ms: remainingMs }),
    });
    return Object.freeze({
      eventPayload,
      persist: () => this.#repository.updateGameSnapshot(game.gameId, snapshot),
      apply: (serverSeq: number) => {
        this.#game = next;
        this.#phase = "PAUSED";
        this.#publish(Object.freeze({ type: "pause_state", serverSeq, payload: eventPayload }));
      },
    });
  }

  teacherResume(command: Readonly<{ teacherId: string; requestId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "teacher_resume",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        const game = this.#game;
        const active = game?.snapshot.active ?? null;
        const pausedFrom = game?.snapshot.paused_from ?? null;
        if (game === null || active === null || this.#phase !== "PAUSED" || pausedFrom === null) {
          return this.#reject("WRONG_PHASE", "transient");
        }
        if (pausedFrom === "PHASE_B" && !this.#connectedPlayerIds().has(game.onePlayerId)) {
          return this.#reject("ONE_UNAVAILABLE", "transient", "Wait for The One to reconnect before resuming");
        }
        if (game.snapshot.pause_reasons.one_kicked) {
          return this.#reject("ONE_UNAVAILABLE", "transient", "Choose how to finish this question before resuming");
        }
        const resumedAtMs = this.#wallNow();
        const nextActive = pausedFrom === "PHASE_A"
          ? Object.freeze({ ...active, deadline_ms: resumedAtMs + Math.max(0, game.snapshot.pause_remaining_ms ?? 0) })
          : Object.freeze({ ...active, phase_b_started_at_ms: resumedAtMs });
        const pauseReasons = Object.freeze({ ...game.snapshot.pause_reasons, teacher: null });
        const remainsPaused = pauseReasons.one_disconnected || pauseReasons.one_kicked;
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase: remainsPaused ? "PAUSED" : pausedFrom,
          active: nextActive,
          paused_reason: remainsPaused ? this.#pauseReason(pauseReasons) : null,
          paused_from: remainsPaused ? pausedFrom : null,
          pause_remaining_ms: remainsPaused ? game.snapshot.pause_remaining_ms : null,
          pause_reasons: pauseReasons,
        });
        const next = Object.freeze({ ...game, snapshot });
        const payload = Object.freeze({
          paused: remainsPaused,
          reason: remainsPaused ? this.#pauseReason(pauseReasons) : "teacher_resumed",
          ...(pausedFrom === "PHASE_A" && !remainsPaused ? { deadline_ms: nextActive.deadline_ms } : {}),
        });
        return {
          state: next,
          eventType: "pause_state",
          eventPayload: { ...payload, resumed_to: pausedFrom, ...(pausedFrom === "PHASE_A" ? { deadline_ms: nextActive.deadline_ms } : {}) },
          persist: () => this.#repository.updateGameSnapshot(game.gameId, snapshot),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (state, event) => {
            this.#game = state;
            this.#phase = state.snapshot.phase;
            if (!remainsPaused && pausedFrom === "PHASE_A") {
              const pausedDurationMs = this.#phaseAPausedAtMonotonicMs === null
                ? Math.max(0, nextActive.deadline_ms - active.deadline_ms)
                : Math.max(0, this.#monotonicNow() - this.#phaseAPausedAtMonotonicMs);
              this.#phaseAStartedMonotonicMs += pausedDurationMs;
              this.#phaseAPausedAtMonotonicMs = null;
            }
            if (!remainsPaused && pausedFrom === "PHASE_B") this.#phaseBStartedMonotonicMs = this.#monotonicNow();
            this.#publish(Object.freeze({ type: "pause_state", serverSeq: event.serverSeq, payload }));
          },
        };
      },
    });
  }

  helpPoll(command: Readonly<{ playerId: string; requestId: string; choice: number }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "help_poll",
      actorKind: "player",
      actorId: command.playerId,
      requestId: command.requestId,
      payload: { choice: command.choice },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const checked = this.#helpContext(command.playerId, "poll");
        if ("code" in checked) return checked;
        const { game, active } = checked;
        if (!Number.isInteger(command.choice) || command.choice < 0 || command.choice >= active.choices.length) {
          return this.#reject("INVALID_CHOICE", "terminal", "Choose one of the answers shown");
        }
        const payload = Object.freeze({
          choice: command.choice,
          count: active.answers.filter((answer) => answer.choice === command.choice).length,
          total_answers: active.answers.length,
        });
        const proposal = this.#helpProposal(command.requestId, game, active, "poll", payload);
        return {
          ...proposal,
          persist: () => this.#repository.applyHelp({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            snapshot: proposal.state.snapshot,
            helpsUsed: proposal.state.helpsUsed,
          }),
        };
      },
    });
  }

  helpAsk(command: Readonly<{ playerId: string; requestId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "help_ask",
      actorKind: "player",
      actorId: command.playerId,
      requestId: command.requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const checked = this.#helpContext(command.playerId, "ask");
        if ("code" in checked) return checked;
        const { game, active } = checked;
        const connected = this.#connectedPlayerIds();
        const candidates = active.answers.filter((answer) => connected.has(answer.player_id));
        const correct = candidates.filter((answer) => answer.choice === active.correct_choice);
        const incorrect = candidates.filter((answer) => answer.choice !== active.correct_choice);
        if (correct.length === 0 || incorrect.length === 0) {
          return this.#reject("ASK_UNAVAILABLE", "transient", "Ask Two needs classmates with different answers this time. Try another Lifeline or lock in your own!");
        }
        const selected = [correct[randomInt(correct.length)]!, incorrect[randomInt(incorrect.length)]!];
        if (randomInt(2) === 1) selected.reverse();
        const players = new Map(this.#repository.players(this.#sessionId).map((player) => [player.id, player]));
        const speakers = Object.freeze(selected.map((answer) => Object.freeze({
          player_id: answer.player_id,
          nickname: players.get(answer.player_id)?.nickname ?? "Classmate",
          choice: answer.choice,
        })));
        const payload = Object.freeze({ speakers, bonus_each: game.snapshot.settings.ask_speaker_bonus });
        const pointAwards = selected.map((answer) => ({
          playerId: answer.player_id,
          points: game.snapshot.settings.ask_speaker_bonus,
        }));
        const proposal = this.#helpProposal(command.requestId, game, active, "ask", payload);
        return {
          ...proposal,
          persist: () => this.#repository.applyHelp({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            snapshot: proposal.state.snapshot,
            helpsUsed: proposal.state.helpsUsed,
            pointAwards,
          }),
        };
      },
    });
  }

  helpTrust(command: Readonly<{ playerId: string; requestId: string }>): LifecycleOutcome {
    const game = this.#game;
    const active = game?.snapshot.active;
    const counts = active?.choices.map((_, choice) => active.answers.filter((answer) => answer.choice === choice).length) ?? [];
    const maximum = counts.length === 0 ? 0 : Math.max(...counts);
    const candidates = counts.flatMap((count, choice) => count === maximum ? [choice] : []);
    const digest = game === null || active === null || active === undefined
      ? 0n
      : BigInt(`0x${createHash("sha256").update(game.gameId + active.question_id).digest("hex")}`);
    const pluralityChoice = candidates[Number(digest % BigInt(Math.max(1, candidates.length)))] ?? 0;
    return this.#answerOne({
      playerId: command.playerId,
      requestId: command.requestId,
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: pluralityChoice,
    }, Object.freeze({
      plurality_choice: pluralityChoice,
      counts: Object.freeze(counts),
      ...(candidates.length > 1 ? { tie_candidates: Object.freeze(candidates) } : {}),
      locked: true,
    }));
  }

  answerOne(command: Readonly<{
    playerId: string;
    requestId: string;
    attemptId: string;
    questionId: string;
    choice: number;
  }>): LifecycleOutcome {
    return this.#answerOne(command);
  }

  #answerOne(command: Readonly<{
    playerId: string;
    requestId: string;
    attemptId: string;
    questionId: string;
    choice: number;
  }>, trustPayload?: Readonly<Record<string, unknown>>, forced?: Readonly<{ teacherId: string; suppliedChoice: boolean }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: command.attemptId,
      commandType: forced === undefined ? (trustPayload === undefined ? "one_answer" : "help_trust") : "teacher_force_reveal",
      actorKind: forced === undefined ? "player" : "teacher",
      actorId: forced?.teacherId ?? command.playerId,
      requestId: command.requestId,
      payload: forced === undefined
        ? (trustPayload === undefined ? { question_id: command.questionId, choice: command.choice } : {})
        : (forced.suppliedChoice ? { one_choice: command.choice } : {}),
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const active = game === null ? null : game.snapshot.active;
        const mayForcePaused = forced !== undefined && this.#phase === "PAUSED" && game?.snapshot.paused_from === "PHASE_B";
        if (game === null || active === null || (this.#phase !== "PHASE_B" && !mayForcePaused)) return this.#reject("WRONG_PHASE", "transient");
        if (forced !== undefined) {
          const session = this.#repository.session(this.#sessionId);
          if (session === undefined || session.teacherId !== forced.teacherId) return this.#reject("FORBIDDEN", "terminal");
        } else if (game.onePlayerId !== command.playerId) return this.#reject("FORBIDDEN", "terminal");
        if (trustPayload !== undefined) {
          const unavailable = this.#helpRejection(game, active, "trust");
          if (unavailable !== null) return unavailable;
          if (active.answers.length === 0) return this.#reject("TRUST_UNAVAILABLE", "transient", "Trust needs at least one class answer");
        }
        if (active.attempt_id !== command.attemptId || active.question_id !== command.questionId) {
          return this.#reject("STALE_ATTEMPT", "transient");
        }
        if (active.one_answer !== null) return this.#reject("ALREADY_ANSWERED", "terminal", "Your answer is already locked");
        if (!Number.isInteger(command.choice) || command.choice < 0 || command.choice >= active.choices.length) {
          return this.#reject("INVALID_CHOICE", "terminal", "Choose one of the answers shown");
        }
        const updated = Object.freeze({
          ...active,
          one_answer: command.choice,
          one_duration_ms: forced !== undefined && this.#phase === "PAUSED"
            ? active.one_duration_ms ?? 0
            : this.#phaseBActiveDurationMs(active),
          ...(trustPayload === undefined ? {} : {
            help_used: "trust" as const,
            help_result: trustPayload,
            momentum_eligible: false,
          }),
        });
        const helpsUsed = trustPayload === undefined
          ? game.snapshot.helps_used
          : Object.freeze({ ...game.snapshot.helps_used, trust: true });
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined) return this.#reject("SESSION_NOT_FOUND", "terminal");
        const visiblePlayers = this.#repository.players(this.#sessionId);
        const scoringPlayerIds = Object.freeze([
          ...new Set([game.onePlayerId, ...updated.eligible_player_ids, ...visiblePlayers.map((player) => player.id)]),
        ]);
        const players = this.#repository.scoringPlayers(this.#sessionId, scoringPlayerIds);
        const oneCorrect = updated.one_answer === updated.correct_choice;
        const scored = scoreOneV100Reveal({
          players,
          eligiblePlayerIds: updated.eligible_player_ids,
          answers: updated.eligible_player_ids.map((playerId) => ({
            playerId,
            choice: updated.answers.find((answer) => answer.player_id === playerId)?.choice ?? null,
          })),
          correctChoice: updated.correct_choice,
          onePlayerId: game.onePlayerId,
          oneCorrect,
          strikesRemaining: game.strikesRemaining,
          bank: game.bank,
          questionNumber: game.questionOffset + 1,
          deckSize: game.deckSize,
          settings: game.snapshot.settings,
        });
        const momentum = this.#momentumReveal(game, updated, visiblePlayers, oneCorrect, scored.strikesRemaining);
        const counts = updated.choices.map((_, choice) =>
          updated.answers.filter((answer) => answer.choice === choice).length,
        );
        const budgetReached = scored.endReason !== null &&
          session.deckStartPosition - 1 >= game.snapshot.settings.session_question_budget;
        const lastResult = scored.endReason === null ? undefined : Object.freeze({
          reason: scored.endReason,
          payouts: scored.payouts,
          bank: scored.bank,
          banked_by_one: scored.bankedByOne,
        });
        const phase = budgetReached
          ? "SESSION_ENDED" as const
          : scored.endReason === null
            ? "BETWEEN_QUESTIONS" as const
            : "LEADERBOARD" as const;
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase,
          active: null,
          paused_reason: null,
          paused_from: null,
          pause_remaining_ms: null,
          pause_reasons: NO_PAUSE_REASONS,
          helps_used: helpsUsed,
          momentum: momentum.state,
          ...(lastResult === undefined ? {} : { last_result: lastResult }),
        });
        const next: RulesetGameRecord = Object.freeze({
          ...game,
          status: scored.endReason === null ? "live" : "ended",
          endReason: scored.endReason,
          questionOffset: game.questionOffset + 1,
          strikesRemaining: momentum.strikesRemaining,
          bank: scored.bank,
          helpsUsed,
          snapshot,
        });
        const revealPayload = Object.freeze({
          question_id: updated.question_id,
          correct_choice: updated.correct_choice,
          counts: Object.freeze(counts),
          one_correct: oneCorrect,
          demoted: scored.demoted,
          score_deltas: scored.scoreDeltas,
          bank_delta: scored.bankDelta,
          bank: scored.bank,
          fast_window_ms: momentum.fastWindowMs,
          one_duration_ms: updated.one_duration_ms,
          ...(forced === undefined ? {} : { forced: true }),
        });
        const endedAtMs = this.#wallNow();
        const gameEndPayload = lastResult === undefined ? null : Object.freeze({
          ...lastResult,
          leaderboard_at_ms: endedAtMs,
        });
        const scoredById = new Map(scored.players.map((player) => [player.id, player]));
        const finalPlayers = visiblePlayers.map((player) => {
          const scoredPlayer = scoredById.get(player.id);
          return scoredPlayer === undefined ? player : Object.freeze({
            ...player,
            role: scoredPlayer.role,
            points: scoredPlayer.points,
            streak: scoredPlayer.streak,
          });
        });
        const leaderboardPayload = gameEndPayload === null ? null : Object.freeze({
          scope: "session",
          rows: leaderboard(finalPlayers),
          server_time_ms: endedAtMs,
        });
        const sessionEndPayload = budgetReached ? Object.freeze({
          reason: "question_budget",
          final_leaderboard: leaderboard(finalPlayers),
        }) : null;
        return {
          state: next,
          eventType: trustPayload === undefined ? "one_answer_locked" : "help_trust_used",
          eventPayload: trustPayload === undefined
            ? { question_id: active.question_id, one_duration_ms: updated.one_duration_ms, ...(forced === undefined ? {} : { forced: true, choice_supplied: forced.suppliedChoice }) }
            : trustPayload,
          followingEvents: [
            ...(trustPayload === undefined ? [] : [{
              eventType: "help_trust_result",
              eventPayload: trustPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            ...(!oneCorrect ? [{
              eventType: "strike",
              eventPayload: { remaining: momentum.strikesRemaining, base: game.snapshot.settings.base_strikes, earned_extra: game.snapshot.momentum.awarded_once },
              actorKind: "system" as const,
              actorId: "system",
            }] : []),
            ...(momentum.progressPayload === null ? [] : [{
              eventType: "meter_progress",
              eventPayload: momentum.progressPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            ...(momentum.filledPayload === null ? [] : [{
              eventType: "meter_filled",
              eventPayload: momentum.filledPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            {
              eventType: "reveal",
              eventPayload: { ...revealPayload, answers: updated.answers, ...(momentum.windowLog === null ? {} : { momentum_window: momentum.windowLog }) },
              actorKind: "system" as const,
              actorId: "system",
            },
            ...(gameEndPayload === null ? [] : [{
              eventType: "game_end",
              eventPayload: gameEndPayload,
              actorKind: "system" as const,
              actorId: "system",
            }, {
              eventType: "leaderboard",
              eventPayload: leaderboardPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            ...(sessionEndPayload === null ? [] : [{
              eventType: "session_end",
              eventPayload: sessionEndPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
          ],
          persist: () => this.#repository.applyReveal({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            players: scored.players,
            questionOffset: next.questionOffset,
            strikesRemaining: momentum.strikesRemaining,
            bank: scored.bank,
            helpsUsed,
            snapshot,
            endReason: scored.endReason,
            endedAtMs,
            ...(budgetReached ? { sessionEndedAtMs: endedAtMs } : {}),
          }),
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: command.requestId,
            serverSeq: event.serverSeq,
            question_id: active.question_id,
            received_at_ms: event.createdAtMs,
          }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = phase;
            const eventFor = (type: string) => events.find((candidate) => candidate.eventType === type);
            if (trustPayload !== undefined) {
              const helpEvent = eventFor("help_trust_result");
              this.#publish(Object.freeze({
                type: "help_trust_result",
                serverSeq: helpEvent?.serverSeq ?? event.serverSeq,
                payload: trustPayload,
              }));
            }
            const strikeEvent = eventFor("strike");
            if (strikeEvent !== undefined) {
              this.#publish(Object.freeze({ type: "strike", serverSeq: strikeEvent.serverSeq, payload: strikeEvent.payload as Readonly<Record<string, unknown>> }));
            }
            const progressEvent = eventFor("meter_progress");
            if (progressEvent !== undefined && momentum.progressPayload !== null) {
              this.#publish(Object.freeze({ type: "meter_progress", serverSeq: progressEvent.serverSeq, payload: momentum.progressPayload }));
            }
            const filledEvent = eventFor("meter_filled");
            if (filledEvent !== undefined && momentum.filledPayload !== null) {
              this.#publish(Object.freeze({ type: "meter_filled", serverSeq: filledEvent.serverSeq, payload: momentum.filledPayload }));
            }
            const revealEvent = eventFor("reveal");
            this.#publish(Object.freeze({
              type: "reveal",
              serverSeq: revealEvent?.serverSeq ?? event.serverSeq,
              payload: revealPayload,
              roleChanges: scored.demoted.map((playerId) => Object.freeze({ playerId, role: "crowd" as const })),
            }));
            const gameEndEvent = eventFor("game_end");
            if (gameEndEvent !== undefined && gameEndPayload !== null && leaderboardPayload !== null) {
              this.#publish(Object.freeze({ type: "game_end", serverSeq: gameEndEvent.serverSeq, payload: gameEndPayload }));
              const leaderboardEvent = eventFor("leaderboard");
              this.#publish(Object.freeze({
                type: "leaderboard",
                serverSeq: leaderboardEvent?.serverSeq ?? gameEndEvent.serverSeq,
                payload: leaderboardPayload,
              }));
            }
            const sessionEndEvent = eventFor("session_end");
            if (sessionEndEvent !== undefined && sessionEndPayload !== null) {
              this.#publish(Object.freeze({
                type: "session_end",
                serverSeq: sessionEndEvent.serverSeq,
                payload: sessionEndPayload,
              }));
            }
          },
        };
      },
    });
  }

  reveal(command: Readonly<{ teacherId: string; requestId: string }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      attemptId: this.#game?.snapshot.active?.attempt_id ?? null,
      commandType: "reveal",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: {},
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        const active = game === null ? null : game.snapshot.active;
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        if (game === null || active === null || this.#phase !== "PHASE_B" || active.one_answer === null) {
          return this.#reject("WRONG_PHASE", "transient");
        }
        const visiblePlayers = this.#repository.players(this.#sessionId);
        const scoringPlayerIds = Object.freeze([
          ...new Set([game.onePlayerId, ...active.eligible_player_ids, ...visiblePlayers.map((player) => player.id)]),
        ]);
        const players = this.#repository.scoringPlayers(this.#sessionId, scoringPlayerIds);
        const oneCorrect = active.one_answer === active.correct_choice;
        const scored = scoreOneV100Reveal({
          players,
          eligiblePlayerIds: active.eligible_player_ids,
          answers: active.eligible_player_ids.map((playerId) => ({
            playerId,
            choice: active.answers.find((answer) => answer.player_id === playerId)?.choice ?? null,
          })),
          correctChoice: active.correct_choice,
          onePlayerId: game.onePlayerId,
          oneCorrect,
          strikesRemaining: game.strikesRemaining,
          bank: game.bank,
          questionNumber: game.questionOffset + 1,
          deckSize: game.deckSize,
          settings: game.snapshot.settings,
        });
        const momentum = this.#momentumReveal(game, active, visiblePlayers, oneCorrect, scored.strikesRemaining);
        const counts = active.choices.map((_, choice) => active.answers.filter((answer) => answer.choice === choice).length);
        const budgetReached = scored.endReason !== null &&
          session.deckStartPosition - 1 >= game.snapshot.settings.session_question_budget;
        const lastResult = scored.endReason === null ? undefined : Object.freeze({
          reason: scored.endReason,
          payouts: scored.payouts,
          bank: scored.bank,
          banked_by_one: scored.bankedByOne,
        });
        const phase = budgetReached
          ? "SESSION_ENDED" as const
          : scored.endReason === null
            ? "BETWEEN_QUESTIONS" as const
            : "LEADERBOARD" as const;
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase,
          active: null,
          paused_reason: null,
          paused_from: null,
          pause_remaining_ms: null,
          pause_reasons: NO_PAUSE_REASONS,
          momentum: momentum.state,
          ...(lastResult === undefined ? {} : { last_result: lastResult }),
        });
        const next: RulesetGameRecord = Object.freeze({
          ...game,
          status: scored.endReason === null ? "live" : "ended",
          endReason: scored.endReason,
          questionOffset: game.questionOffset + 1,
          strikesRemaining: momentum.strikesRemaining,
          bank: scored.bank,
          snapshot,
        });
        const payload = Object.freeze({
          question_id: active.question_id,
          correct_choice: active.correct_choice,
          counts: Object.freeze(counts),
          one_correct: oneCorrect,
          demoted: scored.demoted,
          score_deltas: scored.scoreDeltas,
          bank_delta: scored.bankDelta,
          bank: scored.bank,
          fast_window_ms: momentum.fastWindowMs,
          one_duration_ms: active.one_duration_ms,
        });
        const endedAtMs = this.#wallNow();
        const gameEndPayload = lastResult === undefined ? null : Object.freeze({
          ...lastResult,
          leaderboard_at_ms: endedAtMs,
        });
        const scoredById = new Map(scored.players.map((player) => [player.id, player]));
        const finalPlayers = visiblePlayers.map((player) => {
          const scoredPlayer = scoredById.get(player.id);
          return scoredPlayer === undefined ? player : Object.freeze({
            ...player,
            role: scoredPlayer.role,
            points: scoredPlayer.points,
            streak: scoredPlayer.streak,
          });
        });
        const leaderboardPayload = gameEndPayload === null ? null : Object.freeze({
          scope: "session",
          rows: leaderboard(finalPlayers),
          server_time_ms: endedAtMs,
        });
        const sessionEndPayload = budgetReached ? Object.freeze({
          reason: "question_budget",
          final_leaderboard: leaderboard(finalPlayers),
        }) : null;
        return {
          state: next,
          eventType: "one_answer_locked",
          eventPayload: { question_id: active.question_id, one_duration_ms: active.one_duration_ms },
          followingEvents: [
            ...(!oneCorrect ? [{
              eventType: "strike",
              eventPayload: { remaining: momentum.strikesRemaining, base: game.snapshot.settings.base_strikes, earned_extra: game.snapshot.momentum.awarded_once },
              actorKind: "system" as const,
              actorId: "system",
            }] : []),
            ...(momentum.progressPayload === null ? [] : [{
              eventType: "meter_progress",
              eventPayload: momentum.progressPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            ...(momentum.filledPayload === null ? [] : [{
              eventType: "meter_filled",
              eventPayload: momentum.filledPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            {
              eventType: "reveal",
              eventPayload: { ...payload, answers: active.answers, ...(momentum.windowLog === null ? {} : { momentum_window: momentum.windowLog }) },
              actorKind: "system" as const,
              actorId: "system",
            },
            ...(gameEndPayload === null ? [] : [{
              eventType: "game_end",
              eventPayload: gameEndPayload,
              actorKind: "system" as const,
              actorId: "system",
            }, {
              eventType: "leaderboard",
              eventPayload: leaderboardPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
            ...(sessionEndPayload === null ? [] : [{
              eventType: "session_end",
              eventPayload: sessionEndPayload,
              actorKind: "system" as const,
              actorId: "system",
            }]),
          ],
          persist: () => this.#repository.applyReveal({
            sessionId: this.#sessionId,
            gameId: game.gameId,
            players: scored.players,
            questionOffset: next.questionOffset,
            strikesRemaining: momentum.strikesRemaining,
            bank: scored.bank,
            helpsUsed: game.snapshot.helps_used,
            snapshot,
            endReason: scored.endReason,
            endedAtMs,
            ...(budgetReached ? { sessionEndedAtMs: endedAtMs } : {}),
          }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (state, event, _outcome, events) => {
            this.#game = state;
            this.#phase = phase;
            const eventFor = (type: string) => events.find((candidate) => candidate.eventType === type);
            const strikeEvent = eventFor("strike");
            if (!oneCorrect) {
              this.#publish(Object.freeze({
                type: "strike",
                serverSeq: strikeEvent?.serverSeq ?? event.serverSeq,
                payload: Object.freeze({ remaining: momentum.strikesRemaining, base: game.snapshot.settings.base_strikes, earned_extra: game.snapshot.momentum.awarded_once }),
              }));
            }
            const progressEvent = eventFor("meter_progress");
            if (progressEvent !== undefined && momentum.progressPayload !== null) {
              this.#publish(Object.freeze({ type: "meter_progress", serverSeq: progressEvent.serverSeq, payload: momentum.progressPayload }));
            }
            const filledEvent = eventFor("meter_filled");
            if (filledEvent !== undefined && momentum.filledPayload !== null) {
              this.#publish(Object.freeze({ type: "meter_filled", serverSeq: filledEvent.serverSeq, payload: momentum.filledPayload }));
            }
            const revealEvent = eventFor("reveal");
            this.#publish(Object.freeze({
              type: "reveal",
              serverSeq: revealEvent?.serverSeq ?? event.serverSeq,
              payload,
              roleChanges: scored.demoted.map((playerId) => Object.freeze({ playerId, role: "crowd" as const })),
            }));
            if (scored.endReason !== null && gameEndPayload !== null) {
              const gameEndEvent = eventFor("game_end");
              this.#publish(Object.freeze({
                type: "game_end",
                serverSeq: gameEndEvent?.serverSeq ?? event.serverSeq,
                payload: gameEndPayload,
              }));
              const leaderboardEvent = eventFor("leaderboard");
              this.#publish(Object.freeze({
                type: "leaderboard",
                serverSeq: leaderboardEvent?.serverSeq ?? gameEndEvent?.serverSeq ?? event.serverSeq,
                payload: leaderboardPayload ?? Object.freeze({ scope: "session", rows: leaderboard(finalPlayers) }),
              }));
              const sessionEndEvent = eventFor("session_end");
              if (sessionEndEvent !== undefined && sessionEndPayload !== null) {
                this.#publish(Object.freeze({
                  type: "session_end",
                  serverSeq: sessionEndEvent.serverSeq,
                  payload: sessionEndPayload,
                }));
              }
            }
          },
        };
      },
    });
  }

  forceReveal(command: Readonly<{ teacherId: string; requestId: string; oneChoice?: number }>): LifecycleOutcome {
    const game = this.#game;
    const active = game?.snapshot.active ?? null;
    const forcedChoice = active === null
      ? command.oneChoice ?? 0
      : command.oneChoice ?? active.choices.findIndex((_, choice) => choice !== active.correct_choice);
    return this.#answerOne({
      playerId: game?.onePlayerId ?? "missing-one",
      requestId: command.requestId,
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: forcedChoice,
    }, undefined, Object.freeze({ teacherId: command.teacherId, suppliedChoice: command.oneChoice !== undefined }));
  }

  endGame(command: Readonly<{
    actorId: string;
    requestId: string;
    reason: "flameout" | "deck_survived" | "mob_emptied";
    payouts?: readonly Readonly<{ player_id: string; points: number }>[];
    bankedByOne?: number;
  }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "game_end",
      actorKind: "system",
      actorId: command.actorId,
      requestId: command.requestId,
      payload: { reason: command.reason },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const game = this.#game;
        if (game === null || game.status !== "live" || this.#phase === "LEADERBOARD") return this.#reject("WRONG_PHASE", "transient");
        const payload = Object.freeze({
          reason: command.reason,
          payouts: command.payouts ?? Object.freeze([]),
          bank: game.bank,
          banked_by_one: command.bankedByOne ?? 0,
          leaderboard_at_ms: this.#wallNow(),
        });
        const snapshot: RulesetGameSnapshot = Object.freeze({
          ...game.snapshot,
          phase: "LEADERBOARD",
          last_result: payload,
        });
        const ended = Object.freeze({ ...game, status: "ended" as const, endReason: command.reason, snapshot });
        const rows = leaderboard(this.#repository.players(this.#sessionId));
        return {
          state: ended,
          eventType: "game_end",
          eventPayload: payload,
          followingEvents: [{
            eventType: "leaderboard",
            eventPayload: { scope: "session", rows, server_time_ms: this.#wallNow() },
            actorKind: "system" as const,
            actorId: "system",
          }],
          persist: () => this.#repository.endGame({ gameId: game.gameId, reason: command.reason, snapshot, endedAtMs: this.#wallNow() }),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (next, event, _outcome, events) => {
            this.#game = next;
            this.#phase = "LEADERBOARD";
            this.#publish(Object.freeze({ type: "game_end", serverSeq: event.serverSeq, payload }));
            this.#publish(Object.freeze({
              type: "leaderboard",
              serverSeq: events.find((candidate) => candidate.eventType === "leaderboard")?.serverSeq ?? event.serverSeq,
              payload: Object.freeze({ scope: "session", rows, server_time_ms: this.#wallNow() }),
            }));
          },
        };
      },
    });
  }

  endSession(command: Readonly<{ teacherId: string; requestId: string; reason: "teacher" | "question_budget" }>): LifecycleOutcome {
    return this.#coordinator.execute({
      sessionId: this.#sessionId,
      gameId: this.#game?.gameId ?? null,
      commandType: "teacher_end_session",
      actorKind: "teacher",
      actorId: command.teacherId,
      requestId: command.requestId,
      payload: { reason: command.reason },
      createdAtMs: this.#wallNow(),
      propose: () => {
        const session = this.#repository.session(this.#sessionId);
        if (session === undefined || session.teacherId !== command.teacherId) return this.#reject("FORBIDDEN", "terminal");
        if (this.#phase === "SESSION_ENDED") return this.#reject("SESSION_ENDED", "terminal", "This show has already ended");
        const rows = leaderboard(this.#repository.players(this.#sessionId));
        const payload = Object.freeze({ reason: command.reason, final_leaderboard: rows });
        return {
          state: null,
          eventType: "session_end",
          eventPayload: payload,
          persist: () => this.#repository.endSession(this.#sessionId, this.#wallNow()),
          outcome: (event) => Object.freeze({ ok: true as const, requestId: command.requestId, serverSeq: event.serverSeq }),
          apply: (_next, event) => {
            this.#phase = "SESSION_ENDED";
            this.#publish(Object.freeze({ type: "session_end", serverSeq: event.serverSeq, payload }));
          },
        };
      },
    });
  }

  #helpContext(playerId: string, help: "poll" | "ask"): Readonly<{
    game: RulesetGameRecord;
    active: RulesetAttemptSnapshot;
  }> | RejectedCommand {
    const game = this.#game;
    const active = game?.snapshot.active ?? null;
    if (game === null || active === null || this.#phase !== "PHASE_B") return this.#reject("WRONG_PHASE", "transient");
    if (game.onePlayerId !== playerId) return this.#reject("FORBIDDEN", "terminal", "Only The One can use a help");
    const unavailable = this.#helpRejection(game, active, help);
    return unavailable ?? Object.freeze({ game, active });
  }

  #helpRejection(
    game: RulesetGameRecord,
    active: RulesetAttemptSnapshot,
    help: "poll" | "ask" | "trust",
  ): RejectedCommand | null {
    if (!this.#helpsAvailable(game)[help]) return this.#reject("HELP_USED", "terminal", "That help has already been used");
    if (active.help_used !== null) return this.#reject("HELP_ALREADY_USED", "terminal", "You already used a help on this question");
    return null;
  }

  #helpProposal(
    requestId: string,
    game: RulesetGameRecord,
    active: RulesetAttemptSnapshot,
    help: "poll" | "ask",
    payload: Readonly<Record<string, unknown>>,
  ): CommandProposal<RulesetGameRecord, LifecycleOutcome> {
    const helpsUsed = Object.freeze({ ...game.snapshot.helps_used, [help]: true });
    const updatedActive = Object.freeze({
      ...active,
      help_used: help,
      help_result: Object.freeze({ type: help, ...payload }),
      momentum_eligible: false,
    });
    const snapshot = Object.freeze({ ...game.snapshot, active: updatedActive, helps_used: helpsUsed });
    const next = Object.freeze({ ...game, helpsUsed, snapshot });
    return {
      state: next,
      eventType: `help_${help}_used`,
      eventPayload: { ...payload, momentum_eligible: false },
      followingEvents: [{
        eventType: `help_${help}_result`,
        eventPayload: payload,
        actorKind: "system",
        actorId: "system",
      }],
      outcome: (event) => Object.freeze({ ok: true as const, requestId, serverSeq: event.serverSeq }),
      apply: (state, event, _outcome, events) => {
        this.#game = state;
        const resultEvent = events.find((candidate) => candidate.eventType === `help_${help}_result`);
        this.#publish(Object.freeze({
          type: `help_${help}_result` as "help_poll_result" | "help_ask_result",
          serverSeq: resultEvent?.serverSeq ?? event.serverSeq,
          payload,
        }));
      },
    };
  }

  #helpsAvailable(game: RulesetGameRecord): Readonly<{ poll: boolean; ask: boolean; trust: boolean }> {
    const used = game.snapshot.helps_used ?? game.helpsUsed;
    const limits = game.snapshot.settings.helps_per_game;
    return Object.freeze({
      poll: limits.poll > 0 && !used.poll,
      ask: limits.ask > 0 && !used.ask,
      trust: limits.trust > 0 && !used.trust,
    });
  }

  #settings(session: RulesetSessionRecord): Ruleset1v100Settings | SettingsValidationError | null {
    try {
      const settings = parseSettingsJson(session.settingsJson);
      return isRuleset1v100(settings) ? settings : null;
    } catch (error) {
      return error instanceof SettingsValidationError ? error : new SettingsValidationError("Settings could not be loaded");
    }
  }

  #roles(players: readonly RulesetPlayer[], oneId: string): readonly Readonly<{ playerId: string; role: "one" | "mob" }>[] {
    return Object.freeze(players.map((player) => Object.freeze({
      playerId: player.id,
      role: player.id === oneId ? "one" as const : "mob" as const,
    })));
  }

  #gameStartPayload(
    game: RulesetGameRecord,
    one: RulesetPlayer,
    players: readonly RulesetPlayer[],
    settings: Ruleset1v100Settings,
  ): Readonly<Record<string, unknown>> {
    return Object.freeze({
      game_id: game.gameId,
      ordinal: game.ordinal,
      one: Object.freeze({ id: one.id, nickname: one.nickname }),
      mob_count: Math.max(0, players.length - 1),
      deck_size: game.deckSize,
      base_strikes: settings.base_strikes,
      momentum_enabled: settings.momentum_enabled,
    });
  }

  #phaseAQuestionPayload(active: RulesetAttemptSnapshot): Readonly<Record<string, unknown>> {
    return Object.freeze({
      attempt_id: active.attempt_id,
      question_id: active.question_id,
      index: active.index,
      prompt: active.prompt,
      choices: active.choices,
      started_at_ms: active.started_at_ms,
      deadline_ms: active.deadline_ms,
    });
  }

  #phaseAStatusPayload(active: RulesetAttemptSnapshot, lockedCount: number): Readonly<Record<string, unknown>> {
    return Object.freeze({
      index: active.index,
      locked_count: lockedCount,
      eligible_count: active.eligible_player_ids.length,
      deadline_ms: active.deadline_ms,
      momentum: Object.freeze({
        enabled: this.#game?.snapshot.settings.momentum_enabled ?? false,
        progress: this.#game?.snapshot.momentum.progress ?? 0,
      }),
    });
  }

  #phaseBPayload(active: RulesetAttemptSnapshot, game: RulesetGameRecord): Readonly<Record<string, unknown>> {
    return Object.freeze({
      attempt_id: active.attempt_id,
      question_id: active.question_id,
      index: active.index,
      prompt: active.prompt,
      choices: active.choices,
      started_at_ms: active.phase_b_started_at_ms,
      helps_available: this.#helpsAvailable(game),
      bank: game.bank,
      strikes: game.strikesRemaining,
      momentum: Object.freeze({
        enabled: game.snapshot.settings.momentum_enabled,
        progress: game.snapshot.momentum.progress,
      }),
    });
  }

  #momentumReveal(
    game: RulesetGameRecord,
    active: RulesetAttemptSnapshot,
    players: readonly RulesetPlayer[],
    oneCorrect: boolean,
    strikesRemaining: number,
  ): MomentumReveal {
    if (!game.snapshot.settings.momentum_enabled) {
      return Object.freeze({
        fastWindowMs: null,
        windowLog: null,
        state: game.snapshot.momentum,
        strikesRemaining,
        progressPayload: null,
        filledPayload: null,
      });
    }
    const roles = new Map(players.map((player) => [player.id, player.role]));
    const window = computeMomentumFastWindow({
      answers: active.answers.map((answer) => ({
        choice: answer.choice,
        receiveDurationMs: answer.receive_duration_ms,
        role: roles.get(answer.player_id) === "mob" ? "mob" : "crowd",
      })),
      correctChoice: active.correct_choice,
      fastK: game.snapshot.settings.momentum_fast_k,
      windowMinMs: game.snapshot.settings.momentum_window_min_ms,
      windowMaxMs: game.snapshot.settings.momentum_window_max_ms,
    });
    const windowLog = Object.freeze({
      correct_mob_durations_ms: window.correctMobDurationsMs,
      selected_durations_ms: window.selectedDurationsMs,
      selected_count: window.selectedCount,
      mean_ms: window.meanMs,
      fast_k: window.fastK,
      window_min_ms: window.windowMinMs,
      window_max_ms: window.windowMaxMs,
      fast_window_ms: window.fastWindowMs,
      fallback: window.fallback,
    });
    const credited = oneCorrect && active.momentum_eligible && active.help_used === null &&
      active.one_duration_ms !== null && active.one_duration_ms <= window.fastWindowMs;
    const reason = !oneCorrect
      ? "one_wrong"
      : !active.momentum_eligible || active.help_used !== null
        ? "help_used"
        : active.one_duration_ms === null || active.one_duration_ms > window.fastWindowMs
          ? "too_slow"
          : "fast_correct";
    const progress = game.snapshot.momentum.progress + (credited ? 1 : 0);
    const filled = credited && !game.snapshot.momentum.awarded_once &&
      progress >= game.snapshot.settings.momentum_threshold;
    const nextStrikes = strikesRemaining + (filled ? 1 : 0);
    const state = Object.freeze({
      progress,
      awarded_once: game.snapshot.momentum.awarded_once || filled,
    });
    const progressPayload = Object.freeze({
      progress,
      threshold: game.snapshot.settings.momentum_threshold,
      credited,
      reason,
    });
    const filledPayload = filled ? Object.freeze({
      progress,
      threshold: game.snapshot.settings.momentum_threshold,
      strikes_remaining: nextStrikes,
      awarded_once: true,
    }) : null;
    return Object.freeze({
      fastWindowMs: window.fastWindowMs,
      windowLog,
      state,
      strikesRemaining: nextStrikes,
      progressPayload,
      filledPayload,
    });
  }

  #phaseBActiveDurationMs(active: RulesetAttemptSnapshot): number {
    return Math.max(0, active.one_duration_ms ?? 0) +
      Math.max(0, this.#monotonicNow() - this.#phaseBStartedMonotonicMs);
  }

  // Teacher-gated exposure: locking Phase A HOLDS at PHASE_A_LOCKED; the
  // question reaches The One only when the teacher advances (startPhaseB).
  #phaseBTransition(game: RulesetGameRecord): PhaseBTransition {
    const snapshot: RulesetGameSnapshot = Object.freeze({
      ...game.snapshot,
      phase: "PHASE_A_LOCKED" as const,
    });
    const next = Object.freeze({ ...game, snapshot });
    return Object.freeze({
      game: next,
      eventType: null,
      eventPayload: null,
      exposedAtMs: null,
    });
  }

  #publishPhaseBTransition(transition: PhaseBTransition, serverSeq: number): void {
    const payload = transition.eventPayload;
    if (transition.eventType === null || payload === null) return;
    if (transition.eventType === "pause_state") {
      this.#publish(Object.freeze({
        type: "pause_state",
        serverSeq,
        payload,
      }));
      return;
    }
    this.#phaseBStartedMonotonicMs = this.#monotonicNow();
    this.#publish(Object.freeze({
      type: "phase_b_start",
      serverSeq,
      payload,
    }));
  }

  #pauseReason(reasons: RulesetGameSnapshot["pause_reasons"]): string {
    if (reasons.one_kicked) return "one_kicked";
    if (reasons.one_disconnected) return "one_disconnected";
    return reasons.teacher === null ? "teacher" : "teacher";
  }

  #reject(code: string, disposition: "terminal" | "transient", message?: string): Readonly<{
    code: string;
    disposition: "terminal" | "transient";
    message?: string;
  }> {
    return Object.freeze({ code, disposition, ...(message === undefined ? {} : { message }) });
  }
}
