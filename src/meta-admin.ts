import { createHash, timingSafeEqual } from "node:crypto";

import {
  CommandCoordinator,
  type CommandError,
  type CommandSuccess,
} from "./command-coordinator.js";
import type { AppDatabase } from "./db.js";
import { GameEventStore } from "./game-event-store.js";
import { createSilentLogger, type ServerLogger } from "./log.js";
import {
  generateTeacherKey,
  generateReplacementTeacherKey,
  storeTeacherKey,
} from "./teachers.js";

const META_ACTOR_ID = "meta-organizer";
const MAX_GLOBAL_LOGIN_ATTEMPTS = 10;
const MAX_SOURCE_FAILED_ATTEMPTS = 5;
const MAX_GLOBAL_MUTATION_ATTEMPTS = 60;
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_SOURCES = 10_000;
const revocationListeners = new WeakMap<AppDatabase, Set<(teacherId: string) => void>>();

export type ListedTeacher = Readonly<{
  teacher_id: string;
  label: string;
  status: "active" | "revoked";
  created_at_ms: number;
  revoked_at_ms: number | null;
  last_used_at_ms: number | null;
  session_count: number;
}>;

type MintCommandOutcome =
  | (CommandSuccess & Readonly<{ teacherId: string }>)
  | CommandError;
type RevokeCommandOutcome = (CommandSuccess & Readonly<{ teacherId: string }>) | CommandError;
type ReissueCommandOutcome = MintCommandOutcome;

type FixedWindow = { bucket: number; count: number };

export type TeacherLabelValidation =
  | Readonly<{ ok: true; label: string }>
  | Readonly<{ ok: false; code: "INVALID_LABEL"; message: string }>;

export function validateTeacherLabel(value: string): TeacherLabelValidation {
  const label = value.trim();
  if (label.length === 0 || label.length > 64) {
    return Object.freeze({
      ok: false,
      code: "INVALID_LABEL",
      message: "Teacher labels must be between 1 and 64 characters",
    });
  }
  if (/^(?:tch_|meta_)/i.test(label) || /[A-Za-z0-9_-]{32,}/.test(label)) {
    return Object.freeze({
      ok: false,
      code: "INVALID_LABEL",
      message: "Teacher labels cannot contain credential-like text",
    });
  }
  return Object.freeze({ ok: true, label });
}

export function onTeacherRevoked(
  database: AppDatabase,
  listener: (teacherId: string) => void,
): () => void {
  const listeners = revocationListeners.get(database) ?? new Set<(teacherId: string) => void>();
  listeners.add(listener);
  revocationListeners.set(database, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) revocationListeners.delete(database);
  };
}

function notifyTeacherRevoked(database: AppDatabase, teacherId: string): void {
  for (const listener of revocationListeners.get(database) ?? []) listener(teacherId);
}

