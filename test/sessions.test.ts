import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { createAppServer } from "../src/server.js";
import {
  archiveSession,
  createClassroomSession,
  DEFAULT_SESSION_SETTINGS,
  listTeacherSessions,
  rotateSessionCode,
  sessionCodeHash,
  unarchiveSession,
} from "../src/sessions.js";
import { createSilentLogger } from "../src/log.js";
import { mintTeacherKey } from "../src/teachers.js";

const TOKEN_SECRET = "session-token-secret-32-characters-minimum";

let directory: string;
let database: AppDatabase;
const servers: Array<ReturnType<typeof createAppServer>> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-session-"));
  database = openDatabase(join(directory, "game.db"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  database.close();
  await rm(directory, { recursive: true, force: true });
});

async function baseUrl(): Promise<string> {
  const server = createAppServer({ database, tokenSecret: TOKEN_SECRET });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("classroom session creation", () => {
  it("creates a lobby with architecture-default settings for an authenticated teacher", async () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);

    const response = await fetch(`${await baseUrl()}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "create-default" }),
    });
    const body = (await response.json()) as { session_id: string; code: string };
    const row = database
      .prepare("SELECT status, settings_json FROM sessions WHERE session_id = ?")
      .get(body.session_id) as { status: string; settings_json: string };

    expect(response.status).toBe(201);
    expect(body.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(row.status).toBe("lobby");
    expect(JSON.parse(row.settings_json)).toEqual(DEFAULT_SESSION_SETTINGS);
  });

  it("keeps 1000 sequential codes unique and retries a forced collision", () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const codes = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      codes.add(createClassroomSession(database, teacher.teacherId, TOKEN_SECRET).code);
    }
    expect(codes.size).toBe(1_000);

    const collisionTeacher = mintTeacherKey(database, "Mr Chen");
    createClassroomSession(database, collisionTeacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC234",
    });
    let calls = 0;
    const retried = createClassroomSession(database, collisionTeacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => (calls++ === 0 ? "ABC234" : "ABC235"),
    });

    expect(retried.code).toBe("ABC235");
    expect(calls).toBe(2);
  }, 15_000);

  it("rejects absent and invalid teacher tokens without creating rows", async () => {
    const url = await baseUrl();

    const absent = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "absent" }),
    });
    const invalid = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer definitely-invalid", "content-type": "application/json" },
      body: JSON.stringify({ request_id: "invalid" }),
    });
    const count = database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };

    expect(absent.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(count.count).toBe(0);
  });

  it("lists only the teacher's sessions with codes, status, and active player counts", async () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const otherTeacher = mintTeacherKey(database, "Mr Chen");
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const first = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC234",
    });
    const second = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC235",
    });
    createClassroomSession(database, otherTeacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC236",
    });
    database.prepare("UPDATE sessions SET status = 'live', created_at_ms = 2 WHERE session_id = ?")
      .run(second.sessionId);
    database.prepare("UPDATE sessions SET created_at_ms = 1 WHERE session_id = ?").run(first.sessionId);
    const insertPlayer = database.prepare(
      `INSERT INTO session_players
        (player_id, session_id, nickname, nickname_norm, token_hash, token_expires_at_ms,
         role, joined_at_ms, last_seen_at_ms, kicked_at_ms)
       VALUES (?, ?, ?, ?, ?, 999999, 'mob', 1, 1, ?)`,
    );
    insertPlayer.run("active", second.sessionId, "Avery", "avery", Buffer.alloc(32, 1), null);
    insertPlayer.run("kicked", second.sessionId, "Blake", "blake", Buffer.alloc(32, 2), 2);
    const url = await baseUrl();

    const unauthorized = await fetch(`${url}/api/teacher/sessions`);
    const response = await fetch(`${url}/api/teacher/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(unauthorized.status).toBe(401);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        {
          session_id: second.sessionId,
          code: "ABC235",
          created_at_ms: 2,
          status: "live",
          player_count: 1,
          archived_at_ms: null,
        },
        {
          session_id: first.sessionId,
          code: "ABC234",
          created_at_ms: 1,
          status: "lobby",
          player_count: 0,
          archived_at_ms: null,
        },
      ],
    });
  });

  it("replays coordinated HTTP creation without creating another lobby", async () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const url = await baseUrl();
    const request = () => fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "stable-create" }),
    });

    const first = await request();
    const replay = await request();

    expect(first.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teacher_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teacher_command_outcomes").get())
      .toEqual({ count: 1 });
  });

  it("rotates a legacy session code atomically and replays the result", () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC234",
    });
    database.prepare("UPDATE sessions SET display_code_ciphertext = NULL WHERE session_id = ?")
      .run(classroom.sessionId);

    const first = rotateSessionCode(database, {
      sessionId: classroom.sessionId,
      teacherId: teacher.teacherId,
      requestId: "rotate-code",
      secret: TOKEN_SECRET,
      codeGenerator: () => "ABC235",
    });
    const replay = rotateSessionCode(database, {
      sessionId: classroom.sessionId,
      teacherId: teacher.teacherId,
      requestId: "rotate-code",
      secret: TOKEN_SECRET,
      codeGenerator: () => "ABC236",
    });
    const row = database.prepare(
      "SELECT code_hash, display_code_ciphertext FROM sessions WHERE session_id = ?",
    ).get(classroom.sessionId) as { code_hash: Buffer; display_code_ciphertext: string };
    const envelope = row.display_code_ciphertext.split(".");

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(row.code_hash).toEqual(sessionCodeHash("ABC235", TOKEN_SECRET));
    expect(row.display_code_ciphertext).not.toContain("ABC235");
    expect(envelope).toHaveLength(4);
    expect(Buffer.from(envelope[0] ?? "", "base64url")).toEqual(Buffer.from([1]));
    expect(listTeacherSessions(database, teacher.teacherId, TOKEN_SECRET)[0]?.code).toBe("ABC235");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM game_events WHERE event_type = 'session_code_rotated'",
    ).get()).toEqual({ count: 1 });
  });

  it("isolates a corrupt display-code envelope to its row and logs a warning", () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const first = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC234",
    });
    const second = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET, {
      codeGenerator: () => "ABC235",
    });
    database.prepare("UPDATE sessions SET display_code_ciphertext = 'bad' WHERE session_id = ?")
      .run(first.sessionId);
    const logger = createSilentLogger();

    const sessions = listTeacherSessions(database, teacher.teacherId, TOKEN_SECRET, logger);

    expect(sessions.find((entry) => entry.session_id === first.sessionId)?.code).toBeNull();
    expect(sessions.find((entry) => entry.session_id === second.sessionId)?.code).toBe("ABC235");
    expect(logger.entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "session_display_code_decrypt_failed", session_id: first.sessionId }),
    ]));
  });

  it("hides archived sessions by default, includes them on request, and restores them", () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
    const logger = createSilentLogger();
    database.prepare("UPDATE sessions SET status = 'ended', ended_at_ms = 10 WHERE session_id = ?")
      .run(classroom.sessionId);

    const archived = archiveSession(database, {
      sessionId: classroom.sessionId,
      teacherId: teacher.teacherId,
      requestId: "archive-ended",
    }, logger);

    expect(archived.ok).toBe(true);
    expect(listTeacherSessions(database, teacher.teacherId, TOKEN_SECRET)).toEqual([]);
    expect(listTeacherSessions(
      database,
      teacher.teacherId,
      TOKEN_SECRET,
      createSilentLogger(),
      { includeArchived: true },
    )[0]).toEqual(expect.objectContaining({
      session_id: classroom.sessionId,
      status: "ended",
      archived_at_ms: expect.any(Number),
    }));

    expect(unarchiveSession(database, {
      sessionId: classroom.sessionId,
      teacherId: teacher.teacherId,
      requestId: "unarchive-ended",
    }).ok).toBe(true);
    expect(listTeacherSessions(database, teacher.teacherId, TOKEN_SECRET)[0]?.session_id)
      .toBe(classroom.sessionId);
    expect(database.prepare(
      "SELECT event_type FROM game_events WHERE session_id = ? ORDER BY server_seq",
    ).all(classroom.sessionId)).toEqual([
      { event_type: "session_archived" },
      { event_type: "session_unarchived" },
    ]);
    expect(logger.entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "session_archived", session_id: classroom.sessionId }),
    ]));
  });

  it("ends a lobby while archiving, rejects live sessions, and replays by request id", () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const lobby = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
    const first = archiveSession(database, {
      sessionId: lobby.sessionId,
      teacherId: teacher.teacherId,
      requestId: "archive-lobby",
    });
    const replay = archiveSession(database, {
      sessionId: lobby.sessionId,
      teacherId: teacher.teacherId,
      requestId: "archive-lobby",
    });

    expect(replay).toEqual(first);
    expect(database.prepare(
      "SELECT status, ended_at_ms, archived_at_ms FROM sessions WHERE session_id = ?",
    ).get(lobby.sessionId)).toEqual({
      status: "ended",
      ended_at_ms: expect.any(Number),
      archived_at_ms: expect.any(Number),
    });
    expect(database.prepare(
      "SELECT event_type, payload_json FROM game_events WHERE session_id = ? ORDER BY server_seq",
    ).all(lobby.sessionId)).toEqual([
      { event_type: "session_ended", payload_json: JSON.stringify({ reason: "archived" }) },
      {
        event_type: "session_archived",
        payload_json: expect.stringContaining('"ended_lobby":true'),
      },
    ]);

    const live = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
    database.prepare("UPDATE sessions SET status = 'live' WHERE session_id = ?").run(live.sessionId);
    expect(archiveSession(database, {
      sessionId: live.sessionId,
      teacherId: teacher.teacherId,
      requestId: "archive-live",
    })).toEqual(expect.objectContaining({ ok: false, code: "SESSION_LIVE" }));
  });

  it("does not let another teacher archive a session", async () => {
    const owner = mintTeacherKey(database, "Ms Rivera");
    const other = mintTeacherKey(database, "Mr Chen");
    const classroom = createClassroomSession(database, owner.teacherId, TOKEN_SECRET);
    database.prepare("UPDATE sessions SET status = 'ended' WHERE session_id = ?").run(classroom.sessionId);
    const token = createTeacherToken(other.teacherId, TOKEN_SECRET);

    const response = await fetch(
      `${await baseUrl()}/api/teacher/sessions/${classroom.sessionId}/archive`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ request_id: "not-owner" }),
      },
    );

    expect(response.status).toBe(404);
    expect(database.prepare("SELECT archived_at_ms FROM sessions WHERE session_id = ?")
      .get(classroom.sessionId)).toEqual({ archived_at_ms: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_events WHERE session_id = ?")
      .get(classroom.sessionId)).toEqual({ count: 0 });
  });

  it("exposes archived sessions only when the teacher requests them", async () => {
    const teacher = mintTeacherKey(database, "Ms Rivera");
    const classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
    database.prepare(
      "UPDATE sessions SET status = 'ended', ended_at_ms = 10, archived_at_ms = 11 WHERE session_id = ?",
    ).run(classroom.sessionId);
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const url = await baseUrl();

    const normal = await fetch(`${url}/api/teacher/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const included = await fetch(`${url}/api/teacher/sessions?archived=1`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(await normal.json()).toEqual({ sessions: [] });
    expect(await included.json()).toEqual({ sessions: [expect.objectContaining({
      session_id: classroom.sessionId,
      archived_at_ms: 11,
    })] });
  });
});
