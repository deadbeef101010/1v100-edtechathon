import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const TOKEN_SECRET = "event-store-token-secret-32-characters";

let directory: string;
let database: AppDatabase;
let sessionId: string;
let store: GameEventStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-events-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Event Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET).sessionId;
  store = new GameEventStore(database);
});

afterEach(async () => {
  database.close();
  await rm(directory, { recursive: true, force: true });
});

const event = (overrides: Record<string, unknown> = {}) => ({
  sessionId,
  gameId: null,
  attemptId: "attempt-1",
  eventType: "PHASE_CHANGED",
  actorKind: "teacher" as const,
  actorId: "teacher-1",
  requestId: "request-1",
  payload: { from: "LOBBY", to: "QUESTION_OPEN" },
  createdAtMs: 1_000,
  ...overrides,
});

describe("append-only game event store", () => {
  it.each(["UPDATE", "DELETE"] as const)("rejects %s against game_events", (operation) => {
    const accepted = store.append(event());

    expect(() =>
      database
        .prepare(
          operation === "UPDATE"
            ? "UPDATE game_events SET event_type = 'changed' WHERE event_id = ?"
            : "DELETE FROM game_events WHERE event_id = ?",
        )
        .run(accepted.eventId),
    ).toThrow(/game_events is append-only/);
  });

  it("returns the original persisted event for a duplicate actor request", () => {
    const first = store.append(event());
    const duplicate = store.append(
      event({ eventType: "DIFFERENT_EVENT", payload: { changed: true }, createdAtMs: 2_000 }),
    );
    const count = database.prepare("SELECT COUNT(*) AS count FROM game_events").get() as {
      count: number;
    };

    expect(duplicate).toEqual(first);
    expect(count.count).toBe(1);
    expect(duplicate.payload).toEqual({ from: "LOBBY", to: "QUESTION_OPEN" });
  });

  it("allocates session server sequences atomically and reads strict replay order", () => {
    const third = store.append(event({ requestId: "request-3", eventType: "THIRD" }));
    const first = store.append(event({ requestId: "request-1", eventType: "FIRST" }));
    const second = store.append(event({ requestId: "request-2", eventType: "SECOND" }));

    const replay = store.readSession(sessionId);

    expect([third.serverSeq, first.serverSeq, second.serverSeq]).toEqual([1, 2, 3]);
    expect(replay.map((entry) => entry.serverSeq)).toEqual([1, 2, 3]);
    expect(replay.map((entry) => entry.eventType)).toEqual(["THIRD", "FIRST", "SECOND"]);
  });

  it("rolls back the sequence allocation when persistence fails", () => {
    expect(() => store.append(event({ eventType: "", requestId: "bad" }))).toThrow();

    const accepted = store.append(event());
    const sequence = database
      .prepare("SELECT last_server_seq FROM sessions WHERE session_id = ?")
      .get(sessionId) as { last_server_seq: number };

    expect(accepted.serverSeq).toBe(1);
    expect(sequence.last_server_seq).toBe(1);
  });
});
