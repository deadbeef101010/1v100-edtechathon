import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, runMigrations, type AppDatabase } from "../src/db.js";
import { CommandCoordinator, payloadFingerprint } from "../src/command-coordinator.js";
import { GameEventStore } from "../src/game-event-store.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "database-test-secret-at-least-32-characters";
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations", import.meta.url));

const temporaryDirectories: string[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "game-1v100-db-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("SQLite bootstrap", () => {
  it("applies ordered migrations once and makes the second run a no-op", async () => {
    const directory = await temporaryPath();
    const database = openDatabase(join(directory, "game.db"));
    databases.push(database);
    const initialCount = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    const secondRun = runMigrations(database);
    const finalCount = database
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };

    expect(initialCount.count).toBeGreaterThan(0);
    expect(secondRun).toEqual([]);
    expect(finalCount.count).toBe(initialCount.count);
  });

  it("enables WAL journaling and foreign-key enforcement", async () => {
    const directory = await temporaryPath();
    const database = openDatabase(join(directory, "game.db"));
    databases.push(database);

    const journal = database.pragma("journal_mode", { simple: true });
    const foreignKeys = database.pragma("foreign_keys", { simple: true });

    expect(journal).toBe("wal");
    expect(foreignKeys).toBe(1);
  });

  it("drops pre-upgrade synthetic rate-limit identities so the request can be retried", async () => {
    const directory = await temporaryPath();
    const migrationsDirectory = join(directory, "migrations");
    await mkdir(migrationsDirectory);
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (!name.endsWith(".sql") || name === "010_command_requests.sql") continue;
      await writeFile(
        join(migrationsDirectory, name),
        await readFile(join(MIGRATIONS_DIRECTORY, name)),
      );
    }
    const database = openDatabase(join(directory, "upgrade.db"), { migrationsDirectory });
    databases.push(database);
    const teacher = mintTeacherKey(database, "Upgrade Teacher");
    const session = createClassroomSession(database, teacher.teacherId, SECRET);
    const store = new GameEventStore(database);
    const requestId = "pre-upgrade-rate-limit";
    const playerId = "upgrade-player";
    const event = store.append({
      sessionId: session.sessionId,
      gameId: null,
      attemptId: null,
      eventType: "command_rejected",
      actorKind: "player",
      actorId: playerId,
      requestId,
      payload: { command_type: "rate_limited", code: "RATE_LIMITED" },
      createdAtMs: 1_000,
    });
    database.prepare(
      `INSERT INTO command_outcomes
        (session_id, actor_id, request_id, command_type, payload_fingerprint,
         outcome_json, event_id, created_at_ms)
       VALUES (?, ?, ?, 'rate_limited', ?, ?, ?, ?)`,
    ).run(
      session.sessionId,
      playerId,
      requestId,
      payloadFingerprint("rate_limited", { event: "answer_submit" }),
      JSON.stringify({ ok: false, requestId, code: "RATE_LIMITED" }),
      event.eventId,
      1_000,
    );
    await writeFile(
      join(migrationsDirectory, "010_command_requests.sql"),
      await readFile(join(MIGRATIONS_DIRECTORY, "010_command_requests.sql")),
    );

    expect(runMigrations(database, migrationsDirectory)).toContain("010_command_requests.sql");
    const retried = new CommandCoordinator(database).execute({
      sessionId: session.sessionId,
      commandType: "answer",
      actorKind: "player",
      actorId: playerId,
      requestId,
      payload: { attempt_id: "attempt-1", question_id: "question-1", choice: 1 },
      createdAtMs: 2_000,
      propose: () => ({
        state: null,
        eventType: "answer_accepted",
        eventPayload: {},
        outcome: (accepted) => ({ ok: true as const, requestId, serverSeq: accepted.serverSeq }),
        apply: () => undefined,
      }),
    });

    expect(retried).toMatchObject({ ok: true });
    expect(database.prepare(
      "SELECT command_type FROM command_requests WHERE session_id = ? AND actor_id = ? AND request_id = ?",
    ).get(session.sessionId, playerId, requestId)).toEqual({ command_type: "answer" });
  });

  it("migrates legacy advance identities without replaying success across attempts", async () => {
    const directory = await temporaryPath();
    const migrationsDirectory = join(directory, "migrations");
    await mkdir(migrationsDirectory);
    for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
      if (!name.endsWith(".sql") || name === "010_command_requests.sql") continue;
      await writeFile(join(migrationsDirectory, name), await readFile(join(MIGRATIONS_DIRECTORY, name)));
    }
    const database = openDatabase(join(directory, "advance-upgrade.db"), { migrationsDirectory });
    databases.push(database);
    const teacher = mintTeacherKey(database, "Advance Upgrade Teacher");
    const session = createClassroomSession(database, teacher.teacherId, SECRET);
    const event = new GameEventStore(database).append({
      sessionId: session.sessionId,
      gameId: null,
      attemptId: "legacy-attempt",
      eventType: "teacher_advance",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-advance",
      payload: {},
      createdAtMs: 1_000,
    });
    const legacyOutcome = { ok: true, requestId: "legacy-advance", serverSeq: event.serverSeq };
    database.prepare(
      `INSERT INTO command_outcomes
        (session_id, actor_id, request_id, command_type, payload_fingerprint,
         outcome_json, event_id, created_at_ms)
       VALUES (?, ?, ?, 'advance', ?, ?, ?, ?)`,
    ).run(
      session.sessionId,
      teacher.teacherId,
      "legacy-advance",
      payloadFingerprint("advance", {}),
      JSON.stringify(legacyOutcome),
      event.eventId,
      1_000,
    );
    const rejectedEvent = new GameEventStore(database).append({
      sessionId: session.sessionId,
      gameId: null,
      attemptId: "rejected-attempt",
      eventType: "command_rejected",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-rejected-advance",
      payload: { command_type: "advance", code: "WRONG_PHASE" },
      createdAtMs: 1_001,
    });
    database.prepare(
      `INSERT INTO command_outcomes
        (session_id, actor_id, request_id, command_type, payload_fingerprint,
         outcome_json, event_id, created_at_ms)
       VALUES (?, ?, ?, 'advance', ?, ?, ?, ?)`,
    ).run(
      session.sessionId,
      teacher.teacherId,
      "legacy-rejected-advance",
      payloadFingerprint("advance", {}),
      JSON.stringify({ ok: false, requestId: "legacy-rejected-advance", code: "WRONG_PHASE" }),
      rejectedEvent.eventId,
      1_001,
    );
    await writeFile(
      join(migrationsDirectory, "010_command_requests.sql"),
      await readFile(join(MIGRATIONS_DIRECTORY, "010_command_requests.sql")),
    );
    runMigrations(database, migrationsDirectory);
    const coordinator = new CommandCoordinator(database);

    expect(coordinator.replay({
      sessionId: session.sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-advance",
      payload: { attempt_id: "legacy-attempt" },
    })).toEqual(legacyOutcome);
    expect(coordinator.replay({
      sessionId: session.sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-advance",
      payload: { attempt_id: "different-attempt" },
    })).toMatchObject({ ok: false, code: "REQUEST_MISMATCH" });
    expect(coordinator.replay({
      sessionId: session.sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-rejected-advance",
      payload: { attempt_id: "different-attempt" },
    })).toMatchObject({ ok: false, code: "REQUEST_MISMATCH" });
    expect(coordinator.replay({
      sessionId: session.sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "legacy-rejected-advance",
      payload: { attempt_id: "rejected-attempt" },
    })).toBeUndefined();
  });

  it("rolls back every statement when a migration fails mid-file", async () => {
    const directory = await temporaryPath();
    const migrationsDirectory = join(directory, "migrations");
    await mkdir(migrationsDirectory);
    await writeFile(
      join(migrationsDirectory, "001_broken.sql"),
      [
        "CREATE TABLE should_rollback (id INTEGER PRIMARY KEY);",
        "INSERT INTO table_that_does_not_exist VALUES (1);",
      ].join("\n"),
    );

    expect(() =>
      openDatabase(join(directory, "broken.db"), { migrationsDirectory }),
    ).toThrow();

    const database = openDatabase(join(directory, "inspection.db"), {
      migrationsDirectory: join(directory, "empty-migrations"),
      migrate: false,
    });
    databases.push(database);
    database.close();
    databases.pop();

    const brokenDatabase = openDatabase(join(directory, "broken.db"), { migrate: false });
    databases.push(brokenDatabase);
    const table = brokenDatabase
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback'")
      .get();

    expect(table).toBeUndefined();
  });
});
