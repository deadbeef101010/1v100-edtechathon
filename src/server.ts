import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APP_VERSION } from "./version.js";
import { loadConfig, loadEnvironmentFile } from "./config.js";
import {
  createMetaToken,
  createProjectorTokenForRequest,
  createTeacherToken,
  verifyMetaToken,
  verifyTeacherToken,
} from "./auth.js";
import { openDatabase, type AppDatabase } from "./db.js";
import { authenticateTeacherKey } from "./teachers.js";
import {
  archiveSession,
  createClassroomSession,
  listTeacherSessions,
  teacherSessionCode,
  unarchiveSession,
} from "./sessions.js";
import { attachSocketGateway } from "./socket-gateway.js";
import type { QuestionRound } from "./question-round.js";
import { DevLoginRateLimiter, handleDevViewRequest } from "./dev-views.js";
import { DevBotRunRegistry, type BotCommand } from "./dev-bot-runs.js";
import { listQuestionSets } from "./question-sets.js";
import { MetaAdminService } from "./meta-admin.js";
import { createSilentLogger, ServerLogger, serverLogger } from "./log.js";
import {
  QuestionImportFormatError,
  QuestionImportValidationError,
  importQuestionsCsv,
  type QuestionImportResult,
} from "./question-import.js";
import {
  CommandCoordinator,
  type CommandError,
  type CommandSuccess,
} from "./command-coordinator.js";
import { createPresenceRegistry, type PresenceRegistry } from "./presence.js";

const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../static", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
});

export type AppServerOptions = {
  staticDir?: string;
  database?: AppDatabase;
  tokenSecret?: string;
  metaKeyHash?: string;
  rounds?: Map<string, QuestionRound>;
  devViews?: boolean;
  devToken?: string;
  botCommand?: BotCommand;
  botStopTimeoutMs?: number;
  logger?: ServerLogger;
  buildSha?: string;
  publicBaseUrl?: string;
  presence?: PresenceRegistry;
};

const META_COOKIE_NAME = "meta_session";
const TEACHER_COOKIE_NAME = "teacher_session";

export type GameServerOptions = AppServerOptions & Readonly<{
  database: AppDatabase;
  tokenSecret: string;
}>;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

class PayloadTooLargeError extends Error {}

const QUESTION_IMPORT_MAX_BYTES = 256 * 1_024;

type QuestionImportOutcome = CommandError | (CommandSuccess & Readonly<{
  sets_created: number;
  questions_imported: number;
}>);

type CreateSessionOutcome = CommandError | (CommandSuccess & Readonly<{
  sessionId: string;
  projectorExpiresAtMs: number;
}>);

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 16 * 1_024) {
      throw new PayloadTooLargeError("Request body too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function readTextBody(
  request: import("node:http").IncomingMessage,
  limit: number,
): Promise<Readonly<{ text: string; bytes: number }>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new PayloadTooLargeError("Request body too large");
    chunks.push(buffer);
  }
  return Object.freeze({ text: Buffer.concat(chunks).toString("utf8"), bytes: size });
}

function cookieValue(
  request: import("node:http").IncomingMessage,
  name: string,
): string | undefined {
  const prefix = `${name}=`;
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function metaAuthorized(
  request: import("node:http").IncomingMessage,
  tokenSecret: string,
  metaKeyHash: string,
): boolean {
  const token = cookieValue(request, META_COOKIE_NAME);
  if (token === undefined) {
    return false;
  }
  try {
    verifyMetaToken(token, tokenSecret, metaKeyHash);
    return true;
  } catch {
    return false;
  }
}

function sendMetaNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not_found" });
}

function requestIdFrom(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("request_id" in body) ||
    typeof body.request_id !== "string" ||
    body.request_id.length < 1 ||
    body.request_id.length > 100
  ) {
    return undefined;
  }
  return body.request_id;
}

