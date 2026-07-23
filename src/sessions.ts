import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import {
  createProjectorToken,
  createProjectorTokenForRequest,
  tokenHash,
} from "./auth.js";
import {
  CommandCoordinator,
  type CommandError,
  type CommandSuccess,
} from "./command-coordinator.js";
import type { AppDatabase } from "./db.js";
import { uuidV7 } from "./ids.js";
import { createSilentLogger, type ServerLogger } from "./log.js";

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{6}$`);
const DISPLAY_CODE_KEY_ID = 1;
const DISPLAY_CODE_INFO = Buffer.from("session-display-code", "utf8");

export const DEFAULT_SESSION_SETTINGS = Object.freeze({
  phase_a_seconds: 20,
  base_strikes: 2,
  momentum_enabled: false,
  momentum_threshold: 4,
  questions_per_game: 12,
  session_question_budget: 36,
});

export type CreatedClassroomSession = Readonly<{
  sessionId: string;
  code: string;
  projectorToken: string;
  projectorExpiresAtMs: number;
}>;

export type CreateSessionOptions = {
  codeGenerator?: () => string;
  questionSetId?: string;
  projectorTokenGenerator?: (sessionId: string, expiresAtMs: number) => string;
};

export type TeacherSessionSummary = Readonly<{
  session_id: string;
  code: string | null;
  created_at_ms: number;
  status: "lobby" | "live" | "ended";
  player_count: number;
  archived_at_ms: number | null;
}>;

export type ListTeacherSessionsOptions = Readonly<{
  includeArchived?: boolean;
}>;

export function normalizeSessionCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function sessionCodeHash(code: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(normalizeSessionCode(code)).digest();
}

function displayCodeKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), DISPLAY_CODE_INFO, 32));
}

function displayCodeAad(sessionId: string, keyId: number): Buffer {
  return Buffer.concat([Buffer.from([keyId]), Buffer.from(sessionId, "utf8")]);
}

function encryptSessionCode(code: string, sessionId: string, secret: string): string {
  const nonce = randomBytes(12);
  const keyId = Buffer.from([DISPLAY_CODE_KEY_ID]);
  const cipher = createCipheriv("aes-256-gcm", displayCodeKey(secret), nonce);
  cipher.setAAD(displayCodeAad(sessionId, DISPLAY_CODE_KEY_ID));
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return [keyId, nonce, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}

function decryptSessionCode(value: string, sessionId: string, secret: string): string {
  const parts = value.split(".");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted session code");
  }
  const [keyIdValue, nonceValue, tagValue, ciphertextValue] = parts as [string, string, string, string];
  const keyId = Buffer.from(keyIdValue, "base64url");
  const nonce = Buffer.from(nonceValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  if (keyId.length !== 1 || keyId[0] !== DISPLAY_CODE_KEY_ID || nonce.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid encrypted session code");
  }
  const decipher = createDecipheriv("aes-256-gcm", displayCodeKey(secret), nonce);
  decipher.setAAD(displayCodeAad(sessionId, DISPLAY_CODE_KEY_ID));
  decipher.setAuthTag(tag);
  const code = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  if (!CODE_PATTERN.test(code)) throw new Error("Invalid decrypted session code");
  return code;
}

export function generateSessionCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function listTeacherSessions(
  database: AppDatabase,
  teacherId: string,
  secret: string,
  logger: ServerLogger = createSilentLogger(),
  options: ListTeacherSessionsOptions = {},
): TeacherSessionSummary[] {
  const rows = database
    .prepare(
      `SELECT s.session_id, s.display_code_ciphertext, s.created_at_ms, s.status,
              s.archived_at_ms,
              COUNT(p.player_id) AS player_count
       FROM sessions s
       LEFT JOIN session_players p
         ON p.session_id = s.session_id AND p.kicked_at_ms IS NULL
       WHERE s.teacher_id = ?
         AND (? = 1 OR s.archived_at_ms IS NULL)
       GROUP BY s.session_id
       ORDER BY s.created_at_ms DESC, s.session_id DESC`,
    )
    .all(teacherId, options.includeArchived === true ? 1 : 0) as Array<Omit<TeacherSessionSummary, "code"> & {
      display_code_ciphertext: string | null;
    }>;
  return rows.map(({ display_code_ciphertext: encryptedCode, ...row }) => {
    let code: string | null = null;
    if (encryptedCode !== null) {
      try {
        code = decryptSessionCode(encryptedCode, row.session_id, secret);
      } catch (error) {
        logger.warn("session_display_code_decrypt_failed", {
          sessionId: row.session_id,
          actor: { kind: "teacher", id: teacherId },
          detail: { cause: error instanceof Error ? error.name : "unknown" },
        });
      }
    }
    return Object.freeze({ ...row, code });
  });
}

export function teacherSessionCode(
  database: AppDatabase,
  teacherId: string,
  sessionId: string,
  secret: string,
): string | null {
  const row = database.prepare(
    "SELECT display_code_ciphertext FROM sessions WHERE session_id = ? AND teacher_id = ?",
  ).get(sessionId, teacherId) as { display_code_ciphertext: string | null } | undefined;
  if (row?.display_code_ciphertext === null || row === undefined) return null;
  return decryptSessionCode(row.display_code_ciphertext, sessionId, secret);
}

function findOrCreateQuestionSet(
  database: AppDatabase,
  teacherId: string,
  now: number,
): string {
  const existing = database
    .prepare(
      "SELECT question_set_id FROM question_sets WHERE teacher_id = ? ORDER BY created_at_ms LIMIT 1",
    )
    .get(teacherId) as { question_set_id: string } | undefined;
  if (existing !== undefined) {
    ensureStarterQuestion(database, existing.question_set_id, now);
    return existing.question_set_id;
  }
  const questionSetId = uuidV7(now);
  database
    .prepare(
      `INSERT INTO question_sets
        (question_set_id, teacher_id, title, created_at_ms, updated_at_ms)
       VALUES (?, ?, 'Starter question set', ?, ?)`,
    )
    .run(questionSetId, teacherId, now, now);
  ensureStarterQuestion(database, questionSetId, now);
  return questionSetId;
}

function ensureStarterQuestion(database: AppDatabase, questionSetId: string, now: number): void {
  const existing = database
    .prepare("SELECT 1 FROM questions WHERE question_set_id = ? LIMIT 1")
    .get(questionSetId);
  if (existing !== undefined) {
    return;
  }
  database
    .prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
       VALUES (?, ?, 1, ?, ?, 1, 20)`,
    )
    .run(
      uuidV7(now + 1),
      questionSetId,
      "Which planet is known as the Red Planet?",
      JSON.stringify(["Earth", "Mars", "Jupiter", "Venus"]),
    );
}

