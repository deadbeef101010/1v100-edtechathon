import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AppDatabase } from "./db.js";
import { uuidV7 } from "./ids.js";

export type MintedTeacherKey = Readonly<{
  teacherId: string;
  key: string;
  keyPrefix: string;
}>;

export type GeneratedTeacherKey = MintedTeacherKey & Readonly<{
  keyHash: Buffer;
  label: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

export type AuthenticatedTeacher = Readonly<{
  teacherId: string;
  keyPrefix: string;
}>;

function keyHash(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export function generateTeacherKey(
  label: string,
  now = Date.now(),
): GeneratedTeacherKey {
  const teacherId = uuidV7(now);
  const keyPrefix = randomBytes(6).toString("base64url").slice(0, 8);
  const key = `tch_${keyPrefix}_${randomBytes(32).toString("base64url")}`;
  return Object.freeze({
    teacherId,
    key,
    keyPrefix,
    keyHash: keyHash(key),
    label,
    createdAtMs: now,
    expiresAtMs: now + 90 * 24 * 60 * 60 * 1_000,
  });
}

export function generateReplacementTeacherKey(
  teacherId: string,
  label: string,
  now = Date.now(),
): GeneratedTeacherKey {
  const generated = generateTeacherKey(label, now);
  return Object.freeze({ ...generated, teacherId });
}

export function storeTeacherKey(database: AppDatabase, generated: GeneratedTeacherKey): void {
  database
    .prepare(
      `INSERT INTO teachers
        (teacher_id, key_prefix, key_hash, label, created_at_ms, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      generated.teacherId,
      generated.keyPrefix,
      generated.keyHash,
      generated.label,
      generated.createdAtMs,
      generated.expiresAtMs,
    );
}

export function mintTeacherKey(
  database: AppDatabase,
  label: string,
  now = Date.now(),
): MintedTeacherKey {
  const generated = generateTeacherKey(label, now);
  storeTeacherKey(database, generated);
  return Object.freeze({
    teacherId: generated.teacherId,
    key: generated.key,
    keyPrefix: generated.keyPrefix,
  });
}

type TeacherCredentialRow = {
  teacher_id: string;
  key_hash: Buffer;
  status: "active" | "revoked";
  expires_at_ms: number | null;
};

export function authenticateTeacherKey(
  database: AppDatabase,
  key: string,
  now = Date.now(),
): AuthenticatedTeacher | undefined {
  const match = /^tch_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{43}$/.exec(key);
  const row =
    match?.[1] === undefined
      ? undefined
      : (database
          .prepare(
            "SELECT teacher_id, key_hash, status, expires_at_ms FROM teachers WHERE key_prefix = ?",
          )
          .get(match[1]) as TeacherCredentialRow | undefined);
  const suppliedHash = keyHash(key);
  const hashMatches =
    row !== undefined &&
    row.key_hash.length === suppliedHash.length &&
    timingSafeEqual(row.key_hash, suppliedHash);
  const active =
    row !== undefined &&
    row.status === "active" &&
    (row.expires_at_ms === null || row.expires_at_ms > now);

  if (!hashMatches || !active || row === undefined) {
    database
      .prepare(
        `INSERT INTO auth_events
          (event_type, actor_kind, actor_id, payload_json, created_at_ms)
         VALUES ('teacher_login_failed', 'teacher', ?, ?, ?)`,
      )
      .run(row?.teacher_id ?? null, JSON.stringify({ reason: "invalid_credentials" }), now);
    return undefined;
  }

  database
    .prepare(
      `INSERT INTO auth_events
        (event_type, actor_kind, actor_id, payload_json, created_at_ms)
       VALUES ('teacher_login_succeeded', 'teacher', ?, ?, ?)`,
    )
    .run(row.teacher_id, JSON.stringify({ surface: "teacher_login" }), now);
  return Object.freeze({ teacherId: row.teacher_id, keyPrefix: match?.[1] as string });
}