function consumeFixedWindow(window: FixedWindow, limit: number, now: number): boolean {
  const bucket = Math.floor(now / RATE_WINDOW_MS);
  if (window.bucket !== bucket) {
    window.bucket = bucket;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= limit;
}

function suppliedKeyMatches(key: string, expectedHash: string): boolean {
  const suppliedHash = createHash("sha256").update(key).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === suppliedHash.length && timingSafeEqual(expected, suppliedHash);
}

export class MetaAdminService {
  readonly #database: AppDatabase;
  readonly #metaKeyHash: string;
  readonly #coordinator: CommandCoordinator;
  readonly #logger: ServerLogger;
  readonly #failedAttempts = new Map<string, FixedWindow>();
  readonly #loginWindow: FixedWindow = { bucket: -1, count: 0 };
  readonly #mutationWindow: FixedWindow = { bucket: -1, count: 0 };

  constructor(
    database: AppDatabase,
    metaKeyHash: string,
    logger: ServerLogger = createSilentLogger(),
  ) {
    this.#database = database;
    this.#metaKeyHash = metaKeyHash;
    this.#logger = logger;
    this.#coordinator = new CommandCoordinator(database, new GameEventStore(database), logger);
  }

  authenticate(key: string, source: string, now = Date.now()): "ok" | "invalid" | "limited" {
    if (!consumeFixedWindow(this.#loginWindow, MAX_GLOBAL_LOGIN_ATTEMPTS, now)) {
      this.#recordAuthEvent("meta_login_rate_limited", { scope: "global" }, now);
      return "limited";
    }
    const bucket = Math.floor(now / RATE_WINDOW_MS);
    const attempts = this.#failedAttempts.get(source);
    if (attempts?.bucket === bucket && attempts.count >= MAX_SOURCE_FAILED_ATTEMPTS) {
      this.#recordAuthEvent("meta_login_rate_limited", { scope: "source" }, now);
      attempts.count += 1;
      return "limited";
    }
    if (!suppliedKeyMatches(key, this.#metaKeyHash)) {
      if (!this.#failedAttempts.has(source) && this.#failedAttempts.size >= MAX_TRACKED_SOURCES) {
        const oldestSource = this.#failedAttempts.keys().next().value as string | undefined;
        if (oldestSource !== undefined) this.#failedAttempts.delete(oldestSource);
      }
      const next = attempts?.bucket === bucket ? attempts : { bucket, count: 0 };
      next.count += 1;
      this.#failedAttempts.set(source, next);
      this.#recordAuthEvent("meta_login_failed", { reason: "invalid_credentials" }, now);
      return "invalid";
    }
    this.#failedAttempts.delete(source);
    this.#recordAuthEvent("meta_login_succeeded", { outcome: "ok" }, now);
    return "ok";
  }

  rejectLogin(source: string, reason: string, now = Date.now()): void {
    if (!consumeFixedWindow(this.#loginWindow, MAX_GLOBAL_LOGIN_ATTEMPTS, now)) {
      this.#recordAuthEvent("meta_login_rate_limited", { scope: "global", reason }, now);
      return;
    }
    const bucket = Math.floor(now / RATE_WINDOW_MS);
    const attempts = this.#failedAttempts.get(source);
    const next = attempts?.bucket === bucket ? attempts : { bucket, count: 0 };
    next.count += 1;
    this.#failedAttempts.set(source, next);
    this.#recordAuthEvent("meta_login_failed", { reason }, now);
  }

  beginMutationAttempt(action: "mint" | "reissue" | "revoke", now = Date.now()): boolean {
    const allowed = consumeFixedWindow(
      this.#mutationWindow,
      MAX_GLOBAL_MUTATION_ATTEMPTS,
      now,
    );
    if (!allowed) this.recordMutationOutcome(action, "rate_limited", now);
    return allowed;
  }

  recordMutationOutcome(
    action: "mint" | "reissue" | "revoke",
    outcome: string,
    now = Date.now(),
  ): void {
    this.#recordAuthEvent("meta_admin_attempt", { action, outcome }, now);
    const context = {
      actor: { kind: "meta" as const, id: META_ACTOR_ID },
      detail: { action, outcome },
    };
    if (outcome === "succeeded") this.#logger.info("meta_admin_attempt", context);
    else this.#logger.warn("meta_admin_attempt", context);
  }

  listTeachers(): ListedTeacher[] {
    return this.#database
      .prepare(
        `SELECT t.teacher_id, t.label, t.status, t.created_at_ms, t.revoked_at_ms,
                (SELECT MAX(a.created_at_ms) FROM auth_events a
                 WHERE a.actor_kind = 'teacher' AND a.actor_id = t.teacher_id
                   AND a.event_type = 'teacher_login_succeeded') AS last_used_at_ms,
                (SELECT COUNT(*) FROM sessions s
                 WHERE s.teacher_id = t.teacher_id) AS session_count
         FROM teachers t ORDER BY t.created_at_ms DESC, t.teacher_id DESC`,
      )
      .all() as ListedTeacher[];
  }

  reissueTeacher(
    teacherId: string,
    requestId: string,
    now = Date.now(),
  ):
    | Readonly<{ ok: true; teacherId: string; key: string | null }>
    | Readonly<{ ok: false; code: string }> {
    // Raw keys live only in this closure: persisted outcomes must stay
    // redacted, so a replayed reissue returns key: null instead of the key.
    let issuedKey: string | undefined;
    const outcome = this.#coordinator.execute<null, ReissueCommandOutcome>({
      scope: "meta",
      commandType: "reissue_teacher_key",
      actorKind: "organizer",
      actorId: META_ACTOR_ID,
      requestId,
      payload: { teacher_id: teacherId },
      createdAtMs: now,
      propose: () => {
        const teacher = this.#database
          .prepare("SELECT label, status FROM teachers WHERE teacher_id = ?")
          .get(teacherId) as { label: string; status: "active" | "revoked" } | undefined;
        if (teacher === undefined) {
          return { code: "NOT_FOUND", disposition: "terminal" };
        }
        if (teacher.status === "revoked") {
          return { code: "REVOKED", disposition: "terminal" };
        }
        const generated = generateReplacementTeacherKey(teacherId, teacher.label, now);
        issuedKey = generated.key;
        return {
          state: null,
          eventType: "teacher_key_reissued",
          eventPayload: { teacher_id: teacherId, label: teacher.label },
          persist: () => {
            this.#database
              .prepare(
                `UPDATE teachers
                 SET key_prefix = ?, key_hash = ?, expires_at_ms = ?, key_rotated_at_ms = ?
                 WHERE teacher_id = ? AND status = 'active'`,
              )
              .run(
                generated.keyPrefix,
                generated.keyHash,
                generated.expiresAtMs,
                now,
                teacherId,
              );
          },
          outcome: (event) => ({
            ok: true,
            requestId,
            serverSeq: event.serverSeq,
            teacherId,
          }),
          apply: () => {
            notifyTeacherRevoked(this.#database, teacherId);
            this.#logger.info("teacher_access_rotated", {
              actor: { kind: "meta", id: META_ACTOR_ID },
              detail: { teacher_id: teacherId },
            });
          },
        };
      },
    });
    return outcome.ok
      ? Object.freeze({ ok: true, teacherId: outcome.teacherId, key: issuedKey ?? null })
      : Object.freeze({ ok: false, code: outcome.code });
  }

  mintTeacher(
    label: string,
    requestId: string,
    now = Date.now(),
    auditAttempt = false,
  ):
    | Readonly<{ ok: true; teacherId: string; key: string | null }>
    | Readonly<{ ok: false; code: string; message?: string }> {
    const validated = validateTeacherLabel(label);
    if (!validated.ok) {
      return Object.freeze({ ok: false, code: validated.code, message: validated.message });
    }
    // Raw keys live only in this closure: persisted outcomes must stay
    // redacted, so a replayed mint returns key: null instead of the key.
    let issuedKey: string | undefined;
    const outcome = this.#coordinator.execute<null, MintCommandOutcome>({
      scope: "meta",
      commandType: "mint_teacher_key",
      actorKind: "organizer",
      actorId: META_ACTOR_ID,
      requestId,
      payload: { label: validated.label },
      createdAtMs: now,
      propose: () => {
        const generated = generateTeacherKey(validated.label, now);
        issuedKey = generated.key;
        return {
          state: null,
          eventType: "teacher_key_minted",
          eventPayload: { teacher_id: generated.teacherId, label: validated.label },
          persist: () => {
            storeTeacherKey(this.#database, generated);
            if (auditAttempt) {
              this.#recordAuthEvent(
                "meta_admin_attempt",
                { action: "mint", outcome: "succeeded" },
                now,
              );
            }
          },
          outcome: (event) => ({
            ok: true,
            requestId,
            serverSeq: event.serverSeq,
            teacherId: generated.teacherId,
          }),
          apply: () => undefined,
        };
      },
    });
    if (!outcome.ok) {
      return Object.freeze({ ok: false, code: outcome.code });
    }
    return Object.freeze({ ok: true, teacherId: outcome.teacherId, key: issuedKey ?? null });
  }

  revokeTeacher(
    teacherId: string,
    requestId: string,
    now = Date.now(),
  ): Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }> {
    const outcome = this.#coordinator.execute<null, RevokeCommandOutcome>({
      scope: "meta",
      commandType: "revoke_teacher_key",
      actorKind: "organizer",
      actorId: META_ACTOR_ID,
      requestId,
      payload: { teacher_id: teacherId },
      createdAtMs: now,
      propose: () => {
        const teacher = this.#database
          .prepare("SELECT label, status FROM teachers WHERE teacher_id = ?")
          .get(teacherId) as { label: string; status: "active" | "revoked" } | undefined;
        if (teacher === undefined) {
          return { code: "NOT_FOUND", disposition: "terminal" };
        }
        if (teacher.status === "revoked") {
          return { code: "ALREADY_REVOKED", disposition: "terminal" };
        }
        return {
          state: null,
          eventType: "teacher_key_revoked",
          eventPayload: { teacher_id: teacherId, label: teacher.label },
          persist: () => {
            this.#database
              .prepare(
                `UPDATE teachers SET status = 'revoked', revoked_at_ms = ?
                 WHERE teacher_id = ? AND status = 'active'`,
              )
              .run(now, teacherId);
          },
          outcome: (event) => ({
            ok: true,
            requestId,
            serverSeq: event.serverSeq,
            teacherId,
          }),
          apply: () => notifyTeacherRevoked(this.#database, teacherId),
        };
      },
    });
    return outcome.ok
      ? Object.freeze({ ok: true })
      : Object.freeze({ ok: false, code: outcome.code });
  }

  #recordAuthEvent(
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    now: number,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO auth_events
          (event_type, actor_kind, actor_id, payload_json, created_at_ms)
         VALUES (?, 'system', NULL, ?, ?)`,
      )
      .run(eventType, JSON.stringify({ surface: "meta", ...payload }), now);
  }
}
