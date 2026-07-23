import type { AppDatabase } from "./db.js";
import type {
  RulesetGameRecord,
  RulesetPlayer,
  RulesetRepository,
  RulesetSessionRecord,
} from "./engine/one-v-100-engine.js";
import type { ScoringPlayer } from "./engine/one-v-100-scoring.js";

type PlayerRow = {
  player_id: string;
  nickname: string;
  role: "one" | "mob" | "crowd";
  points: number;
  streak: number;
  has_been_one: number;
  joined_at_ms: number;
};

export class SqliteRulesetRepository implements RulesetRepository {
  readonly #database: AppDatabase;

  constructor(database: AppDatabase) {
    this.#database = database;
  }

  session(sessionId: string): RulesetSessionRecord | undefined {
    const row = this.#database.prepare(
      `SELECT session_id, teacher_id, status, last_server_seq, settings_json, settings_revision,
              deck_start_position,
              (SELECT COUNT(*) FROM questions WHERE question_set_id = sessions.question_set_id) AS question_count
       FROM sessions WHERE session_id = ?`,
    ).get(sessionId) as {
      session_id: string;
      teacher_id: string;
      status: "lobby" | "live" | "ended";
      last_server_seq: number;
      settings_json: string;
      settings_revision: number;
      deck_start_position: number;
      question_count: number;
    } | undefined;
    return row === undefined ? undefined : Object.freeze({
      sessionId: row.session_id,
      teacherId: row.teacher_id,
      status: row.status,
      lastServerSeq: row.last_server_seq,
      settingsJson: row.settings_json,
      settingsRevision: row.settings_revision,
      deckStartPosition: row.deck_start_position,
      questionCount: row.question_count,
    });
  }

  players(sessionId: string): readonly RulesetPlayer[] {
    const rows = this.#database.prepare(
      `SELECT player_id, nickname, role, points, streak, has_been_one, joined_at_ms
       FROM session_players
       WHERE session_id = ? AND kicked_at_ms IS NULL
       ORDER BY joined_at_ms, player_id`,
    ).all(sessionId) as PlayerRow[];
    return Object.freeze(rows.map((row) => Object.freeze({
      id: row.player_id,
      nickname: row.nickname,
      role: row.role,
      points: row.points,
      streak: row.streak,
      hasBeenOne: row.has_been_one === 1,
      joinedAtMs: row.joined_at_ms,
    })));
  }

  scoringPlayers(sessionId: string, playerIds: readonly string[]): readonly ScoringPlayer[] {
    if (playerIds.length === 0) return Object.freeze([]);
    const rows = this.#database.prepare(
      `SELECT player_id, role, points, streak FROM session_players
       WHERE session_id = ? AND player_id IN (${playerIds.map(() => "?").join(", ")})`,
    ).all(sessionId, ...playerIds) as Array<{
      player_id: string;
      role: "one" | "mob" | "crowd";
      points: number;
      streak: number;
    }>;
    return Object.freeze(rows.map((row) => Object.freeze({
      id: row.player_id,
      role: row.role,
      points: row.points,
      streak: row.streak,
    })));
  }

  latestGame(sessionId: string): RulesetGameRecord | undefined {
    const row = this.#database.prepare(
       `SELECT game_id, ordinal, one_player_id, status, end_reason, deck_start_position,
               deck_size, question_offset, strikes_remaining, bank_points, snapshot_json,
               momentum_progress, momentum_awarded,
               phase_b_exposed_at_ms, help_poll_used, help_ask_used, help_trust_used
       FROM games WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(sessionId) as {
      game_id: string;
      ordinal: number;
      one_player_id: string;
      status: "live" | "ended";
      end_reason: "flameout" | "deck_survived" | "mob_emptied" | null;
      deck_start_position: number;
      deck_size: number;
      question_offset: number;
      strikes_remaining: number;
      bank_points: number;
      snapshot_json: string;
      momentum_progress: number;
      momentum_awarded: number;
      phase_b_exposed_at_ms: number | null;
      help_poll_used: number;
      help_ask_used: number;
      help_trust_used: number;
    } | undefined;
    if (row === undefined) return undefined;
    const parsedSnapshot = JSON.parse(row.snapshot_json) as RulesetGameRecord["snapshot"];
    const helpsUsed = Object.freeze({
      poll: row.help_poll_used === 1,
      ask: row.help_ask_used === 1,
      trust: row.help_trust_used === 1,
    });
    const storedSnapshot = Object.freeze({
      ...parsedSnapshot,
      paused_from: parsedSnapshot.paused_from ?? null,
      pause_remaining_ms: parsedSnapshot.pause_remaining_ms ?? null,
      pause_reasons: parsedSnapshot.pause_reasons ?? Object.freeze({
        teacher: parsedSnapshot.paused_reason === null ? null : parsedSnapshot.paused_reason,
        one_disconnected: parsedSnapshot.paused_reason === "Waiting for The One to reconnect",
        one_kicked: parsedSnapshot.paused_reason === "one_kicked",
      }),
      helps_used: helpsUsed,
      momentum: Object.freeze({
        progress: parsedSnapshot.momentum?.progress ?? row.momentum_progress,
        awarded_once: parsedSnapshot.momentum?.awarded_once ?? row.momentum_awarded === 1,
      }),
      ...(parsedSnapshot.active === null ? {} : {
        active: Object.freeze({
          ...parsedSnapshot.active,
          help_used: parsedSnapshot.active.help_used ?? null,
          help_result: parsedSnapshot.active.help_result ?? null,
          momentum_eligible: parsedSnapshot.active.momentum_eligible ?? true,
        }),
      }),
    });
    const snapshot = row.phase_b_exposed_at_ms !== null && storedSnapshot.active !== null &&
      (storedSnapshot.phase === "PHASE_A" || storedSnapshot.phase === "PHASE_A_LOCKED")
      ? Object.freeze({
          ...storedSnapshot,
          phase: "PHASE_B" as const,
          paused_reason: null,
          active: Object.freeze({
            ...storedSnapshot.active,
            phase_b_started_at_ms: storedSnapshot.active.phase_b_started_at_ms ?? row.phase_b_exposed_at_ms,
          }),
        })
      : storedSnapshot;
    return Object.freeze({
      gameId: row.game_id,
      ordinal: row.ordinal,
      onePlayerId: row.one_player_id,
      status: row.status,
      endReason: row.end_reason,
      deckStartPosition: row.deck_start_position,
      deckSize: row.deck_size,
      questionOffset: row.question_offset,
      strikesRemaining: row.strikes_remaining,
      bank: row.bank_points,
      helpsUsed,
      snapshot,
    });
  }

  questionAt(sessionId: string, position: number): ReturnType<RulesetRepository["questionAt"]> {
    const row = this.#database.prepare(
      `SELECT q.question_id, q.prompt, q.choices_json, q.correct_choice, q.phase_a_seconds
       FROM questions q JOIN sessions s ON s.question_set_id = q.question_set_id
       WHERE s.session_id = ? AND q.position = ?`,
    ).get(sessionId, position) as {
      question_id: string;
      prompt: string;
      choices_json: string;
      correct_choice: number;
      phase_a_seconds: number | null;
    } | undefined;
    if (row === undefined) return undefined;
    const choices = JSON.parse(row.choices_json) as unknown;
    if (
      !Array.isArray(choices) ||
      (choices.length !== 3 && choices.length !== 4) ||
      !choices.every((choice) => typeof choice === "string" && choice.length > 0) ||
      !Number.isInteger(row.correct_choice) ||
      row.correct_choice < 0 ||
      row.correct_choice >= choices.length
    ) {
      throw new Error(`Question ${row.question_id} has invalid choices`);
    }
    return Object.freeze({
      id: row.question_id,
      prompt: row.prompt,
      choices: Object.freeze(choices),
      correctChoice: row.correct_choice,
      phaseASeconds: row.phase_a_seconds,
    });
  }

  startGame(input: Parameters<RulesetRepository["startGame"]>[0]): void {
    this.#database.prepare(
      `UPDATE session_players SET role = 'mob', streak = 0
       WHERE session_id = ? AND kicked_at_ms IS NULL`,
    ).run(input.sessionId);
    this.#database.prepare(
      `UPDATE session_players SET role = 'one', has_been_one = 1
       WHERE session_id = ? AND player_id = ? AND kicked_at_ms IS NULL`,
    ).run(input.sessionId, input.onePlayerId);
    this.#database.prepare(
      `UPDATE sessions SET status = 'live', started_at_ms = COALESCE(started_at_ms, ?)
       WHERE session_id = ?`,
    ).run(input.startedAtMs, input.sessionId);
    this.#database.prepare(
      `INSERT INTO games
        (game_id, session_id, ordinal, one_player_id, status, deck_start_position,
         deck_size, strikes_remaining, snapshot_seq, snapshot_json, started_at_ms)
       VALUES (?, ?, ?, ?, 'live', ?, ?, ?,
         (SELECT last_server_seq FROM sessions WHERE session_id = ?), ?, ?)`,
    ).run(
      input.gameId,
      input.sessionId,
      input.ordinal,
      input.onePlayerId,
      input.deckStartPosition,
      input.deckSize,
      input.strikesRemaining,
      input.sessionId,
      JSON.stringify(input.snapshot),
      input.startedAtMs,
    );
  }

  updateGameSnapshot(gameId: string, snapshot: RulesetGameRecord["snapshot"]): void {
    this.#database.prepare(
      `UPDATE games SET snapshot_json = ?,
         snapshot_seq = (SELECT last_server_seq FROM sessions WHERE session_id = games.session_id)
       WHERE game_id = ?`,
    ).run(JSON.stringify(snapshot), gameId);
  }

  applyHelp(input: Parameters<RulesetRepository["applyHelp"]>[0]): void {
    for (const award of input.pointAwards ?? []) {
      this.#database.prepare(
        "UPDATE session_players SET points = points + ? WHERE session_id = ? AND player_id = ?",
      ).run(award.points, input.sessionId, award.playerId);
    }
    this.#database.prepare(
      `UPDATE games SET snapshot_json = ?, help_poll_used = ?, help_ask_used = ?, help_trust_used = ?,
         snapshot_seq = (SELECT last_server_seq FROM sessions WHERE session_id = games.session_id)
       WHERE game_id = ?`,
    ).run(
      JSON.stringify(input.snapshot),
      input.helpsUsed.poll ? 1 : 0,
      input.helpsUsed.ask ? 1 : 0,
      input.helpsUsed.trust ? 1 : 0,
      input.gameId,
    );
  }

  updateGameProgress(input: Parameters<RulesetRepository["updateGameProgress"]>[0]): void {
    this.#database.prepare(
      `UPDATE games SET question_offset = ?, strikes_remaining = ?, bank_points = ?,
          snapshot_json = ?, phase_b_exposed_at_ms = ?,
          snapshot_seq = (SELECT last_server_seq FROM sessions WHERE session_id = games.session_id)
       WHERE game_id = ?`,
    ).run(
      input.questionOffset,
      input.strikesRemaining,
      input.bank,
      JSON.stringify(input.snapshot),
      input.phaseBExposedAtMs,
      input.gameId,
    );
    if (input.nextDeckPosition !== undefined) {
      this.#database.prepare(
        "UPDATE sessions SET deck_start_position = ? WHERE session_id = ?",
      ).run(input.nextDeckPosition, input.sessionId);
    }
  }

  applyReveal(input: Parameters<RulesetRepository["applyReveal"]>[0]): void {
    for (const player of input.players) {
      this.#database.prepare(
        `UPDATE session_players SET role = ?, points = ?, streak = ?
         WHERE session_id = ? AND player_id = ?`,
      ).run(player.role, player.points, player.streak, input.sessionId, player.id);
    }
    this.#database.prepare(
       `UPDATE games SET question_offset = ?, strikes_remaining = ?, bank_points = ?,
           status = ?, end_reason = ?, ended_at_ms = ?, snapshot_json = ?,
           momentum_progress = ?, momentum_awarded = ?,
           help_poll_used = ?, help_ask_used = ?, help_trust_used = ?,
           phase_b_exposed_at_ms = NULL,
          snapshot_seq = (SELECT last_server_seq FROM sessions WHERE session_id = games.session_id)
       WHERE game_id = ?`,
    ).run(
      input.questionOffset,
      input.strikesRemaining,
      input.bank,
      input.endReason === null ? "live" : "ended",
      input.endReason,
      input.endReason === null ? null : input.endedAtMs,
      JSON.stringify(input.snapshot),
      input.snapshot.momentum.progress,
      input.snapshot.momentum.awarded_once ? 1 : 0,
      input.helpsUsed.poll ? 1 : 0,
      input.helpsUsed.ask ? 1 : 0,
      input.helpsUsed.trust ? 1 : 0,
      input.gameId,
    );
    if (input.sessionEndedAtMs !== undefined) {
      this.endSession(input.sessionId, input.sessionEndedAtMs);
    }
  }

  endGame(input: Parameters<RulesetRepository["endGame"]>[0]): void {
    this.#database.prepare(
      `UPDATE games SET status = 'ended', end_reason = ?, ended_at_ms = ?, snapshot_json = ?,
         snapshot_seq = (SELECT last_server_seq FROM sessions WHERE session_id = games.session_id)
       WHERE game_id = ?`,
    ).run(input.reason, input.endedAtMs, JSON.stringify(input.snapshot), input.gameId);
  }

  endSession(sessionId: string, endedAtMs: number): void {
    this.#database.prepare(
      "UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?",
    ).run(endedAtMs, sessionId);
  }

  updateSettings(sessionId: string, settingsJson: string): number {
    const row = this.#database.prepare(
      `UPDATE sessions SET settings_json = ?, settings_revision = settings_revision + 1
       WHERE session_id = ? RETURNING settings_revision`,
    ).get(settingsJson, sessionId) as { settings_revision: number };
    return row.settings_revision;
  }
}
