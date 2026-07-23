import { timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { Server as SocketIoServer, type Socket } from "socket.io";

import {
  createPlayerToken,
  tokenHash,
  verifyPlayerToken,
  verifyProjectorToken,
  verifyTeacherToken,
} from "./auth.js";
import { CommandCoordinator } from "./command-coordinator.js";
import type { AppDatabase } from "./db.js";
import {
  answererRoom,
  ApplicationEmitter,
  emitApplicationPacket,
  EXCLUDE,
  oneRoom,
  playerRoom,
  projectorRoom,
  projectApplicationPacket,
  respondApplicationPacket,
  snapshotView,
  studentRoom,
  teacherRoom,
} from "./emitter.js";
import { GameEventStore, type StoredGameEvent } from "./game-event-store.js";
import { uuidV7 } from "./ids.js";
import { onTeacherRevoked } from "./meta-admin.js";
import { createSilentLogger, type LogActor, ServerLogger } from "./log.js";
import { nicknameIsAllowed, normalizeNickname, suggestNickname } from "./nickname-policy.js";
import {
  QuestionRound,
  type Question,
  type QuestionRoundBroadcast,
  type QuestionRoundSnapshot,
} from "./question-round.js";
import {
  normalizeSessionCode,
  rotateProjectorCredential,
  rotateSessionCode,
  sessionCodeHash,
  teacherSessionCode,
} from "./sessions.js";
import { attachQuestionSetToSession, openNextDeckQuestion } from "./session-deck.js";
import { OneV100Engine, type RulesetLifecycleEvent } from "./engine/one-v-100-engine.js";
import {
  applyTeacherSettingsPatch,
  isRuleset1v100,
  ONE_V_100_DEFAULT_SETTINGS,
  parseSettingsJson,
  SettingsValidationError,
} from "./engine/ruleset-settings.js";
import { randomUUID } from "node:crypto";
import { SqliteRulesetRepository } from "./ruleset-store.js";
import type { PresenceRegistry } from "./presence.js";

export type SocketGatewayOptions = {
  database: AppDatabase;
  tokenSecret: string;
  rounds?: Map<string, QuestionRound>;
  capacity?: number;
  rateLimitPerSecond?: number;
  preAuthRateLimitPerSecond?: number;
  wallNow?: () => number;
  monotonicNow?: () => number;
  logger?: ServerLogger;
  presence?: PresenceRegistry;
};

export type RosterEntry = Readonly<{
  player_id: string;
  nickname: string;
  connected: boolean;
  role: PlayerRole;
}>;

export type PlayerRole = "one" | "mob" | "crowd";

type JoinPayload = {
  code: string;
  nickname: string;
  request_id?: string;
  client_instance_id?: string;
};

type EnvelopePayload = Readonly<{ v: 1; payload: unknown }>;

type ProjectorAttachPayload = {
  projector_token: string;
};

type TeacherAttachPayload = {
  session_id: string;
};

type ResumePayload = {
  token?: string;
  player_token?: string;
  session_id?: string;
  request_id?: string;
  client_instance_id?: string;
  last_server_seq?: number;
};

type TeacherControlPayload = {
  request_id: string;
  attempt_id?: string;
  reason?: string;
  one_choice?: number;
};
type HelpPayload = { request_id: string; choice?: number };

type OpenQuestionPayload = {
  request_id: string;
  question_id?: string;
};

type AnswerPayload = {
  request_id: string;
  attempt_id?: string;
  question_id: string;
  choice: number;
};

type KickPlayerPayload = {
  request_id: string;
  player_id: string;
};

type AssignRolePayload = {
  request_id: string;
  player_id: string;
  role: string;
};

type EndSessionPayload = {
  request_id: string;
};

type RotateSessionCredentialPayload = {
  request_id: string;
};

type AttachQuestionSetPayload = {
  request_id: string;
  question_set_id: string;
};

type StartSessionPayload = { request_id: string; first_one_player_id: string };
type SelectNextOnePayload = { request_id: string; player_id: string };
type TeacherSettingsPayload = {
  request_id: string;
  phase_a_seconds?: number;
  base_strikes?: number;
  momentum_enabled?: boolean;
};

type Ack = (payload: unknown) => void;

type SocketPrincipal =
  | Readonly<{ role: "student"; sessionId: string; playerId: string }>
  | Readonly<{ role: "projector"; sessionId: string }>
  | Readonly<{ role: "teacher"; sessionId: string; teacherId: string }>;

type PayloadSchema<Payload> = (payload: unknown) => payload is Payload;

const PROTOCOL_ERROR = Object.freeze({ error: "protocol_error" });
const MAX_PAYLOAD_BYTES = 16 * 1_024;
const SESSION_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const UUID_V7_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_V7_PATTERN = new RegExp(`^${UUID_V7_SOURCE}$`, "i");
const PLAYER_TOKEN_PATTERN = new RegExp(
  `^p1\\.${UUID_V7_SOURCE}\\.[0-9]{1,16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`,
  "i",
);
const PROJECTOR_TOKEN_PATTERN = new RegExp(
  `^prj1\\.${UUID_V7_SOURCE}\\.[0-9]{1,16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`,
  "i",
);

export { answererRoom, oneRoom, playerRoom, projectorRoom, studentRoom, teacherRoom } from "./emitter.js";

type QuestionRow = {
  question_id: string;
  prompt: string;
  choices_json: string;
  correct_choice: number;
  phase_a_seconds: number | null;
};

function questionFromRow(row: QuestionRow): Question {
  const choices = JSON.parse(row.choices_json) as unknown;
  if (
    !Array.isArray(choices) ||
    choices.length < 3 ||
    choices.length > 4 ||
    !choices.every((choice) => typeof choice === "string") ||
    !Number.isInteger(row.correct_choice) ||
    row.correct_choice < 0 ||
    row.correct_choice >= choices.length
  ) {
    throw new Error(`Invalid question data: ${row.question_id}`);
  }
  return Object.freeze({
    id: row.question_id,
    prompt: row.prompt,
    choices: Object.freeze(choices),
    correctChoice: row.correct_choice,
  });
}

function eventPayload(event: StoredGameEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

export function replayRoundSnapshot(
  events: readonly StoredGameEvent[],
  loadQuestion: (questionId: string) => Question | undefined,
  monotonicNow: number,
  wallNow: number,
): QuestionRoundSnapshot | undefined {
  let snapshot: QuestionRoundSnapshot | undefined;
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.eventType === "question_open" && event.attemptId !== null) {
      const questionId = typeof payload.question_id === "string" ? payload.question_id : "";
      const persistedQuestion = loadQuestion(questionId);
      const choices = Array.isArray(payload.choices) && payload.choices.every((choice) => typeof choice === "string")
        ? payload.choices
        : persistedQuestion?.choices;
      const correctChoice = typeof payload.correct_choice === "number"
        ? payload.correct_choice
        : persistedQuestion?.correctChoice;
      const startedWallMs = typeof payload.started_at_ms === "number" ? payload.started_at_ms : event.createdAtMs;
      const deadlineWallMs = typeof payload.deadline_ms === "number" ? payload.deadline_ms : startedWallMs;
      const eligiblePlayerIds = Array.isArray(payload.eligible_player_ids)
        ? payload.eligible_player_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (choices === undefined || correctChoice === undefined || typeof payload.prompt !== "string") {
        continue;
      }
      const elapsedMs = Math.max(0, wallNow - startedWallMs);
      snapshot = Object.freeze({
        phase: "QUESTION_OPEN",
        active: Object.freeze({
          attemptId: event.attemptId,
          question: Object.freeze({ id: questionId, prompt: payload.prompt, choices, correctChoice }),
          startedMonotonicMs: monotonicNow - elapsedMs,
          deadlineMonotonicMs: monotonicNow + Math.max(0, deadlineWallMs - wallNow),
          startedWallMs,
          deadlineWallMs,
          eligiblePlayerIds: Object.freeze(eligiblePlayerIds),
        }),
        answers: Object.freeze([]),
        revealAck: null,
        pauseRemainingMs: null,
      });
      continue;
    }
    if (snapshot?.active === null || snapshot === undefined || event.attemptId !== snapshot.active.attemptId) {
      if (event.eventType === "session_ended") snapshot = undefined;
      continue;
    }
    if (event.eventType === "answer_accepted" && event.actorId !== null) {
      const choice = payload.choice;
      const receiveDuration = payload.receive_duration_ms;
      if (typeof choice === "number" && typeof receiveDuration === "number") {
        snapshot = Object.freeze({
          ...snapshot,
          answers: Object.freeze([
            ...snapshot.answers.filter((answer) => answer.playerId !== event.actorId),
            Object.freeze({
              playerId: event.actorId,
              choice,
              receivedAtMs: snapshot.active.startedMonotonicMs + receiveDuration,
            }),
          ]),
        });
      }
    } else if (event.eventType === "pause" && typeof payload.remaining_ms === "number") {
      snapshot = Object.freeze({ ...snapshot, phase: "PAUSED", pauseRemainingMs: payload.remaining_ms });
    } else if (event.eventType === "resume" && typeof payload.deadline_ms === "number") {
      const remainingMs = Math.max(0, payload.deadline_ms - wallNow);
      snapshot = Object.freeze({
        ...snapshot,
        phase: "QUESTION_OPEN",
        active: Object.freeze({
          ...snapshot.active,
          deadlineMonotonicMs: monotonicNow + remainingMs,
          deadlineWallMs: payload.deadline_ms,
        }),
        pauseRemainingMs: null,
      });
    } else if (event.eventType === "phase_a_locked") {
      snapshot = Object.freeze({ ...snapshot, phase: "LOCKED" });
    } else if (event.eventType === "reveal") {
      snapshot = Object.freeze({
        ...snapshot,
        phase: "REVEALED",
        revealAck: Object.freeze({
          ok: true,
          requestId: event.requestId ?? `restored-reveal:${event.attemptId ?? "round"}`,
          serverSeq: event.serverSeq,
        }),
      });
    } else if (event.eventType === "teacher_advance" || event.eventType === "session_ended") {
      snapshot = undefined;
    }
  }
  return snapshot;
}

