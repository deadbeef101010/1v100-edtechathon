import { createHash } from "node:crypto";

import type { AppDatabase } from "./db.js";
import { createSilentLogger, type ServerLogger } from "./log.js";
import {
  GameEventStore,
  type ActorKind,
  type NewGameEvent,
  type StoredGameEvent,
} from "./game-event-store.js";

export type CommandError = Readonly<{
  ok: false;
  requestId: string;
  code: string;
  message?: string;
}>;

export type CommandSuccess = Readonly<{
  ok: true;
  requestId: string;
  serverSeq: number;
}>;

export type CommandOutcome = CommandSuccess | CommandError;

type StoredRequestRow = {
  command_type: string;
  payload_fingerprint: string;
  attempt_id?: string | null;
};

type StoredOutcomeRow = {
  outcome_json: string;
  attempt_id?: string | null;
};

type ProposalEvent = Readonly<{
  eventType: string;
  eventPayload: unknown;
  actorKind: ActorKind;
  actorId: string;
  gameId?: string | null;
  attemptId?: string | null;
}>;

export type CommandProposal<State, Outcome extends CommandOutcome> = Readonly<{
  state: State;
  eventType: string;
  eventPayload: unknown;
  gameId?: string | null;
  attemptId?: string | null;
  priorEvents?: readonly ProposalEvent[];
  followingEvents?: readonly ProposalEvent[];
  outcome: (event: StoredGameEvent) => Outcome;
  persist?: () => void;
  apply: (
    state: State,
    event: StoredGameEvent,
    outcome: Outcome,
    events: readonly StoredGameEvent[],
  ) => void;
}>;

export type RejectedCommand = Readonly<{
  code: string;
  message?: string;
  disposition: "terminal" | "transient";
}>;

export type CommandIdentity = Readonly<{
  sessionId: string;
  commandType: string;
  actorKind: ActorKind;
  actorId: string;
  requestId: string;
  payload: unknown;
}>;

type MetaCommandIdentity = Readonly<{
  scope: "meta";
  commandType: string;
  actorKind: "organizer";
  actorId: string;
  requestId: string;
  payload: unknown;
}>;

type TeacherCommandIdentity = Readonly<{
  scope: "teacher";
  teacherId: string;
  commandType: string;
  actorKind: "teacher";
  actorId: string;
  requestId: string;
  payload: unknown;
}>;

export type CommandRequest<State, Outcome extends CommandOutcome> = Readonly<{
  sessionId: string;
  gameId?: string | null;
  attemptId?: string | null;
  commandType: string;
  actorKind: ActorKind;
  actorId: string;
  requestId: string;
  payload: unknown;
  createdAtMs: number;
  prepare?: () => void;
  propose: () => CommandProposal<State, Outcome> | RejectedCommand;
}>;

export type MetaCommandRequest<State, Outcome extends CommandOutcome> = Readonly<{
  scope: "meta";
  commandType: string;
  actorKind: "organizer";
  actorId: string;
  requestId: string;
  payload: unknown;
  createdAtMs: number;
  propose: () => CommandProposal<State, Outcome> | RejectedCommand;
}>;

export type TeacherCommandRequest<State, Outcome extends CommandOutcome> = Readonly<{
  scope: "teacher";
  teacherId: string;
  commandType: string;
  actorKind: "teacher";
  actorId: string;
  requestId: string;
  payload: unknown;
  createdAtMs: number;
  propose: () => CommandProposal<State, Outcome> | RejectedCommand;
}>;

type AnyCommandRequest<State, Outcome extends CommandOutcome> =
  | CommandRequest<State, Outcome>
  | MetaCommandRequest<State, Outcome>
  | TeacherCommandRequest<State, Outcome>;

function isMetaRequest<State, Outcome extends CommandOutcome>(
  request: AnyCommandRequest<State, Outcome>,
): request is MetaCommandRequest<State, Outcome> {
  return "scope" in request && request.scope === "meta";
}

function isTeacherRequest<State, Outcome extends CommandOutcome>(
  request: AnyCommandRequest<State, Outcome>,
): request is TeacherCommandRequest<State, Outcome> {
  return "scope" in request && request.scope === "teacher";
}

function isSessionRequest<State, Outcome extends CommandOutcome>(
  request: AnyCommandRequest<State, Outcome>,
): request is CommandRequest<State, Outcome> {
  return !("scope" in request);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

export function payloadFingerprint(commandType: string, payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ commandType, payload }))
    .digest("hex");
}