function requestSource(request: import("node:http").IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

const TEACHER_LOGIN_WINDOW_MS = 60_000;
const MAX_GLOBAL_TEACHER_LOGIN_ATTEMPTS = 30;
const MAX_SOURCE_FAILED_TEACHER_LOGINS = 5;
const MAX_TRACKED_LOGIN_SOURCES = 10_000;

// Limits are enforced before authenticateTeacherKey runs so rate-limited
// floods never reach the database: every failed attempt otherwise writes a
// durable auth_events row that can never be pruned.
export class TeacherLoginRateLimiter {
  #globalBucket = -1;
  #globalCount = 0;
  readonly #failedBySource = new Map<string, { bucket: number; count: number }>();

  consume(source: string, now = Date.now()): boolean {
    const bucket = Math.floor(now / TEACHER_LOGIN_WINDOW_MS);
    if (bucket !== this.#globalBucket) {
      this.#globalBucket = bucket;
      this.#globalCount = 0;
    }
    this.#globalCount += 1;
    if (this.#globalCount > MAX_GLOBAL_TEACHER_LOGIN_ATTEMPTS) return false;
    const failures = this.#failedBySource.get(source);
    return !(failures?.bucket === bucket && failures.count >= MAX_SOURCE_FAILED_TEACHER_LOGINS);
  }

  recordFailure(source: string, now = Date.now()): void {
    const bucket = Math.floor(now / TEACHER_LOGIN_WINDOW_MS);
    if (!this.#failedBySource.has(source) && this.#failedBySource.size >= MAX_TRACKED_LOGIN_SOURCES) {
      const oldestSource = this.#failedBySource.keys().next().value as string | undefined;
      if (oldestSource !== undefined) this.#failedBySource.delete(oldestSource);
    }
    const failures = this.#failedBySource.get(source);
    const next = failures?.bucket === bucket ? failures : { bucket, count: 0 };
    next.count += 1;
    this.#failedBySource.set(source, next);
  }

  recordSuccess(source: string): void {
    this.#failedBySource.delete(source);
  }
}

function isJsonContentType(request: import("node:http").IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType);
}

async function handleMetaLogin(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  service: MetaAdminService,
  tokenSecret: string,
  metaKeyHash: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    service.rejectLogin(requestSource(request), "malformed_json");
    sendMetaNotFound(response);
    return;
  }
  const key =
    typeof body === "object" && body !== null && "key" in body && typeof body.key === "string"
      ? body.key.trim()
      : "";
  if (service.authenticate(key, requestSource(request)) !== "ok") {
    sendMetaNotFound(response);
    return;
  }
  const token = createMetaToken(tokenSecret, metaKeyHash);
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${META_COOKIE_NAME}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=1800`,
  );
  sendJson(response, 200, { ok: true });
}

function handleListTeachers(response: ServerResponse, service: MetaAdminService): void {
  sendJson(response, 200, { teachers: service.listTeachers() });
}

async function handleMintTeacher(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  service: MetaAdminService,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    service.recordMutationOutcome("mint", "malformed_json");
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const label =
    typeof body === "object" && body !== null && "label" in body && typeof body.label === "string"
      ? body.label.trim()
      : "";
  const requestId = requestIdFrom(body);
  if (requestId === undefined) {
    service.recordMutationOutcome("mint", "invalid_request_id");
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  let result;
  try {
    result = service.mintTeacher(label, requestId);
  } catch (error) {
    service.recordMutationOutcome("mint", "internal_error");
    throw error;
  }
  if (!result.ok) {
    service.recordMutationOutcome("mint", result.code.toLowerCase());
    sendJson(response, result.code === "INVALID_LABEL" ? 400 : 409, {
      error: result.code.toLowerCase(),
      ...(result.message === undefined ? {} : { message: result.message }),
    });
    return;
  }
  service.recordMutationOutcome("mint", result.key === null ? "replayed" : "succeeded");
  if (result.key === null) {
    // Replayed request: the key was shown once at mint time and is not stored.
    sendJson(response, 200, {
      teacher_id: result.teacherId,
      key: null,
      code: "key_already_issued",
      warning: "This request already minted a key and keys are shown only once. Reissue to get a new key.",
    });
    return;
  }
  sendJson(response, 201, {
    teacher_id: result.teacherId,
    key: result.key,
    warning: "Copy this key now. It will not be shown again.",
  });
}

async function handleRevokeTeacher(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  service: MetaAdminService,
  teacherId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    service.recordMutationOutcome("revoke", "malformed_json");
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const confirmed =
    typeof body === "object" && body !== null && "confirm" in body && body.confirm === true;
  const requestId = requestIdFrom(body);
  if (!confirmed || requestId === undefined) {
    service.recordMutationOutcome(
      "revoke",
      !confirmed ? "confirmation_required" : "invalid_request_id",
    );
    sendJson(response, 400, { error: "confirmation_required" });
    return;
  }
  let result;
  try {
    result = service.revokeTeacher(teacherId, requestId);
  } catch (error) {
    service.recordMutationOutcome("revoke", "internal_error");
    throw error;
  }
  if (!result.ok) {
    service.recordMutationOutcome("revoke", result.code.toLowerCase());
    sendJson(response, result.code === "NOT_FOUND" ? 404 : 409, {
      error: result.code.toLowerCase(),
    });
    return;
  }
  service.recordMutationOutcome("revoke", "succeeded");
  sendJson(response, 200, { ok: true });
}

async function handleReissueTeacher(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  service: MetaAdminService,
  teacherId: string,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    service.recordMutationOutcome("reissue", "malformed_json");
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const confirmed =
    typeof body === "object" && body !== null && "confirm" in body && body.confirm === true;
  const requestId = requestIdFrom(body);
  if (!confirmed || requestId === undefined) {
    const error = !confirmed ? "confirmation_required" : "invalid_request";
    service.recordMutationOutcome(
      "reissue",
      !confirmed ? "confirmation_required" : "invalid_request_id",
    );
    sendJson(response, 400, { error });
    return;
  }
  let result;
  try {
    result = service.reissueTeacher(teacherId, requestId);
  } catch (error) {
    service.recordMutationOutcome("reissue", "internal_error");
    throw error;
  }
  if (!result.ok) {
    service.recordMutationOutcome("reissue", result.code.toLowerCase());
    sendJson(response, result.code === "NOT_FOUND" ? 404 : 409, {
      error: result.code.toLowerCase(),
    });
    return;
  }
  service.recordMutationOutcome("reissue", result.key === null ? "replayed" : "succeeded");
  if (result.key === null) {
    // Replayed request: the key was shown once at reissue time and is not stored.
    sendJson(response, 200, {
      teacher_id: result.teacherId,
      key: null,
      code: "key_already_issued",
      warning: "This request already reissued a key and keys are shown only once. Reissue again to get a new key.",
    });
    return;
  }
  sendJson(response, 200, {
    teacher_id: result.teacherId,
    key: result.key,
    warning: "Copy this key now. It will not be shown again.",
  });
}

async function handleTeacherLogin(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  database: AppDatabase,
  tokenSecret: string,
  limiter: TeacherLoginRateLimiter,
  logger: ServerLogger,
): Promise<void> {
  response.setHeader("cache-control", "no-store");
  const source = requestSource(request);
  if (!limiter.consume(source)) {
    logger.warn("auth_rate_limited", {
      actor: { kind: "teacher" },
      detail: { surface: "teacher_login" },
    });
    sendJson(response, 429, { error: "rate_limited" });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    limiter.recordFailure(source);
    logger.warn(error instanceof PayloadTooLargeError ? "payload_size_rejected" : "protocol_error", {
      actor: { kind: "teacher" },
      detail: { transport: "http", route: "/api/teacher/login", cause: error instanceof PayloadTooLargeError ? "body_too_large" : "invalid_json" },
    });
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const key =
    typeof body === "object" && body !== null && "key" in body && typeof body.key === "string"
      ? body.key
      : "";
  const teacher = authenticateTeacherKey(database, key);
  if (teacher === undefined) {
    limiter.recordFailure(source);
    logger.warn("auth_failure", {
      actor: { kind: "teacher" },
      detail: { surface: "teacher_login", reason: "invalid_credentials" },
    });
    sendJson(response, 401, { error: "invalid_credentials" });
    return;
  }
  limiter.recordSuccess(source);
  const token = createTeacherToken(teacher.teacherId, tokenSecret, Date.now(), teacher.keyPrefix);
  logger.info("teacher_login_succeeded", {
    actor: { kind: "teacher", id: teacher.teacherId },
    detail: { surface: "teacher_login" },
  });
  // Secure only over HTTPS: browsers silently drop Secure cookies on
  // plain-HTTP local and private-network deployments.
  const teacherCookieSecure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${TEACHER_COOKIE_NAME}=${token}; Path=/; HttpOnly${teacherCookieSecure}; SameSite=Strict; Max-Age=43200`,
  );
  sendJson(response, 200, { ok: true });
}