export function createClassroomSession(
  database: AppDatabase,
  teacherId: string,
  secret: string,
  options: CreateSessionOptions = {},
): CreatedClassroomSession {
  const now = Date.now();
  const questionSetId = options.questionSetId ?? findOrCreateQuestionSet(database, teacherId, now);
  if (options.questionSetId !== undefined) {
    const owned = database
      .prepare("SELECT question_set_id FROM question_sets WHERE question_set_id = ? AND teacher_id = ?")
      .get(options.questionSetId, teacherId);
    if (owned === undefined) {
      throw new Error("Question set does not belong to this teacher");
    }
  }
  const codeGenerator = options.codeGenerator ?? generateSessionCode;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = normalizeSessionCode(codeGenerator());
    if (!CODE_PATTERN.test(code)) {
      throw new Error("Session code generator returned an invalid code");
    }
    const sessionId = uuidV7(now);
    const projectorExpiresAtMs = now + 8 * 60 * 60 * 1_000;
    const projectorToken = options.projectorTokenGenerator?.(sessionId, projectorExpiresAtMs) ??
      createProjectorToken(sessionId, secret, now);
    try {
      database
        .prepare(
          `INSERT INTO sessions
            (session_id, teacher_id, question_set_id, code_hash, display_code_ciphertext,
             projector_token_hash, projector_expires_at_ms, status,
             settings_json, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'lobby', ?, ?)`,
        )
        .run(
          sessionId,
          teacherId,
          questionSetId,
          sessionCodeHash(code, secret),
          encryptSessionCode(code, sessionId, secret),
          tokenHash(projectorToken),
          projectorExpiresAtMs,
          JSON.stringify(DEFAULT_SESSION_SETTINGS),
          now,
        );
      return Object.freeze({ sessionId, code, projectorToken, projectorExpiresAtMs });
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_CONSTRAINT_UNIQUE") {
        throw error;
      }
    }
  }
  throw new Error("Unable to allocate a unique session code");
}

type SessionMutationOutcome = CommandError | CommandSuccess;

