import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandCoordinator } from "../src/command-coordinator.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { ServerLogger } from "../src/log.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = `coordinator-${"test-only-".repeat(3)}`;
let directory: string;
let databasePath: string;
let database: AppDatabase;
let sessionId: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-coordinator-"));
  databasePath = join(directory, "game.db");
  database = openDatabase(databasePath);
  const teacher = mintTeacherKey(database, "Coordinator Teacher");
  sessionId = createClassroomSession(database, teacher.teacherId, SECRET).sessionId;
});

afterEach(async () => {
  if (database.open) {
    database.close();
  }
  await rm(directory, { recursive: true, force: true });
});

describe("transactional command coordinator", () => {
  it("does not swap live state when materialized persistence fails and remains retriable", () => {
    const coordinator = new CommandCoordinator(database);
    let liveState: Readonly<{ value: number }> = Object.freeze({ value: 0 });
    const request = () => ({
      sessionId,
      commandType: "increment",
      actorKind: "teacher" as const,
      actorId: "teacher-1",
      requestId: "request-1",
      payload: { amount: 1 },
      createdAtMs: 1_000,
      propose: () => ({
        state: Object.freeze({ value: 1 }),
        eventType: "incremented",
        eventPayload: { amount: 1 },
        persist: () => {
          database.prepare("INSERT INTO missing_table VALUES (?)").run(1);
        },
        outcome: (event: { serverSeq: number }) => ({
          ok: true as const,
          requestId: "request-1",
          serverSeq: event.serverSeq,
        }),
        apply: (state: Readonly<{ value: number }>) => {
          liveState = state;
        },
      }),
    });

    expect(() => coordinator.execute(request())).toThrow(/missing_table/);
    expect(liveState).toEqual({ value: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_events").get()).toEqual({
      count: 0,
    });

    database.exec("CREATE TABLE missing_table (value INTEGER NOT NULL) STRICT");
    const first = coordinator.execute(request());
    const retry = coordinator.execute(request());
    expect(retry).toEqual(first);
    expect(liveState).toEqual({ value: 1 });
  });

  it("rejects a reused request ID carrying a different payload fingerprint", () => {
    const coordinator = new CommandCoordinator(database);
    const execute = (amount: number) =>
      coordinator.execute({
        sessionId,
        commandType: "increment",
        actorKind: "teacher",
        actorId: "teacher-1",
        requestId: "request-1",
        payload: { amount },
        createdAtMs: 1_000,
        propose: () => ({
          state: amount,
          eventType: "incremented",
          eventPayload: { amount },
          outcome: (event) => ({
            ok: true as const,
            requestId: "request-1",
            serverSeq: event.serverSeq,
          }),
          apply: () => undefined,
        }),
      });

    expect(execute(1)).toMatchObject({ ok: true });
    expect(execute(2)).toEqual({
      ok: false,
      requestId: "request-1",
      code: "REQUEST_MISMATCH",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_events").get()).toEqual({
      count: 1,
    });
  });

  it("commits following events in causal order and rolls them back together", () => {
    const coordinator = new CommandCoordinator(database);
    const command = () => coordinator.execute({
      sessionId,
      commandType: "ordered-transition",
      actorKind: "teacher" as const,
      actorId: "teacher-1",
      requestId: "ordered-request",
      payload: {},
      createdAtMs: 1_000,
      propose: () => ({
        state: null,
        eventType: "first",
        eventPayload: {},
        followingEvents: [
          { eventType: "second", eventPayload: {}, actorKind: "system" as const, actorId: "system" },
          { eventType: "third", eventPayload: {}, actorKind: "system" as const, actorId: "system" },
        ],
        outcome: (event: { serverSeq: number }) => ({
          ok: true as const,
          requestId: "ordered-request",
          serverSeq: event.serverSeq,
        }),
        apply: () => undefined,
      }),
    });

    database.exec(`CREATE TRIGGER reject_third BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'third' BEGIN SELECT RAISE(ABORT, 'reject third'); END`);
    expect(command).toThrow(/reject third/);
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM command_requests").get()).toEqual({ count: 0 });

    database.exec("DROP TRIGGER reject_third");
    expect(command()).toMatchObject({ ok: true, serverSeq: 1 });
    expect(database.prepare(
      "SELECT event_type, server_seq FROM game_events ORDER BY server_seq",
    ).all()).toEqual([
      { event_type: "first", server_seq: 1 },
      { event_type: "second", server_seq: 2 },
      { event_type: "third", server_seq: 3 },
    ]);
  });

  it("replays a rejected outcome identically after reopening the database", () => {
    const command = (coordinator: CommandCoordinator) =>
      coordinator.execute({
        sessionId,
        commandType: "advance",
        actorKind: "teacher",
        actorId: "teacher-1",
        requestId: "request-1",
        payload: { attempt_id: "attempt-1" },
        createdAtMs: 1_000,
        propose: () => ({
          code: "SESSION_ENDED",
          message: "This show has ended",
          disposition: "terminal" as const,
        }),
      });
    const first = command(new CommandCoordinator(database));
    database.close();
    database = openDatabase(databasePath);

    const replay = command(new CommandCoordinator(database));
    expect(replay).toEqual(first);
    expect(replay).toEqual({
      ok: false,
      requestId: "request-1",
      code: "SESSION_ENDED",
      message: "This show has ended",
    });
  });

  it("re-evaluates a transient rejection with the same request ID", () => {
    const coordinator = new CommandCoordinator(database);
    let allowed = false;
    let applied = 0;
    const command = () => coordinator.execute({
      sessionId,
      commandType: "advance",
      actorKind: "teacher" as const,
      actorId: "teacher-1",
      requestId: "transient-request",
      payload: {},
      createdAtMs: 1_000,
      propose: () => allowed
        ? {
            state: null,
            eventType: "advanced",
            eventPayload: {},
            outcome: (event: { serverSeq: number }) => ({
              ok: true as const,
              requestId: "transient-request",
              serverSeq: event.serverSeq,
            }),
            apply: () => applied += 1,
          }
        : { code: "WRONG_PHASE", disposition: "transient" as const },
    });

    expect(command()).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    allowed = true;
    expect(command()).toMatchObject({ ok: true });
    expect(command()).toMatchObject({ ok: true });
    expect(applied).toBe(1);
    expect(database.prepare(
      "SELECT event_type, request_id FROM game_events ORDER BY server_seq",
    ).all()).toEqual([
      { event_type: "command_rejected", request_id: null },
      { event_type: "advanced", request_id: "transient-request" },
    ]);
    expect(coordinator.execute({
      sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: "teacher-1",
      requestId: "another-transient-request",
      payload: { attempt: 1 },
      createdAtMs: 1_000,
      propose: () => ({ code: "WRONG_PHASE", disposition: "transient" as const }),
    })).toMatchObject({ code: "WRONG_PHASE" });
    expect(coordinator.execute({
      sessionId,
      commandType: "advance",
      actorKind: "teacher",
      actorId: "teacher-1",
      requestId: "another-transient-request",
      payload: { attempt: 2 },
      createdAtMs: 1_000,
      propose: () => ({ code: "WRONG_PHASE", disposition: "transient" as const }),
    })).toMatchObject({ code: "REQUEST_MISMATCH" });
  });

  it("keeps command outcomes unchanged when mismatch logging throws", () => {
    const logger = new ServerLogger({ write: () => { throw new Error("broken pipe"); } });
    const coordinator = new CommandCoordinator(database, undefined, logger);
    const execute = (amount: number) => coordinator.execute({
      sessionId,
      commandType: "increment",
      actorKind: "teacher" as const,
      actorId: "teacher-1",
      requestId: "logged-request",
      payload: { amount },
      createdAtMs: 1_000,
      propose: () => ({
        state: null,
        eventType: "incremented",
        eventPayload: { amount },
        outcome: (event: { serverSeq: number }) => ({
          ok: true as const,
          requestId: "logged-request",
          serverSeq: event.serverSeq,
        }),
        apply: () => undefined,
      }),
    });

    expect(execute(1)).toMatchObject({ ok: true });
    expect(execute(2)).toEqual({
      ok: false,
      requestId: "logged-request",
      code: "REQUEST_MISMATCH",
    });
    expect(logger.droppedCount).toBe(1);
  });

  it("requires a non-empty actor ID", () => {
    expect(() =>
      new CommandCoordinator(database).execute({
        sessionId,
        commandType: "advance",
        actorKind: "teacher",
        actorId: "",
        requestId: "request-1",
        payload: {},
        createdAtMs: 1_000,
        propose: () => ({ code: "FORBIDDEN", disposition: "terminal" as const }),
      }),
    ).toThrow(/actor_id/);
  });
});