function handleTeacherLogout(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
): void {
  // Secure only over HTTPS: browsers can ignore Secure-flagged deletions on
  // plain-HTTP local or private-network deployments, making sign-out a no-op.
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${TEACHER_COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
  sendJson(response, 200, { ok: true });
}

function teacherIdFromRequest(
  request: import("node:http").IncomingMessage,
  database: AppDatabase,
  tokenSecret: string,
  logger?: ServerLogger,
  source: "any" | "cookie" = "any",
): string | undefined {
  const authorization = request.headers.authorization;
  const bearer = source === "cookie" || !authorization?.startsWith("Bearer ")
    ? undefined
    : authorization.slice("Bearer ".length);
  const cookieToken = cookieValue(request, TEACHER_COOKIE_NAME);
  const token = bearer ?? cookieToken;
  if (token === undefined) {
    logger?.warn("auth_failure", {
      actor: { kind: "teacher" },
      detail: { surface: "http_bearer", reason: "missing_token" },
    });
    return undefined;
  }
  let claims;
  try {
    claims = verifyTeacherToken(token, tokenSecret);
  } catch {
    logger?.warn("auth_failure", {
      actor: { kind: "teacher" },
      detail: { surface: "http_bearer", reason: "invalid_token" },
    });
    return undefined;
  }
  // Revocation invalidates previously minted teacher cookies on their next protected request.
  const teacher = database
    .prepare(
      `SELECT teacher_id FROM teachers
       WHERE teacher_id = ? AND status = 'active'
         AND ((? IS NULL AND key_rotated_at_ms IS NULL) OR key_prefix = ?)
         AND (expires_at_ms IS NULL OR expires_at_ms > ?)`,
    )
    .get(claims.teacherId, claims.keyPrefix ?? null, claims.keyPrefix ?? null, Date.now()) as
    | { teacher_id: string }
    | undefined;
  if (teacher === undefined) {
    logger?.warn("auth_failure", {
      actor: { kind: "teacher", id: claims.teacherId },
      detail: { surface: "http_bearer", reason: "inactive_principal" },
    });
  }
  return teacher?.teacher_id;
}

async function handleCreateSession(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): Promise<void> {
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger);
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    logger.warn(error instanceof PayloadTooLargeError ? "payload_size_rejected" : "protocol_error", {
      actor: { kind: "teacher", id: teacherId },
      detail: { transport: "http", route: "/api/sessions", cause: error instanceof PayloadTooLargeError ? "body_too_large" : "invalid_json" },
    });
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const requestId = requestIdFrom(body);
  const questionSetId = typeof body === "object" && body !== null && "question_set_id" in body &&
    typeof body.question_set_id === "string" && body.question_set_id.length > 0
    ? body.question_set_id
    : undefined;
  if (requestId === undefined) {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  let created: ReturnType<typeof createClassroomSession> | undefined;
  const outcome = new CommandCoordinator(database, undefined, logger).execute<null, CreateSessionOutcome>({
    scope: "teacher",
    teacherId,
    commandType: "create_classroom_session",
    actorKind: "teacher",
    actorId: teacherId,
    requestId,
    payload: { question_set_id: questionSetId ?? null },
    createdAtMs: Date.now(),
    propose: () => {
      const owned = questionSetId === undefined ? true : database.prepare(
        "SELECT 1 FROM question_sets WHERE question_set_id = ? AND teacher_id = ?",
      ).get(questionSetId, teacherId) !== undefined;
      if (!owned) {
        return { code: "QUESTION_SET_NOT_FOUND", disposition: "terminal" };
      }
      return {
        state: null,
        eventType: "classroom_session_created",
        eventPayload: { question_set_id: questionSetId ?? null },
        persist: () => {
          created = createClassroomSession(database, teacherId, tokenSecret, {
            ...(questionSetId === undefined ? {} : { questionSetId }),
            projectorTokenGenerator: (sessionId, expiresAtMs) =>
              createProjectorTokenForRequest(sessionId, requestId, expiresAtMs, tokenSecret),
          });
        },
        outcome: (event) => {
          if (created === undefined) throw new Error("Session creation did not persist");
          return Object.freeze({
            ok: true as const,
            requestId,
            serverSeq: event.serverSeq,
            sessionId: created.sessionId,
            projectorExpiresAtMs: created.projectorExpiresAtMs,
          });
        },
        apply: () => {
          if (created === undefined) throw new Error("Session creation did not persist");
          logger.info("classroom_session_created", {
            sessionId: created.sessionId,
            actor: { kind: "teacher", id: teacherId },
            detail: { request_id: requestId, question_set_selected: questionSetId !== undefined },
          });
        },
      };
    },
  });
  if (!outcome.ok) {
    sendJson(response, outcome.code === "QUESTION_SET_NOT_FOUND" ? 404 : 409, {
      error: outcome.code.toLowerCase(),
    });
    return;
  }
  const displayCode = teacherSessionCode(database, teacherId, outcome.sessionId, tokenSecret);
  if (displayCode === null) throw new Error("Created session has no display code");
  sendJson(response, 201, {
    session_id: outcome.sessionId,
    code: displayCode,
    projector_token: createProjectorTokenForRequest(
      outcome.sessionId,
      requestId,
      outcome.projectorExpiresAtMs,
      tokenSecret,
    ),
  });
}

function handleQuestionSets(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  url: URL,
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): void {
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger);
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  const subject = url.searchParams.get("subject")?.trim();
  const grade = url.searchParams.get("grade")?.trim();
  sendJson(response, 200, {
    question_sets: listQuestionSets(database, teacherId, {
      ...(subject === undefined || subject.length === 0 ? {} : { subject }),
      ...(grade === undefined || grade.length === 0 ? {} : { grade }),
    }),
  });
}