function isRejected<State, Outcome extends CommandOutcome>(
  proposal: CommandProposal<State, Outcome> | RejectedCommand,
): proposal is RejectedCommand {
  return "code" in proposal;
}

export class CommandCoordinator {
  readonly #database: AppDatabase;
  readonly #store: GameEventStore;
  readonly #logger: ServerLogger;

  constructor(
    database: AppDatabase,
    store = new GameEventStore(database),
    logger: ServerLogger = createSilentLogger(),
  ) {
    this.#database = database;
    this.#store = store;
    this.#logger = logger;
  }

  execute<State, Outcome extends CommandOutcome>(
    request: AnyCommandRequest<State, Outcome>,
  ): Outcome {
    if (request.actorId.length === 0) {
      throw new Error("Commands require a non-empty actor_id");
    }
    const fingerprint = payloadFingerprint(request.commandType, request.payload);
    const replay = this.replay<Outcome>(request);
    if (replay !== undefined) return replay;

    let committed:
      | Readonly<{
          proposal: CommandProposal<State, Outcome>;
          event: StoredGameEvent;
          events: readonly StoredGameEvent[];
          outcome: Outcome;
        }>
      | undefined;
    const transaction = this.#database.transaction((): Outcome => {
      const raced = this.replay<Outcome>(request);
      if (raced !== undefined) return raced;
      if (isSessionRequest(request)) {
        this.#insertRequest(request, fingerprint);
        request.prepare?.();
      }

      const proposed = request.propose();
      if (isRejected(proposed)) {
        const outcome = Object.freeze({
          ok: false,
          requestId: request.requestId,
          code: proposed.code,
          ...(proposed.message === undefined ? {} : { message: proposed.message }),
        }) as Outcome;
        const event = this.#append(request, "command_rejected", {
          command_type: request.commandType,
          code: proposed.code,
          request_id: request.requestId,
          disposition: proposed.disposition,
        }, proposed.disposition === "terminal" ? request.requestId : null);
        if (proposed.disposition === "terminal") {
          this.#insertOutcome(request, outcome, event.eventId);
        }
        return outcome;
      }

       const appendProposalEvent = (proposalEvent: ProposalEvent): StoredGameEvent => {
         if (!isSessionRequest(request)) {
           throw new Error("Scoped commands do not support additional session events");
         }
         return this.#store.append({
           sessionId: request.sessionId,
           gameId: proposalEvent.gameId ?? request.gameId ?? null,
           attemptId: proposalEvent.attemptId ?? request.attemptId ?? null,
           eventType: proposalEvent.eventType,
           actorKind: proposalEvent.actorKind,
           actorId: proposalEvent.actorId,
           requestId: null,
           payload: proposalEvent.eventPayload,
           createdAtMs: request.createdAtMs,
         });
       };
       const events = (proposed.priorEvents ?? []).map(appendProposalEvent);
       const event = this.#append(
         request,
         proposed.eventType,
         proposed.eventPayload,
         request.requestId,
         proposed.gameId,
         proposed.attemptId,
       );
       events.push(event);
       events.push(...(proposed.followingEvents ?? []).map(appendProposalEvent));
      proposed.persist?.();
      const outcome = Object.freeze(proposed.outcome(event)) as Outcome;
      this.#insertOutcome(request, outcome, event.eventId);
      committed = Object.freeze({ proposal: proposed, event, events: Object.freeze(events), outcome });
      return outcome;
    });

    const outcome = transaction();
    if (committed !== undefined) {
      committed.proposal.apply(
        committed.proposal.state,
        committed.event,
        committed.outcome,
        committed.events,
      );
    }
    return outcome;
  }

  replay<Outcome extends CommandOutcome>(
    request: CommandIdentity | MetaCommandIdentity | TeacherCommandIdentity,
  ): Outcome | undefined {
    if (request.actorId.length === 0) {
      throw new Error("Commands require a non-empty actor_id");
    }
    const fingerprint = payloadFingerprint(request.commandType, request.payload);
    const scoped = "scope" in request;
    const storedRequest = !scoped
      ? this.#storedRequest(request.sessionId, request.actorId, request.requestId)
      : request.scope === "meta"
        ? this.#storedMetaOutcome(request.actorId, request.requestId)
        : this.#storedTeacherOutcome(request.teacherId, request.actorId, request.requestId);
    if (storedRequest === undefined) return undefined;
    const outcome = !scoped
      ? this.#storedOutcome(request.sessionId, request.actorId, request.requestId)
      : request.scope === "meta"
        ? this.#storedMetaOutcome(request.actorId, request.requestId)
        : this.#storedTeacherOutcome(request.teacherId, request.actorId, request.requestId);
    const requestedAttempt = typeof request.payload === "object" && request.payload !== null &&
      "attempt_id" in request.payload && typeof request.payload.attempt_id === "string"
      ? request.payload.attempt_id
      : undefined;
    const legacyAdvanceMatches = request.commandType === "advance" &&
      storedRequest.command_type === "advance" &&
      storedRequest.payload_fingerprint === payloadFingerprint("advance", {}) &&
      requestedAttempt !== undefined && storedRequest.attempt_id === requestedAttempt;
    if (
      !legacyAdvanceMatches && (
        storedRequest.command_type !== request.commandType ||
        storedRequest.payload_fingerprint !== fingerprint
      )
    ) {
      this.#logRequestMismatch(request);
      return Object.freeze({
        ok: false,
        requestId: request.requestId,
        code: "REQUEST_MISMATCH",
      }) as Outcome;
    }
    return outcome === undefined
      ? undefined
      : Object.freeze(JSON.parse(outcome.outcome_json) as Outcome);
  }

  #append<State, Outcome extends CommandOutcome>(
    request: AnyCommandRequest<State, Outcome>,
    eventType: string,
    payload: unknown,
    requestId: string | null = request.requestId,
    gameId?: string | null,
    attemptId?: string | null,
  ): StoredGameEvent {
    if (isMetaRequest(request)) {
      const sequence = this.#database
        .prepare(
          `UPDATE meta_state SET last_server_seq = last_server_seq + 1
           WHERE singleton = 1 RETURNING last_server_seq`,
        )
        .get() as { last_server_seq: number };
      const result = this.#database
        .prepare(
          `INSERT INTO meta_events
            (server_seq, event_type, actor_kind, actor_id, request_id, payload_json, created_at_ms)
           VALUES (?, ?, 'organizer', ?, ?, ?, ?)`,
        )
        .run(
          sequence.last_server_seq,
          eventType,
          request.actorId,
          request.requestId,
          JSON.stringify(payload),
          request.createdAtMs,
        );
      return Object.freeze({
        eventId: Number(result.lastInsertRowid),
        sessionId: "meta",
        gameId: null,
        serverSeq: sequence.last_server_seq,
        attemptId: null,
        eventType,
        actorKind: "organizer",
        actorId: request.actorId,
        requestId: request.requestId,
        payload,
        createdAtMs: request.createdAtMs,
      });
    }
    if (isTeacherRequest(request)) {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO teacher_command_state (teacher_id, last_server_seq)
           VALUES (?, 0)`,
        )
        .run(request.teacherId);
      const sequence = this.#database
        .prepare(
          `UPDATE teacher_command_state SET last_server_seq = last_server_seq + 1
           WHERE teacher_id = ? RETURNING last_server_seq`,
        )
        .get(request.teacherId) as { last_server_seq: number };
      const result = this.#database
        .prepare(
          `INSERT INTO teacher_events
            (teacher_id, server_seq, event_type, actor_kind, actor_id, request_id,
             payload_json, created_at_ms)
           VALUES (?, ?, ?, 'teacher', ?, ?, ?, ?)`,
        )
        .run(
          request.teacherId,
          sequence.last_server_seq,
          eventType,
          request.actorId,
          request.requestId,
          JSON.stringify(payload),
          request.createdAtMs,
        );
      return Object.freeze({
        eventId: Number(result.lastInsertRowid),
        sessionId: `teacher:${request.teacherId}`,
        gameId: null,
        serverSeq: sequence.last_server_seq,
        attemptId: null,
        eventType,
        actorKind: "teacher",
        actorId: request.actorId,
        requestId: request.requestId,
        payload,
        createdAtMs: request.createdAtMs,
      });
    }
    const event: NewGameEvent = {
      sessionId: request.sessionId,
       gameId: gameId ?? request.gameId ?? null,
       attemptId: attemptId ?? request.attemptId ?? null,
      eventType,
      actorKind: request.actorKind,
      actorId: request.actorId,
      requestId,
      payload,
      createdAtMs: request.createdAtMs,
    };
    return this.#store.append(event);
  }

  #storedRequest(sessionId: string, actorId: string, requestId: string): StoredRequestRow | undefined {
    return this.#database
      .prepare(
        `SELECT requests.command_type, requests.payload_fingerprint,
                (SELECT events.attempt_id FROM game_events events
                 WHERE events.session_id = requests.session_id
                   AND events.actor_id = requests.actor_id
                   AND events.request_id = requests.request_id
                 ORDER BY events.event_id LIMIT 1) AS attempt_id
         FROM command_requests requests
         WHERE requests.session_id = ? AND requests.actor_id = ? AND requests.request_id = ?`,
      )
      .get(sessionId, actorId, requestId) as StoredRequestRow | undefined;
  }

  #storedMetaOutcome(actorId: string, requestId: string): (StoredRequestRow & StoredOutcomeRow) | undefined {
    return this.#database
      .prepare(
        `SELECT command_type, payload_fingerprint, outcome_json
         FROM meta_command_outcomes WHERE actor_id = ? AND request_id = ?`,
      )
      .get(actorId, requestId) as (StoredRequestRow & StoredOutcomeRow) | undefined;
  }

  #storedTeacherOutcome(
    teacherId: string,
    actorId: string,
    requestId: string,
  ): (StoredRequestRow & StoredOutcomeRow) | undefined {
    return this.#database
      .prepare(
        `SELECT command_type, payload_fingerprint, outcome_json
         FROM teacher_command_outcomes
         WHERE teacher_id = ? AND actor_id = ? AND request_id = ?`,
      )
      .get(teacherId, actorId, requestId) as (StoredRequestRow & StoredOutcomeRow) | undefined;
  }

  #storedOutcome(sessionId: string, actorId: string, requestId: string): StoredOutcomeRow | undefined {
    return this.#database
      .prepare(
        `SELECT outcomes.outcome_json, events.attempt_id
         FROM command_outcomes outcomes
         JOIN game_events events ON events.event_id = outcomes.event_id
         WHERE outcomes.session_id = ? AND outcomes.actor_id = ? AND outcomes.request_id = ?`,
      )
      .get(sessionId, actorId, requestId) as StoredOutcomeRow | undefined;
  }

  #insertRequest<State, Outcome extends CommandOutcome>(
    request: CommandRequest<State, Outcome>,
    fingerprint: string,
  ): void {
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO command_requests
          (session_id, actor_id, request_id, command_type, payload_fingerprint, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.sessionId,
        request.actorId,
        request.requestId,
        request.commandType,
        fingerprint,
        request.createdAtMs,
      );
  }

  #insertOutcome<State, Outcome extends CommandOutcome>(
    request: AnyCommandRequest<State, Outcome>,
    outcome: Outcome,
    eventId: number,
  ): void {
    if (isMetaRequest(request)) {
      this.#database
        .prepare(
          `INSERT INTO meta_command_outcomes
            (actor_id, request_id, command_type, payload_fingerprint,
             outcome_json, event_id, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.actorId,
          request.requestId,
          request.commandType,
          payloadFingerprint(request.commandType, request.payload),
          JSON.stringify(outcome),
          eventId,
          request.createdAtMs,
        );
      return;
    }
    if (isTeacherRequest(request)) {
      this.#database
        .prepare(
          `INSERT INTO teacher_command_outcomes
            (teacher_id, actor_id, request_id, command_type, payload_fingerprint,
             outcome_json, event_id, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.teacherId,
          request.actorId,
          request.requestId,
          request.commandType,
          payloadFingerprint(request.commandType, request.payload),
          JSON.stringify(outcome),
          eventId,
          request.createdAtMs,
        );
      return;
    }
    const sessionRequest = request as CommandRequest<State, Outcome>;
    this.#database
      .prepare(
        `INSERT INTO command_outcomes
          (session_id, actor_id, request_id, command_type, payload_fingerprint,
           outcome_json, event_id, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionRequest.sessionId,
        sessionRequest.actorId,
        sessionRequest.requestId,
        sessionRequest.commandType,
        payloadFingerprint(sessionRequest.commandType, sessionRequest.payload),
        JSON.stringify(outcome),
        eventId,
        sessionRequest.createdAtMs,
      );
  }

  #logRequestMismatch(
    request: CommandIdentity | MetaCommandIdentity | TeacherCommandIdentity,
  ): void {
    this.#logger.warn("command_request_mismatch", {
      ...("scope" in request ? {} : { sessionId: request.sessionId }),
      actor: {
        kind: request.actorKind === "organizer"
          ? "meta"
          : request.actorKind === "player"
            ? "player"
            : request.actorKind,
        id: request.actorId,
      },
      detail: { command: request.commandType, request_id: request.requestId },
    });
  }
}