function hashesMatch(expected: Buffer, supplied: Buffer): boolean {
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function isPlainObject(payload: unknown): payload is Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(payload) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const isJoinPayload: PayloadSchema<JoinPayload> = (payload): payload is JoinPayload => {
  if (
    !isPlainObject(payload) ||
    typeof payload.code !== "string" ||
    typeof payload.nickname !== "string" ||
    payload.code.length > 16 ||
    payload.nickname.length > 96
  ) {
    return false;
  }
  const nickname = normalizeNickname(payload.nickname).display;
  return (
    SESSION_CODE_PATTERN.test(normalizeSessionCode(payload.code)) &&
    nickname.length >= 1 &&
    nickname.length <= 24
  );
};

const isResumePayload: PayloadSchema<ResumePayload> = (payload): payload is ResumePayload =>
  isPlainObject(payload) &&
  ((typeof payload.token === "string" &&
    payload.token.length <= 160 &&
    PLAYER_TOKEN_PATTERN.test(payload.token)) ||
    (typeof payload.player_token === "string" &&
      payload.player_token.length <= 160 &&
      PLAYER_TOKEN_PATTERN.test(payload.player_token))) &&
  (payload.session_id === undefined ||
    (typeof payload.session_id === "string" && UUID_V7_PATTERN.test(payload.session_id))) &&
  (payload.request_id === undefined ||
    (typeof payload.request_id === "string" && payload.request_id.length >= 1 && payload.request_id.length <= 64)) &&
  (payload.client_instance_id === undefined ||
    (typeof payload.client_instance_id === "string" && payload.client_instance_id.length >= 1 && payload.client_instance_id.length <= 64)) &&
  (payload.last_server_seq === undefined ||
    (typeof payload.last_server_seq === "number" &&
      Number.isSafeInteger(payload.last_server_seq) && payload.last_server_seq >= 0));

const isProjectorAttachPayload: PayloadSchema<ProjectorAttachPayload> = (
  payload,
): payload is ProjectorAttachPayload =>
  isPlainObject(payload) &&
  typeof payload.projector_token === "string" &&
  payload.projector_token.length <= 164 &&
  PROJECTOR_TOKEN_PATTERN.test(payload.projector_token);

const isTeacherAttachPayload: PayloadSchema<TeacherAttachPayload> = (
  payload,
): payload is TeacherAttachPayload =>
  isPlainObject(payload) &&
  typeof payload.session_id === "string" &&
  payload.session_id.length === 36 &&
    UUID_V7_PATTERN.test(payload.session_id);

const isTeacherControlPayload: PayloadSchema<TeacherControlPayload> = (
  payload,
): payload is TeacherControlPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  (payload.attempt_id === undefined ||
    (typeof payload.attempt_id === "string" && payload.attempt_id.length >= 1 && payload.attempt_id.length <= 64)) &&
  (payload.reason === undefined ||
    (typeof payload.reason === "string" && payload.reason.length <= 200)) &&
  (payload.one_choice === undefined ||
    (typeof payload.one_choice === "number" && Number.isInteger(payload.one_choice) && payload.one_choice >= 0 && payload.one_choice <= 3));

const isHelpPayload: PayloadSchema<HelpPayload> = (payload): payload is HelpPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" && payload.request_id.length >= 1 && payload.request_id.length <= 64 &&
  (payload.choice === undefined || (typeof payload.choice === "number" && Number.isInteger(payload.choice) && payload.choice >= 0 && payload.choice <= 3));

const isOpenQuestionPayload: PayloadSchema<OpenQuestionPayload> = (
  payload,
): payload is OpenQuestionPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  (payload.question_id === undefined ||
    (typeof payload.question_id === "string" && payload.question_id.length >= 1 && payload.question_id.length <= 64));

const isAnswerPayload: PayloadSchema<AnswerPayload> = (payload): payload is AnswerPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  (payload.attempt_id === undefined ||
    (typeof payload.attempt_id === "string" &&
      payload.attempt_id.length >= 1 &&
      payload.attempt_id.length <= 64)) &&
  typeof payload.question_id === "string" &&
  payload.question_id.length >= 1 &&
  payload.question_id.length <= 64 &&
  typeof payload.choice === "number" &&
  Number.isInteger(payload.choice) &&
  payload.choice >= 0 &&
  payload.choice <= 3;

const isKickPlayerPayload: PayloadSchema<KickPlayerPayload> = (
  payload,
): payload is KickPlayerPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  typeof payload.player_id === "string" &&
  payload.player_id.length >= 1 &&
  payload.player_id.length <= 64;

const isAssignRolePayload: PayloadSchema<AssignRolePayload> = (
  payload,
): payload is AssignRolePayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  typeof payload.player_id === "string" &&
  payload.player_id.length >= 1 &&
  payload.player_id.length <= 64 &&
  typeof payload.role === "string" &&
  payload.role.length >= 1 &&
  payload.role.length <= 16;

const isEndSessionPayload: PayloadSchema<EndSessionPayload> = (
  payload,
): payload is EndSessionPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64;

const isRotateSessionCredentialPayload: PayloadSchema<RotateSessionCredentialPayload> = (
  payload,
): payload is RotateSessionCredentialPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64;

const isAttachQuestionSetPayload: PayloadSchema<AttachQuestionSetPayload> = (
  payload,
): payload is AttachQuestionSetPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" &&
  payload.request_id.length >= 1 &&
  payload.request_id.length <= 64 &&
  typeof payload.question_set_id === "string" &&
  payload.question_set_id.length >= 1 &&
    payload.question_set_id.length <= 64;

const isStartSessionPayload: PayloadSchema<StartSessionPayload> = (payload): payload is StartSessionPayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" && payload.request_id.length >= 1 && payload.request_id.length <= 64 &&
  typeof payload.first_one_player_id === "string" && payload.first_one_player_id.length >= 1 &&
  payload.first_one_player_id.length <= 64;

const isSelectNextOnePayload: PayloadSchema<SelectNextOnePayload> = (payload): payload is SelectNextOnePayload =>
  isPlainObject(payload) &&
  typeof payload.request_id === "string" && payload.request_id.length >= 1 && payload.request_id.length <= 64 &&
  typeof payload.player_id === "string" && payload.player_id.length >= 1 && payload.player_id.length <= 64;

const isTeacherSettingsPayload: PayloadSchema<TeacherSettingsPayload> = (payload): payload is TeacherSettingsPayload =>
  isPlainObject(payload) &&
  Object.keys(payload).every((key) => ["request_id", "phase_a_seconds", "base_strikes", "momentum_enabled"].includes(key)) &&
  typeof payload.request_id === "string" && payload.request_id.length >= 1 && payload.request_id.length <= 64 &&
  (payload.phase_a_seconds !== undefined || payload.base_strikes !== undefined || payload.momentum_enabled !== undefined) &&
  (payload.phase_a_seconds === undefined || Number.isInteger(payload.phase_a_seconds)) &&
  (payload.base_strikes === undefined || Number.isInteger(payload.base_strikes)) &&
  (payload.momentum_enabled === undefined || typeof payload.momentum_enabled === "boolean");

function withSocketBoundary<Payload>(
  socket: Socket,
  event: string,
  schema: PayloadSchema<Payload>,
  handler: (socket: Socket, payload: Payload, ack: Ack) => void | Promise<void>,
  logger: ServerLogger,
  context: () => Readonly<{ sessionId?: string; actor: LogActor }>,
): (payload: unknown, ack: unknown) => void {
  return (payload: unknown, ack: unknown): void => {
    if (typeof ack !== "function") {
      const logContext = context();
      logger.warn("protocol_error", {
        ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
        actor: logContext.actor,
        detail: { transport: "socket", command: event, cause: "missing_ack" },
      });
      return;
    }
    const safeAck: Ack = (response) => {
      if (
        isPlainObject(response) &&
        (response.ok === false || typeof response.error === "string")
      ) {
        const logContext = context();
        logger.warn("socket_action_rejected", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: {
            command: event,
            code: typeof response.code === "string"
              ? response.code
              : typeof response.error === "string"
                ? response.error
                : "rejected",
          },
        });
      }
      try {
        respondApplicationPacket(event, ack as Ack, response, logger);
      } catch {
        const logContext = context();
        logger.warn("protocol_error", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, cause: "ack_transport" },
        });
      }
    };
    let applicationPayload = payload;
    if (typeof payload === "string") {
      if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
        const logContext = context();
        logger.warn("payload_size_rejected", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, bytes: Buffer.byteLength(payload, "utf8") },
        });
        safeAck({ ok: false, code: "PAYLOAD_TOO_LARGE", message: "That message is too large" });
        return;
      }
      try {
        applicationPayload = JSON.parse(payload) as unknown;
      } catch {
        const logContext = context();
        logger.warn("protocol_error", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, cause: "invalid_json" },
        });
        safeAck(PROTOCOL_ERROR);
        return;
      }
    } else {
      try {
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
          const logContext = context();
          logger.warn("payload_size_rejected", {
            ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
            actor: logContext.actor,
            detail: { transport: "socket", command: event, bytes: Buffer.byteLength(JSON.stringify(payload), "utf8") },
          });
          safeAck({ ok: false, code: "PAYLOAD_TOO_LARGE", message: "That message is too large" });
          return;
        }
      } catch {
        const logContext = context();
        logger.warn("protocol_error", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, cause: "unserializable_payload" },
        });
        safeAck(PROTOCOL_ERROR);
        return;
      }
    }
    if (isPlainObject(applicationPayload) && applicationPayload.v === 1 && "payload" in applicationPayload) {
      applicationPayload = (applicationPayload as EnvelopePayload).payload;
    }
    let validatedPayload: Payload;
    try {
      if (!schema(applicationPayload)) {
        const logContext = context();
        logger.warn("protocol_error", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, cause: "schema_validation" },
        });
        safeAck(PROTOCOL_ERROR);
        return;
      }
      validatedPayload = applicationPayload;
    } catch {
      const logContext = context();
      logger.warn("protocol_error", {
        ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
        actor: logContext.actor,
        detail: { transport: "socket", command: event, cause: "schema_exception" },
      });
      safeAck(PROTOCOL_ERROR);
      return;
    }
    void (async () => {
      try {
        await handler(socket, validatedPayload, safeAck);
      } catch (error) {
        const logContext = context();
        logger.error("protocol_error", {
          ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
          actor: logContext.actor,
          detail: { transport: "socket", command: event, cause: "handler_exception", error: error instanceof Error ? error.name : "unknown" },
        });
        safeAck(PROTOCOL_ERROR);
      }
    })();
  };
}