function handleTeacherSessions(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  url: URL,
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): void {
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger);
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  sendJson(response, 200, {
    sessions: listTeacherSessions(database, teacherId, tokenSecret, logger, {
      includeArchived: url.searchParams.get("archived") === "1",
    }),
  });
}

function handleTeacherSessionDeck(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): void {
  response.setHeader("cache-control", "no-store");
  // Strict cookie-derived identity: the answer key must never be reachable
  // via Authorization headers alone (review finding).
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger, "cookie");
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  const session = database.prepare(
    "SELECT teacher_id, question_set_id, deck_start_position FROM sessions WHERE session_id = ?",
  ).get(sessionId) as {
    teacher_id: string;
    question_set_id: string;
    deck_start_position: number;
  } | undefined;
  if (session === undefined) {
    logger.warn("teacher_deck_access_rejected", {
      sessionId,
      actor: { kind: "teacher", id: teacherId },
      detail: { reason: "session_not_found" },
    });
    sendJson(response, 404, { error: "session_not_found" });
    return;
  }
  if (session.teacher_id !== teacherId) {
    logger.warn("teacher_deck_access_rejected", {
      sessionId,
      actor: { kind: "teacher", id: teacherId },
      detail: { reason: "wrong_teacher" },
    });
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  const rows = database.prepare(
    `SELECT question_id, position, prompt, choices_json, correct_choice
     FROM questions WHERE question_set_id = ? ORDER BY position`,
  ).all(session.question_set_id) as Array<{
    question_id: string;
    position: number;
    prompt: string;
    choices_json: string;
    correct_choice: number;
  }>;
  const questions = rows.map((row) => {
    const choices = JSON.parse(row.choices_json) as unknown;
    if (!Array.isArray(choices) || !choices.every((choice) => typeof choice === "string")) {
      throw new Error(`Question ${row.question_id} has invalid choices`);
    }
    return Object.freeze({
      question_id: row.question_id,
      position: row.position,
      prompt: row.prompt,
      choices: Object.freeze(choices),
      correct_choice: row.correct_choice,
      played: row.position < session.deck_start_position,
    });
  });
  logger.info("teacher_deck_viewed", {
    sessionId,
    actor: { kind: "teacher", id: teacherId },
    detail: { cursor_position: session.deck_start_position, question_count: questions.length },
  });
  sendJson(response, 200, {
    cursor_position: session.deck_start_position,
    questions,
  });
}