export function archiveSession(
  database: AppDatabase,
  input: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
  }>,
  logger: ServerLogger = createSilentLogger(),
): SessionMutationOutcome {
  const archivedAtMs = Date.now();
  return new CommandCoordinator(database, undefined, logger).execute<null, SessionMutationOutcome>({
    sessionId: input.sessionId,
    commandType: "archive_session",
    actorKind: "teacher",
    actorId: input.teacherId,
    requestId: input.requestId,
    payload: {},
    createdAtMs: archivedAtMs,
    propose: () => {
      const session = database.prepare(
        `SELECT status, archived_at_ms FROM sessions
         WHERE session_id = ? AND teacher_id = ?`,
      ).get(input.sessionId, input.teacherId) as {
        status: "lobby" | "live" | "ended";
        archived_at_ms: number | null;
      } | undefined;
      if (session === undefined) return { code: "SESSION_NOT_FOUND", disposition: "terminal" };
      if (session.archived_at_ms !== null) return { code: "SESSION_ARCHIVED", disposition: "terminal" };
      if (session.status === "live") {
        return {
          code: "SESSION_LIVE",
          message: "End the live session before archiving it",
          disposition: "terminal",
        };
      }
      const endsLobby = session.status === "lobby";
      return {
        state: null,
        eventType: "session_archived",
        eventPayload: { archived_at_ms: archivedAtMs, ended_lobby: endsLobby },
        ...(endsLobby
          ? {
              priorEvents: [{
                eventType: "session_ended",
                eventPayload: { reason: "archived" },
                actorKind: "teacher" as const,
                actorId: input.teacherId,
              }],
            }
          : {}),
        persist: () => {
          database.prepare(
            `UPDATE sessions
             SET archived_at_ms = ?,
                 status = CASE WHEN status = 'lobby' THEN 'ended' ELSE status END,
                 ended_at_ms = CASE WHEN status = 'lobby' THEN ? ELSE ended_at_ms END
             WHERE session_id = ?`,
          ).run(archivedAtMs, archivedAtMs, input.sessionId);
        },
        outcome: (event) => Object.freeze({
          ok: true as const,
          requestId: input.requestId,
          serverSeq: event.serverSeq,
        }),
        apply: () => {
          logger.info("session_archived", {
            sessionId: input.sessionId,
            actor: { kind: "teacher", id: input.teacherId },
            detail: { request_id: input.requestId, ended_lobby: endsLobby },
          });
        },
      };
    },
  });
}

export function unarchiveSession(
  database: AppDatabase,
  input: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
  }>,
  logger: ServerLogger = createSilentLogger(),
): SessionMutationOutcome {
  return new CommandCoordinator(database, undefined, logger).execute<null, SessionMutationOutcome>({
    sessionId: input.sessionId,
    commandType: "unarchive_session",
    actorKind: "teacher",
    actorId: input.teacherId,
    requestId: input.requestId,
    payload: {},
    createdAtMs: Date.now(),
    propose: () => {
      const session = database.prepare(
        `SELECT archived_at_ms FROM sessions
         WHERE session_id = ? AND teacher_id = ?`,
      ).get(input.sessionId, input.teacherId) as { archived_at_ms: number | null } | undefined;
      if (session === undefined) return { code: "SESSION_NOT_FOUND", disposition: "terminal" };
      if (session.archived_at_ms === null) {
        return { code: "SESSION_NOT_ARCHIVED", disposition: "terminal" };
      }
      return {
        state: null,
        eventType: "session_unarchived",
        eventPayload: {},
        persist: () => {
          database.prepare("UPDATE sessions SET archived_at_ms = NULL WHERE session_id = ?")
            .run(input.sessionId);
        },
        outcome: (event) => Object.freeze({
          ok: true as const,
          requestId: input.requestId,
          serverSeq: event.serverSeq,
        }),
        apply: () => {
          logger.info("session_unarchived", {
            sessionId: input.sessionId,
            actor: { kind: "teacher", id: input.teacherId },
            detail: { request_id: input.requestId },
          });
        },
      };
    },
  });
}