export function attachSocketGateway(
  httpServer: HttpServer,
  options: SocketGatewayOptions,
): SocketIoServer {
  const { database, tokenSecret } = options;
  const capacity = options.capacity ?? 40;
  const rateLimitPerSecond = options.rateLimitPerSecond ?? 20;
  const preAuthRateLimitPerSecond = options.preAuthRateLimitPerSecond ?? 5;
  const rounds = options.rounds ?? new Map<string, QuestionRound>();
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = options.logger ?? createSilentLogger();
  const store = new GameEventStore(database);
  const io = new SocketIoServer(httpServer, {
    path: "/socket.io/",
    transports: ["polling", "websocket"],
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 32 * 1_024,
  });
  const socketPlayers = new Map<string, { sessionId: string; playerId: string }>();
  const socketPrincipals = new Map<string, SocketPrincipal>();
  const onlinePlayers = new Map<string, Set<string>>();
  if (options.presence !== undefined) {
    options.presence.lookup = (playerId) => onlinePlayers.get(playerId)?.size ?? 0;
  }
  const commandWindows = new Map<string, { second: number; count: number }>();
  const preAuthWindows = new Map<string, { second: number; count: number; logged: boolean }>();
  const preAuthSourceWindows = new Map<string, { second: number; count: number; logged: boolean }>();
  const unauthenticatedLifecycleWindows = new Map<string, number>();
  const coordinator = new CommandCoordinator(database, store, logger);
  const roundUnsubscribers = new Map<string, () => void>();
  const roundTimers = new Map<string, NodeJS.Timeout>();
  const rulesetTimers = new Map<string, NodeJS.Timeout>();
  const lockCountSentAt = new Map<string, number>();
  const pendingLockCounts = new Map<string, Readonly<Record<string, unknown>>>();
  const lockCountTimers = new Map<string, NodeJS.Timeout>();
  const rulesetEngines = new Map<string, OneV100Engine>();
  const rulesetPublications = new Map<string, Promise<void>>();
  const systemLocks = new Set<string>();
  const unsubscribeRevocations = onTeacherRevoked(database, (teacherId) => {
    for (const [socketId, principal] of socketPrincipals) {
      if (principal.role !== "teacher" || principal.teacherId !== teacherId) continue;
      socketPrincipals.delete(socketId);
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
  });

  const principalContext = (socket: Socket): Readonly<{ sessionId?: string; actor: LogActor }> => {
    const principal = socketPrincipals.get(socket.id);
    if (principal === undefined) return Object.freeze({ actor: Object.freeze({ kind: "unbound" }) });
    if (principal.role === "student") {
      return Object.freeze({ sessionId: principal.sessionId, actor: Object.freeze({ kind: "player", id: principal.playerId }) });
    }
    if (principal.role === "teacher") {
      return Object.freeze({ sessionId: principal.sessionId, actor: Object.freeze({ kind: "teacher", id: principal.teacherId }) });
    }
    return Object.freeze({ sessionId: principal.sessionId, actor: Object.freeze({ kind: "projector" }) });
  };

  const emitterFor = (sessionId: string): ApplicationEmitter =>
    new ApplicationEmitter(io, sessionId, logger);

  const roundSnapshotFor = (
    sessionId: string,
    audience: "teacher" | "projector" | "one" | "answerer",
    playerId?: string,
  ): Readonly<Record<string, unknown>> | null => {
    const round = roundFor(sessionId);
    if (round === undefined) return null;
    const snapshot = round.liveSnapshot(playerId);
    return snapshotView(snapshot, {
      audience,
      ...(playerId === undefined
        ? {}
        : { eligible: round.snapshot().active?.eligiblePlayerIds.includes(playerId) ?? false }),
    });
  };

  const rulesetSnapshotFor = (
    sessionId: string,
    audience: "teacher" | "projector" | "one" | "answerer",
    playerId?: string,
  ): Readonly<Record<string, unknown>> | null => {
    const ruleset = rulesetFor(sessionId);
    if (ruleset === undefined) return null;
    return snapshotView(ruleset.liveSnapshot(playerId), {
      audience,
      ...(playerId === undefined ? {} : { eligible: ruleset.isEligible(playerId) }),
    });
  };

  const logAuthFailure = (
    surface: "player" | "projector" | "teacher",
    reason: string,
    sessionId?: string,
  ): void => {
    logger.warn("auth_failure", {
      ...(sessionId === undefined ? {} : { sessionId }),
      actor: { kind: surface },
      detail: { surface: `${surface}_socket`, reason },
    });
  };

  const withTime = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> =>
    Object.freeze({ ...payload, server_time_ms: payload.server_time_ms ?? wallNow() });

  const clearRoundTimer = (sessionId: string): void => {
    const timer = roundTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    roundTimers.delete(sessionId);
  };

  const scheduleRoundTimer = (sessionId: string, round: QuestionRound): void => {
    clearRoundTimer(sessionId);
    const snapshot = round.liveSnapshot();
    if (snapshot.phase !== "QUESTION_OPEN" || snapshot.deadline_ms === null) return;
    const attemptId = snapshot.attempt_id;
    if (snapshot.deadline_ms <= wallNow()) {
      logger.info("deadline_timer_fired", {
        sessionId,
        actor: { kind: "system", id: "system" },
        detail: { attempt_id: attemptId, trigger: "already_due" },
      });
      round.lockExpired();
      return;
    }
    const timer = setTimeout(() => {
      roundTimers.delete(sessionId);
      const current = round.liveSnapshot();
      logger.info("deadline_timer_fired", {
        sessionId,
        actor: { kind: "system", id: "system" },
        detail: { attempt_id: attemptId, phase: current.phase },
      });
      if (current.phase !== "QUESTION_OPEN" || current.attempt_id !== attemptId) return;
      if (current.deadline_ms !== null && current.deadline_ms > wallNow()) {
        scheduleRoundTimer(sessionId, round);
        return;
      }
      const lockKey = `${sessionId}:${attemptId ?? "round"}`;
      systemLocks.add(lockKey);
      try {
        round.lockExpired();
      } finally {
        systemLocks.delete(lockKey);
      }
    }, Math.max(0, snapshot.deadline_ms - wallNow()));
    timer.unref();
    roundTimers.set(sessionId, timer);
  };

  const bridgeRound = (sessionId: string, round: QuestionRound): void => {
    if (roundUnsubscribers.has(sessionId)) {
      return;
    }
    const unsubscribe = round.subscribe((event: QuestionRoundBroadcast) => {
      const payload = withTime({
        ...event.payload,
        server_seq: event.serverSeq,
      });
      const emitter = emitterFor(sessionId);
      if (event.type === "question_open") {
        emitApplicationPacket(emitter, "question_open", {
          teacher: payload,
          answerers: payload,
          one: payload,
          projector: payload,
          players: EXCLUDE,
        });
      } else if (event.type === "leaderboard") {
        emitApplicationPacket(emitter, "leaderboard", { teacher: payload, projector: payload, players: payload });
      } else {
        emitApplicationPacket(emitter, event.type, {
          teacher: payload,
          projector: payload,
          one: payload,
          answerers: payload,
          players: payload,
        });
      }
      if (event.type === "question_open" || (event.type === "phase_state" && event.payload.phase === "QUESTION_OPEN")) {
        scheduleRoundTimer(sessionId, round);
      } else if (event.type === "phase_a_locked" || event.type === "reveal" || event.type === "phase_state") {
        clearRoundTimer(sessionId);
      }
    });
    roundUnsubscribers.set(sessionId, unsubscribe);
  };

  for (const [sessionId, round] of rounds) {
    bridgeRound(sessionId, round);
  }

  const roundFor = (sessionId: string): QuestionRound | undefined => {
    const round = rounds.get(sessionId);
    if (round !== undefined) {
      bridgeRound(sessionId, round);
    }
    return round;
  };

  const loadQuestion = (questionId: string): Question | undefined => {
    const row = database
      .prepare(
        `SELECT question_id, prompt, choices_json, correct_choice, phase_a_seconds
         FROM questions WHERE question_id = ?`,
      )
      .get(questionId) as QuestionRow | undefined;
    return row === undefined ? undefined : questionFromRow(row);
  };

  const ensureRound = (sessionId: string, restore?: QuestionRoundSnapshot): QuestionRound => {
    const existing = roundFor(sessionId);
    if (existing !== undefined) return existing;
    const round = new QuestionRound({
      sessionId,
      store,
      database,
      monotonicNow,
      wallNow,
      emit: () => undefined,
      connectedPlayerIds: () => new Set(
        (database
          .prepare(
            `SELECT player_id FROM session_players
             WHERE session_id = ? AND kicked_at_ms IS NULL`,
          )
          .all(sessionId) as Array<{ player_id: string }>)
          .filter((player) => (onlinePlayers.get(player.player_id)?.size ?? 0) > 0)
          .map((player) => player.player_id),
      ),
      logger,
      ...(restore === undefined ? {} : { restore }),
    });
    rounds.set(sessionId, round);
    bridgeRound(sessionId, round);
    if (restore !== undefined) scheduleRoundTimer(sessionId, round);
    return round;
  };

  for (const session of database
    .prepare("SELECT session_id FROM sessions WHERE status != 'ended'")
    .all() as Array<{ session_id: string }>) {
    if (rounds.has(session.session_id)) continue;
    const restored = replayRoundSnapshot(
      store.readSession(session.session_id),
      loadQuestion,
      monotonicNow(),
      wallNow(),
    );
    if (restored !== undefined) {
      ensureRound(session.session_id, restored);
      logger.info("round_restored", {
        sessionId: session.session_id,
        actor: { kind: "system", id: "system" },
        detail: { phase: restored.phase, attempt_id: restored.active?.attemptId ?? null, answer_count: restored.answers.length },
      });
    }
  }

  const sessionEnded = (sessionId: string): boolean => {
    const row = database.prepare("SELECT status FROM sessions WHERE session_id = ?").get(sessionId) as
      | { status: string }
      | undefined;
    return row?.status === "ended";
  };

  const timed = (payload: Readonly<Record<string, unknown>>, round?: QuestionRound): Readonly<Record<string, unknown>> =>
    Object.freeze({
      ...payload,
      server_time_ms: wallNow(),
      deadline_ms: round?.liveSnapshot().deadline_ms ?? null,
    });

  const rejectedCommand = (request: Readonly<{
    sessionId: string;
    commandType: string;
    actorKind: "teacher" | "player";
    actorId: string;
    requestId: string;
    payload: unknown;
    code: string;
    message?: string;
    disposition: "terminal" | "transient";
  }>) => coordinator.execute({
    sessionId: request.sessionId,
    commandType: request.commandType,
    actorKind: request.actorKind,
    actorId: request.actorId,
    requestId: request.requestId,
    payload: request.payload,
    createdAtMs: wallNow(),
    propose: () => ({
      code: request.code,
      ...(request.message === undefined ? {} : { message: request.message }),
      disposition: request.disposition,
    }),
  });

  const ensureDeadlineLocked = (sessionId: string, round: QuestionRound): void => {
    const snapshot = round.liveSnapshot();
    if (
      snapshot.phase !== "QUESTION_OPEN" ||
      snapshot.deadline_ms === null ||
      snapshot.deadline_ms > wallNow()
    ) {
      return;
    }
    const lockKey = `${sessionId}:${snapshot.attempt_id ?? "round"}`;
    if (systemLocks.has(lockKey)) return;
    systemLocks.add(lockKey);
    try {
      round.lockExpired();
    } finally {
      systemLocks.delete(lockKey);
    }
  };

  const roster = (sessionId: string): RosterEntry[] =>
    database
      .prepare(
         `SELECT player_id, nickname, role FROM session_players
         WHERE session_id = ? AND kicked_at_ms IS NULL ORDER BY joined_at_ms, rowid`,
      )
      .all(sessionId)
      .map((row) => {
        const player = row as { player_id: string; nickname: string; role: PlayerRole };
        return Object.freeze({
          player_id: player.player_id,
          nickname: player.nickname,
          role: player.role,
          connected: (onlinePlayers.get(player.player_id)?.size ?? 0) > 0,
        });
      });

  const broadcastRoster = (sessionId: string, entries = roster(sessionId)): void => {
    emitApplicationPacket(emitterFor(sessionId), "roster_update", {
      teacher: entries,
      projector: entries,
      players: entries,
    });
  };

  const withConnectedPlayer = (
    entries: RosterEntry[],
    playerId: string,
  ): RosterEntry[] =>
    entries.map((entry) =>
      entry.player_id === playerId
        ? Object.freeze({ ...entry, connected: true })
        : entry,
    );

  const bindPlayerSocket = async (
    socket: Socket,
    sessionId: string,
    playerId: string,
    role: PlayerRole = "mob",
  ): Promise<void> => {
    const principal = Object.freeze({ role: "student" as const, sessionId, playerId });
    socketPrincipals.set(socket.id, principal);
    try {
      await socket.join([
        studentRoom(sessionId),
        playerRoom(sessionId, playerId),
        role === "one" ? oneRoom(sessionId) : answererRoom(sessionId),
      ]);
    } catch (error) {
      if (socketPrincipals.get(socket.id) === principal) {
        socketPrincipals.delete(socket.id);
      }
      throw error;
    }
    socketPlayers.set(socket.id, { sessionId, playerId });
    const sockets = onlinePlayers.get(playerId) ?? new Set<string>();
    sockets.add(socket.id);
    onlinePlayers.set(playerId, sockets);
    logger.info("socket_principal_bound", {
      sessionId,
      actor: { kind: "player", id: playerId },
      detail: { principal_kind: "player", role },
    });
  };

  const movePlayerSocketsToRole = async (
    sessionId: string,
    playerId: string,
    role: PlayerRole,
  ): Promise<void> => {
    const sockets = io.sockets.adapter.rooms.get(playerRoom(sessionId, playerId));
    if (sockets === undefined) return;
    const socketIds = [...sockets];
    await Promise.all(socketIds.map(async (socketId) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket === undefined) return;
      // Leave every old derived role before exposing the persisted new role.
      await socket.leave(oneRoom(sessionId));
      await socket.leave(answererRoom(sessionId));
    }));
    await Promise.all(socketIds.map(async (socketId) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket === undefined) return;
      await socket.join(role === "one" ? oneRoom(sessionId) : answererRoom(sessionId));
    }));
    logger.info("player_role_rooms_changed", {
      sessionId,
      actor: { kind: "player", id: playerId },
      detail: { role, socket_count: socketIds.length },
    });
  };

  const clearRulesetTimer = (sessionId: string): void => {
    const timer = rulesetTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    rulesetTimers.delete(sessionId);
  };

  const scheduleRulesetTimer = (sessionId: string, engine: OneV100Engine): void => {
    clearRulesetTimer(sessionId);
    const active = engine.game?.snapshot.active;
    if (engine.phase !== "PHASE_A" || active === undefined || active === null) return;
    if (active.deadline_ms <= wallNow()) {
      engine.lockExpiredPhaseA();
      return;
    }
    const attemptId = active.attempt_id;
    const timer = setTimeout(() => {
      rulesetTimers.delete(sessionId);
      const current = engine.game?.snapshot.active;
      if (engine.phase !== "PHASE_A" || current?.attempt_id !== attemptId) return;
      if (current.deadline_ms > wallNow()) {
        scheduleRulesetTimer(sessionId, engine);
        return;
      }
      engine.lockExpiredPhaseA();
    }, active.deadline_ms - wallNow());
    timer.unref();
    rulesetTimers.set(sessionId, timer);
  };

  const publishRuleset = (sessionId: string, event: RulesetLifecycleEvent): void => {
    const prior = rulesetPublications.get(sessionId) ?? Promise.resolve();
    const publication = prior.then(async () => {
      if (event.roleChanges !== undefined) {
        await Promise.all(event.roleChanges.map((change) =>
          movePlayerSocketsToRole(sessionId, change.playerId, change.role),
        ));
        broadcastRoster(sessionId);
      }
      const payload = withTime({ ...event.payload, server_seq: event.serverSeq });
      const emitter = emitterFor(sessionId);
      if (event.type === "leaderboard") {
        emitApplicationPacket(emitter, "leaderboard", { teacher: payload, projector: payload, players: payload });
      } else if (event.type === "session_end") {
        emitApplicationPacket(emitter, "session_end", { teacher: payload, projector: payload, players: payload });
      } else if (event.type === "game_start") {
        emitApplicationPacket(emitter, "game_start", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else if (event.type === "next_game") {
        emitApplicationPacket(emitter, "next_game", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else if (event.type === "phase_a_start") {
        emitApplicationPacket(emitter, "phase_a_start", { answerers: payload, teacher: payload });
        const engine = rulesetEngines.get(sessionId);
        if (engine !== undefined) scheduleRulesetTimer(sessionId, engine);
      } else if (event.type === "phase_a_status") {
        emitApplicationPacket(emitter, "phase_a_status", { teacher: payload, projector: payload, one: payload });
      } else if (event.type === "lock_counts") {
        const lastSentAt = lockCountSentAt.get(sessionId) ?? Number.NEGATIVE_INFINITY;
        const delayMs = Math.max(0, 250 - (wallNow() - lastSentAt));
        if (delayMs === 0) {
          lockCountSentAt.set(sessionId, wallNow());
          emitApplicationPacket(emitter, "lock_counts", { teacher: payload, projector: payload, one: payload, answerers: payload });
        } else {
          pendingLockCounts.set(sessionId, payload);
          if (!lockCountTimers.has(sessionId)) {
            const timer = setTimeout(() => {
              lockCountTimers.delete(sessionId);
              const pending = pendingLockCounts.get(sessionId);
              pendingLockCounts.delete(sessionId);
              if (pending === undefined) return;
              lockCountSentAt.set(sessionId, wallNow());
              emitApplicationPacket(emitterFor(sessionId), "lock_counts", {
                teacher: pending,
                projector: pending,
                one: pending,
                answerers: pending,
              });
            }, delayMs);
            timer.unref();
            lockCountTimers.set(sessionId, timer);
          }
        }
      } else if (event.type === "phase_a_locked") {
        clearRulesetTimer(sessionId);
        const lockCountTimer = lockCountTimers.get(sessionId);
        if (lockCountTimer !== undefined) clearTimeout(lockCountTimer);
        lockCountTimers.delete(sessionId);
        pendingLockCounts.delete(sessionId);
        lockCountSentAt.delete(sessionId);
        emitApplicationPacket(emitter, "phase_a_locked", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else if (event.type === "phase_b_start") {
        emitApplicationPacket(emitter, "phase_b_start", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else if (event.type === "help_poll_result" || event.type === "help_ask_result" || event.type === "help_trust_result") {
        emitApplicationPacket(emitter, event.type, { teacher: payload, projector: payload, one: payload, answerers: payload, players: payload });
      } else if (event.type === "pause_state") {
        emitApplicationPacket(emitter, "pause_state", { teacher: payload, projector: payload, one: payload, answerers: payload });
        const engine = rulesetEngines.get(sessionId);
        if (engine?.phase === "PHASE_A") scheduleRulesetTimer(sessionId, engine);
        else clearRulesetTimer(sessionId);
      } else if (event.type === "strike") {
        emitApplicationPacket(emitter, "strike", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else if (event.type === "meter_progress" || event.type === "meter_filled") {
        emitApplicationPacket(emitter, event.type, {
          teacher: payload,
          projector: payload,
          one: payload,
          answerers: payload,
          players: payload,
        });
      } else if (event.type === "reveal") {
        emitApplicationPacket(emitter, "reveal", { teacher: payload, projector: payload, one: payload, answerers: payload });
      } else {
        emitApplicationPacket(emitter, "game_end", { teacher: payload, projector: payload, one: payload, answerers: payload });
      }
    });
    rulesetPublications.set(sessionId, publication);
    void publication.finally(() => {
      if (rulesetPublications.get(sessionId) === publication) rulesetPublications.delete(sessionId);
    });
  };

  const rulesetFor = (sessionId: string): OneV100Engine | undefined => {
    const existing = rulesetEngines.get(sessionId);
    if (existing !== undefined) return existing;
    const row = database.prepare("SELECT settings_json FROM sessions WHERE session_id = ?").get(sessionId) as
      | { settings_json: string }
      | undefined;
    if (row === undefined) return undefined;
    try {
      if (!isRuleset1v100(parseSettingsJson(row.settings_json))) return undefined;
    } catch {
      return undefined;
    }
    const engine = new OneV100Engine({
      sessionId,
      coordinator,
      repository: new SqliteRulesetRepository(database),
      wallNow,
      monotonicNow,
      connectedPlayerIds: () => new Set(
        (database
          .prepare(
            `SELECT player_id FROM session_players
             WHERE session_id = ? AND kicked_at_ms IS NULL`,
          )
          .all(sessionId) as Array<{ player_id: string }>)
          .filter((player) => (onlinePlayers.get(player.player_id)?.size ?? 0) > 0)
          .map((player) => player.player_id),
      ),
      publish: (event) => publishRuleset(sessionId, event),
    });
    rulesetEngines.set(sessionId, engine);
    try {
      engine.recover();
    } catch (error) {
      logger.error("ruleset_recovery_failed", {
        sessionId,
        actor: { kind: "system", id: "system" },
        detail: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }
    scheduleRulesetTimer(sessionId, engine);
    return engine;
  };

  for (const row of database.prepare(
    "SELECT session_id FROM sessions WHERE status != 'ended'",
  ).all() as Array<{ session_id: string }>) {
    rulesetFor(row.session_id);
  }

  const bindRoleSocket = async (
    socket: Socket,
    principal: SocketPrincipal,
    room: string,
  ): Promise<void> => {
    socketPrincipals.set(socket.id, principal);
    try {
      const playerRoomPrefix = `s:${principal.sessionId}:p:`;
      await Promise.all([...socket.rooms]
        .filter((currentRoom) =>
          currentRoom === studentRoom(principal.sessionId) ||
          currentRoom === answererRoom(principal.sessionId) ||
          currentRoom === oneRoom(principal.sessionId) ||
          currentRoom.startsWith(playerRoomPrefix)
        )
        .map((currentRoom) => socket.leave(currentRoom)));
      await socket.join(room);
    } catch (error) {
      if (socketPrincipals.get(socket.id) === principal) {
        socketPrincipals.delete(socket.id);
      }
      throw error;
    }
    logger.info("socket_principal_bound", {
      sessionId: principal.sessionId,
      actor: principal.role === "teacher"
        ? { kind: "teacher", id: principal.teacherId }
        : { kind: "projector" },
      detail: { principal_kind: principal.role },
    });
  };

  const rejectBoundSocket = (socket: Socket, ack: Ack): boolean => {
    if (!socketPrincipals.has(socket.id)) {
      return false;
    }
    ack({ ok: false, code: "PRINCIPAL_CONFLICT" });
    return true;
  };

  async function handleJoin(socket: Socket, payload: JoinPayload, ack: Ack): Promise<void> {
    if (rejectBoundSocket(socket, ack)) {
      return;
    }
    const code = normalizeSessionCode(payload.code);
    const session = database
      .prepare(
        `SELECT session_id, status FROM sessions WHERE code_hash = ?`,
      )
      .get(sessionCodeHash(code, tokenSecret)) as
      | { session_id: string; status: "lobby" | "live" | "ended" }
      | undefined;
    if (session === undefined) {
      ack({ ok: false, code: "JOIN_BAD_CODE", message: "That show code is not active" });
      return;
    }
    const now = Date.now();
    const requestId = payload.request_id ?? uuidV7(now);
    const actorId = payload.client_instance_id ?? socket.id;
    const replay = coordinator.replay({
      sessionId: session.session_id,
      commandType: "join",
      actorKind: "player",
      actorId,
      requestId,
      payload,
    });
    if (replay !== undefined) {
      if (!replay.ok) {
        ack(replay);
        return;
      }
      const joined = replay as typeof replay & { player_id: string; token: string; role: PlayerRole };
      const persistedRoster = roster(session.session_id);
      await bindPlayerSocket(socket, session.session_id, joined.player_id, joined.role);
      const snapshot = rulesetSnapshotFor(
        session.session_id,
        joined.role === "one" ? "one" : "answerer",
        joined.player_id,
      ) ?? roundSnapshotFor(
        session.session_id,
        joined.role === "one" ? "one" : "answerer",
        joined.player_id,
      );
      ack({
        player_id: joined.player_id,
        token: joined.token,
        role: joined.role,
        late_join: joined.role === "crowd",
        session_id: session.session_id,
        points: 0,
        roster: withConnectedPlayer(persistedRoster, joined.player_id),
        snapshot,
      });
      return;
    }
    if (session.status === "ended") {
      ack({ ok: false, code: "JOIN_BAD_CODE", message: "That show code is not active" });
      return;
    }
    const nickname = normalizeNickname(payload.nickname);
    if (nickname.display.length === 0 || nickname.display.length > 24) {
      ack({ ok: false, code: "JOIN_BAD_NICKNAME", message: "Choose a nickname from 1 to 24 characters" });
      return;
    }
    if (!nicknameIsAllowed(nickname)) {
      ack({
        ok: false,
        code: "NICKNAME_NOT_ALLOWED",
        message: "Please choose a classroom-friendly nickname",
      });
      return;
    }
    if (payload.client_instance_id !== undefined) {
      const existing = database
        .prepare(
          `SELECT player_id, token_value, role FROM session_players
           WHERE session_id = ? AND nickname_norm = ? AND client_instance_id = ?
             AND kicked_at_ms IS NULL`,
        )
        .get(session.session_id, nickname.normalized, payload.client_instance_id) as
        | { player_id: string; token_value: string | null; role: PlayerRole }
        | undefined;
      if (existing !== undefined && existing.token_value !== null) {
        const persistedRoster = roster(session.session_id);
        await bindPlayerSocket(socket, session.session_id, existing.player_id, existing.role);
        const currentRoster = withConnectedPlayer(persistedRoster, existing.player_id);
        const snapshot = rulesetSnapshotFor(
          session.session_id,
          existing.role === "one" ? "one" : "answerer",
          existing.player_id,
        ) ?? roundSnapshotFor(
          session.session_id,
          existing.role === "one" ? "one" : "answerer",
          existing.player_id,
        );
        ack({
          player_id: existing.player_id,
          token: existing.token_value,
          role: existing.role,
          late_join: existing.role === "crowd",
          session_id: session.session_id,
          points: 0,
          roster: currentRoster,
          snapshot,
        });
        return;
      }
    }
    const activeCount = database
      .prepare(
        `SELECT COUNT(*) AS count FROM session_players
         WHERE session_id = ? AND kicked_at_ms IS NULL`,
      )
      .get(session.session_id) as { count: number };
    if (activeCount.count >= capacity) {
      ack({ ok: false, code: "SESSION_FULL", message: "This game is full. Ask your teacher for help" });
      return;
    }

    const playerId = uuidV7(now);
    const token = createPlayerToken(playerId, session.session_id, tokenSecret, now);
    let persisted = false;
    let outcome;
    try {
      outcome = coordinator.execute({
        sessionId: session.session_id,
        commandType: "join",
        actorKind: "player",
        actorId,
        requestId,
        payload,
        createdAtMs: now,
        propose: () => ({
          state: Object.freeze({ playerId, token }),
          eventType: "player_joined",
          eventPayload: {
            player_id: playerId,
            nickname: nickname.display,
            role: session.status === "lobby" ? "mob" : "crowd",
          },
          persist: () => {
            database
              .prepare(
                `INSERT INTO session_players
                  (player_id, session_id, nickname, nickname_norm, token_hash,
                   token_expires_at_ms, role, joined_at_ms, last_seen_at_ms,
                   client_instance_id, token_value)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                playerId,
                session.session_id,
                nickname.display,
                nickname.normalized,
                tokenHash(token),
                now + 24 * 60 * 60 * 1_000,
                session.status === "lobby" ? "mob" : "crowd",
                now,
                now,
                payload.client_instance_id ?? null,
                token,
              );
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId,
            serverSeq: event.serverSeq,
            player_id: playerId,
            token,
            role: session.status === "lobby" ? "mob" as const : "crowd" as const,
            session_id: session.session_id,
            points: 0,
          }),
          apply: () => {
            persisted = true;
          },
        }),
      });
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        const unavailable = new Set(
          (database
            .prepare("SELECT nickname_norm FROM session_players WHERE session_id = ?")
            .all(session.session_id) as Array<{ nickname_norm: string }>).map(
            (row) => row.nickname_norm,
          ),
        );
        ack({
          ok: false,
          code: "NICKNAME_TAKEN",
          message: "That nickname is already playing. Try the suggestion!",
          suggestion: suggestNickname(nickname.display, unavailable),
        });
        return;
      }
      throw error;
    }
    if (!outcome.ok) {
      ack(outcome);
      return;
    }
    const outcomePlayerId = (outcome as typeof outcome & { player_id: string }).player_id;
    const outcomeToken = (outcome as typeof outcome & { token: string }).token;
    const outcomeRole = (outcome as typeof outcome & { role: PlayerRole }).role;

    const persistedRoster = roster(session.session_id);
    await bindPlayerSocket(socket, session.session_id, outcomePlayerId, outcomeRole);
    const currentRoster = withConnectedPlayer(persistedRoster, outcomePlayerId);
    if (persisted) {
      broadcastRoster(session.session_id, currentRoster);
    }
    ack({
      player_id: outcomePlayerId,
      token: outcomeToken,
      role: outcomeRole,
      late_join: outcomeRole === "crowd",
      session_id: session.session_id,
      points: 0,
      roster: currentRoster,
      snapshot: rulesetSnapshotFor(
        session.session_id,
        "answerer",
        outcomePlayerId,
      ) ?? roundSnapshotFor(
        session.session_id,
        "answerer",
        outcomePlayerId,
      ),
    });
  }

  async function handleResume(socket: Socket, payload: ResumePayload, ack: Ack): Promise<void> {
    if (rejectBoundSocket(socket, ack)) {
      return;
    }
    const token = payload.token ?? payload.player_token;
    if (token === undefined) {
      logAuthFailure("player", "missing_token", payload.session_id);
      ack({ ok: false, code: "RECONNECT_BAD_TOKEN" });
      return;
    }
    const playerId = token.split(".")[1];
    if (playerId === undefined) {
      logAuthFailure("player", "malformed_token", payload.session_id);
      ack({ ok: false, code: "RECONNECT_BAD_TOKEN" });
      return;
    }
    const player = database
      .prepare(
        `SELECT p.player_id, p.session_id, p.nickname, p.role, p.points,
                p.token_hash, p.token_expires_at_ms, p.kicked_at_ms, s.status
         FROM session_players p
         JOIN sessions s ON s.session_id = p.session_id
         WHERE p.player_id = ?`,
      )
      .get(playerId) as
      | {
           player_id: string;
           session_id: string;
           nickname: string;
           role: PlayerRole;
           points: number;
           token_hash: Buffer;
          token_expires_at_ms: number;
          kicked_at_ms: number | null;
          status: string;
        }
       | undefined;
    if (player !== undefined && player.kicked_at_ms !== null) {
      logAuthFailure("player", "kicked", player.session_id);
      ack({ ok: false, code: "KICKED" });
      return;
    }
    if (
      player === undefined ||
      player.token_expires_at_ms <= Date.now() ||
      (payload.session_id !== undefined && payload.session_id !== player.session_id) ||
      !hashesMatch(player.token_hash, tokenHash(token))
    ) {
      logAuthFailure("player", "invalid_token", player?.session_id ?? payload.session_id);
      ack({ ok: false, code: "RECONNECT_BAD_TOKEN" });
      return;
    }
    try {
      verifyPlayerToken(token, player.session_id, tokenSecret);
    } catch {
      logAuthFailure("player", "invalid_signature", player.session_id);
      ack({ ok: false, code: "RECONNECT_BAD_TOKEN" });
      return;
    }
    const now = Date.now();
    const requestId = payload.request_id ?? uuidV7(now);
    const idempotencyPayload = { session_id: payload.session_id ?? player.session_id };
    const replay = coordinator.replay({
      sessionId: player.session_id,
      commandType: "resume_player",
      actorKind: "player",
      actorId: player.player_id,
      requestId,
      payload: idempotencyPayload,
    });
    if (replay !== undefined && !replay.ok) {
      ack(timed({ ...replay, request_id: replay.requestId }));
      return;
    }
    if (replay === undefined && player.status === "ended") {
      const result = rejectedCommand({
        sessionId: player.session_id,
        commandType: "resume_player",
        actorKind: "player",
        actorId: player.player_id,
        requestId,
        payload: idempotencyPayload,
        code: "SESSION_ENDED",
        message: "This show has ended",
        disposition: "terminal",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    const result = coordinator.execute({
      sessionId: player.session_id,
      commandType: "resume_player",
      actorKind: "player",
      actorId: player.player_id,
      requestId,
      payload: idempotencyPayload,
      createdAtMs: now,
      propose: () => ({
        state: player,
        eventType: "player_resumed",
        eventPayload: { player_id: player.player_id },
        persist: () => {
          database
            .prepare("UPDATE session_players SET last_seen_at_ms = ? WHERE player_id = ?")
            .run(now, player.player_id);
        },
        outcome: (event) => Object.freeze({
          ok: true as const,
          requestId,
          serverSeq: event.serverSeq,
          player_id: player.player_id,
        }),
        apply: () => undefined,
      }),
    });
    if (!result.ok) {
      ack(result);
      return;
    }
    const persistedRoster = roster(player.session_id);
    await bindPlayerSocket(socket, player.session_id, player.player_id, player.role);
    const currentRoster = withConnectedPlayer(persistedRoster, player.player_id);
    broadcastRoster(player.session_id, currentRoster);
    const fresh = database
      .prepare("SELECT nickname, role, points, streak FROM session_players WHERE player_id = ?")
      .get(player.player_id) as { nickname: string; role: string; points: number; streak: number };
    const liveRound = roundFor(player.session_id);
    const ruleset = rulesetFor(player.session_id);
    if (ruleset?.game?.onePlayerId === player.player_id && ruleset.phase === "PAUSED") {
      ruleset.resumeOne(player.player_id);
    }
    const snapshot = rulesetSnapshotFor(
      player.session_id,
      player.role === "one" ? "one" : "answerer",
      player.player_id,
    ) ?? roundSnapshotFor(
      player.session_id,
      player.role === "one" ? "one" : "answerer",
      player.player_id,
    ) ?? projectApplicationPacket("state_snapshot", player.role === "one" ? "one" : "answerers", {
      phase: "LOBBY" as const,
      attempt_id: null,
      question: null,
      own_answer: null,
      locked_count: 0,
      eligible_count: 0,
      server_time_ms: wallNow(),
      deadline_ms: null,
    });
    ack(timed({
      ...result,
      player_id: player.player_id,
      nickname: fresh.nickname,
      role: fresh.role,
      points: fresh.points,
      streak: fresh.streak,
      session_id: player.session_id,
      session_state: player.status,
      snapshot,
      roster: currentRoster,
    }, liveRound));
  }

  async function handleProjectorAttach(
    socket: Socket,
    payload: ProjectorAttachPayload,
    ack: Ack,
  ): Promise<void> {
    if (rejectBoundSocket(socket, ack)) {
      return;
    }
    let claims;
    try {
      claims = verifyProjectorToken(payload.projector_token, tokenSecret);
    } catch {
      logAuthFailure("projector", "invalid_token");
      ack({ ok: false, code: "PROJECTOR_UNAUTHORIZED" });
      return;
    }
    const session = database
      .prepare(
        `SELECT projector_token_hash, projector_expires_at_ms, status FROM sessions
         WHERE session_id = ?`,
      )
      .get(claims.sessionId) as
      | { projector_token_hash: Buffer; projector_expires_at_ms: number; status: string }
      | undefined;
    if (
      session === undefined ||
      session.status === "ended" ||
      session.projector_expires_at_ms <= Date.now() ||
      !hashesMatch(session.projector_token_hash, tokenHash(payload.projector_token))
    ) {
      logAuthFailure("projector", "inactive_or_mismatched_session", claims.sessionId);
      ack({ ok: false, code: "PROJECTOR_UNAUTHORIZED" });
      return;
    }
    const currentRoster = roster(claims.sessionId);
    const snapshot = rulesetSnapshotFor(claims.sessionId, "projector") ??
      roundSnapshotFor(claims.sessionId, "projector");
    await bindRoleSocket(
      socket,
      Object.freeze({ role: "projector", sessionId: claims.sessionId }),
      projectorRoom(claims.sessionId),
    );
    ack({ ok: true, session_id: claims.sessionId, roster: currentRoster, snapshot });
  }

  async function handleTeacherAttach(
    socket: Socket,
    payload: TeacherAttachPayload,
    ack: Ack,
  ): Promise<void> {
    if (rejectBoundSocket(socket, ack)) {
      return;
    }
    const cookieToken = socket.handshake.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("teacher_session="))
      ?.slice("teacher_session=".length);
    const authToken = socket.handshake.auth.teacher_token;
    const token = typeof authToken === "string" ? authToken : cookieToken;
    if (typeof token !== "string") {
      logAuthFailure("teacher", "missing_token", payload.session_id);
      ack({ ok: false, code: "TEACHER_UNAUTHORIZED" });
      return;
    }
    let claims;
    try {
      claims = verifyTeacherToken(token, tokenSecret);
    } catch {
      logAuthFailure("teacher", "invalid_token", payload.session_id);
      ack({ ok: false, code: "TEACHER_UNAUTHORIZED" });
      return;
    }
    const session = database
      .prepare(
        `SELECT s.session_id, s.settings_json, s.settings_revision FROM sessions s
         JOIN teachers t ON t.teacher_id = s.teacher_id
         WHERE s.session_id = ? AND s.teacher_id = ? AND s.status != 'ended'
           AND t.status = 'active'
           AND ((? IS NULL AND t.key_rotated_at_ms IS NULL) OR t.key_prefix = ?)
           AND (t.expires_at_ms IS NULL OR t.expires_at_ms > ?)`,
      )
      .get(
        payload.session_id,
        claims.teacherId,
        claims.keyPrefix ?? null,
        claims.keyPrefix ?? null,
        Date.now(),
      ) as
      | { session_id: string; settings_json: string; settings_revision: number }
      | undefined;
    if (session === undefined) {
      logAuthFailure("teacher", "inactive_or_forbidden_session", payload.session_id);
      ack({ ok: false, code: "TEACHER_UNAUTHORIZED" });
      return;
    }
    const currentRoster = roster(session.session_id);
    const snapshot = rulesetSnapshotFor(session.session_id, "teacher") ??
      roundSnapshotFor(session.session_id, "teacher");
    const settings = parseSettingsJson(session.settings_json);
    await bindRoleSocket(
      socket,
      Object.freeze({
        role: "teacher",
        sessionId: session.session_id,
        teacherId: claims.teacherId,
      }),
      teacherRoom(session.session_id),
    );
    ack({
      ok: true,
      session_id: session.session_id,
      roster: currentRoster,
      snapshot,
      settings_revision: session.settings_revision,
      phase_a_seconds: settings.phase_a_seconds,
    });
  }

  function activeTeacherPrincipal(socket: Socket): Extract<SocketPrincipal, { role: "teacher" }> | undefined {
    const principal = socketPrincipals.get(socket.id);
    if (principal?.role !== "teacher") return undefined;
    const active = database
      .prepare(
        `SELECT teacher_id FROM teachers
         WHERE teacher_id = ? AND status = 'active'
           AND (expires_at_ms IS NULL OR expires_at_ms > ?)`,
      )
      .get(principal.teacherId, Date.now());
    if (active !== undefined) return principal;
    socketPrincipals.delete(socket.id);
    void socket.leave(teacherRoom(principal.sessionId));
    return undefined;
  }

  async function handleTeacherControl(
    socket: Socket,
    payload: TeacherControlPayload,
    ack: Ack,
    control: "advance" | "pause" | "resume" | "forceReveal",
  ): Promise<void> {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack(timed({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" }));
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    if (ruleset !== undefined) {
      const commandType = control === "advance"
        ? "teacher_advance"
        : control === "pause"
          ? "teacher_pause"
          : control === "resume"
            ? "teacher_resume"
            : "teacher_force_reveal";
      const commandPayload = control === "pause"
        ? (payload.reason === undefined ? {} : { reason: payload.reason })
        : control === "forceReveal"
          ? (payload.one_choice === undefined ? {} : { one_choice: payload.one_choice })
          : {};
      const replay = coordinator.replay({
        sessionId: principal.sessionId,
        commandType,
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload: commandPayload,
      });
      if (replay !== undefined) {
        ack(timed({ ...replay, request_id: replay.requestId }));
        return;
      }
      if (sessionEnded(principal.sessionId)) {
        const result = rejectedCommand({
          sessionId: principal.sessionId,
          commandType,
          actorKind: "teacher",
          actorId: principal.teacherId,
          requestId: payload.request_id,
          payload: commandPayload,
          code: "SESSION_ENDED",
          message: "This show has ended",
          disposition: "terminal",
        });
        ack(timed({ ...result, request_id: result.requestId }));
        return;
      }
    }
    if (control === "advance") {
      if (ruleset !== undefined) {
        const result = ruleset.phase === "LEADERBOARD"
          ? ruleset.nextGame({ teacherId: principal.teacherId, requestId: payload.request_id })
          : ruleset.phase === "PHASE_A_LOCKED"
            ? ruleset.startPhaseB()
            : ruleset.startPhaseA({ teacherId: principal.teacherId, requestId: payload.request_id });
        await rulesetPublications.get(principal.sessionId);
        ack(timed({ ...result, request_id: result.requestId }));
        return;
      }
    }
    if (ruleset !== undefined) {
      const result = control === "pause"
        ? ruleset.teacherPause({ teacherId: principal.teacherId, requestId: payload.request_id, ...(payload.reason === undefined ? {} : { reason: payload.reason }) })
        : control === "resume"
          ? ruleset.teacherResume({ teacherId: principal.teacherId, requestId: payload.request_id })
          : ruleset.forceReveal({ teacherId: principal.teacherId, requestId: payload.request_id, ...(payload.one_choice === undefined ? {} : { oneChoice: payload.one_choice }) });
      await rulesetPublications.get(principal.sessionId);
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    if (payload.attempt_id === undefined) {
      ack(timed({ ok: false, request_id: payload.request_id, code: "WRONG_PHASE" }));
      return;
    }
    const command = {
      actorId: principal.teacherId,
      requestId: payload.request_id,
      attemptId: payload.attempt_id,
    };
    const commandType = control === "forceReveal" ? "reveal" : control;
    const commandPayload = control === "advance"
      ? { attempt_id: command.attemptId }
      : control === "pause"
        ? { ...command, ...(payload.reason === undefined ? {} : { reason: payload.reason }) }
        : command;
    const replay = coordinator.replay({
      sessionId: principal.sessionId,
      commandType,
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload: commandPayload,
    });
    if (replay !== undefined) {
      ack(timed({ ...replay, request_id: replay.requestId }, roundFor(principal.sessionId)));
      return;
    }
    if (sessionEnded(principal.sessionId)) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType,
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload: commandPayload,
        code: "SESSION_ENDED",
        message: "This show has ended",
        disposition: "terminal",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    const round = roundFor(principal.sessionId);
    if (round === undefined) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType,
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload: commandPayload,
        code: "WRONG_PHASE",
        disposition: "transient",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    ensureDeadlineLocked(principal.sessionId, round);
    const result =
      control === "pause"
        ? round.pause({ ...command, ...(payload.reason === undefined ? {} : { reason: payload.reason }) })
        : round[control](command);
    ack(timed({ ...result, request_id: result.requestId }, round));
  }

  function handleOpenQuestion(socket: Socket, payload: OpenQuestionPayload, ack: Ack): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack(timed({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" }));
      return;
    }
    const idempotencyPayload = { question_id: payload.question_id ?? null };
    if (rulesetFor(principal.sessionId) !== undefined) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "open_question",
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload: idempotencyPayload,
        code: "WRONG_PHASE",
        message: "Use the 1v100 game controls for this session",
        disposition: "transient",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    if (payload.question_id === undefined || payload.question_id === null) {
      // No explicit question: draw the NEXT deck question and advance the
      // cursor (openNextDeckQuestion owns replay/idempotency for this path —
      // the old fallback re-served position 1 forever).
      if (sessionEnded(principal.sessionId)) {
        const result = rejectedCommand({
          sessionId: principal.sessionId,
          commandType: "open_question",
          actorKind: "teacher",
          actorId: principal.teacherId,
          requestId: payload.request_id,
          payload: idempotencyPayload,
          code: "SESSION_ENDED",
          message: "This show has ended",
          disposition: "terminal",
        });
        ack(timed({ ...result, request_id: result.requestId }));
        return;
      }
      const eligible = (database
        .prepare(
          `SELECT player_id FROM session_players
           WHERE session_id = ? AND role IN ('mob', 'crowd') AND kicked_at_ms IS NULL
           ORDER BY joined_at_ms, player_id`,
        )
        .all(principal.sessionId) as Array<{ player_id: string }>).map((player) => player.player_id);
      const deckRound = ensureRound(principal.sessionId);
      try {
        const session = database.prepare(
          "SELECT settings_json FROM sessions WHERE session_id = ?",
        ).get(principal.sessionId) as { settings_json: string };
        const settings = parseSettingsJson(session.settings_json);
        const result = openNextDeckQuestion(database, deckRound, {
          sessionId: principal.sessionId,
          teacherId: principal.teacherId,
          requestId: payload.request_id,
          attemptId: payload.request_id,
          durationMs: settings.phase_a_seconds * 1_000,
          eligiblePlayerIds: eligible,
        }, logger) as { ok: boolean; requestId: string };
        ack(timed({
          ...result,
          request_id: result.requestId,
          ...(result.ok ? { attempt_id: payload.request_id } : {}),
        }, deckRound));
      } catch (error) {
        logger.warn("open_question_deck_exhausted", {
          actor: { kind: "teacher", id: principal.teacherId },
          detail: { session_id: principal.sessionId, cause: error instanceof Error ? error.message : "unknown" },
        });
        ack(timed({
          ok: false,
          request_id: payload.request_id,
          code: "NO_QUESTION",
          message: "No more questions in this set",
        }));
      }
      return;
    }
    const replay = coordinator.replay({
      sessionId: principal.sessionId,
      commandType: "open_question",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload: idempotencyPayload,
    });
    if (replay !== undefined) {
      ack(timed({
        ...replay,
        request_id: replay.requestId,
        ...(replay.ok ? { attempt_id: payload.request_id } : {}),
      }));
      return;
    }
    if (sessionEnded(principal.sessionId)) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "open_question",
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload: idempotencyPayload,
        code: "SESSION_ENDED",
        message: "This show has ended",
        disposition: "terminal",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    const row = database
      .prepare(
        `SELECT q.question_id, q.prompt, q.choices_json, q.correct_choice, q.phase_a_seconds
         FROM questions q JOIN sessions s ON s.question_set_id = q.question_set_id
         WHERE s.session_id = ? AND (? IS NULL OR q.question_id = ?)
         ORDER BY q.position LIMIT 1`,
      )
      .get(principal.sessionId, payload.question_id ?? null, payload.question_id ?? null) as QuestionRow | undefined;
    if (row === undefined) {
      ack(timed({ ok: false, request_id: payload.request_id, code: "NO_QUESTION", message: "No classroom question is ready" }));
      return;
    }
    const eligiblePlayerIds = (database
      .prepare(
        `SELECT player_id FROM session_players
         WHERE session_id = ? AND role IN ('mob', 'crowd') AND kicked_at_ms IS NULL
         ORDER BY joined_at_ms, player_id`,
      )
      .all(principal.sessionId) as Array<{ player_id: string }>).map((player) => player.player_id);
    const round = ensureRound(principal.sessionId);
    const attemptId = payload.request_id;
    const session = database.prepare(
      "SELECT settings_json FROM sessions WHERE session_id = ?",
    ).get(principal.sessionId) as { settings_json: string };
    const settings = parseSettingsJson(session.settings_json);
    const result = round.openQuestion({
      actorId: principal.teacherId,
      requestId: payload.request_id,
      attemptId,
      question: questionFromRow(row),
      durationMs: (row.phase_a_seconds ?? settings.phase_a_seconds) * 1_000,
      eligiblePlayerIds,
      idempotencyPayload,
    });
    ack(timed({ ...result, request_id: result.requestId, ...(result.ok ? { attempt_id: attemptId } : {}) }, round));
  }

  function handleAnswer(
    socket: Socket,
    payload: AnswerPayload,
    ack: Ack,
    inbound: "answer_submit" | "one_answer" = "answer_submit",
  ): void {
    const principal = socketPrincipals.get(socket.id);
    if (principal?.role !== "student") {
      ack(timed({ ok: false, requestId: payload.request_id, request_id: payload.request_id, code: "FORBIDDEN" }));
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    if (ruleset !== undefined) {
      if (ruleset.needsRecovery()) {
        try {
          ruleset.recover();
        } catch (error) {
          logger.error("ruleset_recovery_failed", {
            sessionId: principal.sessionId,
            actor: { kind: "system", id: "system" },
            detail: { cause: error instanceof Error ? error.name : "unknown" },
          });
        }
      }
      if (ruleset.needsRecovery()) {
        ack(timed({
          ok: false,
          request_id: payload.request_id,
          code: "WRONG_PHASE",
          message: "Wait for the next question",
        }));
        return;
      }
      ruleset.lockExpiredPhaseA();
      if (inbound === "one_answer" && principal.playerId !== ruleset.game?.onePlayerId) {
        const result = rejectedCommand({
          sessionId: principal.sessionId,
          commandType: "one_answer",
          actorKind: "player",
          actorId: principal.playerId,
          requestId: payload.request_id,
          payload,
          code: "FORBIDDEN",
          message: "You cannot answer this question",
          disposition: "terminal",
        });
        ack(timed({ ...result, request_id: result.requestId }));
        return;
      }
      const attemptId = payload.attempt_id ?? ruleset.game?.snapshot.active?.attempt_id;
      if (attemptId === undefined) {
        const result = rejectedCommand({
          sessionId: principal.sessionId,
          commandType: inbound === "one_answer" ? "one_answer" : "student_answer",
          actorKind: "player",
          actorId: principal.playerId,
          requestId: payload.request_id,
          payload,
          code: "WRONG_PHASE",
          message: "Wait for the next question",
          disposition: "transient",
        });
        ack(timed({ ...result, request_id: result.requestId }));
        return;
      }
      const result = principal.playerId === ruleset.game?.onePlayerId
        ? ruleset.answerOne({
            playerId: principal.playerId,
            requestId: payload.request_id,
            attemptId,
            questionId: payload.question_id,
            choice: payload.choice,
          })
        : ruleset.answerPhaseA({
            playerId: principal.playerId,
            requestId: payload.request_id,
            attemptId,
            questionId: payload.question_id,
            choice: payload.choice,
          });
      const messages: Readonly<Record<string, string>> = {
        WRONG_PHASE: "Wait for the next question",
        TOO_LATE: "Time is up for this question",
        ALREADY_ANSWERED: "Your answer is already locked",
        STALE_ATTEMPT: "That question has finished",
        FORBIDDEN: "You cannot answer this question",
        INVALID_CHOICE: "Choose one of the answers shown",
        REQUEST_MISMATCH: "Please try that answer again",
      };
      ack(timed(result.ok
        ? { ...result, request_id: result.requestId, locked: true }
        : { ...result, request_id: result.requestId, message: result.message ?? messages[result.code] ?? "Ask your teacher for help" }));
      return;
    }
    const idempotencyPayload = {
      attempt_id: payload.attempt_id ?? null,
      question_id: payload.question_id,
      choice: payload.choice,
    };
    const replay = coordinator.replay({
      sessionId: principal.sessionId,
      commandType: "answer",
      actorKind: "player",
      actorId: principal.playerId,
      requestId: payload.request_id,
      payload: idempotencyPayload,
    });
    if (replay !== undefined) {
      ack(timed(replay.ok
        ? { ...replay, request_id: replay.requestId, locked: true }
        : { ...replay, request_id: replay.requestId }));
      return;
    }
    if (sessionEnded(principal.sessionId)) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "answer",
        actorKind: "player",
        actorId: principal.playerId,
        requestId: payload.request_id,
        payload: idempotencyPayload,
        code: "SESSION_ENDED",
        message: "This show has ended",
        disposition: "terminal",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    const round = roundFor(principal.sessionId);
    if (round === undefined) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "answer",
        actorKind: "player",
        actorId: principal.playerId,
        requestId: payload.request_id,
        payload: idempotencyPayload,
        code: "WRONG_PHASE",
        disposition: "transient",
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    ensureDeadlineLocked(principal.sessionId, round);
    const snapshot = round.liveSnapshot(principal.playerId);
    const attemptId = payload.attempt_id ?? snapshot.attempt_id;
    if (attemptId === null) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "answer",
        actorKind: "player",
        actorId: principal.playerId,
        requestId: payload.request_id,
        payload: idempotencyPayload,
        code: "WRONG_PHASE",
        message: "Wait for the next question",
        disposition: "transient",
      });
      ack(timed({ ...result, request_id: result.requestId }, round));
      return;
    }
    const result = round.answer({
      actorId: principal.playerId,
      requestId: payload.request_id,
      attemptId,
      questionId: payload.question_id,
      choice: payload.choice,
      idempotencyPayload,
    });
    const messages: Readonly<Record<string, string>> = {
      WRONG_PHASE: "Wait for the next question",
      TOO_LATE: "Time is up for this question",
      ALREADY_ANSWERED: "Your answer is already locked",
      STALE_ATTEMPT: "That question has finished",
      FORBIDDEN: "You cannot answer this question",
      INVALID_CHOICE: "Choose one of the answers shown",
      REQUEST_MISMATCH: "Please try that answer again",
    };
    ack(timed(result.ok
      ? { ...result, request_id: result.requestId, locked: true }
      : {
          ...result,
          request_id: result.requestId,
          message: messages[result.code] ?? "Ask your teacher for help",
        }, round));
  }

  function handleHelp(socket: Socket, payload: HelpPayload, ack: Ack, help: "poll" | "ask" | "trust"): void {
    const principal = socketPrincipals.get(socket.id);
    if (principal?.role !== "student") {
      ack(timed({ ok: false, request_id: payload.request_id, code: "FORBIDDEN", message: "Only The One can use a help" }));
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    if (ruleset === undefined) {
      ack(timed({ ok: false, request_id: payload.request_id, code: "WRONG_PHASE", message: "Wait for The One's turn" }));
      return;
    }
    const result = help === "poll"
      ? payload.choice === undefined
        ? { ok: false as const, requestId: payload.request_id, code: "INVALID_CHOICE", message: "Choose one of the answers shown" }
        : ruleset.helpPoll({ playerId: principal.playerId, requestId: payload.request_id, choice: payload.choice })
      : help === "ask"
        ? ruleset.helpAsk({ playerId: principal.playerId, requestId: payload.request_id })
        : ruleset.helpTrust({ playerId: principal.playerId, requestId: payload.request_id });
    ack(timed(result.ok
      ? { ...result, request_id: result.requestId }
      : { ...result, request_id: result.requestId, message: result.message ?? "That help is not available right now" }));
  }

  function handleEndSession(socket: Socket, payload: EndSessionPayload, ack: Ack): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    if (ruleset !== undefined) {
      const rulesetResult = ruleset.endSession({
        teacherId: principal.teacherId,
        requestId: payload.request_id,
        reason: "teacher",
      });
      ack(timed({ ...rulesetResult, request_id: rulesetResult.requestId }));
      return;
    }
    const now = Date.now();
    const result = coordinator.execute({
      sessionId: principal.sessionId,
      commandType: "end_session",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload: {},
      createdAtMs: now,
      propose: () => {
        const session = database
          .prepare("SELECT status FROM sessions WHERE session_id = ?")
          .get(principal.sessionId) as { status: string } | undefined;
        if (session === undefined || session.status === "ended") {
          return { code: "SESSION_ENDED", message: "This show has already ended", disposition: "terminal" };
        }
        return {
          state: principal.sessionId,
          eventType: "session_ended",
          eventPayload: { reason: "teacher" },
          persist: () => {
            database
              .prepare("UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?")
              .run(now, principal.sessionId);
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: payload.request_id,
            serverSeq: event.serverSeq,
          }),
          apply: (sessionId, event) => {
            clearRoundTimer(sessionId);
            const ended = Object.freeze({
              session_id: sessionId,
              reason: "teacher",
              server_seq: event.serverSeq,
              server_time_ms: now,
              deadline_ms: null,
            });
            const emitter = emitterFor(sessionId);
            emitApplicationPacket(emitter, "session_ended", { teacher: ended, projector: ended, players: ended });
            emitApplicationPacket(emitter, "session_end", { teacher: ended, projector: ended, players: ended });
          },
        };
      },
    });
    ack(timed(result.ok ? { ...result, request_id: result.requestId } : result));
  }

  function handleRotateSessionCode(
    socket: Socket,
    payload: RotateSessionCredentialPayload,
    ack: Ack,
  ): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const result = rotateSessionCode(database, {
      sessionId: principal.sessionId,
      teacherId: principal.teacherId,
      requestId: payload.request_id,
      secret: tokenSecret,
    }, logger);
    if (!result.ok) {
      ack({ ...result, request_id: result.requestId });
      return;
    }
    const code = teacherSessionCode(database, principal.teacherId, principal.sessionId, tokenSecret);
    ack({ ...result, request_id: result.requestId, code });
  }

  function handleRotateProjectorCredential(
    socket: Socket,
    payload: RotateSessionCredentialPayload,
    ack: Ack,
  ): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const result = rotateProjectorCredential(database, {
      sessionId: principal.sessionId,
      teacherId: principal.teacherId,
      requestId: payload.request_id,
      secret: tokenSecret,
    }, logger);
    if (result.ok) {
      setTimeout(() => {
        void io.in(projectorRoom(principal.sessionId)).disconnectSockets(true);
      }, 0);
      ack({
        ...result,
        request_id: result.requestId,
        projector_token: result.projectorToken,
      });
      return;
    }
    ack({ ...result, request_id: result.requestId });
  }

  async function handleStartSession(socket: Socket, payload: StartSessionPayload, ack: Ack): Promise<void> {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    let ruleset = rulesetFor(principal.sessionId);
    if (ruleset === undefined) {
      // First 1v100 start on a generic session: activate the ruleset (write
      // mode + defaults into settings_json via the coordinator), then the
      // lazy rulesetFor constructs the engine. Own request id: the start
      // command's id must stay free for the engine's dedupe.
      const genericPhase = roundFor(principal.sessionId)?.phase ?? "LOBBY";
      if (genericPhase !== "LOBBY" && genericPhase !== "REVEALED") {
        const rejected = rejectedCommand({
          sessionId: principal.sessionId,
          commandType: "activate_one_v_100",
          actorKind: "teacher",
          actorId: principal.teacherId,
          requestId: payload.request_id,
          payload: {},
          code: "WRONG_PHASE",
          message: "Finish the open question first, then start the show",
          disposition: "transient",
        });
        ack(timed({ ...rejected, request_id: rejected.requestId }));
        return;
      }
      const current = parseSettingsJson(
        (database.prepare("SELECT settings_json FROM sessions WHERE session_id = ?")
          .get(principal.sessionId) as { settings_json: string }).settings_json,
      );
      const activated = {
        ...ONE_V_100_DEFAULT_SETTINGS,
        phase_a_seconds: current.phase_a_seconds,
        base_strikes: current.base_strikes,
        momentum_enabled: current.momentum_enabled,
        momentum_threshold: current.momentum_threshold,
        questions_per_game: current.questions_per_game,
        session_question_budget: current.session_question_budget,
      };
      const activation = coordinator.execute({
        sessionId: principal.sessionId,
        commandType: "activate_one_v_100",
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: randomUUID(),
        payload: { mode: "one_v_100" },
        createdAtMs: Date.now(),
        propose: () => ({
          state: null,
          eventType: "mode_activated",
          eventPayload: { mode: "one_v_100", settings: activated },
          persist: () => {
            database.prepare(
              "UPDATE sessions SET settings_json = ?, settings_revision = settings_revision + 1 WHERE session_id = ?",
            ).run(JSON.stringify(activated), principal.sessionId);
          },
          outcome: (event) => Object.freeze({ ok: true as const, requestId: payload.request_id, serverSeq: event.serverSeq }),
          apply: () => undefined,
        }),
      });
      if (activation.ok !== true) {
        ack(timed({ ...activation, request_id: payload.request_id }));
        return;
      }
      logger.info("one_v_100_activated", {
        sessionId: principal.sessionId,
        actor: { kind: "teacher", id: principal.teacherId },
        detail: { source: "teacher_start_session" },
      });
      ruleset = rulesetFor(principal.sessionId);
      if (ruleset === undefined) {
        ack({ ok: false, request_id: payload.request_id, code: "ACTIVATION_FAILED", message: "Could not start the show. Try again." });
        return;
      }
    }
    const result = ruleset.startSession({
      teacherId: principal.teacherId,
      requestId: payload.request_id,
      firstOnePlayerId: payload.first_one_player_id,
    });
    if (result.ok) {
      await rulesetPublications.get(principal.sessionId);
    }
    ack(timed({ ...result, request_id: result.requestId }));
  }

  function handleSelectNextOne(socket: Socket, payload: SelectNextOnePayload, ack: Ack): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    if (ruleset === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "GENERIC_SESSION" });
      return;
    }
    const result = ruleset.selectNextOne({
      teacherId: principal.teacherId,
      requestId: payload.request_id,
      playerId: payload.player_id,
    });
    ack(timed({ ...result, request_id: result.requestId }));
  }

  function handleTeacherSettings(socket: Socket, payload: TeacherSettingsPayload, ack: Ack): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, request_id: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const ruleset = rulesetFor(principal.sessionId);
    const { request_id: requestId, ...patch } = payload;
    if (ruleset !== undefined) {
      const result = ruleset.updateSettings({
        teacherId: principal.teacherId,
        requestId,
        patch,
      });
      ack(timed({ ...result, request_id: result.requestId }));
      return;
    }
    const result = coordinator.execute({
      sessionId: principal.sessionId,
      commandType: "teacher_settings",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId,
      payload: patch,
      createdAtMs: wallNow(),
      propose: () => {
        const session = database.prepare(
          "SELECT teacher_id, settings_json, settings_revision FROM sessions WHERE session_id = ?",
        ).get(principal.sessionId) as {
          teacher_id: string;
          settings_json: string;
          settings_revision: number;
        } | undefined;
        if (session === undefined || session.teacher_id !== principal.teacherId) {
          return { code: "FORBIDDEN", disposition: "terminal" };
        }
        let next;
        try {
          next = applyTeacherSettingsPatch(parseSettingsJson(session.settings_json), patch);
        } catch (error) {
          return {
            code: "INVALID_SETTINGS",
            message: error instanceof SettingsValidationError
              ? error.message
              : "Settings could not be updated",
            disposition: "terminal",
          };
        }
        const revision = session.settings_revision + 1;
        return {
          state: next,
          eventType: "settings_updated",
          eventPayload: { settings_revision: revision, changed: Object.keys(patch) },
          persist: () => {
            database.prepare(
              `UPDATE sessions SET settings_json = ?, settings_revision = settings_revision + 1
               WHERE session_id = ?`,
            ).run(JSON.stringify(next), principal.sessionId);
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId,
            serverSeq: event.serverSeq,
            settings_revision: revision,
            phase_a_seconds: next.phase_a_seconds,
          }),
          apply: () => undefined,
        };
      },
    });
    ack(timed({ ...result, request_id: result.requestId }, roundFor(principal.sessionId)));
  }

  function handleAttachQuestionSet(
    socket: Socket,
    payload: AttachQuestionSetPayload,
    ack: Ack,
  ): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, requestId: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const result = attachQuestionSetToSession(database, {
      sessionId: principal.sessionId,
      teacherId: principal.teacherId,
      requestId: payload.request_id,
      questionSetId: payload.question_set_id,
    }, (event) => {
      emitApplicationPacket(emitterFor(principal.sessionId), "question_set_attached", { teacher: {
        ...event.payload,
        server_seq: event.serverSeq,
        server_time_ms: Date.now(),
      } });
    }, logger);
    ack(result);
  }

  function handleKickPlayer(socket: Socket, payload: KickPlayerPayload, ack: Ack): void {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({ ok: false, requestId: payload.request_id, code: "FORBIDDEN" });
      return;
    }
    const replay = coordinator.replay({
      sessionId: principal.sessionId,
      commandType: "kick_player",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload,
    });
    if (replay !== undefined) {
      ack(replay);
      return;
    }
    if (sessionEnded(principal.sessionId)) {
      const result = rejectedCommand({
        sessionId: principal.sessionId,
        commandType: "kick_player",
        actorKind: "teacher",
        actorId: principal.teacherId,
        requestId: payload.request_id,
        payload,
        code: "SESSION_ENDED",
        message: "This show has ended",
        disposition: "terminal",
      });
      ack(result);
      return;
    }
    const player = database
      .prepare(
        `SELECT player_id, nickname, kicked_at_ms FROM session_players
         WHERE session_id = ? AND player_id = ?`,
      )
      .get(principal.sessionId, payload.player_id) as
      | { player_id: string; nickname: string; kicked_at_ms: number | null }
      | undefined;
    const now = Date.now();
    const kickPause = rulesetFor(principal.sessionId)?.prepareKickPause(player?.player_id ?? "");
    const result = coordinator.execute({
      sessionId: principal.sessionId,
      commandType: "kick_player",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload,
      createdAtMs: now,
      propose: () => {
        if (player === undefined || player.kicked_at_ms !== null) {
          return { code: "PLAYER_NOT_ACTIVE", message: "That player is not in the game", disposition: "terminal" };
        }
        return {
          state: player,
          eventType: "player_kicked",
          eventPayload: { player_id: player.player_id, nickname: player.nickname },
          followingEvents: kickPause === undefined ? [] : [{
            eventType: "pause_state",
            eventPayload: kickPause.eventPayload,
            actorKind: "system" as const,
            actorId: "system",
          }],
          persist: () => {
            database
              .prepare(
                `UPDATE session_players
                 SET kicked_at_ms = ?, token_hash = ?
                 WHERE session_id = ? AND player_id = ? AND kicked_at_ms IS NULL`,
              )
              .run(now, tokenHash(`revoked:${player.player_id}:${now}`), principal.sessionId, player.player_id);
            kickPause?.persist();
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: payload.request_id,
            serverSeq: event.serverSeq,
          }),
           apply: (_state, _event, _outcome, events) => {
            const kickedRoom = playerRoom(principal.sessionId, player.player_id);
            emitApplicationPacket(emitterFor(principal.sessionId), "kicked", {
              [`player:${player.player_id}`]: {
                code: "KICKED",
                message: "Your teacher removed you from this game",
              },
            });
            broadcastRoster(principal.sessionId);
             const pauseEvent = events.find((event) => event.eventType === "pause_state");
             if (kickPause !== undefined && pauseEvent !== undefined) kickPause.apply(pauseEvent.serverSeq);
            setTimeout(() => {
              void io.in(kickedRoom).disconnectSockets(true);
            }, 0);
          },
        };
      },
    });
    ack(result);
  }

  async function handleAssignRole(
    socket: Socket,
    payload: AssignRolePayload,
    ack: Ack,
  ): Promise<void> {
    const principal = activeTeacherPrincipal(socket);
    if (principal === undefined) {
      ack({
        ok: false,
        requestId: payload.request_id,
        code: "FORBIDDEN",
        message: "Ask your teacher for help",
      });
      return;
    }
    const commandPayload = { player_id: payload.player_id, role: payload.role };
    const replay = coordinator.replay({
      sessionId: principal.sessionId,
      commandType: "assign_role",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload: commandPayload,
    });
    if (replay !== undefined) {
      ack(replay);
      return;
    }
    const result = coordinator.execute<Readonly<{ playerId: string; role: PlayerRole }>,
      | Readonly<{ ok: true; requestId: string; serverSeq: number; player_id: string; role: PlayerRole }>
      | Readonly<{ ok: false; requestId: string; code: string; message?: string }>>({
      sessionId: principal.sessionId,
      commandType: "assign_role",
      actorKind: "teacher",
      actorId: principal.teacherId,
      requestId: payload.request_id,
      payload: commandPayload,
      createdAtMs: wallNow(),
      propose: () => {
        const ruleset = rulesetFor(principal.sessionId);
        const phase = ruleset?.phase ?? roundFor(principal.sessionId)?.phase ?? "LOBBY";
        const legal = ruleset === undefined ? ["LOBBY", "REVEALED"] : ["LOBBY", "LEADERBOARD"];
        if (!legal.includes(phase)) {
          return {
            code: "WRONG_PHASE",
            message: "Wait until this question is finished",
            disposition: "transient",
          };
        }
        if (!(["one", "mob", "crowd"] as const).some((role) => role === payload.role)) {
          return { code: "INVALID_ROLE", message: "Choose a role shown by the game", disposition: "terminal" };
        }
        const role = payload.role as PlayerRole;
        const ownedSession = database
          .prepare("SELECT session_id, status FROM sessions WHERE session_id = ? AND teacher_id = ?")
          .get(principal.sessionId, principal.teacherId) as { session_id: string; status: string } | undefined;
        if (ownedSession === undefined) {
          return { code: "FORBIDDEN", message: "Ask your teacher for help", disposition: "terminal" };
        }
        if (ownedSession.status === "ended") {
          return { code: "SESSION_ENDED", message: "This show has ended", disposition: "terminal" };
        }
        const player = database
          .prepare(
            `SELECT player_id FROM session_players
             WHERE session_id = ? AND player_id = ? AND kicked_at_ms IS NULL`,
          )
          .get(principal.sessionId, payload.player_id) as { player_id: string } | undefined;
        if (player === undefined) {
          return { code: "PLAYER_NOT_FOUND", message: "That player is not in this game", disposition: "terminal" };
        }
        const state = Object.freeze({ playerId: player.player_id, role });
        return {
          state,
          eventType: "role_assigned",
          eventPayload: { player_id: player.player_id, role },
          persist: () => {
            database
              .prepare("UPDATE session_players SET role = ? WHERE session_id = ? AND player_id = ?")
              .run(role, principal.sessionId, player.player_id);
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: payload.request_id,
            serverSeq: event.serverSeq,
            player_id: player.player_id,
            role,
          }),
          apply: () => undefined,
        };
      },
    });
    if (!result.ok) {
      ack(result);
      return;
    }
    await movePlayerSocketsToRole(principal.sessionId, result.player_id, result.role);
    broadcastRoster(principal.sessionId);
    ack(result);
  }

  io.on("connection", (socket) => {
    const lifecycleWindow = Math.floor(monotonicNow() / 60_000);
    const source = socket.handshake.address;
    if (unauthenticatedLifecycleWindows.get(source) !== lifecycleWindow) {
      unauthenticatedLifecycleWindows.set(source, lifecycleWindow);
      for (const [candidate, window] of unauthenticatedLifecycleWindows) {
        if (window < lifecycleWindow - 1) unauthenticatedLifecycleWindows.delete(candidate);
      }
      logger.info("socket_connected", {
        actor: { kind: "unbound" },
        detail: { principal_kind: "unbound", transport: socket.conn.transport.name, throttled_window_ms: 60_000 },
      });
    }
    socket.use(([event, payload, packetAck], next) => {
      const second = Math.floor(monotonicNow() / 1_000);
      if (["join_session", "resume", "projector_attach", "teacher_attach"].includes(event)) {
        const source = socket.handshake.address;
        const sourceWindow = preAuthSourceWindows.get(source);
        if (sourceWindow === undefined || sourceWindow.second !== second) {
          preAuthSourceWindows.set(source, { second, count: 1, logged: false });
        } else {
          sourceWindow.count += 1;
          const sourceLimit = Math.max(capacity * 2, preAuthRateLimitPerSecond);
          if (sourceWindow.count > sourceLimit) {
            if (!sourceWindow.logged) {
              sourceWindow.logged = true;
              logger.warn("rate_limit_hit", {
                actor: { kind: "unbound" },
                detail: { command: event, surface: "pre_auth_source", limit_per_second: sourceLimit },
              });
            }
            if (typeof packetAck === "function") {
              respondApplicationPacket(event, packetAck, {
                ok: false,
                code: "RATE_LIMITED",
                message: "Slow down and try again",
              }, logger);
            }
            next(new Error("RATE_LIMITED"));
            return;
          }
        }
        const window = preAuthWindows.get(socket.id);
        if (window === undefined || window.second !== second) {
          preAuthWindows.set(socket.id, { second, count: 1, logged: false });
          next();
          return;
        }
        window.count += 1;
        if (window.count <= preAuthRateLimitPerSecond) {
          next();
          return;
        }
        if (!window.logged) {
          window.logged = true;
          logger.warn("rate_limit_hit", {
            actor: { kind: "unbound" },
            detail: { command: event, surface: "pre_auth_socket", limit_per_second: preAuthRateLimitPerSecond },
          });
        }
        if (typeof packetAck === "function") {
          respondApplicationPacket(event, packetAck, {
            ok: false,
            code: "RATE_LIMITED",
            message: "Slow down and try again",
          }, logger);
        }
        next(new Error("RATE_LIMITED"));
        return;
      }
      const window = commandWindows.get(socket.id);
      if (window === undefined || window.second !== second) {
        commandWindows.set(socket.id, { second, count: 1 });
        next();
        return;
      }
      window.count += 1;
      if (window.count <= rateLimitPerSecond) {
        next();
        return;
      }
      const requestId = isPlainObject(payload) && typeof payload.request_id === "string"
        ? payload.request_id
        : uuidV7();
      const principal = socketPrincipals.get(socket.id);
      const logContext = principalContext(socket);
      logger.warn("rate_limit_hit", {
        ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
        actor: logContext.actor,
        detail: { command: event, limit_per_second: rateLimitPerSecond },
      });
      if (principal !== undefined) {
        store.append({
          sessionId: principal.sessionId,
          gameId: null,
          attemptId: null,
          eventType: "command_rejected",
          actorKind: principal.role === "student" ? "player" : "teacher",
          actorId:
            principal.role === "student"
              ? principal.playerId
              : principal.role === "teacher"
                ? principal.teacherId
                : `projector:${principal.sessionId}`,
          requestId: null,
          payload: {
            command_type: event,
            code: "RATE_LIMITED",
            request_id: requestId,
            disposition: "transient",
          },
          createdAtMs: wallNow(),
        });
      }
      if (principal !== undefined) {
        const error = {
          ok: false,
          request_id: requestId,
          code: "RATE_LIMITED",
          message: "Slow down and try again",
        };
        const emitter = emitterFor(principal.sessionId);
        if (principal.role === "student") {
          emitApplicationPacket(emitter, "command_error", { [`player:${principal.playerId}`]: error });
        } else if (principal.role === "teacher") {
          emitApplicationPacket(emitter, "command_error", { teacher: error });
        } else {
          emitApplicationPacket(emitter, "command_error", { projector: error });
        }
      }
      next(new Error("RATE_LIMITED"));
    });
    socket.on("join_session", withSocketBoundary(socket, "join_session", isJoinPayload, handleJoin, logger, () => principalContext(socket)));
    socket.on(
      "projector_attach",
      withSocketBoundary(socket, "projector_attach", isProjectorAttachPayload, handleProjectorAttach, logger, () => principalContext(socket)),
    );
    socket.on("resume", withSocketBoundary(socket, "resume", isResumePayload, handleResume, logger, () => principalContext(socket)));
    socket.on("answer_submit", withSocketBoundary(socket, "answer_submit", isAnswerPayload, (answerSocket, payload, ack) =>
      handleAnswer(answerSocket, payload, ack, "answer_submit"), logger, () => principalContext(socket)));
    socket.on("one_answer", withSocketBoundary(socket, "one_answer", isAnswerPayload, (answerSocket, payload, ack) =>
      handleAnswer(answerSocket, payload, ack, "one_answer"), logger, () => principalContext(socket)));
    socket.on("help_poll", withSocketBoundary(socket, "help_poll", isHelpPayload, (helpSocket, payload, ack) =>
      handleHelp(helpSocket, payload, ack, "poll"), logger, () => principalContext(socket)));
    socket.on("help_ask", withSocketBoundary(socket, "help_ask", isHelpPayload, (helpSocket, payload, ack) =>
      handleHelp(helpSocket, payload, ack, "ask"), logger, () => principalContext(socket)));
    socket.on("help_trust", withSocketBoundary(socket, "help_trust", isHelpPayload, (helpSocket, payload, ack) =>
      handleHelp(helpSocket, payload, ack, "trust"), logger, () => principalContext(socket)));
    socket.on("teacher_open_question", withSocketBoundary(socket, "teacher_open_question", isOpenQuestionPayload, handleOpenQuestion, logger, () => principalContext(socket)));
    socket.on("teacher_start_session", withSocketBoundary(socket, "teacher_start_session", isStartSessionPayload, handleStartSession, logger, () => principalContext(socket)));
    socket.on("teacher_select_next_one", withSocketBoundary(socket, "teacher_select_next_one", isSelectNextOnePayload, handleSelectNextOne, logger, () => principalContext(socket)));
    socket.on("teacher_settings", withSocketBoundary(socket, "teacher_settings", isTeacherSettingsPayload, handleTeacherSettings, logger, () => principalContext(socket)));
    socket.on(
      "teacher_end_session",
      withSocketBoundary(socket, "teacher_end_session", isEndSessionPayload, handleEndSession, logger, () => principalContext(socket)),
    );
    socket.on(
      "teacher_rotate_session_code",
      withSocketBoundary(socket, "teacher_rotate_session_code", isRotateSessionCredentialPayload, handleRotateSessionCode, logger, () => principalContext(socket)),
    );
    socket.on(
      "teacher_rotate_projector_credential",
      withSocketBoundary(socket, "teacher_rotate_projector_credential", isRotateSessionCredentialPayload, handleRotateProjectorCredential, logger, () => principalContext(socket)),
    );
    socket.on("kick_player", withSocketBoundary(socket, "kick_player", isKickPlayerPayload, handleKickPlayer, logger, () => principalContext(socket)));
    socket.on("assign_role", withSocketBoundary(socket, "assign_role", isAssignRolePayload, handleAssignRole, logger, () => principalContext(socket)));
    socket.on(
      "teacher_attach_question_set",
      withSocketBoundary(socket, "teacher_attach_question_set", isAttachQuestionSetPayload, handleAttachQuestionSet, logger, () => principalContext(socket)),
    );
    socket.on(
      "teacher_attach",
      withSocketBoundary(socket, "teacher_attach", isTeacherAttachPayload, handleTeacherAttach, logger, () => principalContext(socket)),
    );
    for (const [event, control] of [
      ["teacher_advance", "advance"],
      ["teacher_pause", "pause"],
      ["teacher_resume", "resume"],
      ["teacher_force_reveal", "forceReveal"],
    ] as const) {
      socket.on(
        event,
        withSocketBoundary(socket, event, isTeacherControlPayload, (controlSocket, payload, ack) =>
          handleTeacherControl(controlSocket, payload, ack, control),
        logger, () => principalContext(socket)),
      );
    }
    socket.on("disconnect", (reason) => {
      try {
        const principal = socketPrincipals.get(socket.id);
        if (principal !== undefined) {
          const logContext = principalContext(socket);
          logger.info("socket_disconnected", {
            ...(logContext.sessionId === undefined ? {} : { sessionId: logContext.sessionId }),
            actor: logContext.actor,
            detail: { principal_kind: logContext.actor.kind, reason },
          });
        }
        socketPrincipals.delete(socket.id);
        commandWindows.delete(socket.id);
        preAuthWindows.delete(socket.id);
        const player = socketPlayers.get(socket.id);
        if (player === undefined) {
          return;
        }
        socketPlayers.delete(socket.id);
        const sockets = onlinePlayers.get(player.playerId);
        sockets?.delete(socket.id);
        if (sockets?.size === 0) {
          onlinePlayers.delete(player.playerId);
          const ruleset = rulesetFor(player.sessionId);
          if (
            ruleset?.game?.onePlayerId === player.playerId &&
            (ruleset.phase === "PHASE_B" || ruleset.phase === "PAUSED")
          ) {
            ruleset.pauseOneDisconnected(player.playerId);
          }
        }
        broadcastRoster(player.sessionId);
      } catch (error) {
        logger.error("socket_disconnect_cleanup_failed", {
          actor: { kind: "system", id: "system" },
          detail: { cause: error instanceof Error ? error.name : "unknown" },
        });
      }
    });
  });

  io.engine.on("close", () => {
    unsubscribeRevocations();
    for (const sessionId of roundTimers.keys()) clearRoundTimer(sessionId);
    for (const timer of rulesetTimers.values()) clearTimeout(timer);
    for (const timer of lockCountTimers.values()) clearTimeout(timer);
  });

  return io;
}