async function handleSessionArchive(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  action: "archive" | "unarchive",
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): Promise<void> {
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger);
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  if (database.prepare(
    "SELECT 1 FROM sessions WHERE session_id = ? AND teacher_id = ?",
  ).get(sessionId, teacherId) === undefined) {
    sendJson(response, 404, { error: "session_not_found" });
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const requestId = requestIdFrom(body);
  if (requestId === undefined) {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  const mutate = action === "archive" ? archiveSession : unarchiveSession;
  const outcome = mutate(database, { sessionId, teacherId, requestId }, logger);
  if (!outcome.ok) {
    sendJson(response, outcome.code === "SESSION_NOT_FOUND" ? 404 : 409, {
      error: outcome.code.toLowerCase(),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    });
    return;
  }
  sendJson(response, 200, {
    ok: true,
    request_id: outcome.requestId,
    server_seq: outcome.serverSeq,
  });
}

async function handleQuestionImport(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  database: AppDatabase,
  tokenSecret: string,
  logger: ServerLogger,
): Promise<void> {
  const teacherId = teacherIdFromRequest(request, database, tokenSecret, logger);
  if (teacherId === undefined) {
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }
  const requestId = request.headers["x-request-id"];
  if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 100) {
    sendJson(response, 400, { error: "invalid_request" });
    return;
  }
  let body: Readonly<{ text: string; bytes: number }>;
  try {
    body = await readTextBody(request, QUESTION_IMPORT_MAX_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      logger.warn("payload_size_rejected", {
        actor: { kind: "teacher", id: teacherId },
        detail: {
          transport: "http",
          route: "/api/question-sets/import",
          max_bytes: QUESTION_IMPORT_MAX_BYTES,
        },
      });
      sendJson(response, 413, {
        error: "payload_too_large",
        max_bytes: QUESTION_IMPORT_MAX_BYTES,
      });
      return;
    }
    throw error;
  }
  const sourceHeader = request.headers["x-file-name"];
  const sourceName = typeof sourceHeader === "string" && sourceHeader.length <= 255
    ? sourceHeader
    : undefined;
  const digest = createHash("sha256").update(body.text).digest("hex");
  let imported: QuestionImportResult | undefined;
  try {
    const outcome = new CommandCoordinator(database, undefined, logger).execute<null, QuestionImportOutcome>({
      scope: "teacher",
      teacherId,
      commandType: "import_question_set",
      actorKind: "teacher",
      actorId: teacherId,
      requestId,
      payload: { digest, bytes: body.bytes, source_name: sourceName ?? null },
      createdAtMs: Date.now(),
      propose: () => ({
        state: null,
        eventType: "question_set_imported",
        eventPayload: { digest, bytes: body.bytes, source_name: sourceName ?? null },
        persist: () => {
          imported = importQuestionsCsv(database, body.text, {
            teacherId,
            ...(sourceName === undefined ? {} : { sourceName }),
          });
        },
        outcome: (event) => ({
          ok: true as const,
          requestId,
          serverSeq: event.serverSeq,
          sets_created: imported?.setsCreated ?? 0,
          questions_imported: imported?.questionsImported ?? 0,
        }),
        apply: () => {
          logger.info("question_set_imported", {
            actor: { kind: "teacher", id: teacherId },
            detail: {
              request_id: requestId,
              bytes: body.bytes,
              sets_created: imported?.setsCreated ?? 0,
              questions_imported: imported?.questionsImported ?? 0,
            },
          });
        },
      }),
    });
    if (!outcome.ok) {
      sendJson(response, outcome.code === "REQUEST_MISMATCH" ? 409 : 400, {
        error: outcome.code.toLowerCase(),
      });
      return;
    }
    sendJson(response, 201, {
      sets_created: outcome.sets_created,
      questions_imported: outcome.questions_imported,
    });
  } catch (error) {
    if (error instanceof QuestionImportValidationError) {
      logger.warn("question_set_import_rejected", {
        actor: { kind: "teacher", id: teacherId },
        detail: { request_id: requestId, reason: "row_validation", error_count: error.errors.length },
      });
      sendJson(response, 422, { error: "validation_failed", errors: error.errors });
      return;
    }
    if (error instanceof QuestionImportFormatError) {
      logger.warn("question_set_import_rejected", {
        actor: { kind: "teacher", id: teacherId },
        detail: { request_id: requestId, reason: "invalid_csv" },
      });
      sendJson(response, 400, { error: "invalid_csv", message: error.message });
      return;
    }
    throw error;
  }
}