export function rotateSessionCode(
  database: AppDatabase,
  input: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
    secret: string;
    codeGenerator?: () => string;
  }>,
  logger: ServerLogger = createSilentLogger(),
): SessionMutationOutcome {
  let nextCode = "";
  return new CommandCoordinator(database, undefined, logger).execute<null, SessionMutationOutcome>({
    sessionId: input.sessionId,
    commandType: "rotate_session_code",
    actorKind: "teacher",
    actorId: input.teacherId,
    requestId: input.requestId,
    payload: {},
    createdAtMs: Date.now(),
    propose: () => {
      const session = database.prepare(
        "SELECT status FROM sessions WHERE session_id = ? AND teacher_id = ?",
      ).get(input.sessionId, input.teacherId) as { status: string } | undefined;
      if (session === undefined) {
        return { code: "SESSION_NOT_FOUND", disposition: "terminal" };
      }
      if (session.status === "ended") {
        return { code: "SESSION_ENDED", message: "This show has ended", disposition: "terminal" };
      }
      const generate = input.codeGenerator ?? generateSessionCode;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = normalizeSessionCode(generate());
        if (!CODE_PATTERN.test(candidate)) throw new Error("Session code generator returned an invalid code");
        const existing = database.prepare("SELECT 1 FROM sessions WHERE code_hash = ? AND session_id != ?")
          .get(sessionCodeHash(candidate, input.secret), input.sessionId);
        if (existing === undefined) {
          nextCode = candidate;
          break;
        }
      }
      if (nextCode.length === 0) throw new Error("Unable to allocate a unique session code");
      return {
        state: null,
        eventType: "session_code_rotated",
        eventPayload: { display_key_id: DISPLAY_CODE_KEY_ID },
        persist: () => {
          database.prepare(
            "UPDATE sessions SET code_hash = ?, display_code_ciphertext = ? WHERE session_id = ?",
          ).run(
            sessionCodeHash(nextCode, input.secret),
            encryptSessionCode(nextCode, input.sessionId, input.secret),
            input.sessionId,
          );
        },
        outcome: (event) => Object.freeze({
          ok: true as const,
          requestId: input.requestId,
          serverSeq: event.serverSeq,
        }),
        apply: () => {
          logger.info("session_code_rotated", {
            sessionId: input.sessionId,
            actor: { kind: "teacher", id: input.teacherId },
            detail: { request_id: input.requestId },
          });
        },
      };
    },
  });
}

type ProjectorCredentialOutcome = CommandError | (CommandSuccess & Readonly<{
  projectorExpiresAtMs: number;
}>);

export type ProjectorCredentialResult = CommandError | (CommandSuccess & Readonly<{
  projectorToken: string;
  projectorExpiresAtMs: number;
}>);

export function rotateProjectorCredential(
  database: AppDatabase,
  input: Readonly<{
    sessionId: string;
    teacherId: string;
    requestId: string;
    secret: string;
  }>,
  logger: ServerLogger = createSilentLogger(),
): ProjectorCredentialResult {
  const expiresAtMs = Date.now() + 8 * 60 * 60 * 1_000;
  const outcome = new CommandCoordinator(database, undefined, logger)
    .execute<null, ProjectorCredentialOutcome>({
      sessionId: input.sessionId,
      commandType: "rotate_projector_credential",
      actorKind: "teacher",
      actorId: input.teacherId,
      requestId: input.requestId,
      payload: {},
      createdAtMs: Date.now(),
      propose: () => {
        const session = database.prepare(
          "SELECT status FROM sessions WHERE session_id = ? AND teacher_id = ?",
        ).get(input.sessionId, input.teacherId) as { status: string } | undefined;
        if (session === undefined) return { code: "SESSION_NOT_FOUND", disposition: "terminal" };
        if (session.status === "ended") {
          return { code: "SESSION_ENDED", message: "This show has ended", disposition: "terminal" };
        }
        const token = createProjectorTokenForRequest(
          input.sessionId,
          input.requestId,
          expiresAtMs,
          input.secret,
        );
        return {
          state: null,
          eventType: "projector_credential_rotated",
          eventPayload: { expires_at_ms: expiresAtMs },
          persist: () => {
            database.prepare(
              "UPDATE sessions SET projector_token_hash = ?, projector_expires_at_ms = ? WHERE session_id = ?",
            ).run(tokenHash(token), expiresAtMs, input.sessionId);
          },
          outcome: (event) => Object.freeze({
            ok: true as const,
            requestId: input.requestId,
            serverSeq: event.serverSeq,
            projectorExpiresAtMs: expiresAtMs,
          }),
          apply: () => {
            logger.info("projector_credential_rotated", {
              sessionId: input.sessionId,
              actor: { kind: "teacher", id: input.teacherId },
              detail: { request_id: input.requestId, expires_at_ms: expiresAtMs },
            });
          },
        };
      },
    });
  if (!outcome.ok) return outcome;
  return Object.freeze({
    ...outcome,
    projectorToken: createProjectorTokenForRequest(
      input.sessionId,
      input.requestId,
      outcome.projectorExpiresAtMs,
      input.secret,
    ),
  });
}
