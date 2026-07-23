import type { AppDatabase } from "./db.js";

export type ActorKind = "system" | "teacher" | "player";

export type NewGameEvent = Readonly<{
  sessionId: string;
  gameId: string | null;
  attemptId: string | null;
  eventType: string;
  actorKind: ActorKind;
  actorId: string | null;
  requestId: string | null;
  payload: unknown;
  createdAtMs: number;
}>;

export type StoredGameEvent = Readonly<{
  eventId: number;
  sessionId: string;
  gameId: string | null;
  serverSeq: number;
  attemptId: string | null;
  eventType: string;
  actorKind: ActorKind | "organizer";
  actorId: string | null;
  requestId: string | null;
  payload: unknown;
  createdAtMs: number;
}>;

type GameEventRow = {
  event_id: number;
  session_id: string;
  game_id: string | null;
  server_seq: number;
  attempt_id: string | null;
  event_type: string;
  actor_kind: ActorKind;
  actor_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at_ms: number;
};

function fromRow(row: GameEventRow): StoredGameEvent {
  return Object.freeze({
    eventId: row.event_id,
    sessionId: row.session_id,
    gameId: row.game_id,
    serverSeq: row.server_seq,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    requestId: row.request_id,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAtMs: row.created_at_ms,
  });
}

export class GameEventStore {
  readonly #database: AppDatabase;
  readonly #appendTransaction: (event: NewGameEvent) => StoredGameEvent;

  constructor(database: AppDatabase) {
    this.#database = database;
    this.#appendTransaction = database.transaction((event: NewGameEvent) => {
      if (event.requestId !== null && event.actorId !== null) {
        const existing = this.#findRequest(
          event.sessionId,
          event.actorKind,
          event.actorId,
          event.requestId,
        );
        if (existing !== undefined) {
          return existing;
        }
      }

      const sequence = database
        .prepare(
          `UPDATE sessions SET last_server_seq = last_server_seq + 1
           WHERE session_id = ? RETURNING last_server_seq`,
        )
        .get(event.sessionId) as { last_server_seq: number } | undefined;
      if (sequence === undefined) {
        throw new Error(`Unknown session: ${event.sessionId}`);
      }
      const result = database
        .prepare(
          `INSERT INTO game_events
            (session_id, game_id, server_seq, attempt_id, event_type, actor_kind,
             actor_id, request_id, payload_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.sessionId,
          event.gameId,
          sequence.last_server_seq,
          event.attemptId,
          event.eventType,
          event.actorKind,
          event.actorId,
          event.requestId,
          JSON.stringify(event.payload),
          event.createdAtMs,
        );
      return this.#byId(Number(result.lastInsertRowid));
    });
  }

  append(event: NewGameEvent): StoredGameEvent {
    return this.#appendTransaction(event);
  }

  readSession(sessionId: string): StoredGameEvent[] {
    return this.#database
      .prepare("SELECT * FROM game_events WHERE session_id = ? ORDER BY server_seq")
      .all(sessionId)
      .map((row) => fromRow(row as GameEventRow));
  }

  #findRequest(
    sessionId: string,
    actorKind: ActorKind,
    actorId: string,
    requestId: string,
  ): StoredGameEvent | undefined {
    const row = this.#database
      .prepare(
         `SELECT * FROM game_events
          WHERE session_id = ? AND actor_kind = ? AND actor_id = ? AND request_id = ?
            AND event_type != 'command_rejected'`,
      )
      .get(sessionId, actorKind, actorId, requestId) as GameEventRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  #byId(eventId: number): StoredGameEvent {
    const row = this.#database
      .prepare("SELECT * FROM game_events WHERE event_id = ?")
      .get(eventId) as GameEventRow | undefined;
    if (row === undefined) {
      throw new Error(`Missing inserted event: ${eventId}`);
    }
    return fromRow(row);
  }
}