async function serveStatic(
  response: ServerResponse,
  relativeUrlPath: string,
  staticDir: string,
): Promise<void> {
  const relativePath = normalize(decodeURIComponent(relativeUrlPath));
  const filePath = join(staticDir, relativePath);
  const staticPrefix = staticDir.endsWith(sep) ? staticDir : `${staticDir}${sep}`;

  if (!filePath.startsWith(staticPrefix)) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      // Assets are unfingerprinted and redeploy often; force revalidation so a
      // cached student.js can never run against a newer student.html (mismatched
      // element ids -> the join hangs on "Joining the show...").
      "cache-control": "no-cache",
    });
    response.end(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    throw error;
  }
}

export function createAppServer(options: AppServerOptions = {}): Server {
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
  const logger = options.logger ?? createSilentLogger();
  const metaService =
    options.database === undefined || options.metaKeyHash === undefined
      ? undefined
      : new MetaAdminService(options.database, options.metaKeyHash, logger);
  const devEnabled = options.devViews ?? process.env.DEV_VIEWS === "1";
  const devToken = options.devToken ?? process.env.DEV_TOKEN;
  const devLoginLimiter = new DevLoginRateLimiter();
  const teacherLoginLimiter = new TeacherLoginRateLimiter();
  const botRuns = devEnabled && devToken !== undefined && options.database !== undefined && options.tokenSecret !== undefined
    ? new DevBotRunRegistry({
        database: options.database,
        tokenSecret: options.tokenSecret,
        devToken,
        logger,
        ...(options.botCommand === undefined ? {} : { command: options.botCommand }),
        ...(options.botStopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.botStopTimeoutMs }),
      })
    : undefined;

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, staticDir, metaService, logger, {
      enabled: devEnabled,
      devToken,
      loginLimiter: devLoginLimiter,
      teacherLoginLimiter,
      botRuns,
    }).catch((error: unknown) => {
      logger.error("http_request_failed", {
        detail: { method: request.method ?? "UNKNOWN", path: request.url?.split("?")[0] ?? "/", cause: error instanceof Error ? error.name : "unknown" },
      });
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      } else {
        response.destroy();
      }
    });
  });
  server.once("close", () => {
    const closed = botRuns?.close();
    if (closed !== undefined) void closed.completed;
  });
  return server;
}

export function createGameServer(options: GameServerOptions): Readonly<{
  server: Server;
  gateway: ReturnType<typeof attachSocketGateway>;
  rounds: Map<string, QuestionRound>;
}> {
  const rounds = options.rounds ?? new Map<string, QuestionRound>();
  const logger = options.logger ?? createSilentLogger();
  const presence = createPresenceRegistry();
  const server = createAppServer({ ...options, rounds, logger, presence });
  const gateway = attachSocketGateway(server, {
    database: options.database,
    tokenSecret: options.tokenSecret,
    rounds,
    logger,
    presence,
  });
  return Object.freeze({ server, gateway, rounds });
}

async function handleHttpRequest(
  request: import("node:http").IncomingMessage,
  response: ServerResponse,
  options: AppServerOptions,
  staticDir: string,
  metaService: MetaAdminService | undefined,
  logger: ServerLogger,
  devRuntime: Readonly<{
    enabled: boolean;
    devToken: string | undefined;
    loginLimiter: DevLoginRateLimiter;
    teacherLoginLimiter: TeacherLoginRateLimiter;
    botRuns: DevBotRunRegistry | undefined;
  }>,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");

    const isMetaLogin = request.method === "POST" && url.pathname === "/api/meta/login";
    const isMetaMint = request.method === "POST" && url.pathname === "/api/meta/teachers";
    const revokePathMatch = /^\/api\/meta\/teachers\/([^/]+)\/revoke$/.exec(url.pathname);
    const isMetaRevoke = request.method === "POST" && revokePathMatch !== null;
    const revokeTeacherId = revokePathMatch?.[1];
    const reissuePathMatch = /^\/api\/meta\/teachers\/([^/]+)\/reissue$/.exec(url.pathname);
    const isMetaReissue = request.method === "POST" && reissuePathMatch !== null;
    const reissueTeacherId = reissuePathMatch?.[1];
    const hasValidRevokeTeacherId =
      revokeTeacherId !== undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        revokeTeacherId,
      );
    const hasValidReissueTeacherId =
      reissueTeacherId !== undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        reissueTeacherId,
      );
    const mutationAction = isMetaMint
      ? "mint"
      : isMetaReissue
        ? "reissue"
        : isMetaRevoke
          ? "revoke"
          : undefined;

    if (mutationAction !== undefined && metaService !== undefined) {
      if (!metaService.beginMutationAttempt(mutationAction)) {
        sendMetaNotFound(response);
        return;
      }
    }

    if (url.pathname.startsWith("/api/meta/") && request.method !== "GET") {
      const fetchSite = request.headers["sec-fetch-site"];
      if (fetchSite === "cross-site" || !isJsonContentType(request)) {
        const outcome = fetchSite === "cross-site" ? "cross_site_rejected" : "content_type_rejected";
        if (isMetaLogin && metaService !== undefined) {
          metaService.rejectLogin(requestSource(request), outcome);
        } else if (mutationAction !== undefined && metaService !== undefined) {
          metaService.recordMutationOutcome(mutationAction, outcome);
        }
        sendMetaNotFound(response);
        return;
      }
    }

    if (
      isMetaLogin &&
      metaService !== undefined &&
      options.tokenSecret !== undefined &&
      options.metaKeyHash !== undefined
    ) {
      await handleMetaLogin(
        request,
        response,
        metaService,
        options.tokenSecret,
        options.metaKeyHash,
      );
      return;
    }

    if (
      url.pathname.startsWith("/api/meta/") &&
      url.pathname !== "/api/meta/login" &&
      (metaService === undefined ||
        options.tokenSecret === undefined ||
        options.metaKeyHash === undefined ||
        !metaAuthorized(request, options.tokenSecret, options.metaKeyHash))
    ) {
      if (mutationAction !== undefined && metaService !== undefined) {
        metaService.recordMutationOutcome(mutationAction, "unauthorized");
      }
      sendMetaNotFound(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/meta/teachers") {
      handleListTeachers(response, metaService as MetaAdminService);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/meta/teachers") {
      await handleMintTeacher(request, response, metaService as MetaAdminService);
      return;
    }

    if (isMetaRevoke && !hasValidRevokeTeacherId) {
      (metaService as MetaAdminService).recordMutationOutcome("revoke", "malformed_teacher_id");
      sendMetaNotFound(response);
      return;
    }

    if (isMetaRevoke && revokeTeacherId !== undefined) {
      await handleRevokeTeacher(
        request,
        response,
        metaService as MetaAdminService,
        revokeTeacherId,
      );
      return;
    }

    if (isMetaReissue && !hasValidReissueTeacherId) {
      (metaService as MetaAdminService).recordMutationOutcome(
        "reissue",
        "malformed_teacher_id",
      );
      sendMetaNotFound(response);
      return;
    }

    if (isMetaReissue && reissueTeacherId !== undefined) {
      await handleReissueTeacher(
        request,
        response,
        metaService as MetaAdminService,
        reissueTeacherId,
      );
      return;
    }

    if (
      options.database !== undefined &&
      options.tokenSecret !== undefined &&
      await handleDevViewRequest(request, response, url, {
        database: options.database,
        rounds: options.rounds ?? new Map(),
        enabled: devRuntime.enabled,
        ...(devRuntime.devToken === undefined ? {} : { devToken: devRuntime.devToken }),
        tokenSecret: options.tokenSecret,
        ...(devRuntime.botRuns === undefined ? {} : { botRuns: devRuntime.botRuns }),
        loginLimiter: devRuntime.loginLimiter,
        logger,
        ...(options.presence === undefined ? {} : { presence: options.presence }),
        teacherIdFromRequest: (candidate) =>
          teacherIdFromRequest(candidate, options.database as AppDatabase, options.tokenSecret as string, logger),
      })
    ) {
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/question-sets" &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      handleQuestionSets(request, response, url, options.database, options.tokenSecret, logger);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/question-sets/import" &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      await handleQuestionImport(request, response, options.database, options.tokenSecret, logger);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/teacher/login" &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      await handleTeacherLogin(
        request,
        response,
        options.database,
        options.tokenSecret,
        devRuntime.teacherLoginLimiter,
        logger,
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/teacher/logout") {
      handleTeacherLogout(request, response);
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/teacher/sessions" &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      handleTeacherSessions(request, response, url, options.database, options.tokenSecret, logger);
      return;
    }

    const sessionDeckMatch = /^\/api\/teacher\/sessions\/([^/]+)\/deck$/.exec(url.pathname);
    if (
      request.method === "GET" &&
      sessionDeckMatch !== null &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      handleTeacherSessionDeck(
        request,
        response,
        decodeURIComponent(sessionDeckMatch[1] ?? ""),
        options.database,
        options.tokenSecret,
        logger,
      );
      return;
    }

    const sessionArchiveMatch = /^\/api\/teacher\/sessions\/([^/]+)\/(archive|unarchive)$/.exec(url.pathname);
    if (
      request.method === "POST" &&
      sessionArchiveMatch !== null &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      await handleSessionArchive(
        request,
        response,
        decodeURIComponent(sessionArchiveMatch[1] ?? ""),
        sessionArchiveMatch[2] as "archive" | "unarchive",
        options.database,
        options.tokenSecret,
        logger,
      );
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/sessions" &&
      options.database !== undefined &&
      options.tokenSecret !== undefined
    ) {
      await handleCreateSession(request, response, options.database, options.tokenSecret, logger);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        version: APP_VERSION,
        ...(options.buildSha === undefined ? {} : { build_sha: options.buildSha }),
        ...(options.publicBaseUrl === undefined ? {} : { base_url: options.publicBaseUrl }),
        uptime_s: Math.floor(process.uptime()),
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/static/")) {
      await serveStatic(response, url.pathname.slice("/static/".length), staticDir);
      return;
    }

    const surfaceFile =
      url.pathname === "/"
        ? "index.html"
        : url.pathname === "/teach"
          ? "teacher.html"
          : url.pathname === "/join"
            ? "student.html"
            : url.pathname === "/meta"
              ? "meta.html"
            : /^\/projector\/[0-9a-f-]{36}$/.test(url.pathname)
              ? "projector.html"
              : undefined;
    if (request.method === "GET" && surfaceFile !== undefined) {
      await serveStatic(response, surfaceFile, staticDir);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
}

export async function runServer(): Promise<Server> {
  loadEnvironmentFile();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    serverLogger.error("configuration_rejected", {
      detail: { cause: error instanceof Error ? error.name : "unknown" },
    });
    throw error;
  }
  const database = openDatabase(config.dbPath);
  const logger = new ServerLogger({ minimumLevel: config.logLevel });
  const runtime = createGameServer({
    database,
    tokenSecret: config.tokenSecret,
    metaKeyHash: config.metaKeyHash,
    ...(config.buildSha === undefined ? {} : { buildSha: config.buildSha }),
    ...(config.baseUrl === undefined ? {} : { publicBaseUrl: config.baseUrl }),
    devViews: process.env.DEV_VIEWS === "1",
    logger,
    ...(process.env.DEV_TOKEN === undefined ? {} : { devToken: process.env.DEV_TOKEN }),
  });
  const { server, gateway } = runtime;
  const port = config.port;
  const host = process.env.HOST ?? "127.0.0.1";

  server.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  const boundPort = address !== null && typeof address !== "string" ? address.port : port;
  logger.info("server_ready", { detail: { host, port: boundPort } });

  process.once("SIGTERM", () => {
    logger.info("shutdown_started", { detail: { signal: "SIGTERM" } });
    logger.info("shutdown_sockets_disconnecting", { detail: {} });
    gateway.disconnectSockets(true);
    const forceClose = setTimeout(() => {
      logger.warn("shutdown_force_close", { detail: { timeout_ms: 2_500 } });
      server.closeAllConnections();
    }, 2_500);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      logger.info("shutdown_http_closed", { detail: {} });
      database.close();
      logger.info("shutdown_complete", { detail: {} });
      process.exitCode = 0;
    });
    server.closeIdleConnections();
  });

  return server;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void runServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("server_start_failed", {
      detail: { cause: error instanceof Error ? error.name : "unknown" },
    });
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
